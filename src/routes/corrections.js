'use client';
import { useState, useRef } from 'react';
import { api } from '@/lib/api';

const CHARGE_CODES = [
  { code: 'DA',  label: 'DA',  full: 'Daily Allowance' },
  { code: 'AP',  label: 'AP',  full: 'Availability Premium' },
  { code: 'YWC', label: 'YWC', full: 'Years With Client' },
  { code: 'PD',  label: 'PD',  full: 'Per Diem' },
  { code: 'HD',  label: 'HD',  full: 'Hard Day' },
  { code: 'BD',  label: 'BD',  full: 'BOD Day' },
];

function parseHHMM(val: string): number | null {
  const m = val.match(/^(\d{1,3}):([0-5]\d)$/);
  if (!m) return null;
  return parseInt(m[1]) + parseInt(m[2]) / 60;
}

interface Props {
  date:         string;
  colSpan:      number;
  periodId:     string;
  placementId:  string;
  isRotationEnd?: boolean;
  onSuccess:    () => void;
  onCancel:     () => void;
}

export default function InlineCorrectionRow({
  date, colSpan, periodId, placementId, isRotationEnd, onSuccess, onCancel
}: Props) {
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set());
  const [blhHHMM,  setBlhHHMM]    = useState('');
  const [rotEnd,   setRotEnd]      = useState(false);
  const [comment,  setComment]     = useState('');
  const [file,     setFile]        = useState<File | null>(null);
  const [saving,   setSaving]      = useState(false);
  const [error,    setError]       = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading]    = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const toggleCode = (code: string) =>
    setSelectedCodes(prev => { const n = new Set(prev); n.has(code) ? n.delete(code) : n.add(code); return n; });

  const blhDecimal = blhHHMM ? parseHHMM(blhHHMM) : null;

  const submit = async () => {
    if (selectedCodes.size === 0 && !blhHHMM && !comment.trim()) {
      setError('Select at least one charge, enter BLH, or add a comment'); return;
    }
    setSaving(true); setError('');
    try {
      let attachmentUrl  = null;
      let attachmentName = null;

      // Upload attachment as base64
      if (file) {
        setUploading(true); setUploadError('');
        try {
          const base64 = await new Promise<string>((res, rej) => {
            const r = new FileReader();
            r.onload = () => res((r.result as string).split(',')[1]);
            r.onerror = rej;
            r.readAsDataURL(file);
          });
          const up = await api.post('/corrections/upload', {
            fileBase64: base64, fileName: file.name,
            mimeType: file.type, placementId, date,
          });
          attachmentUrl  = up.data.url;
          attachmentName = up.data.name;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Upload failed';
          setUploadError(msg.includes('mime') ? 'Unsupported file type (use JPG, PNG or PDF)' : 'Upload failed');
        } finally { setUploading(false); }
      }

      await api.post('/corrections', {
        placement_id:               placementId,
        period_id:                  periodId,
        correction_date:            date,
        correction_type:            'INLINE',
        charge_codes:               Array.from(selectedCodes),
        reason:                     comment.trim() || 'Inline correction',
        blh_hhmm:                   blhHHMM || null,
        blh_decimal:                blhDecimal,
        is_rotation_end_correction: rotEnd,
        attachment_url:             attachmentUrl,
        attachment_name:            attachmentName,
        status:                     'pending',
      });
      onSuccess();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to submit');
    } finally { setSaving(false); }
  };

  return (
    <tr className="bg-amber-50/60 border-t border-amber-200">
      <td colSpan={colSpan} className="px-0 py-0">
        <div className="px-4 py-3 space-y-3">

          {/* Charge toggles */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-amber-800 mr-1">Claim charges:</span>
            {CHARGE_CODES.map(({ code, label, full }) => (
              <button key={code} onClick={() => toggleCode(code)}
                title={full}
                className={`w-10 h-8 rounded-lg text-xs font-bold border-2 transition-all ${
                  selectedCodes.has(code)
                    ? 'bg-amber-500 border-amber-600 text-white shadow-sm scale-105'
                    : 'bg-white border-navy-200 text-navy-400 hover:border-amber-400 hover:text-amber-600'
                }`}>
                {label}
              </button>
            ))}
          </div>

          {/* BLH override — only on rotation end days */}
          {isRotationEnd && (
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-amber-800 whitespace-nowrap">BLH override:</label>
                <input
                  type="text"
                  value={blhHHMM}
                  onChange={e => setBlhHHMM(e.target.value)}
                  placeholder="HH:MM"
                  pattern="\d+:[0-5]\d"
                  className="w-20 border border-amber-300 rounded-lg px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
                />
                {blhDecimal !== null && (
                  <span className="text-xs text-amber-700 font-mono">= {blhDecimal.toFixed(2)}h</span>
                )}
              </div>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={rotEnd} onChange={e => setRotEnd(e.target.checked)}
                  className="rounded border-amber-300 text-amber-500 focus:ring-amber-400" />
                <span className="text-xs font-semibold text-amber-800">Correct rotation end</span>
              </label>
            </div>
          )}

          {/* Comment */}
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            rows={2}
            placeholder="Add a comment or explain your claim..."
            className="w-full border border-amber-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none bg-white"
          />

          {/* Attachment — prominent separate row */}
          <div>
            <button onClick={() => fileRef.current?.click()}
              className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border-2 border-dashed transition-all text-xs font-semibold ${
                file
                  ? 'border-amber-400 bg-amber-50 text-amber-800'
                  : 'border-amber-200 text-amber-600 hover:border-amber-400 hover:bg-amber-50 bg-white'
              }`}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
              </svg>
              {file ? `📎 ${file.name.substring(0,20)}${file.name.length > 20 ? '…' : ''}` : '📎 Attach proof (optional photo or PDF)'}
            </button>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden"
              onChange={e => setFile(e.target.files?.[0] || null)} />
            {file && !uploading && !uploadError && (
              <button onClick={() => setFile(null)}
                className="text-xs text-amber-600 underline mt-1 w-full text-center">
                Remove attachment
              </button>
            )}
            {uploading && <p className="text-xs text-amber-600 text-center mt-1">Uploading…</p>}
            {uploadError && <p className="text-xs text-red-500 text-center mt-1">{uploadError} — will submit without attachment</p>}
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}

          {/* Actions */}
          <div className="flex gap-2 justify-end">
            <button onClick={onCancel}
              className="px-4 py-1.5 text-xs text-navy-400 border border-navy-200 rounded-lg hover:bg-navy/5 bg-white">
              Cancel
            </button>
            <button onClick={submit} disabled={saving}
              className="px-4 py-1.5 text-xs font-semibold text-white bg-amber-500 hover:bg-amber-600 rounded-lg disabled:opacity-50 transition-colors">
              {saving ? 'Submitting…' : 'Submit Correction →'}
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}
