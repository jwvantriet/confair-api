/**
 * Roster & Charge Items routes
 */
import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth, requireAgency, requireCompanyOrAbove } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { fetchRosters, fetchRostersForCrew, rosterItemsList, mapRosterToRows, buildDailySummary, monthBounds, fetchActiveRolesForPeriod, fetchDateOfEmploymentForPeriod } from '../services/raido.js';

// ── Rate helpers (inlined to avoid circular import) ───────────────────────────
function normalizeCurrency(raw) {
  if (!raw) return 'USD';
  const u = raw.toUpperCase().trim();
  if (u === 'EUR' || u.includes('EURO')) return 'EUR';
  if (u === 'USD' || u.includes('DOLLAR') || u.includes('US ')) return 'USD';
  if (u === 'GBP' || u.includes('POUND') || u.includes('STERLING')) return 'GBP';
  if (/^[A-Z]{3}$/.test(u)) return u;
  return 'USD';
}

/**
 * Fetch every finance row for a Carerix job and return them grouped by
 * `kindId` (which maps to our charge_type codes). Rows are kept with their
 * start/end dates so the caller can pick the right rate per day.
 *
 * Returns: { [kindId]: [{ amount, currency, start, end }, ...] }
 * - each array is sorted by `start` ascending (nulls first)
 * - expired rows (end < periodFrom) are dropped if periodFrom provided
 */
async function fetchCarerixRatesForJob(carerixJobId, periodFrom = null) {
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const result = await queryGraphQL(`
      query JobFinancePage($qualifier: String, $pageable: Pageable) {
        crJobFinancePage(qualifier: $qualifier, pageable: $pageable) {
          items {
            _id
            toFinance {
              _id
              amount
              startDate
              endDate
              toKindNode { dataNodeID value }
              toCurrencyNode { dataNodeID value }
              toTypeNode { typeID }
            }
          }
        }
      }
    `, {
      qualifier: 'toJob.jobID == ' + parseInt(carerixJobId),
      pageable: { page: 0, size: 100 }
    });

    const items = result?.data?.crJobFinancePage?.items || [];
    const rateMap = {};

    for (const item of items) {
      const finance = item?.toFinance;
      if (!finance) continue;
      const start  = finance.startDate ? String(finance.startDate).split('T')[0] : null;
      const end    = finance.endDate   ? String(finance.endDate).split('T')[0]   : null;
      if (periodFrom && end && end < periodFrom) continue; // ends before period starts
      const kindId = finance.toKindNode?.dataNodeID;
      if (!kindId) continue;
      const amount = finance.amount != null ? Number(finance.amount) : null;
      if (amount == null) continue;
      const currency = normalizeCurrency((finance.toCurrencyNode?.value || '').trim());
      if (!rateMap[kindId]) rateMap[kindId] = [];
      rateMap[kindId].push({ amount, currency, start, end });
    }

    // Sort each kind's rates by start date ascending (nulls first = open-ended from past)
    for (const k of Object.keys(rateMap)) {
      rateMap[k].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    }
    return rateMap;
  } catch (err) {
    logger.warn('fetchCarerixRatesForJob failed', { carerixJobId, error: err.message });
    return {};
  }
}

// Pick the rate whose [start, end] window covers `dayDate`. Falls back to the
// newest-starting rate if nothing covers the day (e.g. future rate only).
function pickRateForDay(rates, dayDate) {
  if (!rates?.length) return null;
  const covering = rates.find(r =>
    (!r.start || r.start <= dayDate) &&
    (!r.end   || r.end   >= dayDate)
  );
  if (covering) return covering;
  return rates[rates.length - 1]; // last-resort
}

const router = Router();
router.use(requireAuth);

// Carerix finance typeID → charge type code
const CHARGE_TYPE_MAP = {
  DailyAllowance:      9582,
  AvailabilityPremium: 12308,
  YearsWithClient:     12328,
  PerDiem:             10203,
  GroundFee:           11382,
  SimFee:              10217,
  SoldOffDay:          10062,
  BODDays:             12378,
};

// ── GET /roster/charge-types ──────────────────────────────────────────────────
router.get('/charge-types', async (req, res, next) => {
  try {
    const { data } = await adminSupabase.from('charge_types').select('*').order('sort_order');
    res.json(data || []);
  } catch (err) { next(err); }
});

