/**
 * Background roster-sync service.
 *
 * The HTTP route at POST /roster/sync/:periodId returns a sync_run id
 * immediately and kicks off `runRosterSync` in the background. Progress
 * events are buffered in memory and flushed to `sync_runs.raw_events`
 * every N events or M seconds, so the frontend can poll for status
 * via GET /roster/sync-runs/:syncRunId without holding a long-lived
 * connection (which Vercel's function lifetime would kill).
 *
 * Extracted from src/routes/roster.js so the route handler can stay thin.
 */

import { adminSupabase } from './supabase.js';
import {
  fetchRosters, rosterItemsList, mapRosterToRows, buildDailySummary,
  fetchActiveRolesForPeriod, fetchDateOfEmploymentForPeriod, fetchRostersForCrew,
} from './raido.js';
import { recomputePlacementRotations } from './rotations.js';
import { isPlacementActiveInPeriod } from './access.js';
import { logger } from '../utils/logger.js';

const FLUSH_EVERY_EVENTS = 10;
const FLUSH_EVERY_MS     = 3_000;
const MAX_BUFFERED_EVENTS = 5_000;

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
 * Returns rates grouped by Carerix kind dataNodeID. Keys are strings — the
 * caller stringifies its lookup key so types match.
 *
 * Also returns a `_debug` shape (totalItems, kept, dropped) so callers can
 * surface why a particular job ended up with empty rates.
 */
async function fetchCarerixRatesForJob(carerixJobId, periodFrom = null) {
  const debug = {
    totalItems:        0,
    droppedNoFinance:  0,
    droppedExpired:    0,
    droppedNoKindId:   0,
    droppedNoAmount:   0,
    kept:              0,
    error:             null,
  };
  try {
    const { queryGraphQL } = await import('./carerix.js');
    const result = await queryGraphQL(`
      query JobFinancePage($qualifier: String, $pageable: Pageable) {
        crJobFinancePage(qualifier: $qualifier, pageable: $pageable) {
          items {
            _id
            toFinance {
              _id amount startDate endDate
              toKindNode { dataNodeID value }
              toCurrencyNode { dataNodeID value }
              toTypeNode { typeID }
            }
          }
        }
      }
    `, {
      qualifier: 'toJob.jobID == ' + parseInt(carerixJobId, 10),
      pageable: { page: 0, size: 100 },
    });

    const items = result?.data?.crJobFinancePage?.items || [];
    debug.totalItems = items.length;

    const rateMap = {};
    for (const item of items) {
      const finance = item?.toFinance;
      if (!finance) { debug.droppedNoFinance++; continue; }
      const start = finance.startDate ? String(finance.startDate).split('T')[0] : null;
      const end   = finance.endDate   ? String(finance.endDate).split('T')[0]   : null;
      if (periodFrom && end && end < periodFrom) { debug.droppedExpired++; continue; }
      const kindId = finance.toKindNode?.dataNodeID;
      if (kindId == null) { debug.droppedNoKindId++; continue; }
      const amount = finance.amount != null ? Number(finance.amount) : null;
      if (amount == null) { debug.droppedNoAmount++; continue; }
      const currency = normalizeCurrency((finance.toCurrencyNode?.value || '').trim());
      // Stringify the key so caller's lookup (which also stringifies via
      // implicit coercion) is guaranteed to match.
      const key = String(kindId);
      if (!rateMap[key]) rateMap[key] = [];
      rateMap[key].push({ amount, currency, start, end });
      debug.kept++;
    }
    for (const k of Object.keys(rateMap)) {
      rateMap[k].sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    }
    return { rateMap, debug };
  } catch (err) {
    logger.warn('fetchCarerixRatesForJob failed', { carerixJobId, error: err.message });
    debug.error = err.message;
    return { rateMap: {}, debug };
  }
}

