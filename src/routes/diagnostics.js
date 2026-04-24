/**
 * Diagnostics endpoint — tests every component of the sync pipeline
 * GET /diagnostics/sync-test/:periodId
 * Returns a full report of each step, pass/fail, and data counts
 */
import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { fetchRosters, rosterItemsList, mapRosterToRows, buildDailySummary, fetchActiveRolesForPeriod } from '../services/raido.js';
import { queryGraphQL, getCarerixCheckboxRegistry } from '../services/carerix.js';

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

// ── GET /diagnostics/special-roles — probe SpecialRoles API for a period ──────
router.get('/special-roles/:periodId', async (req, res) => {
  try {
    const { data: period } = await adminSupabase
      .from('payroll_periods').select('*').eq('id', req.params.periodId).single();
    if (!period) return res.status(404).json({ error: 'Period not found' });

    const { data: placements } = await adminSupabase
      .from('placements').select('id, crew_id, full_name, active_roles').not('crew_id', 'is', null);

    const rolesMap = await fetchActiveRolesForPeriod(period.start_date, period.end_date);

    // Show what was returned and how it maps to each placement
    const mapping = (placements || []).map(p => ({
      crew_id:         p.crew_id,
      full_name:       p.full_name,
      active_roles_db: p.active_roles,
      roles_from_api:  rolesMap[p.crew_id?.toUpperCase()] || null,
      key_found:       p.crew_id?.toUpperCase() in rolesMap,
    }));

    res.json({
      period: period.period_ref,
      from: period.start_date,
      to: period.end_date,
      rolesMapKeys: Object.keys(rolesMap),
      rolesMap,
      placements: mapping,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /diagnostics/raido-crew/:crewId? ──────────────────────────────────────
// Dump the raw RAIDO /crew payload for one crew member. Useful to discover
// what fields RAIDO exposes (e.g. tenure / client start date) so we can wire
// them into downstream logic without guessing. If no crewId is given, returns
// the first crew from the response.
router.get('/raido-crew/:crewId?', async (req, res) => {
  try {
    const { config } = await import('../config.js');
    const axios = (await import('axios')).default;
    const url = `${config.raido.baseUrl}/crew`;
    const params = {
      OnlyActive: 'true',
      RequestData: 'SpecialRoles',
      // Wide window so tenure fields like StartDate / FirstAssignment
      // surface even if they're only populated when inside it.
      From: '2000-01-01',
      To:   new Date().toISOString().split('T')[0],
      limit: 5000,
    };
    const resp = await axios.get(url, {
      headers: { 'Ocp-Apim-Subscription-Key': config.raido.apiKey, 'Accept': 'application/json' },
      params, timeout: 30_000,
    });
    const body  = resp.data;
    const list  = Array.isArray(body) ? body : (body?.items || body?.data || []);
    const crewId = req.params.crewId?.toUpperCase();
    const match = crewId
      ? list.find(c => [c?.Number, c?.EmployeeNumber, c?.Code1, c?.Code2]
          .some(v => String(v || '').toUpperCase() === crewId))
      : list[0];
    res.json({
      endpoint: url,
      totalCrew: list.length,
      query: { crewId: crewId || null },
      rawSampleKeys: match ? Object.keys(match).sort() : null,
      raw: match || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, status: err.response?.status, body: err.response?.data });
  }
});

// ── GET /diagnostics/user-access/:userProfileId ──────────────────────────────
// Dumps everything we need to debug why a user's user_company_access isn't
// populated after a login: the Carerix side (raw additionalInfo, linked
// CRUserCompany rows), the registry (dataNodeID → exportCode), the DB
// lookups (companies by carerix_company_id, existing user_company_access
// rows), and the final upsert error if any.
//
// Call this after the user has logged in at least once.
router.get('/user-access/:userProfileId', async (req, res) => {
  const out = { userProfileId: req.params.userProfileId, ts: new Date().toISOString() };
  try {
    const userProfileId = req.params.userProfileId;

    // 1. user_profiles row
    const { data: up, error: upErr } = await adminSupabase
      .from('user_profiles')
      .select('id, email, role, carerix_user_id, carerix_company_id')
      .eq('id', userProfileId)
      .maybeSingle();
    out.user_profile = up || null;
    if (upErr) out.user_profile_error = upErr.message;
    if (!up) return res.json(out);

    const crUserIdNum = Number(up.carerix_user_id);
    if (!Number.isFinite(crUserIdNum)) {
      out.warning = 'user has no numeric carerix_user_id';
      return res.json(out);
    }

    // 2. Live Carerix state
    const [userResp, linksResp, registry] = await Promise.all([
      queryGraphQL(`
        query CRUser($qualifier: String) {
          crUserPage(qualifier: $qualifier, pageable: { page: 0, size: 1 }) {
            items { _id userID userName firstName lastName additionalInfo }
          }
        }
      `, { qualifier: `userID == ${crUserIdNum}` }),
      queryGraphQL(`
        query UserCompanies($qualifier: String, $pageable: Pageable) {
          crUserCompanyPage(qualifier: $qualifier, pageable: $pageable) {
            totalElements
            items { _id toCompany { _id companyID name } }
          }
        }
      `, { qualifier: `toUser.userID == ${crUserIdNum}`, pageable: { page: 0, size: 100 } }),
      getCarerixCheckboxRegistry(),
    ]);

    const crUser = userResp?.data?.crUserPage?.items?.[0] || null;
    const additionalInfo = crUser?.additionalInfo || {};
    out.carerix_user = crUser;
    out.carerix_user_graphql_errors = userResp?.errors || null;
    out.carerix_user_links = linksResp?.data?.crUserCompanyPage?.items || [];
    out.carerix_links_graphql_errors = linksResp?.errors || null;

    // 3. Registry
    out.registry = {
      entries: Object.keys(registry).length,
      sample: Object.fromEntries(Object.entries(registry).slice(0, 10)),
    };

    // 4. Decoded function groups
    const decoded = [];
    for (const [key, value] of Object.entries(additionalInfo)) {
      const rawKey = key.startsWith('_') ? key.slice(1) : key;
      const code = registry[rawKey];
      if (!code) continue;
      if (String(value).trim() !== '1') continue;
      decoded.push({ key: rawKey, exportCode: code });
    }
    out.decoded_function_groups = decoded;
    out.additional_info_all = additionalInfo;

    // 5. Platform companies lookup
    const carerixCompanyIds = Array.from(new Set(
      out.carerix_user_links
        .map(l => l?.toCompany?.companyID)
        .filter(v => v != null)
        .map(String)
    ));
    out.carerix_company_ids = carerixCompanyIds;

    if (carerixCompanyIds.length) {
      const { data: companies, error: cErr } = await adminSupabase
        .from('companies')
        .select('id, carerix_company_id, name')
        .in('carerix_company_id', carerixCompanyIds);
      out.companies_lookup = companies || [];
      if (cErr) out.companies_lookup_error = cErr.message;
      const byCid = new Map((companies || []).map(c => [String(c.carerix_company_id), c]));
      out.resolved_uuids = carerixCompanyIds.map(cid => byCid.get(cid)?.id).filter(Boolean);
      out.unknown_carerix_ids = carerixCompanyIds.filter(cid => !byCid.has(cid));
    }

    // 6. Current user_company_access rows for this user
    const { data: access, error: accErr } = await adminSupabase
      .from('user_company_access')
      .select('company_id, function_groups')
      .eq('user_profile_id', userProfileId);
    out.user_company_access = access || [];
    if (accErr) out.user_company_access_error = accErr.message;

    // 7. Try a write to see the exact error (if any)
    if (out.resolved_uuids?.length) {
      const testRow = {
        user_profile_id: userProfileId,
        company_id:      out.resolved_uuids[0],
        function_groups: decoded.map(d => d.exportCode).length
          ? decoded.map(d => d.exportCode)
          : null,
      };
      const { error: upsertErr } = await adminSupabase
        .from('user_company_access')
        .upsert([testRow], { onConflict: 'user_profile_id,company_id' });
      out.probe_upsert = {
        row:   testRow,
        error: upsertErr ? { code: upsertErr.code, message: upsertErr.message, details: upsertErr.details, hint: upsertErr.hint } : null,
      };
    }

    res.json(out);
  } catch (err) {
    out.fatal = { message: err.message, stack: err.stack };
    res.status(500).json(out);
  }
});

export default router;