// ── POST /roster/sync/:periodId ───────────────────────────────────────────────
router.post('/sync/:periodId', requireAgency, async (req, res, next) => {
  // Stream progress as NDJSON lines so the frontend can show real-time status
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Persistent audit trail. Every emit() is pushed into eventBuffer; we
  // flush the row on terminal states (done / error / client-disconnect).
  const eventBuffer = [];
  let syncRunId = null;
  let lastStep  = null;
  const runState = { placements_synced: 0, placements_errors: 0, items_created: 0, placements_total: 0 };

  const emit = (step, data = {}) => {
    const evt = { step, ts: Date.now(), ...data };
    eventBuffer.push(evt);
    lastStep = step;
    try { res.write(JSON.stringify(evt) + '\n'); } catch(_e) {}
  };

  const finalizeRun = async (status, errorMessage = null) => {
    if (!syncRunId) return;
    try {
      await adminSupabase.from('sync_runs').update({
        ended_at: new Date().toISOString(),
        status,
        placements_total:  runState.placements_total,
        placements_synced: runState.placements_synced,
        placements_errors: runState.placements_errors,
        items_created:     runState.items_created,
        last_step:         lastStep,
        error_message:     errorMessage,
        event_count:       eventBuffer.length,
        raw_events:        eventBuffer,
      }).eq('id', syncRunId);
    } catch (e) {
      logger.warn('sync_runs finalize failed', { error: e.message });
    }
  };

  // Heartbeat every 10s so clients (and proxies) know the connection is alive
  // during long Supabase/RAIDO/Carerix awaits.
  const heartbeat = setInterval(() => emit('heartbeat'), 10_000);

  // Client disconnect handling — record the run as cancelled if the stream
  // was closed before we emitted `done`/`error`.
  let didFinalize = false;
  const markFinal = async (status, msg) => {
    if (didFinalize) return;
    didFinalize = true;
    clearInterval(heartbeat);
    await finalizeRun(status, msg);
  };
  res.on('close', () => {
    clearInterval(heartbeat);
    if (!didFinalize) {
      // Fire-and-forget — the socket is gone so we can't await cleanly
      markFinal('cancelled', 'client disconnected before done/error');
    }
  });

  try {
    const { periodId } = req.params;

    // Create the sync_runs row immediately so concurrent syncs are visible.
    try {
      const { data: runRow } = await adminSupabase.from('sync_runs').insert({
        kind: 'roster_sync',
        period_id: periodId,
        triggered_by: req.user?.id || null,
        status: 'running',
      }).select('id').single();
      syncRunId = runRow?.id || null;
    } catch (e) {
      logger.warn('sync_runs insert failed (non-fatal)', { error: e.message });
    }
    emit('sync_run', { id: syncRunId });

    const { data: period } = await adminSupabase.from('payroll_periods').select('*').eq('id', periodId).single();
    if (!period) throw new ApiError('Period not found', 404);
    emit('period', { ref: period.period_ref, from: period.start_date, to: period.end_date });

    const { data: placements } = await adminSupabase
      .from('placements')
      .select('id, placement_ref, full_name, crew_id, crew_nia, carerix_placement_id, carerix_job_id, user_profile_id')
      .not('crew_id', 'is', null);

    if (!placements?.length) {
      emit('done', { synced: 0, errors: 0, results: [] });
      await markFinal('completed');
      res.end();
      return;
    }
    runState.placements_total = placements.length;
    emit('placements', { count: placements.length, names: placements.map(p => p.crew_id) });

    // Auto-match any placements that are missing carerix_job_id
    const needsMatch = (placements || []).filter(p => !p.carerix_job_id);
    if (needsMatch.length > 0) {
      try {
        const { autoMatchPlacementsCarerixIds } = await import('../services/carerix.js');
        const matchResult = await autoMatchPlacementsCarerixIds();
        logger.info('Carerix auto-match', matchResult);
        emit('carerix_match', matchResult);
        // Reload placements so newly matched IDs are available during sync
        if (matchResult.matched > 0) {
          const { data: refreshed } = await adminSupabase
            .from('placements')
            .select('id, placement_ref, full_name, crew_id, crew_nia, carerix_placement_id, carerix_job_id, user_profile_id')
            .not('crew_id', 'is', null);
          placements.splice(0, placements.length, ...(refreshed || []));
        }
      } catch (e) {
        logger.warn('Carerix auto-match failed (non-fatal)', { error: e.message });
      }
    }


    const periodFrom = period.start_date;
    const periodTo   = period.end_date;
    let synced = 0, errors = 0;
    const results = [];

    // Fetch active roles from /crew?RequestData=SpecialRoles once for the whole period
    let rolesMap = {};
    try {
      rolesMap = await fetchActiveRolesForPeriod(periodFrom, periodTo);
      logger.info('Roles fetched', { count: Object.keys(rolesMap).length });
      emit('roles', { count: Object.keys(rolesMap).length, codes: Object.keys(rolesMap) });
    } catch (e) {
      logger.warn('Failed to fetch special roles', { error: e.message });
    }

    // Fetch the full period roster from RAIDO ONCE. RAIDO cannot filter by
    // crew server-side, so fetching per-placement just re-downloads the same
    // payload N times. Share the items across the per-placement loop below.
    let sharedRosterItems = [];
    try {
      const allRosters = await fetchRosters(periodFrom, periodTo);
      sharedRosterItems = rosterItemsList(allRosters);
      logger.info('RAIDO global fetch', { items: sharedRosterItems.length });
      emit('raido_global', { items: sharedRosterItems.length });
    } catch (e) {
      logger.warn('RAIDO global fetch failed (will try per-placement as fallback)', { error: e.message });
      emit('raido_global_error', { error: e.message });
    }

    // Load charge type IDs once
    const { data: chargeTypes } = await adminSupabase.from('charge_types').select('id, code, carerix_type_id');
    const ctByCode = Object.fromEntries((chargeTypes || []).map(ct => [ct.code, ct]));

    // Fetch DateOfEmployment per crew from /crew endpoint once.
    // Used to gate YearsWithClient (≥5 years from that date, per day).
    let doeMap = {};
    try {
      doeMap = await fetchDateOfEmploymentForPeriod(periodFrom, periodTo);
      logger.info('DateOfEmployment fetched', { count: Object.keys(doeMap).length });
      emit('tenure', { count: Object.keys(doeMap).length, codes: Object.keys(doeMap) });
    } catch (e) {
      logger.warn('Failed to fetch DateOfEmployment', { error: e.message });
    }
    const msPerYear = 365.25 * 24 * 3600 * 1000;

    for (const placement of placements) {
      emit('placement_start', { name: placement.full_name, crew_id: placement.crew_id, has_carerix_job: !!placement.carerix_job_id });
      try {
        // Check if sync is locked for this placement/period (company has approved corrections)
        const { data: lockStatus } = await adminSupabase
          .from('roster_period_status')
          .select('sync_locked')
          .eq('placement_id', placement.id)
          .eq('period_id', periodId)
          .maybeSingle();

        if (lockStatus?.sync_locked) {
          results.push({ placement: placement.full_name, days: 0, items: 0, skipped: true, reason: 'sync locked by company approval' });
          synced++;
          continue;
        }

        // Reuse the shared period-level fetch. Fallback to per-crew fetch
        // only if the global fetch failed (sharedRosterItems empty).
        let items = sharedRosterItems;
        if (!items.length) {
          const rosters = await fetchRostersForCrew(periodFrom, periodTo, placement.crew_id);
          items = rosterItemsList(rosters);
        }
        const rows         = mapRosterToRows(items, placement.crew_id, placement.crew_nia);
        const crewSummary  = buildDailySummary(rows).find(c => c.crewId?.toUpperCase() === placement.crew_id?.toUpperCase());

        logger.info('Roster sync', { placement: placement.full_name, rosterRows: rows.length, days: crewSummary?.days?.length || 0 });
        emit('raido', { crew_id: placement.crew_id, rows: rows.length, days: crewSummary?.days?.length || 0 });

        if (!crewSummary?.days?.length) { results.push({ placement: placement.full_name, days: 0, items: 0 }); synced++; continue; }

        // Write back qualification from roster Crew object + active_roles from /crew SpecialRoles API
        const qual       = crewSummary.qualification;
        const rolesFromApi = rolesMap[placement.crew_id?.toUpperCase()] || null;
        logger.info('Roles lookup', {
          placement: placement.full_name,
          crew_id: placement.crew_id,
          rolesFound: rolesFromApi,
          rolesMapKeys: Object.keys(rolesMap),
        });
        const roles      = rolesFromApi || crewSummary.activeRoles || null;
        if (qual || roles) {
          await adminSupabase.from('placements').update({
            ...(qual  ? { qualification: qual }  : {}),
            ...(roles ? { active_roles: roles }  : {}),
          }).eq('id', placement.id);
        }

        let itemsCreated = 0;

        // Fetch live rates from Carerix (if placement has a carerix_job_id).
        // ratesByCode is now { code: [{amount,currency,start,end}, ...] } so the
        // day loop below can pick the rate valid for each specific day.
        let ratesByCode = {};
        if (placement.carerix_job_id) {
          try {
            const carerixRateMap = await fetchCarerixRatesForJob(placement.carerix_job_id, periodFrom);
            // Map carerix_type_id → charge code using chargeTypes
            for (const ct of chargeTypes || []) {
              const rates = ct.carerix_type_id ? carerixRateMap[ct.carerix_type_id] : null;
              if (!rates?.length) continue;
              ratesByCode[ct.code] = rates;
              // Persist the currently-applicable rate (the one covering today)
              // to placement_rates so other code paths keep a simple cache.
              const today = new Date().toISOString().split('T')[0];
              const nowRate = pickRateForDay(rates, today) || rates[0];
              await adminSupabase.from('placement_rates').upsert({
                placement_id: placement.id, charge_type_id: ct.id,
                amount: nowRate.amount, currency: nowRate.currency,
                fetched_at: new Date().toISOString(),
              }, { onConflict: 'placement_id,charge_type_id' });
            }
            logger.info('Rates fetched from Carerix', { placement: placement.full_name, rateCount: Object.keys(ratesByCode).length });
            emit('rates', { crew_id: placement.crew_id, source: 'carerix', rateCount: Object.keys(ratesByCode).length, codes: Object.keys(ratesByCode) });
          } catch (e) {
            logger.warn('Carerix rate fetch failed, using DB fallback', { placement: placement.full_name, error: e.message });
            emit('rates_warn', { crew_id: placement.crew_id, error: e.message });
          }
        }
        // Fallback: load a single amount per code from placement_rates table.
        // Wrap in an array so the per-day lookup still works.
        if (!Object.keys(ratesByCode).length) {
          const { data: storedRates } = await adminSupabase
            .from('placement_rates').select('charge_type_id, amount, currency')
            .eq('placement_id', placement.id);
          for (const r of storedRates || []) {
            const ct = (chargeTypes || []).find(c => c.id === r.charge_type_id);
            if (ct) ratesByCode[ct.code] = [{ amount: Number(r.amount), currency: r.currency, start: null, end: null }];
          }
        }

        // YearsWithClient: tenure-based, per day. Crew earns YWC on a given
        // day only if (day.date - DateOfEmployment) ≥ 5 years. RAIDO's
        // DateOfEmployment from /crew is the source of truth (confirmed via
        // /raido-probe). No local persistence: re-derived every sync.
        const crewKey = placement.crew_id?.toUpperCase();
        const dateOfEmployment = crewKey ? doeMap[crewKey] : null; // 'YYYY-MM-DD' or undefined
        const ywcEligibleForDay = (dayDate) => {
          if (!dateOfEmployment) return false;
          const diffYears = (new Date(dayDate) - new Date(dateOfEmployment)) / msPerYear;
          return diffYears >= 5;
        };
        // Clean slate per sync: wipe ALL charge_items for this placement+
        // period, then re-emit only what the current rules produce (day
        // loop below + Overtime flush after). Keeps the table in sync
        // with rule changes — e.g. PerDiem no longer emitted on PXP days,
        // YWC gated on DateOfEmployment — without accumulating stale rows.
        await adminSupabase.from('charge_items')
          .delete()
          .eq('placement_id', placement.id)
          .eq('period_id', periodId);

        let dayIdx = 0;
        for (const day of crewSummary.days) {
          dayIdx++;
          // Inject YWC quantity on payable days where the crew has already
          // reached 5 years with the client as of this specific day. The
          // crossing day itself is the first eligible day.
          if (day.isPayable && ywcEligibleForDay(day.date)) {
            day.charges = { ...day.charges, YearsWithClient: 1 };
          }
          try {
            // Upsert roster_day. Chain .select() so the call returns a real
            // Promise — wrapping a PostgrestBuilder in Promise.race caused
            // silent no-op writes (the builder's thenable was consumed
            // without triggering fetch).
            const rd = await adminSupabase.from('roster_days').upsert({
              placement_id: placement.id, period_id: periodId, roster_date: day.date,
              crew_id: placement.crew_id, crew_nia: placement.crew_nia,
              activities: day.activities, is_payable: day.isPayable,
              has_ground: day.hasGround, has_sim: day.hasSim, has_pxp: day.hasPxp,
              sold_off: day.soldOff, bod: day.bod, fetched_at: new Date().toISOString(),
            }, { onConflict: 'placement_id,period_id,roster_date' }).select('id').limit(1);
            if (rd?.error) throw new Error(`roster_days ${day.date}: ${rd.error.message}`);

            for (const [chargeCode, qty] of Object.entries(day.charges || {})) {
              if (!qty) continue;
              const ct = ctByCode[chargeCode];
              if (!ct) continue;
              const rateRow  = pickRateForDay(ratesByCode[chargeCode], day.date);
              const rate     = rateRow?.amount ?? null;
              const currency = rateRow?.currency ?? 'USD';
              const total    = rate != null ? Math.round(qty * rate * 100) / 100 : null;
              const ci = await adminSupabase.from('charge_items').upsert({
                placement_id: placement.id, period_id: periodId,
                charge_type_id: ct.id, charge_date: day.date,
                quantity: qty, rate_per_unit: rate, currency, total_amount: total, status: 'confirmed',
              }, { onConflict: 'placement_id,charge_date,charge_type_id' }).select('id').limit(1);
              if (ci?.error) throw new Error(`charge_items ${day.date}/${chargeCode}: ${ci.error.message}`);
              itemsCreated++;
            }
          } catch (dayErr) {
            emit('day_error', { crew_id: placement.crew_id, date: day.date, error: dayErr.message });
            throw dayErr;
          }

          // Progress ping every 5 days so the client sees forward motion
          if (dayIdx % 5 === 0 || dayIdx === crewSummary.days.length) {
            emit('placement_progress', {
              crew_id: placement.crew_id,
              dayIdx, totalDays: crewSummary.days.length,
              lastDate: day.date, itemsSoFar: itemsCreated,
            });
          }
        }

        results.push({ placement: placement.full_name, days: crewSummary.days.length, items: itemsCreated });
        emit('placement_done', { name: placement.full_name, crew_id: placement.crew_id, days: crewSummary.days.length, items: itemsCreated });
        synced++;
        runState.items_created += itemsCreated;

        // Compute and write Overtime charge items for rotations exceeding 65h BLH
        // Rotation = consecutive payable days; OT = (total flight BLH - 65) per rotation
        const hhmmToDec = (h) => { const p = (h||'').split(':'); return p.length===2?parseInt(p[0])+parseInt(p[1])/60:0; };
        const otCt = ctByCode['Overtime'];
        if (otCt) {
          let rotBLH = 0, rotStart = null, rotEndDay = null;
          const flushRotation = async (endDate) => {
            if (rotBLH > 65 && endDate) {
              const otQty = Math.round((rotBLH - 65) * 100) / 100;
              await adminSupabase.from('charge_items').upsert({
                placement_id: placement.id, period_id: periodId,
                charge_type_id: otCt.id, charge_date: endDate,
                quantity: otQty, rate_amount: null, currency: 'USD', total_value: null, status: 'confirmed',
              }, { onConflict: 'placement_id,charge_date,charge_type_id', returning: 'minimal' });
            }
          };
          for (const day of crewSummary.days) {
            if (day.isPayable) {
              if (!rotStart) rotStart = day.date;
              rotEndDay = day.date;
              const acts = Array.isArray(day.activities) ? day.activities : [];
              for (const a of acts) {
                if (a?.aBLH && a.ActivityType?.toUpperCase() === 'FLIGHT') rotBLH += hhmmToDec(a.aBLH);
              }
            } else if (rotStart) {
              await flushRotation(rotEndDay);
              rotBLH = 0; rotStart = null; rotEndDay = null;
            }
          }
          if (rotStart) await flushRotation(rotEndDay); // rotation reaching end of period
        }
      } catch (e) {
        logger.error('Sync error', { placement: placement.full_name, error: e.message });
        emit('placement_error', { name: placement.full_name, crew_id: placement.crew_id, error: e.message });
        errors++;
      }
    }

    runState.placements_synced = synced;
    runState.placements_errors = errors;
    emit('done', { message: 'Sync complete', synced, errors, results });
    await markFinal(errors > 0 ? 'completed' : 'completed');
    res.end();
  } catch (err) {
    try { emit('error', { message: err.message }); } catch(_) {}
    await markFinal('failed', err.message);
    try { res.end(); } catch(_) { next(err); }
  }
});

