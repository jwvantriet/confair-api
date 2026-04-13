/**
 * Invoice routes
 * GET  /invoice/pdf/:placementId/:periodId     — generate PDF
 * POST /invoice/sync-carerix/:placementId      — cache Carerix data to Supabase
 * POST /invoice/assign-number/:placementId/:periodId — assign invoice number (definite only)
 */
import { Router }        from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth }   from '../middleware/auth.js';
import { ApiError }      from '../middleware/errorHandler.js';
import { logger }        from '../utils/logger.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchCarerixInvoiceData(carerixJobId) {
  /** Fetch all invoice-relevant data from Carerix for a job. Returns null on failure. */
  try {
    const { queryGraphQL } = await import('../services/carerix.js');
    const safeQ = async (q, v = {}) => {
      try { const r = await queryGraphQL(q, v); return r?.data || null; }
      catch(e) { return null; }
    };

    // 1. Job — employee + company (no toOffice in combined query — causes 400)
    const jd = await safeQ(
      'query J($id:ID!){ crJob(_id:$id){ _id jobID name additionalInfo toCompany{_id companyID name} toEmployee{_id employeeID} } }',
      { id: String(carerixJobId) }
    );
    const job = jd?.crJob;
    if (!job) return null;

    // Parse additionalInfo
    const ai = {};
    for (const [k, v] of Object.entries(job.additionalInfo || {}))
      if (v != null && v !== '') ai[k.replace(/^_/, '')] = v;

    // 2. Employee (fetch in parallel with office attempts)
    const empId = job.toEmployee?._id;
    const empData = empId ? await safeQ(
      'query E($id:ID!){ crEmployee(_id:$id){ _id firstName lastName name paymentIbanCode paymentBicCode paymentAccountName homeFullAddress homePostalCode homeCity toHomeCountryNode{value} } }',
      { id: String(empId) }
    ) : null;
    const emp = empData?.crEmployee;

    // 3. Office — try multiple query paths
    let officeId = null;
    for (const [path, q] of [
      ['direct',  'query J($id:ID!){ crJob(_id:$id){ toOffice{_id name} } }'],
      ['vacancy', 'query J($id:ID!){ crJob(_id:$id){ toVacancy{ toOffice{_id name} } } }'],
    ]) {
      const r = await safeQ(q, { id: String(carerixJobId) });
      officeId = r?.crJob?.toOffice?._id || r?.crJob?.toVacancy?.toOffice?._id;
      if (officeId) { logger.info('Found office via ' + path, { officeId }); break; }
    }

    // 4. Office address — visitCityCode is the confirmed field name
    let office = officeId ? { _id: officeId } : null;
    if (officeId) {
      for (const q of [
        'query O($id:ID!){ crOffice(_id:$id){ _id name visitCityCode visitPostalCode visitStreet visitNumber toVisitCountryNode{value} vatNumber emailAddress } }',
        'query O($id:ID!){ crOffice(_id:$id){ _id name visitCity visitPostalCode visitStreet visitNumber toVisitCountryNode{value} vatNumber } }',
        'query O($id:ID!){ crOffice(_id:$id){ _id name city postalCode street number toCountryNode{value} } }',
        'query O($id:ID!){ crOffice(_id:$id){ _id name homeCity homePostalCode homeStreet toHomeCountryNode{value} } }',
      ]) {
        const r = await safeQ(q, { id: String(officeId) });
        if (r?.crOffice) { office = { ...office, ...r.crOffice }; break; }
      }
    }

    return { job, emp, office, ai };
  } catch(e) {
    logger.warn('fetchCarerixInvoiceData failed', { error: e.message });
    return null;
  }
}