function pickRateForDay(rates, dayDate) {
  if (!rates?.length) return null;
  const covering = rates.find(r =>
    (!r.start || r.start <= dayDate) &&
    (!r.end   || r.end   >= dayDate)
  );
  if (covering) return covering;
  return rates[rates.length - 1];
}

export async function runRosterSync({ periodId, syncRunId }) {
  const eventBuffer = [];
  let lastStep     = null;
  let lastFlush    = Date.now();
  const runState = {
    placements_total:  0,
    placements_synced: 0,
    placements_errors: 0,
    items_created:     0,
  };

  const flush = async (extra = {}) => {
    lastFlush = Date.now();
    try {
      const persisted = eventBuffer.length > MAX_BUFFERED_EVENTS
        ? eventBuffer.slice(-MAX_BUFFERED_EVENTS)
        : eventBuffer;
      await adminSupabase.from('sync_runs').update({
        last_step:         lastStep,
        placements_total:  runState.placements_total,
        placements_synced: runState.placements_synced,
        placements_errors: runState.placements_errors,
        items_created:     runState.items_created,
        event_count:       eventBuffer.length,
        raw_events:        persisted,
        ...extra,
      }).eq('id', syncRunId);
    } catch (e) {
      logger.warn('sync_runs flush failed (continuing)', { syncRunId, error: e.message });
    }
  };

  const emit = (step, data = {}) => {
    const evt = { step, ts: Date.now(), ...data };
    eventBuffer.push(evt);
    lastStep = step;
    if (
      eventBuffer.length % FLUSH_EVERY_EVENTS === 0 ||
      Date.now() - lastFlush > FLUSH_EVERY_MS
    ) {
      void flush();
    }
  };

  try {
    emit('sync_run', { id: syncRunId });

    const { data: period } = await adminSupabase
      .from('payroll_periods').select('*').eq('id', periodId).single();
    if (!period) throw new Error('Period not found');
    emit('period', { ref: period.period_ref, from: period.start_date, to: period.end_date });

    const { data: allPlacementsForSync } = await adminSupabase
      .from('placements')
      .select('id, placement_ref, full_name, crew_id, crew_nia, carerix_placement_id, carerix_job_id, user_profile_id, start_date, end_date')
      .not('crew_id', 'is', null);

    const placements = (allPlacementsForSync || []).filter(p => isPlacementActiveInPeriod(p, period));
    if (!placements?.length) {
      emit('done', { synced: 0, errors: 0, results: [] });
      await flush({ status: 'completed', ended_at: new Date().toISOString() });
      return;
    }
    runState.placements_total = placements.length;
    emit('placements', { count: placements.length, names: placements.map(p => p.crew_id) });

    const needsMatch = placements.filter(p => !p.carerix_job_id);
    if (needsMatch.length > 0) {
      try {
        const { autoMatchPlacementsCarerixIds } = await import('./carerix.js');
        const matchResult = await autoMatchPlacementsCarerixIds();
        emit('carerix_match', matchResult);
        if (matchResult.matched > 0) {
          const { data: refreshed } = await adminSupabase
            .from('placements')
            .select('id, placement_ref, full_name, crew_id, crew_nia, carerix_placement_id, carerix_job_id, user_profile_id, start_date, end_date')
            .not('crew_id', 'is', null);
          const active = (refreshed || []).filter(p => isPlacementActiveInPeriod(p, period));
          placements.splice(0, placements.length, ...active);
        }
      } catch (e) {
        logger.warn('Carerix auto-match failed (non-fatal)', { error: e.message });
      }
    }

    const periodFrom = period.start_date;
    const periodTo   = period.end_date;

    let rolesMap = {};
    try {
      rolesMap = await fetchActiveRolesForPeriod(periodFrom, periodTo);
      emit('roles', { count: Object.keys(rolesMap).length, codes: Object.keys(rolesMap) });
    } catch (e) {
      logger.warn('Failed to fetch special roles', { error: e.message });
    }

    let sharedRosterItems = [];
    try {
      const allRosters = await fetchRosters(periodFrom, periodTo);
      sharedRosterItems = rosterItemsList(allRosters);
      emit('raido_global', { items: sharedRosterItems.length });
    } catch (e) {
      logger.warn('RAIDO global fetch failed (will try per-placement as fallback)', { error: e.message });
      emit('raido_global_error', { error: e.message });
    }

    const { data: chargeTypes } = await adminSupabase.from('charge_types').select('id, code, carerix_type_id');
    const ctByCode = Object.fromEntries((chargeTypes || []).map(ct => [ct.code, ct]));

    // One-time at the top of the sync: emit what charge_types looks like
    // server-side. If carerix_type_id values are missing or wrong here,
    // every per-placement rates lookup will produce 0.
    emit('charge_types_loaded', {
      count: chargeTypes?.length ?? 0,
      codes: (chargeTypes || []).map(ct => ({
        code:            ct.code,
        carerix_type_id: ct.carerix_type_id,
        type:            typeof ct.carerix_type_id,
      })),
    });

    let doeMap = {};
    try {
      doeMap = await fetchDateOfEmploymentForPeriod(periodFrom, periodTo);
      emit('tenure', { count: Object.keys(doeMap).length, codes: Object.keys(doeMap) });
    } catch (e) {
      logger.warn('Failed to fetch DateOfEmployment', { error: e.message });
    }
    const msPerYear = 365.25 * 24 * 3600 * 1000;

    let synced = 0, errors = 0;
    const results = [];

    for (const placement of placements) {
      emit('placement_start', { name: placement.full_name, crew_id: placement.crew_id, has_carerix_job: !!placement.carerix_job_id });
      try {
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

        let items = sharedRosterItems;
        if (!items.length) {
          const rosters = await fetchRostersForCrew(periodFrom, periodTo, placement.crew_id);
          items = rosterItemsList(rosters);
        }
        const rows         = mapRosterToRows(items, placement.crew_id, placement.crew_nia);
        const crewSummary  = buildDailySummary(rows).find(c => c.crewId?.toUpperCase() === placement.crew_id?.toUpperCase());
        emit('raido', { crew_id: placement.crew_id, rows: rows.length, days: crewSummary?.days?.length || 0 });

        if (!crewSummary?.days?.length) { results.push({ placement: placement.full_name, days: 0, items: 0 }); synced++; continue; }

        const qual         = crewSummary.qualification;
        const rolesFromApi = rolesMap[placement.crew_id?.toUpperCase()] || null;
        const roles        = rolesFromApi || crewSummary.activeRoles || null;
        if (qual || roles) {
          await adminSupabase.from('placements').update({
            ...(qual  ? { qualification: qual }  : {}),
            ...(roles ? { active_roles: roles }  : {}),
          }).eq('id', placement.id);
        }

        let itemsCreated = 0;
        let ratesByCode = {};
        if (placement.carerix_job_id) {
          try {
            const { rateMap: carerixRateMap, debug: rateDebug } =
              await fetchCarerixRatesForJob(placement.carerix_job_id, periodFrom);

            const rateMapKeys = Object.keys(carerixRateMap);

            for (const ct of chargeTypes || []) {
              const lookupKey = ct.carerix_type_id != null ? String(ct.carerix_type_id) : null;
              const rates     = lookupKey ? carerixRateMap[lookupKey] : null;
              if (!rates?.length) continue;
              ratesByCode[ct.code] = rates;
              const today = new Date().toISOString().split('T')[0];
              const nowRate = pickRateForDay(rates, today) || rates[0];
              await adminSupabase.from('placement_rates').upsert({
                placement_id: placement.id, charge_type_id: ct.id,
                amount: nowRate.amount, currency: nowRate.currency,
                fetched_at: new Date().toISOString(),
              }, { onConflict: 'placement_id,charge_type_id' });
            }

            // Diagnostic — surfaces *why* the mapping produced 0 codes.
            // Safe to leave on; payload is small.
            emit('rates_debug', {
              crew_id:            placement.crew_id,
              carerix_job_id:     placement.carerix_job_id,
              fetch:              rateDebug,
              rateMapKeys,
              chargeTypeIds:      (chargeTypes || []).map(ct => ({
                code:            ct.code,
                carerix_type_id: ct.carerix_type_id,
              })),
              matched:            Object.keys(ratesByCode),
            });

            emit('rates', {
              crew_id:    placement.crew_id,
              source:     'carerix',
              rateCount:  Object.keys(ratesByCode).length,
              codes:      Object.keys(ratesByCode),
            });
          } catch (e) {
            logger.warn('Carerix rate fetch failed, using DB fallback', { error: e.message });
            emit('rates_warn', { crew_id: placement.crew_id, error: e.message });
          }
        } else {
          emit('rates_skip', { crew_id: placement.crew_id, reason: 'no carerix_job_id' });
        }
        if (!Object.keys(ratesByCode).length) {
          const { data: storedRates } = await adminSupabase
            .from('placement_rates').select('charge_type_id, amount, currency')
            .eq('placement_id', placement.id);
          for (const r of storedRates || []) {
            const ct = (chargeTypes || []).find(c => c.id === r.charge_type_id);
            if (ct) ratesByCode[ct.code] = [{ amount: Number(r.amount), currency: r.currency, start: null, end: null }];
          }
        }

        const crewKey = placement.crew_id?.toUpperCase();
        const dateOfEmployment = crewKey ? doeMap[crewKey] : null;
        const ywcEligibleForDay = (dayDate) => {
          if (!dateOfEmployment) return false;
          const diffYears = (new Date(dayDate) - new Date(dateOfEmployment)) / msPerYear;
          return diffYears >= 5;
        };

        await adminSupabase.from('charge_items')
          .delete()
          .eq('placement_id', placement.id)
          .eq('period_id', periodId);

        let dayIdx = 0;
        for (const day of crewSummary.days) {
          dayIdx++;
          if (day.isPayable && ywcEligibleForDay(day.date)) {
            day.charges = { ...day.charges, YearsWithClient: 1 };
          }
          try {
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
        runState.placements_synced = synced;

        const otCt = ctByCode['Overtime'];
        try {
          const { wrote } = await recomputePlacementRotations(placement.id, { lookbackMonths: 4 });
          emit('rotations', { crew_id: placement.crew_id, count: wrote });

          if (otCt) {
            const { data: closedOt } = await adminSupabase
              .from('rotations')
              .select('end_date, ot_hours, ot_period_id')
              .eq('placement_id', placement.id)
              .eq('ot_period_id', periodId)
              .gt('ot_hours', 0);
            for (const r of closedOt || []) {
              await adminSupabase.from('charge_items').upsert({
                placement_id: placement.id, period_id: periodId,
                charge_type_id: otCt.id, charge_date: r.end_date,
                quantity: r.ot_hours, rate_amount: null, currency: 'USD',
                total_value: null, status: 'confirmed',
              }, { onConflict: 'placement_id,charge_date,charge_type_id', returning: 'minimal' });
            }
          }
        } catch (rotErr) {
          logger.warn('rotation recompute failed', { error: rotErr.message });
          emit('rotations_warn', { crew_id: placement.crew_id, error: rotErr.message });
        }

        await flush();
      } catch (e) {
        logger.error('Sync error', { placement: placement.full_name, error: e.message });
        emit('placement_error', { name: placement.full_name, crew_id: placement.crew_id, error: e.message });
        errors++;
        runState.placements_errors = errors;
      }
    }

    emit('done', { message: 'Sync complete', synced, errors, results });
    await flush({ status: 'completed', ended_at: new Date().toISOString() });
  } catch (err) {
    logger.error('runRosterSync crashed', { syncRunId, error: err.message });
    try { emit('error', { message: err.message }); } catch(_) {}
    await flush({ status: 'failed', ended_at: new Date().toISOString(), error_message: err.message });
  }
}
