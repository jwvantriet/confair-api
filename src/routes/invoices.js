/**
 * Invoices routes + invoice generation logic
 *
 * GET /invoices              — List invoices
 * GET /invoices/:id          — Invoice detail
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { adminSupabase } from '../services/supabase.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase
      .from('invoices')
      .select('*, payroll_runs(run_ref), companies(name), placements(full_name)')
      .order('created_at', { ascending: false });
    if (error) throw new ApiError(error.message);
    res.json(data);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase
      .from('invoices')
      .select('*, payroll_runs(*), companies(*), placements(*), markup_configurations(*)')
      .eq('id', req.params.id)
      .single();
    if (error || !data) throw new ApiError('Invoice not found', 404);
    res.json(data);
  } catch (err) { next(err); }
});

/**
 * generateInvoicesForRun
 *
 * Called after a run is finalized. Generates:
 *  1. One reversed invoice per Placement (Placement → Agency)
 *  2. One invoice per Company (Agency → Company) with markup applied
 *
 * Markup models supported:
 *  - percentage:       totalBase × percentage
 *  - fixed_per_person: count(placements) × fixed_amount
 *  - tiered_per_person: tier lookup by person count
 */
export async function generateInvoicesForRun(runId, actorUserId) {
  // Load all entries for this run grouped by placement and company
  const { data: runEntries, error } = await adminSupabase
    .from('payroll_run_entries')
    .select(`
      amount,
      declaration_entries(
        placement_id, company_id,
        placements(id, full_name),
        companies(id, name)
      ),
      correction_requests(
        placement_id, company_id,
        placements(id, full_name),
        companies(id, name)
      )
    `)
    .eq('payroll_run_id', runId);

  if (error) throw new Error(`Failed to load run entries: ${error.message}`);

  // Aggregate by placement and company
  const byPlacement = {}, byCompany = {};
  for (const entry of runEntries) {
    const src = entry.declaration_entries ?? entry.correction_requests;
    if (!src) continue;
    const placementId = src.placement_id;
    const companyId   = src.company_id;
    const amount      = entry.amount ?? 0;

    if (!byPlacement[placementId]) byPlacement[placementId] = { placement: src.placements, companyId, total: 0 };
    byPlacement[placementId].total += amount;

    if (!byCompany[companyId]) byCompany[companyId] = { company: src.companies, placements: new Set(), total: 0 };
    byCompany[companyId].placements.add(placementId);
    byCompany[companyId].total += amount;
  }

  const createdInvoices = [];

  // Step 1: Reversed invoices — Placement → Agency
  for (const [placementId, data] of Object.entries(byPlacement)) {
    const { data: inv, error: invErr } = await adminSupabase
      .from('invoices')
      .insert({
        invoice_type:          'placement_to_agency',
        payroll_run_id:        runId,
        issuing_placement_id:  placementId,
        base_amount:           data.total,
        markup_amount:         0,
        total_amount:          data.total,
        status:                'issued',
        issue_date:            new Date().toISOString().slice(0, 10),
      })
      .select()
      .single();
    if (invErr) { logger.error('Failed to create placement invoice', { invErr }); continue; }

    await writeAuditLog({ eventType: 'invoice_generated', actorUserId, entityType: 'invoice', entityId: inv.id, payload: { type: 'placement_to_agency', placementId, amount: data.total } });
    createdInvoices.push(inv);
  }

  // Step 2: Agency → Company invoices with markup
  for (const [companyId, data] of Object.entries(byCompany)) {
    // Load active markup configuration for this company
    const today = new Date().toISOString().slice(0, 10);
    const { data: markup } = await adminSupabase
      .from('markup_configurations')
      .select('*')
      .eq('company_id', companyId)
      .lte('valid_from', today)
      .or(`valid_until.is.null,valid_until.gte.${today}`)
      .order('valid_from', { ascending: false })
      .limit(1)
      .maybeSingle();

    const personCount = data.placements.size;
    let markupAmount = 0;
    let markupBreakdown = null;

    if (markup) {
      if (markup.model === 'percentage') {
        markupAmount = data.total * (markup.percentage_value / 100);
        markupBreakdown = { model: 'percentage', rate: markup.percentage_value, base: data.total };
      } else if (markup.model === 'fixed_per_person') {
        markupAmount = personCount * markup.fixed_amount;
        markupBreakdown = { model: 'fixed_per_person', persons: personCount, feePerPerson: markup.fixed_amount };
      } else if (markup.model === 'tiered_per_person') {
        const tiers = markup.tier_definitions ?? [];
        const tier  = tiers.find(t => personCount >= t.min && (t.max === null || personCount <= t.max));
        if (tier) {
          markupAmount = personCount * tier.fee_per_person;
          markupBreakdown = { model: 'tiered_per_person', persons: personCount, tier, feeApplied: tier.fee_per_person };
        }
      }
    }

    const totalAmount = data.total + markupAmount;
    const { data: inv, error: invErr } = await adminSupabase
      .from('invoices')
      .insert({
        invoice_type:        'agency_to_company',
        payroll_run_id:      runId,
        receiving_company_id: companyId,
        base_amount:         data.total,
        markup_amount:       markupAmount,
        total_amount:        totalAmount,
        markup_config_id:    markup?.id ?? null,
        markup_breakdown:    markupBreakdown,
        status:              'draft',
        issue_date:          new Date().toISOString().slice(0, 10),
      })
      .select()
      .single();
    if (invErr) { logger.error('Failed to create company invoice', { invErr }); continue; }

    await writeAuditLog({ eventType: 'invoice_generated', actorUserId, entityType: 'invoice', entityId: inv.id, payload: { type: 'agency_to_company', companyId, base: data.total, markup: markupAmount, total: totalAmount } });
    createdInvoices.push(inv);
  }

  return createdInvoices;
}

export default router;
