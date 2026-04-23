/**
 * Charge configuration — per (company, role_group) catalog of which charge
 * types apply and any rule config for each. Agency-only.
 *
 *   GET  /charge-config/companies         → companies the caller can configure
 *   GET  /charge-config/role-groups       → role_groups catalog
 *   GET  /charge-config?companyId&roleGroup → config matrix for a (company, role)
 *   PUT  /charge-config                   → upsert a batch of rows
 *   POST /charge-config/copy              → copy entire config from one company to another
 */
import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';

const router = Router();
router.use(requireAuth, requireAgency);

// ── GET /charge-config/companies ─────────────────────────────────────────────
router.get('/companies', async (_req, res, next) => {
  try {
    const { data, error } = await adminSupabase
      .from('companies')
      .select('id, name, carerix_company_id, is_active')
      .order('name');
    if (error) throw new ApiError(error.message, 500);
    res.json({ items: data || [] });
  } catch (err) { next(err); }
});

// ── GET /charge-config/role-groups ───────────────────────────────────────────
router.get('/role-groups', async (_req, res, next) => {
  try {
    const { data, error } = await adminSupabase
      .from('role_groups')
      .select('code, label, sort_order')
      .order('sort_order');
    if (error) throw new ApiError(error.message, 500);
    res.json({ items: data || [] });
  } catch (err) { next(err); }
});

// ── GET /charge-config?companyId&roleGroup ───────────────────────────────────
// Returns the full matrix: every charge_type (active) joined to the
// existing config row (if any). Missing rows are reported as enabled=false.
router.get('/', async (req, res, next) => {
  try {
    const { companyId, roleGroup } = req.query;
    if (!companyId) throw new ApiError('companyId is required', 400);
    if (!roleGroup) throw new ApiError('roleGroup is required', 400);

    const { data: types, error: tErr } = await adminSupabase
      .from('charge_types')
      .select('id, code, label, carerix_type_id, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true, nullsFirst: false });
    if (tErr) throw new ApiError(tErr.message, 500);

    const { data: cfgRows, error: cErr } = await adminSupabase
      .from('company_charge_config')
      .select('charge_type_id, enabled, rule_config')
      .eq('company_id', companyId)
      .eq('role_group', roleGroup);
    if (cErr) throw new ApiError(cErr.message, 500);

    const cfgByType = new Map((cfgRows || []).map(r => [r.charge_type_id, r]));
    const entries = (types || []).map(t => {
      const cfg = cfgByType.get(t.id);
      return {
        charge_type_id: t.id,
        code: t.code,
        label: t.label,
        carerix_type_id: t.carerix_type_id,
        enabled: cfg ? !!cfg.enabled : false,
        rule_config: cfg?.rule_config ?? null,
      };
    });

    res.json({ company_id: companyId, role_group: roleGroup, entries });
  } catch (err) { next(err); }
});

// ── PUT /charge-config ───────────────────────────────────────────────────────
// Body: { companyId, roleGroup, entries: [{ charge_type_id, enabled, rule_config }] }
router.put('/', async (req, res, next) => {
  try {
    const { companyId, roleGroup, entries } = req.body || {};
    if (!companyId) throw new ApiError('companyId is required', 400);
    if (!roleGroup) throw new ApiError('roleGroup is required', 400);
    if (!Array.isArray(entries)) throw new ApiError('entries must be an array', 400);

    const rows = entries.map(e => ({
      company_id:     companyId,
      role_group:     roleGroup,
      charge_type_id: e.charge_type_id,
      enabled:        !!e.enabled,
      rule_config:    e.rule_config ?? null,
    }));

    if (rows.length) {
      const { error } = await adminSupabase
        .from('company_charge_config')
        .upsert(rows, { onConflict: 'company_id,role_group,charge_type_id' });
      if (error) throw new ApiError(error.message, 500);
    }

    res.json({ saved: rows.length });
  } catch (err) { next(err); }
});

// ── POST /charge-config/copy ─────────────────────────────────────────────────
// Body: { fromCompanyId, toCompanyId, roleGroup? }
// If roleGroup omitted, copies all role_groups from source to target.
router.post('/copy', async (req, res, next) => {
  try {
    const { fromCompanyId, toCompanyId, roleGroup } = req.body || {};
    if (!fromCompanyId) throw new ApiError('fromCompanyId is required', 400);
    if (!toCompanyId)   throw new ApiError('toCompanyId is required', 400);
    if (fromCompanyId === toCompanyId) {
      throw new ApiError('fromCompanyId and toCompanyId must differ', 400);
    }

    let q = adminSupabase
      .from('company_charge_config')
      .select('role_group, charge_type_id, enabled, rule_config')
      .eq('company_id', fromCompanyId);
    if (roleGroup) q = q.eq('role_group', roleGroup);
    const { data: src, error: sErr } = await q;
    if (sErr) throw new ApiError(sErr.message, 500);

    if (!src?.length) return res.json({ copied: 0 });

    const rows = src.map(r => ({
      company_id:     toCompanyId,
      role_group:     r.role_group,
      charge_type_id: r.charge_type_id,
      enabled:        r.enabled,
      rule_config:    r.rule_config,
    }));

    const { error } = await adminSupabase
      .from('company_charge_config')
      .upsert(rows, { onConflict: 'company_id,role_group,charge_type_id' });
    if (error) throw new ApiError(error.message, 500);

    res.json({ copied: rows.length });
  } catch (err) { next(err); }
});

export default router;