function buildInvoiceFromData(cx, placementFallback) {
  /** Build FROM/BILL TO fields from Carerix data + fallback */
  const { emp, office, ai } = cx || {};

  // FROM — contractor
  const legalName = ai?.['10278'] || ai?.['_10278'] || null;
  const vatNumber = ai?.['10978'] || ai?.['_10978'] || null;
  const empName   = emp ? `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.name : (placementFallback || '');

  const addrParts = [
    emp?.homeFullAddress || '',
    emp?.homePostalCode  || '',
    emp?.homeCity        || '',
    emp?.toHomeCountryNode?.value || '',
  ].filter(Boolean);

  return {
    fromName:    legalName || empName,
    fromLegal:   legalName || null,
    fromVat:     vatNumber || null,
    fromAddress: addrParts.join(', '),
    iban:        emp?.paymentIbanCode   || '',
    bic:         emp?.paymentBicCode    || '',
    accountName: emp?.paymentAccountName || legalName || empName,

    // BILL TO — office (visitCityCode is the confirmed field name for city)
    officeName:    office?.name || '',
    officeAddress: [
      office?.visitStreet   ? `${office.visitStreet} ${office.visitNumber || ''}`.trim() : (office?.street ? `${office.street} ${office.number || ''}`.trim() : (office?.homeStreet || '')),
      office?.visitPostalCode || office?.postalCode || office?.homePostalCode || '',
      office?.visitCityCode || office?.visitCity   || office?.city || office?.homeCity || '',
      (office?.toVisitCountryNode || office?.toCountryNode || office?.toHomeCountryNode)?.value || '',
    ].filter(Boolean).join(', '),
    officeVat: office?.vatNumber || '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /invoice/sync-carerix/:placementId — cache Carerix data to Supabase
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sync-carerix/:placementId', requireAuth, async (req, res, next) => {
  try {
    const { placementId } = req.params;
    const { data: placement } = await adminSupabase
      .from('placements').select('id, full_name, carerix_job_id, company_id').eq('id', placementId).single();
    if (!placement) throw new ApiError('Placement not found', 404);
    if (!placement.carerix_job_id) throw new ApiError('No Carerix job ID on placement', 400);

    const cx = await fetchCarerixInvoiceData(placement.carerix_job_id);
    if (!cx) throw new ApiError('Carerix data unavailable', 502);

    const f = buildInvoiceFromData(cx, placement.full_name);

    // Save to placements
    await adminSupabase.from('placements').update({
      inv_from_name:       f.fromName,
      inv_from_legal_name: f.fromLegal,
      inv_from_vat:        f.fromVat,
      inv_from_address:    f.fromAddress,
      inv_iban:            f.iban,
      inv_bic:             f.bic,
      inv_account_name:    f.accountName,
      inv_carerix_synced_at: new Date().toISOString(),
    }).eq('id', placementId);

    // Save office to company if we have it
    if (f.officeName && placement.company_id) {
      await adminSupabase.from('companies').update({
        inv_office_name:    f.officeName,
        inv_office_address: f.officeAddress,
        inv_office_vat:     f.officeVat,
        inv_office_synced_at: new Date().toISOString(),
      }).eq('id', placement.company_id);
    }

    logger.info('Invoice Carerix sync complete', { placementId, fromName: f.fromName, iban: f.iban, officeId: cx.office?._id });
    res.json({ ok: true, from: f });
  } catch(err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /invoice/pdf/:placementId/:periodId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pdf/:placementId/:periodId', async (req, res, next) => {
  // Auth: placement users can only access their own invoice
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try {
    const { data: { user } } = await adminSupabase.auth.getUser(authHeader.slice(7));
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    const { data: profile } = await adminSupabase.from('user_profiles')
      .select('id, role, is_active').eq('id', user.id).single();
    if (!profile?.is_active) return res.status(403).json({ error: 'Account inactive' });
    if (profile.role === 'placement') {
      const { data: p } = await adminSupabase.from('placements')
        .select('id').eq('user_profile_id', user.id).maybeSingle();
      if (!p || p.id !== req.params.placementId) return res.status(403).json({ error: 'Access denied' });
    } else if (!['agency_admin','agency_operations','company_admin','company_user'].includes(profile.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
  } catch(e) { return res.status(401).json({ error: 'Auth failed' }); }

  try {
    const { placementId, periodId } = req.params;

    // 1. Load all data from Supabase (fast — no Carerix calls)
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

    // 2. Invoice number / concept flag
    const isConcept     = !invoiceRec?.invoice_number;
    const invoiceNumber = invoiceRec?.invoice_number || 'CONCEPT';
    const invoiceDate   = invoiceRec?.invoice_date
      ? new Date(invoiceRec.invoice_date).toLocaleDateString('en-GB')
      : new Date().toLocaleDateString('en-GB');

    // 3. FROM — use cached Carerix data from Supabase
    const fromName    = placement.inv_from_legal_name || placement.inv_from_name || placement.full_name;
    const fromAddr    = placement.inv_from_address    || '';
    const fromVat     = placement.inv_from_vat        ? `VAT: ${placement.inv_from_vat}` : '';
    const iban        = placement.inv_iban            || '';
    const bic         = placement.inv_bic             || '';
    const accountName = placement.inv_account_name    || fromName;

    // 4. BILL TO — cached office/company data from Supabase
    const co          = placement.companies || {};
    const companyName = co.inv_office_name || co.name || 'Client';
    const companyAddr = co.inv_office_address || '';  // populated by sync-carerix
    const companyVat  = co.inv_office_vat ? `VAT: ${co.inv_office_vat}` : '';

    // 5. Aggregate charges
    const chargeMap = {};
    for (const ci of chargeItems || []) {
      const code = ci.charge_types?.code;
      if (!code) continue;
      if (!chargeMap[code]) chargeMap[code] = { label: ci.charge_types?.label || code, quantity: 0, rate: ci.rate_per_unit ? Number(ci.rate_per_unit) : null, currency: ci.currency || 'EUR', total: 0 };
      chargeMap[code].quantity += Number(ci.quantity || 0);
      if (ci.total_amount) chargeMap[code].total += Number(ci.total_amount);
    }
    const ORDER   = ['DailyAllowance','AvailabilityPremium','YearsWithClient','PerDiem','SoldOffDay','BODDays'];
    const lines   = ORDER.map(c => chargeMap[c]).filter(l => l && l.quantity > 0);
    const currency  = lines.find(l => l.currency)?.currency || 'EUR';
    const symbol    = currency === 'USD' ? '$' : '\u20ac';
    const subtotal  = lines.reduce((s, l) => s + (l.total || 0), 0);
    const grandTotal = subtotal; // 0% VAT

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthLabel = `${MONTHS[period.month - 1]} ${period.year}`;
    const crewId     = placement.crew_id || '';

    // 6. Generate PDF
    const PDFDocument = (await import('pdfkit')).default;
    const doc    = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));

    await new Promise((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
      buildPDF(doc, {
        isConcept, invoiceNumber, invoiceDate, monthLabel,
        fromName, fromAddr, fromVat,
        companyName, companyAddr, companyVat,
        iban, bic, accountName,
        crewId, lines, symbol, subtotal, grandTotal, currency,
      });
      doc.end();
    });

    const buf      = Buffer.concat(chunks);
    const safeName = fromName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
    const filename = isConcept
      ? `CONCEPT_Invoice_${safeName}_${monthLabel.replace(' ', '_')}.pdf`
      : `Invoice_${invoiceNumber}_${safeName}_${monthLabel.replace(' ', '_')}.pdf`;

    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': buf.length });
    res.send(buf);
  } catch(err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PDF builder
// ─────────────────────────────────────────────────────────────────────────────
function buildPDF(doc, { isConcept, invoiceNumber, invoiceDate, monthLabel, fromName, fromAddr, fromVat, companyName, companyAddr, companyVat, iban, bic, accountName, crewId, lines, symbol, subtotal, grandTotal, currency }) {
  const NAVY = '#1e2d4a', GREY = '#f4f5f7', LGREY = '#e8eaed', MGREY = '#8a9bb0', RED = '#cc4444';
  const W = doc.page.width, M = 50, CW = W - 2 * M;
  const col2 = M + CW / 2;

  // Header
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(26).text('INVOICE', M, M);
  if (isConcept) doc.fillColor(RED).font('Helvetica-Bold').fontSize(11).text('CONCEPT', M, M + 8, { width: CW, align: 'right' });
  let y = M + 40;
  doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(2).strokeColor(NAVY).stroke();
  y += 14;

  // FROM / BILL TO labels
  doc.fillColor(MGREY).font('Helvetica-Bold').fontSize(7).text('FROM', M, y);
  doc.fillColor(MGREY).font('Helvetica-Bold').fontSize(7).text('BILL TO', col2, y);
  y += 11;

  // Names
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text(fromName || '—', M, y, { width: CW/2 - 10 });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text(companyName || '—', col2, y, { width: CW/2 - 10 });
  y += 14;

  // Addresses
  const fromAddrLines = fromAddr ? fromAddr.split(', ') : [];
  const compAddrLines = companyAddr ? companyAddr.split(', ') : [];
  const maxLines = Math.max(fromAddrLines.length, compAddrLines.length, 1);
  doc.fillColor('#333').font('Helvetica').fontSize(8.5);
  for (let i = 0; i < maxLines; i++) {
    if (fromAddrLines[i]) doc.text(fromAddrLines[i], M, y + i * 12, { width: CW/2 - 10 });
    if (compAddrLines[i]) doc.text(compAddrLines[i], col2, y + i * 12, { width: CW/2 - 10 });
  }
  y += maxLines * 12 + 4;
  if (fromVat)    { doc.fillColor(MGREY).font('Helvetica').fontSize(7.5).text(fromVat, M, y); }
  if (companyVat) { doc.fillColor(MGREY).font('Helvetica').fontSize(7.5).text(companyVat, col2, y); }
  y += 16;

  // Meta box
  const metaH = 54;
  doc.fillColor(GREY).rect(M, y, CW, metaH).fill();
  doc.fillColor(LGREY).lineWidth(0.5).rect(M, y, CW, metaH).stroke();
  const ml = 100, my0 = y + 6;
  const metaRows = [
    [['Invoice Number', invoiceNumber], ['Invoice Date', invoiceDate]],
    [['Contractor',     crewId || fromName], ['Period', monthLabel]],
    [['Currency',       currency],            ['VAT',    '0% — Reversed Charge']],
  ];
  metaRows.forEach((row, ri) => {
    let mx = M + 6;
    row.forEach(([label, val]) => {
      doc.fillColor(MGREY).font('Helvetica-Bold').fontSize(7).text(label, mx, my0 + ri * 16);
      doc.fillColor(NAVY).font('Helvetica').fontSize(8.5).text(val || '—', mx + ml, my0 + ri * 16, { width: CW * 0.5 - ml - 6 });
      mx += CW / 2;
    });
  });
  y += metaH + 14;

  // Line items table
  const cols = { desc: M, qty: M + CW * 0.46, rate: M + CW * 0.64, amt: M + CW * 0.82 };
  const rowH = 22;
  const colWs = [CW * 0.46, CW * 0.18, CW * 0.18, CW * 0.18];

  // Header row
  doc.fillColor(NAVY).rect(M, y, CW, rowH).fill();
  doc.fillColor('white').font('Helvetica-Bold').fontSize(8.5);
  ['Description','Quantity','Rate','Amount'].forEach((h, i) => {
    const x = [cols.desc + 6, cols.qty, cols.rate, cols.amt][i];
    const align = i === 3 ? 'right' : 'left';
    doc.text(h, x, y + 7, { width: colWs[i], align });
  });
  y += rowH;

  // Data rows
  lines.forEach((l, i) => {
    doc.fillColor(i % 2 === 0 ? 'white' : GREY).rect(M, y, CW, rowH).fill();
    doc.fillColor('#1a1a1a').font('Helvetica').fontSize(8.5);
    doc.text(l.label, cols.desc + 6, y + 7, { width: CW * 0.44 });
    doc.text(`${l.quantity} day${l.quantity !== 1 ? 's' : ''}`, cols.qty, y + 7);
    doc.text(l.rate != null ? `${symbol}${Number(l.rate).toFixed(2)}` : '—', cols.rate, y + 7);
    doc.text(l.total ? `${symbol}${l.total.toFixed(2)}` : '—', cols.amt, y + 7, { width: CW * 0.18, align: 'right' });
    y += rowH;
  });

  // Overtime row
  doc.fillColor(lines.length % 2 === 0 ? 'white' : GREY).rect(M, y, CW, rowH).fill();
  doc.fillColor('#1a1a1a').font('Helvetica').fontSize(8.5);
  doc.text('Overtime', cols.desc + 6, y + 7);
  doc.text('See rotation detail', cols.qty, y + 7);
  doc.text('—', cols.rate, y + 7);
  doc.text(`${symbol}0.00`, cols.amt, y + 7, { width: CW * 0.18, align: 'right' });
  y += rowH;

  doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(1).strokeColor(NAVY).stroke();
  y += 4;

  // Subtotal + VAT rows
  [['Subtotal', subtotal], ['VAT (0% — Reversed Charge)', 0]].forEach(([label, val]) => {
    doc.fillColor(GREY).rect(M, y, CW, 20).fill();
    doc.fillColor('#333').font('Helvetica').fontSize(8.5);
    doc.text(label, cols.rate, y + 6, { width: CW * 0.36 });
    doc.text(`${symbol}${val.toFixed(2)}`, cols.amt, y + 6, { width: CW * 0.18, align: 'right' });
    y += 20;
  });
  y += 2;

  // Total
  doc.fillColor(NAVY).rect(M, y, CW, 28).fill();
  doc.fillColor('white').font('Helvetica-Bold').fontSize(10);
  doc.text('TOTAL DUE', cols.desc + 6, y + 9);
  doc.text(`${symbol}${grandTotal.toFixed(2)}`, cols.amt, y + 9, { width: CW * 0.18, align: 'right' });
  y += 36;

  // Payment information
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text('PAYMENT INFORMATION', M, y);
  y += 12;
  doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(0.5).strokeColor(LGREY).stroke();
  y += 8;

  const payRows = [
    ['Account Name', accountName || fromName, 'Currency',  currency],
    ['IBAN',         iban || 'Not provided',   'BIC/SWIFT', bic || 'Not provided'],
    ['Reference',    invoiceNumber,             '',          ''],
  ];
  payRows.forEach(([l1, v1, l2, v2]) => {
    doc.fillColor(MGREY).font('Helvetica-Bold').fontSize(7).text(l1, M, y);
    doc.fillColor('#333').font('Helvetica').fontSize(8.5).text(v1, M + 80, y, { width: CW/2 - 90 });
    doc.fillColor(MGREY).font('Helvetica-Bold').fontSize(7).text(l2, col2, y);
    doc.fillColor('#333').font('Helvetica').fontSize(8.5).text(v2, col2 + 80, y, { width: CW/2 - 90 });
    y += 14;
  });
  y += 8;

  // Footer note
  doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(0.5).strokeColor(LGREY).stroke();
  y += 8;
  const note = isConcept
    ? 'CONCEPT INVOICE — This document is a draft. Invoice number will be assigned upon finalization.'
    : `Payment due within 30 days. Please reference ${invoiceNumber} in your payment.`;
  doc.fillColor(MGREY).font('Helvetica').fontSize(7.5).text(note, M, y, { width: CW });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /invoice/assign-number/:placementId/:periodId
// ─────────────────────────────────────────────────────────────────────────────
router.post('/assign-number/:placementId/:periodId', requireAuth, async (req, res, next) => {
  try {
    const { placementId, periodId } = req.params;
    const { data: status } = await adminSupabase
      .from('roster_period_status').select('status')
      .eq('placement_id', placementId).eq('period_id', periodId).single();
    if (status?.status !== 'definite') throw new ApiError('Status must be definite to assign invoice number', 400);

    const year = new Date().getFullYear();
    const { data: seqNum } = await adminSupabase.rpc('next_invoice_number', { p_year: year });
    const invNumber = `INV-${year}-${String(seqNum).padStart(4, '0')}`;

    await adminSupabase.from('roster_invoices').upsert({
      placement_id: placementId, period_id: periodId,
      invoice_number: invNumber,
      invoice_date: new Date().toISOString().split('T')[0],
      due_date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
      is_concept: false,
    }, { onConflict: 'placement_id,period_id' });

    res.json({ invoice_number: invNumber });
  } catch(err) { next(err); }
});

export default router;