// ── GET /roster/summary/:periodId ─────────────────────────────────────────────
router.get('/summary/:periodId', async (req, res, next) => {
  try {
    const { periodId } = req.params;
    const { user }     = req;

    // Determine which placements to show
    let placementIds = null; // null = no filter (agency sees all)

    if (user.role === 'placement') {
      const { data: p } = await adminSupabase.from('placements').select('id').eq('user_profile_id', user.id).maybeSingle();
      if (!p) return res.json({ placements: [] });
      placementIds = [p.id];
    } else if (user.role === 'company_admin' || user.role === 'company_user') {
      const { data: company } = await adminSupabase.from('companies').select('id').eq('carerix_company_id', user.carerix_company_id).maybeSingle();
      if (!company) return res.json({ placements: [] });
      const { data: plist } = await adminSupabase.from('placements').select('id').eq('company_id', company.id);
      if (!plist?.length) return res.json({ placements: [] });
      placementIds = plist.map(p => p.id);
    }

    // Fetch charge items
    let q = adminSupabase
      .from('charge_items')
      .select('placement_id, charge_type_id, charge_date, quantity, rate_amount, currency, total_value, status, charge_types(code, label, sort_order)')
      .eq('period_id', periodId)
      .order('charge_date');

    if (placementIds) q = q.in('placement_id', placementIds);

    const { data: items, error } = await q;
    logger.info('Summary query', { periodId, role: user.role, placementIds, count: items?.length, error: error?.message });
    if (error) throw new ApiError(error.message);

    // Fetch all placements in scope (even those with no charges yet)
    let allPlacements = [];
    if (placementIds) {
      const { data: ps } = await adminSupabase.from('placements').select('id, full_name, crew_id').in('id', placementIds);
      allPlacements = ps || [];
    } else {
      // Agency: get all placements that have charge items this period
      const pids = [...new Set((items || []).map(i => i.placement_id))];
      if (pids.length) {
        const { data: ps } = await adminSupabase.from('placements').select('id, full_name, crew_id').in('id', pids);
        allPlacements = ps || [];
      }
    }
    const placementMap = Object.fromEntries(allPlacements.map(p => [p.id, p]));

    // Seed byPlacement with all placements (so zero-charge placements still appear)
    const byPlacement = new Map();
    for (const pl of allPlacements) {
      byPlacement.set(pl.id, { placementId: pl.id, displayName: pl.full_name || '', crewId: pl.crew_id || null, chargeTypes: new Map(), totalValue: 0, currency: 'USD' });
    }

    // Fill in charge items
    for (const item of items || []) {
      const pid = item.placement_id;
      if (!byPlacement.has(pid)) {
        const pl = placementMap[pid];
        byPlacement.set(pid, { placementId: pid, displayName: pl?.full_name || 'Unknown', crewId: pl?.crew_id || null, chargeTypes: new Map(), totalValue: 0, currency: item.currency });
      }
      const p = byPlacement.get(pid);
      const code = item.charge_types?.code;
      if (!p.chargeTypes.has(code)) {
        p.chargeTypes.set(code, { code, label: item.charge_types?.label, quantity: 0, totalValue: 0, currency: item.currency });
      }
      const ct = p.chargeTypes.get(code);
      ct.quantity   += Number(item.quantity   || 0);
      ct.totalValue += Number(item.total_value || 0);
      p.totalValue  += Number(item.total_value || 0);
    }

    res.json({ placements: Array.from(byPlacement.values()).map(p => ({ ...p, chargeTypes: Array.from(p.chargeTypes.values()) })) });
  } catch (err) { next(err); }
});

