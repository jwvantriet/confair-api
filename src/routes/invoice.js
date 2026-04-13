/**
 * Invoice generation route
 * GET  /invoice/pdf/:placementId/:periodId  — generate concept or final PDF
 * POST /invoice/assign-number/:placementId/:periodId — assign invoice number (definite only)
 */
import { Router }      from 'express';
import { adminSupabase } from '../services/supabase.js';
import { requireAuth }   from '../middleware/auth.js';
import { ApiError }      from '../middleware/errorHandler.js';
import { logger }        from '../utils/logger.js';
import { execFile }      from 'child_process';
import { promisify }     from 'util';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir }        from 'os';
import { join }          from 'path';

const router      = Router();
const execFileP   = promisify(execFile);

// ── GET /invoice/pdf/:placementId/:periodId ───────────────────────────────────
router.get('/pdf/:placementId/:periodId', requireAuth, async (req, res, next) => {
  try {
    const { placementId, periodId } = req.params;

    // 1. Fetch placement first (need company_id), then rest in parallel
    const { data: placement } = await adminSupabase
      .from('placements').select('*, companies(*)').eq('id', placementId).single();

    if (!placement) throw new ApiError('Placement not found', 404);

    const [
      { data: period },
      { data: chargeItems },
      { data: status },
      { data: company },
    ] = await Promise.all([
      adminSupabase.from('payroll_periods').select('*').eq('id', periodId).single(),
      adminSupabase.from('charge_items')
        .select('*, charge_types(code, label, sort_order)')
        .eq('placement_id', placementId)
        .eq('period_id', periodId)
        .order('charge_date'),
      adminSupabase.from('roster_period_status')
        .select('*, roster_invoices(*)')
        .eq('placement_id', placementId)
        .eq('period_id', periodId)
        .single(),
      adminSupabase.from('companies')
        .select('*')
        .eq('id', placement.company_id)
        .single(),
    ]);

    if (!period) throw new ApiError('Period not found', 404);

    const isConcept = !status?.roster_invoices?.invoice_number;
    const invoiceNumber = status?.roster_invoices?.invoice_number || 'CONCEPT';
    const invoiceDate   = status?.roster_invoices?.invoice_date
      ? new Date(status.roster_invoices.invoice_date).toLocaleDateString('en-GB')
      : new Date().toLocaleDateString('en-GB');

    // 2. Aggregate charge items by code
    const chargeMap = {};
    for (const ci of chargeItems || []) {
      const code = ci.charge_types?.code;
      if (!code) continue;
      if (!chargeMap[code]) {
        chargeMap[code] = {
          label:    ci.charge_types?.label || code,
          quantity: 0,
          rate:     ci.rate_per_unit ? Number(ci.rate_per_unit) : null,
          currency: ci.currency || 'EUR',
          total:    0,
        };
      }
      chargeMap[code].quantity += Number(ci.quantity || 0);
      if (ci.total_amount) chargeMap[code].total += Number(ci.total_amount);
    }

    // Ordered charge lines
    const DISPLAY_ORDER = [
      'DailyAllowance', 'AvailabilityPremium', 'YearsWithClient',
      'PerDiem', 'SoldOffDay', 'BODDays', 'Overtime',
    ];
    const lines = DISPLAY_ORDER
      .map(code => chargeMap[code])
      .filter(Boolean)
      .filter(l => l.quantity > 0 || l.code === 'Overtime');

    const currency = lines.find(l => l.currency)?.currency || 'EUR';
    const symbol   = currency === 'USD' ? '$' : '€';
    const grandTotal = lines.reduce((s, l) => s + (l.total || 0), 0);

    // 3. Build month string for description
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthLabel = `${MONTHS[period.month - 1]} ${period.year}`;

    // 4. Write Python PDF generator script
    const pyScript = buildPyScript({
      isConcept, invoiceNumber, invoiceDate,
      placement, company, period, monthLabel,
      lines, currency, symbol, grandTotal,
    });

    const tmpPy  = join(tmpdir(), `inv_${placementId}_${Date.now()}.py`);
    const tmpPdf = join(tmpdir(), `inv_${placementId}_${Date.now()}.pdf`);
    writeFileSync(tmpPy, pyScript, 'utf8');

    try {
      await execFileP('python3', [tmpPy, tmpPdf], { timeout: 15000 });
    } catch (pyErr) {
      logger.error('PDF generation failed', { error: pyErr.message, stderr: pyErr.stderr });
      throw new ApiError('PDF generation failed: ' + pyErr.message, 500);
    }

    const pdfBytes = readFileSync(tmpPdf);
    unlinkSync(tmpPy);
    unlinkSync(tmpPdf);

    const filename = isConcept
      ? `CONCEPT_Invoice_${placement.full_name}_${monthLabel.replace(' ', '_')}.pdf`
      : `Invoice_${invoiceNumber}_${placement.full_name}_${monthLabel.replace(' ', '_')}.pdf`;

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      pdfBytes.length,
    });
    res.send(pdfBytes);
  } catch (err) { next(err); }
});

