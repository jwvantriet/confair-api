/**
 * Invoice generation — PDFKit (pure Node.js, no Python required)
 * GET  /invoice/pdf/:placementId/:periodId
 * POST /invoice/assign-number/:placementId/:periodId  (status=definite only)
 */
import { Router }        from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth }   from '../middleware/auth.js';
import { ApiError }      from '../middleware/errorHandler.js';
import { logger }        from '../utils/logger.js';

const router = Router();

// ── GET /invoice/pdf/:placementId/:periodId ────────────────────────────────────
router.get('/pdf/:placementId/:periodId', requireAuth, async (req, res, next) => {
  try {
    const { placementId, periodId } = req.params;

    // Fetch placement first (need company_id)
    const { data: placement } = await adminSupabase
      .from('placements').select('*, companies(*)').eq('id', placementId).single();
    if (!placement) throw new ApiError('Placement not found', 404);

    const [
      { data: period },
      { data: chargeItems },
      { data: invoiceRec },
    ] = await Promise.all([
      adminSupabase.from('payroll_periods').select('*').eq('id', periodId).single(),
      adminSupabase.from('charge_items')
        .select('*, charge_types(code, label, sort_order)')
        .eq('placement_id', placementId).eq('period_id', periodId).order('charge_date'),
      adminSupabase.from('roster_invoices').select('*')
        .eq('placement_id', placementId).eq('period_id', periodId).maybeSingle(),
    ]);

    if (!period) throw new ApiError('Period not found', 404);

    const isConcept     = !invoiceRec?.invoice_number;
    const invoiceNumber = invoiceRec?.invoice_number || 'CONCEPT';
    const invoiceDate   = invoiceRec?.invoice_date
      ? new Date(invoiceRec.invoice_date).toLocaleDateString('en-GB')
      : new Date().toLocaleDateString('en-GB');

    // Aggregate charges
    const chargeMap = {};
    for (const ci of chargeItems || []) {
      const code = ci.charge_types?.code;
      if (!code) continue;
      if (!chargeMap[code]) chargeMap[code] = { label: ci.charge_types?.label || code, quantity: 0, rate: ci.rate_per_unit ? Number(ci.rate_per_unit) : null, currency: ci.currency || 'EUR', total: 0 };
      chargeMap[code].quantity += Number(ci.quantity || 0);
      if (ci.total_amount) chargeMap[code].total += Number(ci.total_amount);
    }

    const ORDER = ['DailyAllowance','AvailabilityPremium','YearsWithClient','PerDiem','SoldOffDay','BODDays'];
    const lines = ORDER.map(c => chargeMap[c]).filter(l => l && l.quantity > 0);

    const currency   = lines.find(l => l.currency)?.currency || 'EUR';
    const symbol     = currency === 'USD' ? '$' : '\u20ac';
    const grandTotal = lines.reduce((s, l) => s + (l.total || 0), 0);

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthLabel = `${MONTHS[period.month - 1]} ${period.year}`;

    const companyName = placement.companies?.name || 'Client';
    const companyAddr = placement.companies?.address || '';
    const crewId      = placement.crew_id || '';
    const crewName    = placement.full_name || '';

    // Generate PDF with PDFKit
    const PDFDocument = (await import('pdfkit')).default;
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${invoiceNumber}`, Author: 'Confair' } });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));

    await new Promise((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
      buildPDF(doc, { isConcept, invoiceNumber, invoiceDate, monthLabel, companyName, companyAddr, crewId, crewName, lines, symbol, grandTotal, currency });
      doc.end();
    });

    const pdfBuffer = Buffer.concat(chunks);
    const filename = isConcept
      ? `CONCEPT_Invoice_${crewName}_${monthLabel.replace(' ', '_')}.pdf`
      : `Invoice_${invoiceNumber}_${crewName}_${monthLabel.replace(' ', '_')}.pdf`;

    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': pdfBuffer.length });
    res.send(pdfBuffer);

  } catch (err) { next(err); }
});

// ── PDF builder ────────────────────────────────────────────────────────────────
function buildPDF(doc, { isConcept, invoiceNumber, invoiceDate, monthLabel, companyName, companyAddr, crewId, crewName, lines, symbol, grandTotal, currency }) {
  const NAVY    = '#1e2d4a';
  const GREY    = '#f4f5f7';
  const LGREY   = '#e8eaed';
  const MGREY   = '#8a9bb0';
  const RED     = '#cc4444';
  const W       = doc.page.width;
  const M       = 50;
  const CW      = W - 2 * M;

  // ── Header ─────────────────────────────────────────────────────────────────
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(26).text('INVOICE', M, M);
  if (isConcept) {
    doc.fillColor(RED).font('Helvetica-Bold').fontSize(11)
       .text('CONCEPT', M, M + 8, { width: CW, align: 'right' });
  }

  // Divider
  const divY = M + 40;
  doc.moveTo(M, divY).lineTo(M + CW, divY).lineWidth(2).strokeColor(NAVY).stroke();

  // ── FROM / BILL TO ──────────────────────────────────────────────────────────
  const col2X = M + CW / 2;
  let y = divY + 14;

  doc.fillColor(MGREY).font('Helvetica-Bold').fontSize(7).text('FROM', M, y);
  doc.fillColor(MGREY).font('Helvetica-Bold').fontSize(7).text('BILL TO', col2X, y);
  y += 11;

  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text('Confair BV', M, y);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text(companyName, col2X, y);
  y += 13;

  doc.fillColor('#333').font('Helvetica').fontSize(8.5).text('Eindhoven, Netherlands', M, y);
  doc.fillColor('#333').font('Helvetica').fontSize(8.5).text(companyAddr || '', col2X, y);
  y += 12;
  doc.font('Helvetica').fontSize(8.5).text('finance@confair.com', M, y);
  y += 18;

  // ── Meta box ────────────────────────────────────────────────────────────────
  const metaH = 52;
  doc.fillColor(GREY).rect(M, y, CW, metaH).fill();
  doc.fillColor(LGREY).rect(M, y, CW, metaH).stroke();

  const mc = [M + 6, M + CW * 0.5 + 6];
  const ml = 100; // label column width

  const metaRows = [
    [['Invoice Number', invoiceNumber], ['Invoice Date', invoiceDate]],
    [['Contractor',     crewName],      ['Period',       monthLabel]],
    [['Crew ID',        crewId],        ['Currency',     currency]],
  ];
  let my = y + 6;
  for (const row of metaRows) {
    let mx = M + 6;
    for (const [label, val] of row) {
      doc.fillColor(MGREY).font('Helvetica-Bold').fontSize(7).text(label, mx, my);
      doc.fillColor(NAVY).font('Helvetica').fontSize(8.5).text(val || '', mx + ml, my, { width: CW * 0.5 - ml - 6 });
      mx += CW / 2;
    }
    my += 15;
  }
  y += metaH + 14;

  // ── Line items table ────────────────────────────────────────────────────────
  const cols = { desc: M, qty: M + CW * 0.46, rate: M + CW * 0.64, amt: M + CW * 0.82 };
  const rowH = 22;

  // Header row
  doc.fillColor(NAVY).rect(M, y, CW, rowH).fill();
  doc.fillColor('white').font('Helvetica-Bold').fontSize(8.5);
  doc.text('Description', cols.desc + 6, y + 7);
  doc.text('Quantity',    cols.qty,       y + 7);
  doc.text('Rate',        cols.rate,      y + 7);
  doc.text('Amount',      cols.amt,       y + 7, { width: CW * 0.18, align: 'right' });
  y += rowH;

  // Data rows
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const bg = i % 2 === 0 ? 'white' : GREY;
    doc.fillColor(bg).rect(M, y, CW, rowH).fill();

    const qtyStr  = `${l.quantity} day${l.quantity !== 1 ? 's' : ''}`;
    const rateStr = l.rate != null ? `${symbol}${Number(l.rate).toFixed(2)}` : '—';
    const totStr  = l.total ? `${symbol}${l.total.toFixed(2)}` : '—';

    doc.fillColor('#1a1a1a').font('Helvetica').fontSize(8.5);
    doc.text(l.label,  cols.desc + 6, y + 7);
    doc.text(qtyStr,   cols.qty,      y + 7);
    doc.text(rateStr,  cols.rate,     y + 7);
    doc.text(totStr,   cols.amt,      y + 7, { width: CW * 0.18, align: 'right' });
    y += rowH;
  }

  // Overtime row
  const otBg = GREY;
  doc.fillColor(otBg).rect(M, y, CW, rowH).fill();
  doc.fillColor('#1a1a1a').font('Helvetica').fontSize(8.5);
  doc.text('Overtime',                cols.desc + 6, y + 7);
  doc.text('See rotation detail',     cols.qty,      y + 7);
  doc.text('—',                       cols.rate,     y + 7);
  doc.text(`${symbol}0.00`,           cols.amt,      y + 7, { width: CW * 0.18, align: 'right' });
  y += rowH;

  // Bottom border of items
  doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(1).strokeColor(NAVY).stroke();
  y += 6;

  // ── Total row ────────────────────────────────────────────────────────────────
  const totalH = 28;
  doc.fillColor(NAVY).rect(M, y, CW, totalH).fill();
  doc.fillColor('white').font('Helvetica-Bold').fontSize(10);
  doc.text('TOTAL DUE', cols.desc + 6, y + 9);
  doc.text(`${symbol}${grandTotal.toFixed(2)}`, cols.amt, y + 9, { width: CW * 0.18, align: 'right' });
  y += totalH + 20;

  // ── Payment information ──────────────────────────────────────────────────────
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text('PAYMENT INFORMATION', M, y);
  y += 12;
  doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(0.5).strokeColor(LGREY).stroke();
  y += 8;

  const payRows = [
    ['Bank', 'ING Bank N.V.',             'Account Name', 'Confair BV'],
    ['IBAN', 'NL00 INGB 0000 0000 00',    'BIC/SWIFT',    'INGBNL2A'],
    ['Reference', invoiceNumber,           'Currency',     currency],
  ];
  for (const [l1, v1, l2, v2] of payRows) {
    doc.fillColor(MGREY).font('Helvetica-Bold').fontSize(7).text(l1, M, y);
    doc.fillColor('#333').font('Helvetica').fontSize(8.5).text(v1, M + 70, y);
    doc.fillColor(MGREY).font('Helvetica-Bold').fontSize(7).text(l2, col2X, y);
    doc.fillColor('#333').font('Helvetica').fontSize(8.5).text(v2, col2X + 70, y);
    y += 14;
  }
  y += 10;

  // ── Footer note ──────────────────────────────────────────────────────────────
  doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(0.5).strokeColor(LGREY).stroke();
  y += 8;
  const note = isConcept
    ? 'CONCEPT INVOICE — This document is a draft and does not constitute a formal invoice. The invoice number will be assigned upon finalization.'
    : `Payment is due within 30 days of invoice date. Please reference ${invoiceNumber} in your payment. Thank you for your business.`;
  doc.fillColor(MGREY).font('Helvetica').fontSize(7.5).text(note, M, y, { width: CW });
}

// ── POST /invoice/assign-number/:placementId/:periodId ────────────────────────
router.post('/assign-number/:placementId/:periodId', requireAuth, async (req, res, next) => {
  try {
    const { placementId, periodId } = req.params;

    const { data: status } = await adminSupabase
      .from('roster_period_status').select('status')
      .eq('placement_id', placementId).eq('period_id', periodId).single();

    if (status?.status !== 'definite')
      throw new ApiError('Invoice number can only be assigned when status is definite', 400);

    const year = new Date().getFullYear();
    const { data: seqNum } = await adminSupabase.rpc('next_invoice_number', { p_year: year });
    const invNumber = `INV-${year}-${String(seqNum).padStart(4, '0')}`;

    await adminSupabase.from('roster_invoices').upsert({
      placement_id:   placementId,
      period_id:      periodId,
      invoice_number: invNumber,
      invoice_date:   new Date().toISOString().split('T')[0],
      due_date:       new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
      is_concept:     false,
    }, { onConflict: 'placement_id,period_id' });

    res.json({ invoice_number: invNumber });
  } catch (err) { next(err); }
});

export default router;