// ── GET /roster/daily/:periodId/:placementId ──────────────────────────────────
router.get('/daily/:periodId/:placementId', async (req, res, next) => {
  try {
    const { periodId, placementId } = req.params;

    if (req.user.role === 'placement') {
      const { data: p } = await adminSupabase.from('placements').select('id').eq('user_profile_id', req.user.id).maybeSingle();
      if (!p || p.id !== placementId) throw new ApiError('Access denied', 403);
    }

    const { data: items } = await adminSupabase
      .from('charge_items')
      .select('*, charge_types(code, label, sort_order)')
      .eq('period_id', periodId)
      .eq('placement_id', placementId)
      .order('charge_date');

    const { data: corrections } = await adminSupabase
      .from('charge_corrections')
      .select('*, charge_types(code, label)')
      .eq('period_id', periodId)
      .eq('placement_id', placementId);

    const byDate = new Map();
    for (const item of items || []) {
      if (!byDate.has(item.charge_date)) byDate.set(item.charge_date, { date: item.charge_date, charges: [], totalValue: 0 });
      const d = byDate.get(item.charge_date);
      d.charges.push(item);
      d.totalValue += Number(item.total_value || 0);
    }

    res.json({ days: Array.from(byDate.values()), corrections: corrections || [] });
  } catch (err) { next(err); }
});

