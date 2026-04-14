/**
 * Expense routes
 * POST /expenses                   — create expense
 * GET  /expenses                   — list (placement=own, company=theirs, agency=all)
 * GET  /expenses/:id               — get single
 * PUT  /expenses/:id               — update (draft only)
 * PUT  /expenses/:id/status        — approve/decline (company/agency)
 * POST /expenses/scan-receipt      — AI receipt scanning via OpenAI
 * POST /expenses/sync              — sync from Confair API (agency, when credentials available)
 */
import { Router } from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth, requireAgency, requireCompany } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

// ── helpers ────────────────────────────────────────────────────────────────────
async function getPlacementForUser(userId) {
  const { data } = await adminSupabase.from('placements').select('id, full_name, company_id').eq('user_profile_id', userId).maybeSingle();
  return data;
}

async function getUserProfile(userId) {
  const { data } = await adminSupabase.from('user_profiles').select('role, carerix_company_id').eq('id', userId).single();
  return data;
}

// ── GET /expenses ──────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { user } = req;
    let query = adminSupabase.from('expenses')
      .select('*, expense_types(label), placements(full_name, crew_id, companies(name))')
      .order('created_at', { ascending: false });

    if (user.role === 'placement') {
      const p = await getPlacementForUser(user.id);
      if (!p) return res.json([]);
      query = query.eq('placement_id', p.id);
    } else if (user.role === 'company_admin' || user.role === 'company_user') {
      const profile = await getUserProfile(user.id);
      const { data: company } = await adminSupabase.from('companies').select('id').eq('carerix_company_id', profile.carerix_company_id).maybeSingle();
      if (!company) return res.json([]);
      const { data: placements } = await adminSupabase.from('placements').select('id').eq('company_id', company.id);
      const ids = (placements || []).map(p => p.id);
      if (!ids.length) return res.json([]);
      query = query.in('placement_id', ids).neq('status', 'draft'); // company only sees submitted+
    }
    // agency sees all

    // Optional filters
    if (req.query.status)   query = query.eq('status', req.query.status);
    if (req.query.period)   query = query.eq('period_id', req.query.period);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch(err) { next(err); }
});

// ── GET /expenses/:id ──────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await adminSupabase.from('expenses')
      .select('*, expense_types(label), placements(full_name, crew_id, companies(name))')
      .eq('id', req.params.id).single();
    if (error || !data) throw new ApiError('Expense not found', 404);
    res.json(data);
  } catch(err) { next(err); }
});

// ── POST /expenses ─────────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { user } = req;
    const p = await getPlacementForUser(user.id);
    if (!p) throw new ApiError('No placement found for user', 403);

    const {
      transaction_date, type_id, original_amount, original_currency,
      converted_amount, converted_currency, fx_rate,
      description, receipt_url, receipt_filename,
      ai_extracted, ai_merchant, ai_date, ai_amount, ai_currency,
      period_id,
    } = req.body;

    if (!transaction_date || !original_amount || !original_currency) {
      throw new ApiError('transaction_date, original_amount, original_currency are required', 400);
    }

    const { data, error } = await adminSupabase.from('expenses').insert({
      placement_id: p.id,
      period_id,
      transaction_date,
      type_id,
      original_amount,
      original_currency,
      converted_amount,
      converted_currency,
      fx_rate,
      description,
      receipt_url,
      receipt_filename,
      ai_extracted: ai_extracted || false,
      ai_merchant, ai_date, ai_amount, ai_currency,
      status: 'draft',
      submission_date: new Date().toISOString().split('T')[0],
    }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch(err) { next(err); }
});

// ── PUT /expenses/:id ──────────────────────────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const { data: existing } = await adminSupabase.from('expenses').select('status, placement_id').eq('id', req.params.id).single();
    if (!existing) throw new ApiError('Expense not found', 404);
    if (existing.status !== 'draft') throw new ApiError('Only draft expenses can be edited', 400);

    const { data, error } = await adminSupabase.from('expenses')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch(err) { next(err); }
});

