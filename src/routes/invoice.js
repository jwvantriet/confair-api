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
router.get('/pdf/:placementId/:periodId', async (req, res, next) => {
  // Allow placement users to generate their own invoice, or agency/company admins
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try {
    const { data: { user } } = await adminSupabase.auth.getUser(authHeader.slice(7));
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    const { data: profile } = await adminSupabase.from('user_profiles')
      .select('id, role, is_active').eq('id', user.id).single();
    if (!profile?.is_active) return res.status(403).json({ error: 'Account inactive' });
    // Placement users can only access their own invoice
    if (profile.role === 'placement') {
      const { data: p } = await adminSupabase.from('placements')
        .select('id').eq('user_profile_id', user.id).maybeSingle();
      if (!p || p.id !== req.params.placementId) return res.status(403).json({ error: 'Access denied' });
    } else if (!['agency_admin','agency_operations','company_admin','company_user'].includes(profile.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    req.user = { ...user, ...profile };
  } catch (e) { return res.status(401).json({ error: 'Auth failed' }); }
  try {
    const { placementId, periodId } = req.params;

    // Fetch placement first (need carerix_job_id)
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

    // ── Fetch live Carerix data for FROM / BILL TO ────────────────────────────
    let carerixData = null;
    if (placement.carerix_job_id) {
      try {
        const cxFetch = async () => {
          const { queryGraphQL } = await import('../services/carerix.js');
          const safeQ = async (q, vars) => {
            try { const r = await queryGraphQL(q, vars); return r?.data || null; }
            catch(e) { return null; }
          };

          // 1. Job + office in one query
          const jobData = await safeQ(
            'query J($id:ID!){ crJob(_id:$id){ _id jobID name additionalInfo additionalInfoList toCompany{_id companyID name} toEmployee{_id employeeID} } }',
            { id: String(placement.carerix_job_id) }
          );
          const job = jobData?.crJob;
          if (!job) return null;

          // 2. Employee — address + banking (parallel with office)
          const empId = job.toEmployee?._id;

          // Office via separate query (toOffice on crJob causes 400 when combined)
          let officeId = null;
          const offQ = await safeQ('query J($id:ID!){ crJob(_id:$id){ toOffice{_id name} } }', { id: String(placement.carerix_job_id) });
          officeId = offQ?.crJob?.toOffice?._id;
          if (!officeId) {
            const vacQ = await safeQ('query J($id:ID!){ crJob(_id:$id){ toVacancy{ toOffice{_id name} } } }', { id: String(placement.carerix_job_id) });
            officeId = vacQ?.crJob?.toVacancy?.toOffice?._id;
          }

          const [empData, officeData] = await Promise.all([
            empId ? safeQ(
              'query E($id:ID!){ crEmployee(_id:$id){ _id employeeID firstName lastName name paymentIbanCode paymentBicCode paymentAccountName homeFullAddress homeStreet homeNumber homeNumberSuffix homePostalCode homeCity toHomeCountryNode{value} } }',
              { id: String(empId) }
            ) : Promise.resolve(null),
            officeId ? safeQ('query O($id:ID!){ crOffice(_id:$id){ _id name } }', { id: String(officeId) })
              .then(async r => {
                const off = r?.crOffice;
                if (!off) return null;
                // Try address fields
                for (const q of [
                  'query O($id:ID!){ crOffice(_id:$id){ city postalCode street number toCountryNode{value} emailAddress vatNumber } }',
                  'query O($id:ID!){ crOffice(_id:$id){ visitCity visitPostalCode visitStreet visitNumber toVisitCountryNode{value} } }',
                  'query O($id:ID!){ crOffice(_id:$id){ homeCity homePostalCode homeStreet homeNumber toHomeCountryNode{value} } }',
                ]) {
                  const a = await safeQ(q, { id: String(officeId) });
                  if (a?.crOffice) { Object.assign(off, a.crOffice); break; }
                }
                return off;
              })
              : Promise.resolve(null),
          ]);

          // 3. Parse additionalInfo
          const ai = {};
          for (const [k, v] of Object.entries(job.additionalInfo || {}))
            if (v != null && v !== '') ai[k.replace(/^_/, '')] = v;

          return { job, employee: empData?.crEmployee || null, office: officeData, ai };
        };

        // Race against 12s timeout
        carerixData = await Promise.race([
          cxFetch(),
          new Promise(resolve => setTimeout(() => resolve(null), 12000)),
        ]);

        logger.info('Invoice: Carerix data', {
          jobId: placement.carerix_job_id,
          empId: carerixData?.job?.toEmployee?._id,
          officeId: carerixData?.job?.toOffice?._id,
          hasIban: !!carerixData?.employee?.paymentIbanCode,
          aiKeys: Object.keys(carerixData?.ai || {}),
        });
      } catch (cxErr) {
        logger.warn('Invoice: Carerix fetch failed', { error: cxErr.message });
      }
    }

    // ── FROM: contractor details (reversed billing) ───────────────────────────
    const emp = carerixData?.employee;
    const ai  = carerixData?.ai || {};
    const legalName = ai['10278'] || ai['_10278'] || null;
    const vatNumber = ai['10978'] || ai['_10978'] || null;

    let fromName, fromAddr, fromVat;
    // Build address lines — homeFullAddress is the primary street line in Carerix
    const addrLine1 = emp?.homeFullAddress || (emp?.homeStreet ? `${emp.homeStreet} ${emp.homeNumber || ''}`.trim() : '');
    const addrParts = [addrLine1, emp?.homePostalCode || '', emp?.homeCity || '', emp?.toHomeCountryNode?.value || ''].filter(Boolean);
    const empAddr   = addrParts.join(', ');

    if (legalName) {
      fromName = legalName;
      fromVat  = vatNumber ? `VAT: ${vatNumber}` : '';
      fromAddr = empAddr;
    } else {
      fromName = emp ? (`${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp?.name || placement.full_name) : placement.full_name;
      fromVat  = '';
      fromAddr = empAddr;
    }

    // Banking details from Carerix
    const iban          = emp?.paymentIbanCode || '';
    const bic           = emp?.paymentBicCode  || '';
    const accountName   = emp?.paymentAccountName || fromName;

    // ── BILL TO: company connected to job ────────────────────────────────────
    const cxCo = carerixData?.cxCompany;
    // BILL TO — office linked to vacancy (reversed billing)
    const office = carerixData?.office;
    const companyName = office?.name || placement.companies?.name || 'Client';
    const companyAddr = [
      office?.street  ? `${office.street} ${office.number || ''}`.trim() : (office?.visitStreet ? `${office.visitStreet} ${office.visitNumber || ''}`.trim() : (office?.homeStreet || '')),
      office?.postalCode || office?.visitPostalCode || office?.homePostalCode || '',
      office?.city || office?.visitCity || office?.homeCity || '',
      office?.toCountryNode?.value || office?.toVisitCountryNode?.value || office?.toHomeCountryNode?.value || '',
    ].filter(Boolean).join(', ');
    const companyVat = office?.vatNumber ? `VAT: ${office.vatNumber}` : '';

    // ── Aggregate charges ─────────────────────────────────────────────────────
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
    const subtotal   = lines.reduce((s, l) => s + (l.total || 0), 0);
    const vatRate    = 0; // 0% VAT — reversed charge
    const vatAmount  = subtotal * vatRate;
    const grandTotal = subtotal + vatAmount;

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthLabel = `${MONTHS[period.month - 1]} ${period.year}`;

    const crewId   = placement.crew_id || '';
    const crewName = fromName;

    // Generate PDF with PDFKit
    const PDFDocument = (await import('pdfkit')).default;
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${invoiceNumber}`, Author: 'Confair' } });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));

    await new Promise((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
      buildPDF(doc, { isConcept, invoiceNumber, invoiceDate, monthLabel,
        fromName, fromAddr, fromVat,
        companyName, companyAddr, companyVat,
        iban, bic, accountName,
        crewId, crewName,
        lines, symbol, subtotal, vatRate, vatAmount, grandTotal, currency });
      doc.end();
    });

    const pdfBuffer = Buffer.concat(chunks);
    const safeName = (fromName || crewName).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
    const filename = isConcept
      ? `CONCEPT_Invoice_${safeName}_${monthLabel.replace(' ', '_')}.pdf`
      : `Invoice_${invoiceNumber}_${safeName}_${monthLabel.replace(' ', '_')}.pdf`;

    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': pdfBuffer.length });
    res.send(pdfBuffer);

  } catch (err) { next(err); }
});