// ── POST /invoice/assign-number/:placementId/:periodId ────────────────────────
// Only allowed when status = definite
router.post('/assign-number/:placementId/:periodId', requireAuth, async (req, res, next) => {
  try {
    const { placementId, periodId } = req.params;

    const { data: status } = await adminSupabase
      .from('roster_period_status')
      .select('status')
      .eq('placement_id', placementId)
      .eq('period_id', periodId)
      .single();

    if (status?.status !== 'definite')
      throw new ApiError('Invoice number can only be assigned when status is definite', 400);

    // Get next sequence number
    const year = new Date().getFullYear();
    const { data: seq, error: seqErr } = await adminSupabase
      .from('invoice_sequences')
      .update({ last_number: adminSupabase.rpc('increment_invoice_sequence', { p_year: year }) })
      .eq('prefix', 'INV').eq('year', year)
      .select('last_number').single();

    // Simpler: raw increment via SQL
    const { data: seqData } = await adminSupabase.rpc('next_invoice_number', { p_year: year });
    const invNumber = `INV-${year}-${String(seqData).padStart(4, '0')}`;

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

// ── Python PDF script builder ─────────────────────────────────────────────────
function buildPyScript({ isConcept, invoiceNumber, invoiceDate, placement, company, period, monthLabel, lines, currency, symbol, grandTotal }) {
  const companyName = company?.name || placement?.companies?.name || 'Client';
  const companyAddr = company?.address || '';
  const placementName = placement?.full_name || '';
  const crewId = placement?.crew_id || '';

  // Serialize lines as Python list
  const pyLines = lines.map(l =>
    `{"label": ${JSON.stringify(l.label)}, "qty": ${l.quantity}, "rate": ${l.rate ?? 'None'}, "total": ${l.total ?? 0}}`
  ).join(',\n    ');

  return `
import sys
import os
sys.path.insert(0, '/usr/local/lib/python3/dist-packages')
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT, TA_CENTER

output_path = sys.argv[1]

# ── Colours ──────────────────────────────────────────────────────────────────
NAVY    = colors.HexColor('#1e2d4a')
GREY    = colors.HexColor('#f4f5f7')
LGREY   = colors.HexColor('#e8eaed')
MGREY   = colors.HexColor('#8a9bb0')
WHITE   = colors.white
BLACK   = colors.HexColor('#1a1a1a')

W, H = A4
M = 18*mm  # margin

# ── Styles ────────────────────────────────────────────────────────────────────
def sty(name, font='Helvetica', size=9, color=BLACK, **kw):
    return ParagraphStyle(name, fontName=font, fontSize=size, textColor=color, leading=size*1.4, **kw)

S_TITLE     = sty('title',   font='Helvetica-Bold', size=22, color=NAVY)
S_LABEL     = sty('label',   font='Helvetica-Bold', size=7.5, color=MGREY, spaceAfter=1)
S_BODY      = sty('body',    size=8.5)
S_BODY_B    = sty('bodyb',   font='Helvetica-Bold', size=8.5)
S_R         = sty('right',   size=8.5, alignment=TA_RIGHT)
S_R_B       = sty('rightb',  font='Helvetica-Bold', size=8.5, alignment=TA_RIGHT)
S_CONCEPT   = sty('concept', font='Helvetica-Bold', size=10, color=colors.HexColor('#cc4444'), alignment=TA_RIGHT)
S_TOTAL_L   = sty('totl',    font='Helvetica-Bold', size=10, color=WHITE)
S_TOTAL_R   = sty('totr',    font='Helvetica-Bold', size=10, color=WHITE, alignment=TA_RIGHT)
S_SECTION   = sty('sect',    font='Helvetica-Bold', size=8.5, color=NAVY, spaceBefore=6)
S_NOTE      = sty('note',    size=8, color=MGREY)

# ── Document ──────────────────────────────────────────────────────────────────
doc = SimpleDocTemplate(
    output_path, pagesize=A4,
    leftMargin=M, rightMargin=M, topMargin=M, bottomMargin=M,
)
story = []
col_w = (W - 2*M)

# ── Header ─────────────────────────────────────────────────────────────────── 
header_data = [
    [Paragraph('INVOICE', S_TITLE),
     Paragraph(${'${JSON.stringify(isConcept ? "CONCEPT" : "")}'}, S_CONCEPT)],
]
header_tbl = Table(header_data, colWidths=[col_w * 0.6, col_w * 0.4])
header_tbl.setStyle(TableStyle([
    ('VALIGN',     (0,0), (-1,-1), 'MIDDLE'),
    ('TOPPADDING', (0,0), (-1,-1), 0),
    ('BOTTOMPADDING', (0,0), (-1,-1), 4*mm),
]))
story.append(header_tbl)

# ── Divider ────────────────────────────────────────────────────────────────── 
story.append(HRFlowable(width=col_w, thickness=2, color=NAVY, spaceAfter=4*mm))

# ── FROM / BILL TO ─────────────────────────────────────────────────────────── 
from_col = [
    Paragraph('FROM', S_LABEL),
    Paragraph('Confair BV', S_BODY_B),
    Paragraph('Eindhoven, Netherlands', S_BODY),
    Paragraph('finance@confair.com', S_BODY),
]
bill_col = [
    Paragraph('BILL TO', S_LABEL),
    Paragraph(${JSON.stringify(companyName)}, S_BODY_B),
    Paragraph(${JSON.stringify(companyAddr)}, S_BODY),
    Paragraph('', S_BODY),
]
from_tbl = Table([[from_col, bill_col]], colWidths=[col_w*0.5, col_w*0.5])
from_tbl.setStyle(TableStyle([
    ('VALIGN', (0,0), (-1,-1), 'TOP'),
    ('TOPPADDING', (0,0), (-1,-1), 0),
    ('BOTTOMPADDING', (0,0), (-1,-1), 4*mm),
]))
story.append(from_tbl)

# ── Invoice meta ────────────────────────────────────────────────────────────── 
meta_data = [
    [Paragraph('Invoice Number', S_LABEL), Paragraph(${JSON.stringify(invoiceNumber)}, S_BODY_B if not ${isConcept} else S_BODY),
     Paragraph('Invoice Date', S_LABEL),   Paragraph(${JSON.stringify(invoiceDate)}, S_BODY_B)],
    [Paragraph('Crew ID', S_LABEL),        Paragraph(${JSON.stringify(crewId)}, S_BODY),
     Paragraph('Period', S_LABEL),         Paragraph(${JSON.stringify(monthLabel)}, S_BODY)],
    [Paragraph('Contractor', S_LABEL),     Paragraph(${JSON.stringify(placementName)}, S_BODY),
     Paragraph('', S_LABEL),               Paragraph('', S_BODY)],
]
meta_bg = colors.HexColor('#f9f9fb')
meta_tbl = Table(meta_data, colWidths=[col_w*0.15, col_w*0.35, col_w*0.15, col_w*0.35])
meta_tbl.setStyle(TableStyle([
    ('BACKGROUND', (0,0), (-1,-1), meta_bg),
    ('ROWBACKGROUNDS', (0,0), (-1,-1), [meta_bg, WHITE]),
    ('TOPPADDING',    (0,0), (-1,-1), 3),
    ('BOTTOMPADDING', (0,0), (-1,-1), 3),
    ('LEFTPADDING',   (0,0), (-1,-1), 6),
    ('RIGHTPADDING',  (0,0), (-1,-1), 6),
    ('BOX',           (0,0), (-1,-1), 0.5, LGREY),
    ('INNERGRID',     (0,0), (-1,-1), 0.25, LGREY),
]))
story.append(meta_tbl)
story.append(Spacer(1, 5*mm))

# ── Line items ─────────────────────────────────────────────────────────────── 
symbol = ${JSON.stringify(symbol)}

line_items = [
    ${pyLines}
]

# Header row
rows = [[
    Paragraph('Description', S_BODY_B),
    Paragraph('Qty', S_BODY_B),
    Paragraph('Rate', S_BODY_B),
    Paragraph('Amount', S_R_B),
]]

for item in line_items:
    qty    = item["qty"]
    rate   = item["rate"]
    total  = item["total"]
    label  = item["label"]
    qty_s  = str(int(qty)) if qty == int(qty) else str(qty)
    rate_s = f'{symbol}{rate:.2f}' if rate is not None else '—'
    tot_s  = f'{symbol}{total:.2f}' if total else '—'
    rows.append([
        Paragraph(label, S_BODY),
        Paragraph(qty_s + ' day' + ('s' if qty != 1 else ''), S_BODY),
        Paragraph(rate_s, S_BODY),
        Paragraph(tot_s, S_R),
    ])

col_ws = [col_w*0.45, col_w*0.18, col_w*0.18, col_w*0.19]
items_tbl = Table(rows, colWidths=col_ws, repeatRows=1)
items_tbl.setStyle(TableStyle([
    ('BACKGROUND',    (0,0),  (-1,0),  NAVY),
    ('TEXTCOLOR',     (0,0),  (-1,0),  WHITE),
    ('FONTNAME',      (0,0),  (-1,0),  'Helvetica-Bold'),
    ('FONTSIZE',      (0,0),  (-1,0),  8.5),
    ('ROWBACKGROUNDS',(0,1), (-1,-1), [WHITE, GREY]),
    ('TOPPADDING',    (0,0),  (-1,-1), 5),
    ('BOTTOMPADDING', (0,0),  (-1,-1), 5),
    ('LEFTPADDING',   (0,0),  (-1,-1), 6),
    ('RIGHTPADDING',  (0,0),  (-1,-1), 6),
    ('LINEBELOW',     (0,-1), (-1,-1), 1, NAVY),
    ('VALIGN',        (0,0),  (-1,-1), 'MIDDLE'),
]))
story.append(items_tbl)
story.append(Spacer(1, 4*mm))

# ── Total row ─────────────────────────────────────────────────────────────────
grand_total = ${grandTotal}
total_row = Table([
    ['', '', Paragraph('TOTAL DUE', S_TOTAL_L),
     Paragraph(f'{symbol}{grand_total:.2f}', S_TOTAL_R)],
], colWidths=col_ws)
total_row.setStyle(TableStyle([
    ('BACKGROUND',    (0,0), (-1,-1), NAVY),
    ('TOPPADDING',    (0,0), (-1,-1), 6),
    ('BOTTOMPADDING', (0,0), (-1,-1), 6),
    ('LEFTPADDING',   (0,0), (-1,-1), 6),
    ('RIGHTPADDING',  (0,0), (-1,-1), 6),
]))
story.append(total_row)
story.append(Spacer(1, 6*mm))

# ── Payment information ──────────────────────────────────────────────────────
story.append(Paragraph('PAYMENT INFORMATION', S_SECTION))
story.append(HRFlowable(width=col_w, thickness=1, color=LGREY, spaceAfter=2*mm))

pay_data = [
    [Paragraph('Bank', S_LABEL),          Paragraph('ING Bank N.V.', S_BODY),
     Paragraph('Account Name', S_LABEL),   Paragraph('Confair BV', S_BODY)],
    [Paragraph('IBAN', S_LABEL),           Paragraph('NL00 INGB 0000 0000 00', S_BODY),
     Paragraph('BIC/SWIFT', S_LABEL),      Paragraph('INGBNL2A', S_BODY)],
    [Paragraph('Reference', S_LABEL),      Paragraph(${JSON.stringify(invoiceNumber)}, S_BODY),
     Paragraph('Currency', S_LABEL),       Paragraph(${JSON.stringify(currency)}, S_BODY)],
]
pay_tbl = Table(pay_data, colWidths=[col_w*0.15, col_w*0.35, col_w*0.15, col_w*0.35])
pay_tbl.setStyle(TableStyle([
    ('TOPPADDING',    (0,0), (-1,-1), 3),
    ('BOTTOMPADDING', (0,0), (-1,-1), 3),
    ('LEFTPADDING',   (0,0), (-1,-1), 6),
    ('RIGHTPADDING',  (0,0), (-1,-1), 6),
    ('INNERGRID',     (0,0), (-1,-1), 0.25, LGREY),
]))
story.append(pay_tbl)
story.append(Spacer(1, 4*mm))

# ── Note ────────────────────────────────────────────────────────────────────── 
if ${isConcept}:
    story.append(Paragraph(
        'CONCEPT INVOICE — This document is a draft and does not constitute a formal invoice. '
        'The invoice number will be assigned upon finalization.',
        S_NOTE))
else:
    story.append(Paragraph(
        f'Payment is due within 30 days of invoice date. Please reference invoice number {${JSON.stringify(invoiceNumber)}} in your payment.',
        S_NOTE))

doc.build(story)
print("PDF generated:", output_path)
`;
}

export default router;
