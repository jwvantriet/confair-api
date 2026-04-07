/**
 * Import routes — Agency only
 *
 * POST /import/declarations   — Upload and process a declaration file (CSV/XLSX)
 * GET  /import/batches        — List import history
 * GET  /import/batches/:id    — Import batch detail and error log
 */

import { Router } from 'express';
import multer from 'multer';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { adminSupabase } from '../services/supabase.js';
import { bulkFetchFees } from '../services/carerix.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { logger } from '../utils/logger.js';

const router = Router();
router.use(requireAuth, requireAgency);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─── POST /import/declarations ────────────────────────────────────────────────

router.post('/declarations', upload.single('file'), async (req, res, next) => {
  try {
    const { payroll_period_id } = req.body;
    if (!payroll_period_id) throw new ApiError('payroll_period_id is required');
    if (!req.file)          throw new ApiError('No file uploaded');

    const ext = req.file.originalname.split('.').pop().toLowerCase();
    let rows;

    // Parse CSV or XLSX
    if (ext === 'csv') {
      const text = req.file.buffer.toString('utf-8');
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: true });
      rows = parsed.data;
    } else if (['xlsx', 'xls'].includes(ext)) {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    } else {
      throw new ApiError('Unsupported file type. Please upload CSV or XLSX.');
    }

    // Create import batch record
    const { data: batch, error: batchError } = await adminSupabase
      .from('import_batches')
      .insert({
        payroll_period_id,
        uploaded_by:    req.user.id,
        file_name:      req.file.originalname,
        row_count_total: rows.length,
        status:         'processing',
      })
      .select()
      .single();
    if (batchError) throw new ApiError(batchError.message);

    // Validate and process rows
    const required = ['placement_ref','company_ref','date','declaration_type','amount'];
    const valid = [], errors = [], skipped = [];

    // Load lookup maps
    const { data: placementMap } = await adminSupabase
      .from('placements')
      .select('id, placement_ref, carerix_placement_id, company_id');
    const { data: companyMap } = await adminSupabase
      .from('companies')
      .select('id, company_ref, carerix_company_id');
    const { data: typeMap } = await adminSupabase
      .from('declaration_types')
      .select('id, code');

    const placements = Object.fromEntries((placementMap || []).map(p => [p.placement_ref, p]));
    const companies  = Object.fromEntries((companyMap || []).map(c => [c.company_ref, c]));
    const types      = Object.fromEntries((typeMap || []).map(t => [t.code, t]));

    for (const [i, row] of rows.entries()) {
      const rowNum = i + 2;

      // Check required columns
      const missing = required.filter(k => row[k] === undefined || row[k] === '');
      if (missing.length) {
        errors.push({ row: rowNum, error: `Missing required columns: ${missing.join(', ')}` });
        continue;
      }

      const placement = placements[row.placement_ref];
      const company   = companies[row.company_ref];
      const type      = types[String(row.declaration_type).toUpperCase()];

      if (!placement) { errors.push({ row: rowNum, error: `Unknown placement_ref: ${row.placement_ref}` }); continue; }
      if (!company)   { errors.push({ row: rowNum, error: `Unknown company_ref: ${row.company_ref}` }); continue; }
      if (!type)      { errors.push({ row: rowNum, error: `Unknown declaration_type: ${row.declaration_type}` }); continue; }

      if (typeof row.amount !== 'number' || row.amount < 0) {
        errors.push({ row: rowNum, error: `Invalid amount: ${row.amount}` });
        continue;
      }

      valid.push({
        payroll_period_id,
        import_batch_id:     batch.id,
        placement_id:        placement.id,
        company_id:          company.id,
        declaration_type_id: type.id,
        entry_date:          row.date,
        imported_amount:     row.amount,
        status:              'imported',
        // Store refs for fee lookup
        _placementRef:       row.placement_ref,
        _companyRef:         row.company_ref,
        _typeCode:           String(row.declaration_type).toUpperCase(),
      });
    }

    // Upsert valid rows (skip duplicates, track skipped count)
    let imported = 0;
    if (valid.length) {
      const insertRows = valid.map(({ _placementRef, _companyRef, _typeCode, ...rest }) => rest);
      const { data: inserted, error: insertError } = await adminSupabase
        .from('declaration_entries')
        .upsert(insertRows, {
          onConflict: 'payroll_period_id,placement_id,declaration_type_id,entry_date',
          ignoreDuplicates: true,
        })
        .select('id');
      if (insertError) throw new ApiError(insertError.message);
      imported = inserted?.length ?? 0;
      const skippedCount = valid.length - imported;

      // Trigger async fee retrieval (non-blocking)
      const referenceDate = rows[0]?.date ?? new Date().toISOString().slice(0, 10);
      bulkFetchFees(
        valid.map(r => ({
          placementRef:      r._placementRef,
          companyRef:        r._companyRef,
          declarationTypeCode: r._typeCode,
        })),
        referenceDate
      ).then(() => logger.info('Fee retrieval complete', { batchId: batch.id }))
       .catch(err => logger.error('Fee retrieval failed', { err: err.message, batchId: batch.id }));
    }

    // Update batch record
    await adminSupabase
      .from('import_batches')
      .update({
        row_count_imported: imported,
        row_count_failed:   errors.length,
        row_count_skipped:  valid.length - imported,
        import_errors:      errors,
        status:             'complete',
        completed_at:       new Date().toISOString(),
      })
      .eq('id', batch.id);

    await writeAuditLog({
      eventType:   'import_declarations',
      actorUserId: req.user.id,
      actorRole:   req.user.role,
      entityType:  'import_batch',
      entityId:    batch.id,
      payload:     { fileName: req.file.originalname, total: rows.length, imported, errors: errors.length },
    });

    res.status(201).json({
      batchId:  batch.id,
      summary:  { total: rows.length, imported, failed: errors.length, skipped: valid.length - imported },
      errors,   // Show validation errors so Agency can fix and re-upload
    });
  } catch (err) { next(err); }
});

// GET /import/batches
router.get('/batches', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase
      .from('import_batches')
      .select('*, payroll_periods(period_ref, month, year)')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new ApiError(error.message);
    res.json(data);
  } catch (err) { next(err); }
});

// GET /import/batches/:id
router.get('/batches/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase
      .from('import_batches')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !data) throw new ApiError('Batch not found', 404);
    res.json(data);
  } catch (err) { next(err); }
});

export default router;