// ── PDF builder ────────────────────────────────────────────────────────────────
function buildPDF(doc, { isConcept, invoiceNumber, invoiceDate, monthLabel,
  fromName, fromAddr, fromVat,
  companyName, companyAddr, companyVat,
  iban, bic, accountName,
  crewId, crewName,
  lines, symbol, subtotal, vatRate, vatAmount, grandTotal, currency }) {
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

  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text(fromName || 'Contractor', M, y);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9).text(companyName, col2X, y);
  y += 13;

  doc.fillColor('#333').font('Helvetica').fontSize(8.5).text(fromAddr || '', M, y, { width: CW/2 - 10 });
  doc.fillColor('#333').font('Helvetica').fontSize(8.5).text(companyAddr || '', col2X, y, { width: CW/2 - 10 });
  y += 12;
  if (fromVat) { doc.font('Helvetica').fontSize(8).fillColor(MGREY).text(fromVat, M, y); }
  if (companyVat) { doc.font('Helvetica').fontSize(8).fillColor(MGREY).text(companyVat, col2X, y); }
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
    ['Account Name', accountName || fromName || '',  'Currency',  currency],
    ['IBAN',         iban || 'Not provided',          'BIC/SWIFT', bic || 'Not provided'],
    ['Reference',    invoiceNumber,                   'VAT',       vatRate === 0 ? '0% (Reversed Charge)' : `${vatRate * 100}%`],
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
