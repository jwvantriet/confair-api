/**
 * Rotation recomputation for a placement.
 *
 * Walks a chronological sequence of roster_days and partitions them into
 * rotations, using the STOP_CODES set from raido.js and the 30-day hard cap.
 *
 * Rotation rules (authoritative):
 *   1. A day is a STOP day if ALL its activities are in STOP_CODES.
 *   2. A rotation ENDS on the last non-stop day before a stop day.
 *   3. A rotation STARTS on the first non-stop day after a stop day (or
 *      the first non-stop day of the tracked history).
 *   4. 30-day hard cap: if a rotation runs 30 consecutive non-stop days,
 *      close it on day 30 (status = 'capped') and open a new rotation on
 *      day 31 if it's still non-stop.
 *   5. BLH counting: only FLIGHT activities, Designator 'P' excluded
 *      (positioning), EMVT day excludes all flight BLH on that day.
 *   6. Overtime: max(0, total_blh - 65), paid in the period containing
 *      the rotation's end_date.
 */
import { adminSupabase } from './supabase.js';
import { STOP_CODES } from './raido.js';
import { logger } from '../utils/logger.js';

const OT_THRESHOLD_HOURS = 65;
const MAX_ROTATION_DAYS  = 30;

function hhmmToDec(h) {
  const p = (h || '').split(':');
  return p.length === 2 ? parseInt(p[0], 10) + parseInt(p[1], 10) / 60 : 0;
}

function isStopDay(activities) {
  if (!Array.isArray(activities) || activities.length === 0) return true; // empty = stop
  return activities.every(a =>
    STOP_CODES.has(String(a?.ActivityCode || '').toUpperCase().trim())
  );
}

function hasEMVT(activities) {
  return (activities || []).some(a =>
    String(a?.ActivityCode || '').toUpperCase().trim() === 'EMVT'
  );
}

function dayFlightBLH(activities) {
  if (hasEMVT(activities)) return 0;
  return (activities || []).reduce((sum, a) => {
    if (String(a?.ActivityType || '').toUpperCase() !== 'FLIGHT') return sum;
    if (String(a?.Designator || '').toUpperCase().trim() === 'P') return sum;
    return sum + hhmmToDec(a?.aBLH);
  }, 0);
}

/**
 * Given a chronological list of roster_days rows for ONE placement, return
 * an array of rotation records (not yet persisted): {
 *   start_date, end_date, status, total_blh, ot_hours, capped_at_day30
 * }
 *
 * `days` must be sorted by roster_date ASC. Gaps in the date series are
 * treated as stop-equivalent (missing data closes an open rotation).
 */
export function computeRotations(days) {
  const rotations = [];
  let open = null; // { start, lastDayDate, dayCount, blh, days: [] }

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const acts = Array.isArray(d.activities) ? d.activities : [];
    const stop = isStopDay(acts);

    // Detect calendar gap between previous day and this one — treat as stop.
    const prev = days[i - 1];
    if (prev && open) {
      const gapMs = new Date(d.roster_date) - new Date(prev.roster_date);
      const gapDays = Math.round(gapMs / 86_400_000);
      if (gapDays > 1) {
        // close on prev day
        rotations.push(finalize(open, 'closed'));
        open = null;
      }
    }

    if (stop) {
      if (open) {
        rotations.push(finalize(open, 'closed'));
        open = null;
      }
      continue;
    }

    // Non-stop day
    const blh = dayFlightBLH(acts);
    if (!open) {
      open = { start: d.roster_date, lastDayDate: d.roster_date, dayCount: 1, blh };
    } else {
      open.lastDayDate = d.roster_date;
      open.dayCount   += 1;
      open.blh        += blh;
    }

    // 30-day cap — close on day 30, start fresh on day 31 (still this iter).
    if (open.dayCount >= MAX_ROTATION_DAYS) {
      rotations.push(finalize(open, 'capped'));
      open = null;
      // Day 31 doesn't exist in this iteration — next iteration may start a new rotation.
    }
  }

  if (open) rotations.push(finalize(open, 'open'));
  return rotations;
}

function finalize(open, status) {
  const total = Math.round(open.blh * 10_000) / 10_000;
  const ot    = status === 'open' ? 0 : Math.max(0, total - OT_THRESHOLD_HOURS);
  return {
    start_date:      open.start,
    end_date:        status === 'open' ? null : open.lastDayDate,
    status,
    total_blh:       total,
    ot_hours:        Math.round(ot * 10_000) / 10_000,
    capped_at_day30: status === 'capped',
  };
}

