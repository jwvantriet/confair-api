/**
 * Diagnostics endpoint — tests every component of the sync pipeline
 * GET /diagnostics/sync-test/:periodId
 * Returns a full report of each step, pass/fail, and data counts
 */
import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { fetchRosters, rosterItemsList, mapRosterToRows, buildDailySummary } from '../services/raido.js';

const router = Router();
router.use(requireAuth);
router.use(requireAgency);

router.get('/sync-test/:periodId', async (req, res) => {
  const report = { steps: [], passed: 0, failed: 0, ts: new Date().toISOString() };
  const add = (name, ok, detail) => {
    report.steps.push({ name, ok, detail });
    if (ok) report.passed++; else report.failed++;
  };

  try {
    const { periodId } = req.params;

    // ── Step 1: Period exists ─────────────────────────────────────────────────
    const { data: period, error: pe } = await adminSupabase
      .from('payroll_periods').select('*').eq('id', periodId).single();
    if (pe || !period) { add('Period lookup', false, pe?.message || 'Not found'); return res.json(report); }
    add('Period lookup', true, `${period.period_ref} | ${period.start_date} → ${period.end_date}`);

    // ── Step 2: Placements with crew_id ───────────────────────────────────────
    const { data: placements, error: ple } = await adminSupabase
      .from('placements').select('id, crew_id, crew_nia, full_name').not('crew_id', 'is', null);
    if (ple) { add('Placements lookup', false, ple.message); return res.json(report); }
    add('Placements lookup', true, `${placements.length} placements with crew_id: ${placements.map(p => p.crew_id).join(', ')}`);

    // ── Step 3: Charge types ──────────────────────────────────────────────────
    const { data: chargeTypes, error: cte } = await adminSupabase
      .from('charge_types').select('id, code');
    if (cte) { add('Charge types lookup', false, cte.message); return res.json(report); }
    add('Charge types lookup', true, `${chargeTypes.length} types: ${chargeTypes.map(c => c.code).join(', ')}`);
    const ctByCode = Object.fromEntries(chargeTypes.map(ct => [ct.code, ct]));

    // ── Step 4: RAIDO fetch ───────────────────────────────────────────────────
    const today = new Date().toISOString().split('T')[0];
    const safeTo = period.end_date < today ? period.end_date : today;
    let rosters, allItems;
    try {
      rosters  = await fetchRosters(period.start_date, safeTo);
      allItems = rosterItemsList(rosters);
      const isArray = Array.isArray(rosters);
      const msg = rosters?.message || null;
      const raidoError = rosters?._raidoError;
      add('RAIDO fetch', allItems.length > 0,
        raidoError ? `RAIDO ERROR status=${rosters.status} msg=${rosters.message} body=${JSON.stringify(rosters.body)}` :
        msg ? `RAIDO message: ${msg}` :
        `${allItems.length} crew items | type=${isArray ? 'array' : typeof rosters} | from=${period.start_date} to=${safeTo}`
      );
      if (allItems.length === 0) return res.json(report);
    } catch (e) {
      add('RAIDO fetch', false, e.message);
      return res.json(report);
    }

    // ── Step 5: Per-placement mapping ────────────────────────────────────────
    for (const placement of placements) {
      const rows      = mapRosterToRows(allItems, placement.crew_id, placement.crew_nia);
      const summaries = buildDailySummary(rows);
      const crew      = summaries.find(c => c.crewId?.toUpperCase() === placement.crew_id?.toUpperCase()) || summaries[0];
      const days      = crew?.days || [];
      const payable   = days.filter(d => d.isPayable).length;
      const charges   = days.reduce((acc, d) => {
        Object.entries(d.charges || {}).forEach(([k,v]) => { acc[k] = (acc[k]||0) + v; });
        return acc;
      }, {});

      add(`Mapping: ${placement.crew_id}`, rows.length > 0,
        `rows=${rows.length} | summaries=${summaries.length} | days=${days.length} | payable=${payable} | charges=${JSON.stringify(charges)}`
      );

      if (rows.length === 0) continue;

      // ── Step 6: Try a single roster_days upsert ───────────────────────────
      if (days.length > 0) {
        const testDay = days[0];
        const { error: rde } = await adminSupabase.from('roster_days').upsert({
          placement_id: placement.id, period_id: periodId,
          roster_date: testDay.date, crew_id: placement.crew_id, crew_nia: placement.crew_nia,
          activities: testDay.activities.map(a => ({
            ActivityCode: a.ActivityCode, ActivityType: a.ActivityType,
            ActivitySubType: a.ActivitySubType, start_activity: a.start_activity,
            end_activity: a.end_activity, aBLH: a.aBLH ?? null,
          })),
          is_payable: testDay.isPayable || false, fetched_at: new Date().toISOString(),
        }, { onConflict: 'placement_id,period_id,roster_date', returning: 'minimal' });
        add(`roster_days upsert: ${placement.crew_id} day=${testDay.date}`, !rde, rde?.message || 'OK');
      }

      // ── Step 7: Try a single charge_items upsert ─────────────────────────
      const chargeDay = days.find(d => Object.keys(d.charges || {}).length > 0);
      if (chargeDay) {
        const [code, qty] = Object.entries(chargeDay.charges)[0];
        const ct = ctByCode[code];
        if (ct) {
          const { error: cie } = await adminSupabase.from('charge_items').upsert({
            placement_id: placement.id, period_id: periodId,
            charge_type_id: ct.id, charge_date: chargeDay.date,
            quantity: qty, currency: 'USD', status: 'draft',
          }, { onConflict: 'placement_id,charge_date,charge_type_id', returning: 'minimal' });
          add(`charge_items upsert: ${placement.crew_id} ${code}`, !cie, cie?.message || 'OK');
        } else {
          add(`charge_items upsert: ${placement.crew_id} ${code}`, false, `charge_type '${code}' not found in DB`);
        }
      } else {
        add(`charge_items: ${placement.crew_id}`, true, 'No payable days — no charges to write (OK)');
      }
    }

    // ── Step 8: DB state after test ───────────────────────────────────────────
    const { count: rdCount } = await adminSupabase.from('roster_days').select('*', { count: 'exact', head: true }).eq('period_id', periodId);
    const { count: ciCount } = await adminSupabase.from('charge_items').select('*', { count: 'exact', head: true }).eq('period_id', periodId);
    add('DB state after test', true, `roster_days=${rdCount} | charge_items=${ciCount}`);

    res.json(report);
  } catch (err) {
    report.steps.push({ name: 'Unexpected error', ok: false, detail: err.message });
    report.failed++;
    res.status(500).json(report);
  }
});

export default router;