// ── PUT /expenses/:id/submit ───────────────────────────────────────────────────
router.put('/:id/submit', async (req, res, next) => {
  try {
    const { user } = req;
    const p = await getPlacementForUser(user.id);
    const { data: existing } = await adminSupabase.from('expenses').select('*').eq('id', req.params.id).single();
    if (!existing) throw new ApiError('Not found', 404);
    if (existing.placement_id !== p?.id) throw new ApiError('Forbidden', 403);
    if (existing.status !== 'draft') throw new ApiError('Already submitted', 400);

    const { data, error } = await adminSupabase.from('expenses')
      .update({ status: 'submitted', submission_date: new Date().toISOString().split('T')[0], updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch(err) { next(err); }
});

// ── PUT /expenses/:id/status — approve or decline ─────────────────────────────
router.put('/:id/status', async (req, res, next) => {
  try {
    const { user } = req;
    const { status, decline_reason } = req.body;
    if (!['approved', 'declined'].includes(status)) throw new ApiError('Status must be approved or declined', 400);
    if (status === 'declined' && !decline_reason) throw new ApiError('decline_reason is required when declining', 400);

    const { data: existing } = await adminSupabase.from('expenses').select('*').eq('id', req.params.id).single();
    if (!existing) throw new ApiError('Not found', 404);
    if (!['submitted', 'approved', 'declined'].includes(existing.status)) throw new ApiError('Expense must be submitted first', 400);

    const { data, error } = await adminSupabase.from('expenses').update({
      status,
      decline_reason: status === 'declined' ? decline_reason : null,
      reviewed_by:    user.id,
      reviewed_at:    new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    }).eq('id', req.params.id).select().single();
    if (error) throw error;
    logger.info('Expense status updated', { id: req.params.id, status, reviewer: user.id });
    res.json(data);
  } catch(err) { next(err); }
});

// ── POST /expenses/scan-receipt — OpenAI GPT-4o Vision ─────────────────────────
router.post('/scan-receipt', async (req, res, next) => {
  try {
    const { imageBase64, mimeType = 'image/jpeg' } = req.body;
    if (!imageBase64) throw new ApiError('imageBase64 is required', 400);

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new ApiError('OPENAI_API_KEY not configured', 500);

    const prompt = `You are analyzing a receipt image. The photo may have been taken on a mobile device and may include background clutter. Focus only on the receipt itself, ignoring any background.

Extract the following information from the receipt:
1. Total amount (the final amount paid)
2. Currency (3-letter code, e.g. EUR, USD, GBP)
3. Date of the transaction (YYYY-MM-DD format)
4. Merchant/vendor name
5. Brief description of what was purchased

Also: Can you clearly see a receipt in this image? If the background is messy, describe where the receipt is in the image.

Respond ONLY with valid JSON in this exact format:
{
  "found": true/false,
  "amount": number or null,
  "currency": "EUR" or null,
  "date": "YYYY-MM-DD" or null,
  "merchant": "string" or null,
  "description": "string" or null,
  "confidence": "high/medium/low",
  "notes": "any issues or observations"
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' } },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new ApiError(`OpenAI error: ${err.substring(0,200)}`, 502);
    }

    const aiResult = await response.json();
    const content  = aiResult.choices?.[0]?.message?.content || '{}';

    // Parse JSON from response
    let extracted;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      extracted = JSON.parse(jsonMatch?.[0] || content);
    } catch {
      extracted = { found: false, notes: content.substring(0, 200) };
    }

    logger.info('Receipt scanned', { found: extracted.found, amount: extracted.amount, currency: extracted.currency, confidence: extracted.confidence });
    res.json(extracted);
  } catch(err) { next(err); }
});

// ── GET /expenses/fx-rate — get FX conversion rate ────────────────────────────
router.get('/fx-rate', async (req, res, next) => {
  try {
    const { from = 'EUR', to = 'USD' } = req.query;
    if (from === to) return res.json({ rate: 1, from, to });

    const r = await fetch(`https://api.exchangerate-api.com/v4/latest/${from}`);
    if (!r.ok) throw new ApiError('FX rate service unavailable', 502);
    const data = await r.json();
    const rate = data.rates?.[to];
    if (!rate) throw new ApiError(`No rate found for ${from} → ${to}`, 404);
    res.json({ rate, from, to, date: data.date });
  } catch(err) { next(err); }
});

export default router;