/**
 * Load roster_days for a placement since `sinceDate`, ordered chronologically.
 */
async function loadRosterDays(placementId, sinceDate) {
  const { data, error } = await adminSupabase
    .from('roster_days')
    .select('roster_date, activities')
    .eq('placement_id', placementId)
    .gte('roster_date', sinceDate)
    .order('roster_date', { ascending: true });
  if (error) throw new Error(`roster_days fetch: ${error.message}`);
  return data || [];
}

/** Find the payroll_periods.id whose range covers a given date. */
async function findPeriodForDate(date) {
  const { data } = await adminSupabase
    .from('payroll_periods').select('id')
    .lte('start_date', date).gte('end_date', date)
    .limit(1).maybeSingle();
  return data?.id || null;
}

/**
 * Recompute and persist rotations for a single placement based on the last
 * `lookbackMonths` months of roster_days. Wipes any rotations whose
 * start_date falls inside the window (plus any still-open rotation that
 * precedes the window — it may need re-opening with fresh data) then
 * re-inserts the freshly computed set.
 */
export async function recomputePlacementRotations(placementId, { lookbackMonths = 4 } = {}) {
  const since = new Date();
  since.setMonth(since.getMonth() - lookbackMonths);
  since.setDate(1);
  const sinceStr = since.toISOString().split('T')[0];

  const days = await loadRosterDays(placementId, sinceStr);
  const rotations = computeRotations(days);

  // Attach ot_period_id for rotations that closed inside a known period.
  for (const r of rotations) {
    if (r.end_date && r.ot_hours > 0) {
      r.ot_period_id = await findPeriodForDate(r.end_date);
    } else {
      r.ot_period_id = null;
    }
  }

  // Wipe the window + any open rotation whose start falls on/after `sinceStr - 30 days`
  // (safe cap since MAX_ROTATION_DAYS is 30, any rotation that could still be
  //  open at sinceStr must have started within 30 days of it).
  const wipeSince = new Date(since);
  wipeSince.setDate(wipeSince.getDate() - MAX_ROTATION_DAYS);
  const wipeSinceStr = wipeSince.toISOString().split('T')[0];

  const { error: delErr } = await adminSupabase
    .from('rotations')
    .delete()
    .eq('placement_id', placementId)
    .gte('start_date', wipeSinceStr);
  if (delErr) throw new Error(`rotations delete: ${delErr.message}`);

  if (!rotations.length) return { placementId, wrote: 0 };

  const rows = rotations.map(r => ({ ...r, placement_id: placementId }));
  const { error: insErr } = await adminSupabase.from('rotations').insert(rows);
  if (insErr) throw new Error(`rotations insert: ${insErr.message}`);

  return { placementId, wrote: rows.length };
}

/**
 * Recompute rotations for every placement that has roster_days in the
 * last `lookbackMonths` months. Idempotent — safe to re-run.
 */
export async function backfillAllRotations({ lookbackMonths = 4 } = {}) {
  const since = new Date();
  since.setMonth(since.getMonth() - lookbackMonths);
  since.setDate(1);
  const sinceStr = since.toISOString().split('T')[0];

  const { data: rdPids } = await adminSupabase
    .from('roster_days')
    .select('placement_id')
    .gte('roster_date', sinceStr);
  const placementIds = [...new Set((rdPids || []).map(r => r.placement_id))];

  const results = [];
  for (const pid of placementIds) {
    try {
      results.push(await recomputePlacementRotations(pid, { lookbackMonths }));
    } catch (e) {
      logger.error('rotation recompute failed', { placementId: pid, error: e.message });
      results.push({ placementId: pid, error: e.message });
    }
  }
  return { placementsProcessed: placementIds.length, results };
}

/**
 * Return the carry-over BLH at the start of `periodStart` for a placement —
 * i.e. total_blh of any rotation that is still open (status='open') whose
 * start_date is before `periodStart` and overlaps it.
 * Returns 0 if no carry-over.
 */
export async function getCarryoverBLH(placementId, periodStart) {
  const { data } = await adminSupabase
    .from('rotations')
    .select('total_blh, start_date')
    .eq('placement_id', placementId)
    .eq('status', 'open')
    .lt('start_date', periodStart)
    .order('start_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? Number(data.total_blh || 0) : 0;
}