// ── POST /roster/correction ───────────────────────────────────────────────────
router.post('/correction', async (req, res, next) => {
  try {
    const { periodId, correctionDate, chargeTypeId, reason } = req.body;
    if (!periodId || !correctionDate || !reason) throw new ApiError('periodId, correctionDate and reason are required', 400);

    const { data: placement } = await adminSupabase.from('placements').select('id').eq('user_profile_id', req.user.id).maybeSingle();
    if (!placement) throw new ApiError('No placement found for this user', 404);

    const { data, error } = await adminSupabase.from('charge_corrections').insert({
      placement_id: placement.id, period_id: periodId, correction_date: correctionDate,
      charge_type_id: chargeTypeId || null, reason, status: 'pending', requested_by: req.user.id,
    }).select().single();

    if (error) throw new ApiError(error.message);
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// ── GET /roster/corrections/:periodId ─────────────────────────────────────────
router.get('/corrections/:periodId?', requireCompanyOrAbove, async (req, res, next) => {
  try {
    // Company admin sees only their placements' corrections
    let query = adminSupabase
      .from('charge_corrections')
      .select('*, charge_types(code, label), placements(full_name), payroll_periods(period_ref)')
      .order('created_at', { ascending: false });

    if (req.params.periodId) query = query.eq('period_id', req.params.periodId);

    if (req.user.role === 'company_admin' || req.user.role === 'company_user') {
      const { data: company } = await adminSupabase
        .from('companies').select('id').eq('carerix_company_id', req.user.carerix_company_id).maybeSingle();
      if (!company) return res.json([]);
      const { data: plist } = await adminSupabase.from('placements').select('id').eq('company_id', company.id);
      const pids = (plist || []).map(p => p.id);
      if (!pids.length) return res.json([]);
      query = query.in('placement_id', pids);
    }

    const { data, error } = await query;
    if (error) throw new ApiError(error.message);
    res.json(data || []);
  } catch (err) { next(err); }
});

// ── PATCH /roster/correction/:id ──────────────────────────────────────────────
router.patch('/correction/:id', requireCompanyOrAbove, async (req, res, next) => {
  try {
    const { status, reviewNote } = req.body;
    if (!['approved', 'rejected'].includes(status)) throw new ApiError('status must be approved or rejected', 400);
    const { data, error } = await adminSupabase
      .from('charge_corrections')
      .update({ status, review_note: reviewNote, reviewed_by: req.user.id, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw new ApiError(error.message);
    res.json(data);
  } catch (err) { next(err); }
});


// ── GET /roster/placement/:periodId ─────────────────────────────────────────
// Full day-by-day activity view — fetches live from RAIDO for open periods,
// reads from DB for closed/completed periods (payroll frozen).
router.get('/placement/:periodId', async (req, res, next) => {
  try {
    const { periodId } = req.params;
    const { user }     = req;

    // Resolve placement
    let placement;
    if (user.role === 'placement') {
      const { data: p } = await adminSupabase
        .from('placements')
        .select('id, crew_id, crew_nia, full_name')
        .eq('user_profile_id', user.id)
        .maybeSingle();
      if (!p) return res.json({ days: [], source: 'none' });
      placement = p;
    } else {
      // Agency/company: pass ?placement_id=xxx
      const pid = req.query.placement_id;
      if (!pid) return res.status(400).json({ error: 'placement_id required' });
      const { data: p } = await adminSupabase
        .from('placements')
        .select('id, crew_id, crew_nia, full_name')
        .eq('id', pid)
        .maybeSingle();
      if (!p) return res.json({ days: [], source: 'none' });
      placement = p;
    }

    const { data: period } = await adminSupabase
      .from('payroll_periods').select('*').eq('id', periodId).single();
    if (!period) return res.json({ days: [], source: 'none' });

    const today    = new Date();
    const isOpen   = period.status === 'open';
    const periodEnd = new Date(period.end_date);
    // Cap RAIDO end date to today (API rejects future dates)
    const raidoTo  = periodEnd > today
      ? today.toISOString().split('T')[0]
      : period.end_date;

    let rosterDayMap = {};
    let source = 'db';

    // For open periods with a crew_id, fetch live from RAIDO
    if (isOpen && placement.crew_id) {
      try {
        const rosters = await fetchRostersForCrew(period.start_date, raidoTo, placement.crew_id);
        const items   = rosterItemsList(rosters);
        const rows    = mapRosterToRows(items, placement.crew_id, placement.crew_nia);

        logger.info('Placement RAIDO fetch', {
          crew_id: placement.crew_id, items: items.length, rows: rows.length
        });

        // buildDailySummary returns [{crewId, days:[{date,isPayable,activities,charges,...}]}]
        const crewSummaries = buildDailySummary(rows);
        const crewSummary   = crewSummaries.find(c =>
          c.crewId?.toUpperCase() === placement.crew_id?.toUpperCase()
        ) || crewSummaries[0];

        // Load charge type IDs for DB persistence
        const { data: chargeTypes } = await adminSupabase
          .from('charge_types').select('id, code');
        const ctByCode = Object.fromEntries((chargeTypes || []).map(ct => [ct.code, ct]));

        for (const day of (crewSummary?.days || [])) {
          const activities = (day.activities || []).map(r => ({
            ActivityCode:    r.ActivityCode,
            ActivityType:    r.ActivityType,
            ActivitySubType: r.ActivitySubType,
            start_activity:  r.start_activity,
            end_activity:    r.end_activity,
            aBLH:            r.aBLH ?? null,
            Designator:      r.Designator,
          }));

          rosterDayMap[day.date] = {
            activities,
            isPayable: day.isPayable || false,
            charges:   day.charges   || {},
          };

          // Persist to DB (overwrite — period is open)
          await adminSupabase.from('roster_days').upsert({
            placement_id: placement.id, period_id: periodId, roster_date: day.date,
            crew_id: placement.crew_id, crew_nia: placement.crew_nia,
            activities, is_payable: day.isPayable || false,
            has_ground: day.hasGround || false, has_sim: day.hasSim || false,
            sold_off: day.soldOff || false, bod: day.bod || false,
            fetched_at: new Date().toISOString(),
          }, { onConflict: 'placement_id,roster_date', returning: 'minimal' });

          // Upsert charge items
          for (const [code, qty] of Object.entries(day.charges || {})) {
            if (!qty) continue;
            const ct = ctByCode[code];
            if (!ct) continue;
            await adminSupabase.from('charge_items').upsert({
              placement_id: placement.id, period_id: periodId,
              charge_type_id: ct.id, charge_date: day.date,
              quantity: qty, rate_amount: null, currency: 'USD',
              total_value: null, status: 'confirmed',
            }, { onConflict: 'placement_id,charge_date,charge_type_id', returning: 'minimal' });
          }
        }
        source = 'raido';
      } catch (raidoErr) {
        logger.warn('RAIDO fetch failed, falling back to DB', { error: raidoErr.message });
      }
    }

    // Always fall back to DB for closed periods or RAIDO failures
    if (source === 'db' || Object.keys(rosterDayMap).length === 0) {
      const { data: rosterDays } = await adminSupabase
        .from('roster_days')
        .select('roster_date, activities, is_payable')
        .eq('placement_id', placement.id)
        .eq('period_id', periodId)
        .order('roster_date');

      const { data: chargeItems } = await adminSupabase
        .from('charge_items')
        .select('charge_date, quantity, charge_types(code)')
        .eq('placement_id', placement.id)
        .eq('period_id', periodId);

      const chargeByDate = {};
      for (const ci of chargeItems || []) {
        if (!chargeByDate[ci.charge_date]) chargeByDate[ci.charge_date] = {};
        chargeByDate[ci.charge_date][ci.charge_types?.code] = Number(ci.quantity || 0);
      }

      for (const rd of rosterDays || []) {
        rosterDayMap[rd.roster_date] = {
          activities: rd.activities || [],
          isPayable:  rd.is_payable || false,
          charges:    chargeByDate[rd.roster_date] || {},
        };
      }
    }

    // Build full month calendar
    const days = [];
    const start = new Date(period.start_date);
    const end   = new Date(period.end_date);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr  = d.toISOString().split('T')[0];
      const rd       = rosterDayMap[dateStr];
      const isFuture = d > today;

      days.push({
        date:       dateStr,
        isFuture,
        isPayable:  rd?.isPayable || false,
        activities: rd?.activities || [],
        charges:    rd?.charges || {},
      });
    }

    res.json({ days, period, source });
  } catch (err) { next(err); }
});

export default router;
