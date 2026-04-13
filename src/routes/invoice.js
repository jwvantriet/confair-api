'use client';
import React from 'react';
import PayrollProcess from '@/components/PayrollProcess';
import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { getSession } from '@/lib/auth';
import { computeOvertimeData, hhmmToDecimal, roundDec, type DayOTResult } from '@/lib/overtime';

interface Activity {
  ActivityCode:    string;
  ActivityType:    string;
  ActivitySubType: string;
  start_activity:  string;
  end_activity:    string;
  aBLH:            string | null;
  start_base?:     string;
  end_base?:       string;
}

interface ChargeRate { rate: number | null; currency: string; }

interface DayData {
  date:       string;
  isFuture:   boolean;
  isPayable:  boolean;
  activities: Activity[];
  charges:    Record<string, number>;
  chargeRates?: Record<string, ChargeRate>;
}

interface Period {
  id: string; period_ref: string; month: number; year: number;
  start_date: string; end_date: string; status: string;
}

const CHARGE_COLS = [
  { code: 'DailyAllowance',      label: 'DA',  title: 'Daily Allowance'      },
  { code: 'AvailabilityPremium', label: 'AP',  title: 'Availability Premium' },
  { code: 'YearsWithClient',     label: 'YWC', title: 'Years With Client'    },
  { code: 'PerDiem',             label: 'PD',  title: 'Per Diem'             },
  { code: 'SoldOffDay',          label: 'HD',  title: 'Hard Day'             },
  { code: 'BODDays',             label: 'BD',  title: 'Bought Day'           },
];

const SUBTYPE_STYLES: Record<string, string> = {
  DayOff:    'bg-slate-100 text-slate-500',
  Hotel:     'bg-indigo-50 text-indigo-600',
  Transport: 'bg-amber-50 text-amber-600',
  Flight:    'bg-emerald-50 text-emerald-700',
};

// Font Awesome 6 Free — SVG paths (license: https://fontawesome.com/license/free)
const FA = ({ path, vb = "0 0 640 512" }: { path: string; vb?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox={vb} width="16" height="14"
    fill="currentColor" aria-hidden="true" style={{ display:'inline-block', verticalAlign:'middle' }}>
    <path d={path}/>
  </svg>
);

// fa-bed (solid)
const HotelIcon    = () => <FA vb="0 0 640 512" path="M32 32c17.7 0 32 14.3 32 32l0 256 224 0 0-160c0-17.7 14.3-32 32-32l224 0c53 0 96 43 96 96l0 224c0 17.7-14.3 32-32 32s-32-14.3-32-32l0-32-224 0-32 0L64 416l0 32c0 17.7-14.3 32-32 32S0 465.7 0 448L0 64C0 46.3 14.3 32 32 32zm144 96a80 80 0 1 1 0 160 80 80 0 1 1 0-160z"/>;

// fa-plane (solid)
const FlightIcon   = () => <FA vb="0 0 576 512" path="M482.3 192c34.2 0 93.7 29 93.7 64c0 36-59.5 64-93.7 64l-116.6 0L265.2 495.9c-5.7 10-16.3 16.1-27.8 16.1l-56.2 0c-10.6 0-18.3-10.2-15.4-20.4l49-171.6L112 320 68.8 377.6c-3 4-7.8 6.4-12.8 6.4l-42 0c-7.8 0-14-6.3-14-14c0-1.3 .2-2.6 .5-3.9L32 256 .5 145.9c-.4-1.3-.5-2.6-.5-3.9C0 134.3 6.2 128 14 128l42 0c5 0 9.8 2.4 12.8 6.4L112 192l102.9 0-49-171.6C162.9 10.2 170.6 0 181.2 0l56.2 0c11.5 0 22.1 6.2 27.8 16.1L365.7 192l116.6 0z"/>;

// fa-moon (solid)
const DayOffIcon   = () => <FA vb="0 0 384 512" path="M223.5 32C100 32 0 132.3 0 256S100 480 223.5 480c60.6 0 115.5-24.2 155.8-63.4c5-4.9 6.3-12.5 3.1-18.7s-10.1-9.7-17-8.5c-9.8 1.7-19.8 2.6-30.1 2.6c-96.9 0-175.5-78.8-175.5-176c0-65.8 36-123.1 89.3-153.3c6.1-3.5 9.2-10.5 7.7-17.3s-7.3-11.9-14.3-12.2c-6.3-.3-12.6-.4-19-.4z"/>;

// fa-bus (solid)
const TransportIcon = () => <FA vb="0 0 576 512" path="M288 0C422.4 0 512 35.2 512 80l0 16 48 0c8.8 0 16 7.2 16 16l0 32c0 8.8-7.2 16-16 16l-48 0 0 32c17.7 0 32 14.3 32 32l0 192c0 17.7-14.3 32-32 32l0 48c0 8.8-7.2 16-16 16l-64 0c-8.8 0-16-7.2-16-16l0-48-224 0 0 48c0 8.8-7.2 16-16 16l-64 0c-8.8 0-16-7.2-16-16l0-48c-17.7 0-32-14.3-32-32L64 224c0-17.7 14.3-32 32-32l0-32L48 160c-8.8 0-16-7.2-16-16l0-32c0-8.8 7.2-16 16-16l48 0 0-16C96 35.2 153.6 0 288 0zM96 224l0 96 384 0 0-96L96 224zm48 136a40 40 0 1 0 0-80 40 40 0 1 0 0 80zm248-40a40 40 0 1 0 -80 0 40 40 0 1 0 80 0zM96 192l384 0 0-80c0-26.5-85.1-48-192-48S96 85.5 96 112l0 80z"/>;

const SUBTYPE_ICON_COMPONENTS: Record<string, React.ReactNode> = {
  DayOff:    <DayOffIcon />,
  Hotel:     <HotelIcon />,
  Transport: <TransportIcon />,
  Flight:    <FlightIcon />,
};

function fmtTime(iso: string): { time: string; tz: string } {
  if (!iso) return { time: '—', tz: '' };
  try {
    const tzMatch = iso.match(/([+-]\d{2}:\d{2}|Z)$/);
    const tz = tzMatch ? tzMatch[0].replace(':00','').replace('+00','UTC') : '';
    // Parse local time from string directly to avoid UTC conversion
    const timePart = iso.replace(/([+-]\d{2}:\d{2}|Z)$/, '').split('T')[1] || '';
    const time = timePart.slice(0, 5) || '—';
    return { time, tz };
  } catch { return { time: '—', tz: '' }; }
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_NAMES   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function mergeActivities(activities: Activity[]): Activity[] {
  if (!activities.length) return activities;
  const merged: Activity[] = [];
  for (const act of activities) {
    const prev = merged[merged.length - 1];
    if (prev && prev.ActivityCode === act.ActivityCode && prev.end_base === act.start_base) {
      prev.end_activity = act.end_activity;
      prev.end_base     = act.end_base;
      if (!prev.aBLH && act.aBLH) prev.aBLH = act.aBLH;
    } else {
      merged.push({ ...act });
    }
  }
  return merged;
}


export default function PlacementRosterPage() {
  const session = getSession();
  const now = new Date();
  const [year, setYear]     = useState(now.getFullYear());
  const [month, setMonth]   = useState(now.getMonth() + 1);
  const [period, setPeriod] = useState<Period | null>(null);
  const [days, setDays]     = useState<DayData[]>([]);
  const [loading, setLoading] = useState(false);
  const [otData, setOtData]     = useState<Map<string, DayOTResult>>(new Map());
  const [crewNia, setCrewNia]   = useState<string>('');
  const [placementId, setPlacementId]   = useState<string>('');
  const [rosterStatus, setRosterStatus] = useState<Record<string, string | null | boolean> | null>(null);
  const [corrections, setCorrections]   = useState<Array<Record<string, string | null>>>([]);

  useEffect(() => {
    api.get('/payroll/periods').then(r => {
      const p = (r.data as Period[]).find((p: Period) => p.month === month && p.year === year);
      setPeriod(p || null);
    }).catch(() => {});
  }, [month, year]);

  const load = useCallback(() => {
    if (!period?.id) return;
    setLoading(true);
    api.get(`/payroll-roster/my-summary/${period.id}`)
      .then(r => {
        type RosterDay = { activities: Activity[]; is_payable: boolean };
        type ChargeItem = {
          charge_date: string;
          quantity: number;
          rate_per_unit: number | string | null;
          total_amount: number | string | null;
          currency: string | null;
          charge_types: { code: string };
        };
        const rosterMap: Record<string, RosterDay> = r.data.rosterDays || {};
        const chargeItems: ChargeItem[] = r.data.chargeItems || [];
        const start = new Date(period.start_date + 'T12:00:00Z');
        const end   = new Date(period.end_date   + 'T12:00:00Z');
        const today = new Date().toISOString().split('T')[0];
        const result: DayData[] = [];
        for (let cur = new Date(start); cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
          const dateStr = cur.toISOString().split('T')[0];
          const dbDay = rosterMap[dateStr];
          const charges: Record<string, number> = {};
          const chargeRates: Record<string, ChargeRate> = {};
          chargeItems
            .filter(ci => ci.charge_date === dateStr)
            .forEach(ci => { 
              charges[ci.charge_types?.code] = Number(ci.quantity);
              chargeRates[ci.charge_types?.code] = {
                rate: ci.rate_per_unit ? Number(ci.rate_per_unit) : null,
                currency: ci.currency || 'EUR',
              };
            });
          result.push({
            date: dateStr, isFuture: dateStr > today,
            isPayable: dbDay?.is_payable || false,
            activities: dbDay?.activities || [], charges, chargeRates,
          });
        }
        setDays(result);
        if (r.data.placement_id) setPlacementId(r.data.placement_id);
        setRosterStatus(r.data.status || null);
        setCorrections(r.data.corrections || []);
        // crew_nia from roster status or rosterDays (stored during sync)
        const niaSrc = (r.data.status?.notes || '')
          .match(/crew_nia:([A-Z]+)/)?.[1] || '';
        // Fallback: extract from first roster day's activities
        const firstDayActs = Object.values(r.data.rosterDays || {})[0];
        const niaDerived = niaSrc || (firstDayActs as {crew_nia?: string})?.crew_nia || '';
        setCrewNia(niaDerived);
        const ot = computeOvertimeData(result, niaDerived, 0);
        setOtData(ot);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const changeMonth = (delta: number) => {
    let m = month + delta, y = year;
    if (m > 12) { m = 1; y++; }
    if (m < 1)  { m = 12; y--; }
    setMonth(m); setYear(y);
  };

  // Total BLH for period
  const totalBLH = days.reduce((sum, d) => {
    return sum + (d.activities || []).reduce((s, a) => {
      return s + (a.ActivityType?.toUpperCase() === 'FLIGHT' && a.aBLH ? hhmmToDecimal(a.aBLH) : 0);
    }, 0);
  }, 0);

  const totalOT = Array.from(otData.values()).reduce((s, d) => s + (d.rotationOT || 0), 0);

  return (
    <div className="p-3 sm:p-6 max-w-full">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4 sm:mb-6">
        <div>
          <h1 className="font-heading font-bold text-navy text-xl sm:text-2xl">My Payroll</h1>
          <p className="text-navy-400 text-sm font-light mt-0.5">
            {session?.user?.displayName || 'Crew member'} · Day-by-day activity overview
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button onClick={() => changeMonth(-1)} className="w-8 h-8 flex items-center justify-center rounded-lg border border-navy-100 hover:bg-navy-50 text-navy">‹</button>
          <span className="font-heading font-semibold text-navy w-36 text-center">{MONTH_NAMES[month - 1]} {year}</span>
          <button onClick={() => changeMonth(1)} className="w-8 h-8 flex items-center justify-center rounded-lg border border-navy-100 hover:bg-navy-50 text-navy">›</button>
        </div>
      </div>

      {period ? (
        <div className="flex items-center gap-2 mb-5 text-navy-400 text-xs">
          <span>{new Date(period.start_date).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}</span>
          <span>–</span>
          <span>{new Date(period.end_date).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}</span>
          {totalOT > 0 && (
            <span className="ml-2 bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">
              ⚡ OT: {roundDec(totalOT).toFixed(2)}h
            </span>
          )}
        </div>
      ) : (
        <div className="bg-yellow-50 border border-yellow-100 rounded-xl p-4 mb-5 text-sm text-yellow-800">
          No period found for {MONTH_NAMES[month - 1]} {year}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-8 h-8 border-2 border-navy/20 border-t-navy rounded-full animate-spin" />
        </div>
      ) : days.length === 0 ? (
        <div className="text-center py-20 text-navy-400">
          <div className="text-4xl mb-3">📋</div>
          <p className="font-heading font-semibold text-navy mb-1">No roster data</p>
          <p className="text-sm">Your roster for this period hasn&apos;t been synced yet.</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 items-start">
          <div className="flex-1 min-w-0">
          <div className="overflow-x-auto overflow-y-auto max-h-[75vh] rounded-xl border border-navy-100 shadow-sm">
            <table className="w-full text-sm border-collapse bg-white">
              <thead className="sticky top-0 z-20">
                <tr className="bg-navy text-white">
                  <th className="text-left px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wider w-24 sticky left-0 bg-navy z-10">Date</th>
                  <th className="text-left px-2 py-3 font-heading font-semibold text-xs uppercase tracking-wider w-12">From</th>
                  <th className="text-left px-2 py-3 font-heading font-semibold text-xs uppercase tracking-wider w-12">To</th>
                  <th className="text-left px-3 py-3 font-heading font-semibold text-xs uppercase tracking-wider">Activity</th>
                  <th className="text-left px-3 py-3 font-heading font-semibold text-xs uppercase tracking-wider">Start</th>
                  <th className="text-left px-3 py-3 font-heading font-semibold text-xs uppercase tracking-wider">End</th>
                  <th className="text-center px-2 py-3 font-heading font-semibold text-xs uppercase tracking-wider w-16">BLH in<br/>HH:MM</th>
                  <th className="text-center px-2 py-3 font-heading font-semibold text-xs uppercase tracking-wider w-16">BLH in<br/>dec</th>
                  <th className="text-center px-2 py-3 font-heading font-semibold text-xs uppercase tracking-wider w-20">BLH in<br/>rot</th>
                  {CHARGE_COLS.map(c => (
                    <th key={c.code} title={c.title} className="text-center px-2 py-3 font-heading font-semibold text-xs uppercase tracking-wider border-l border-white/20 w-10">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {days.map(day => {
                  const date      = new Date(day.date + 'T12:00:00');
                  const dayName   = DAY_NAMES[date.getDay()];
                  const isWeekend = date.getDay() === 0 || date.getDay() === 6;
                  const acts      = day.activities.length > 0 ? mergeActivities(day.activities) : ([null] as (Activity | null)[]);
                  const rowSpan   = acts.length;
                  const ot        = otData.get(day.date);
                  const isEMVT    = ot?.isEMVTDay;
                  const isRotEnd  = ot?.isRotationEnd && (ot.runningBLH > 0 || ot.rotationOT > 0);

                  return [
                    // Carryover banner row
                    (ot?.carryoverBLH && ot.carryoverBLH > 0) ? (
                      <tr key={`${day.date}-carryover`} className="bg-blue-50 border-t-2 border-blue-200">
                        <td colSpan={9 + CHARGE_COLS.length} className="px-4 py-1.5 text-xs text-blue-700 font-medium">
                          ↩ BLH carried over from previous month: <strong>{ot.carryoverBLH.toFixed(2)}h</strong>
                        </td>
                      </tr>
                    ) : null,

                    // Rotation START banner
                    (ot?.isRotationStart && !ot?.carryoverBLH) ? (
                      <tr key={`${day.date}-rot-start`} className="border-t-2 border-emerald-300 bg-emerald-50/40">
                        <td className="px-4 py-1 sticky left-0 bg-inherit z-10" />
                        <td colSpan={8 + CHARGE_COLS.length} className="px-3 py-1 text-xs font-medium text-emerald-700">
                          ▶ Rotation start
                        </td>
                      </tr>
                    ) : null,

                    // Activity rows
                    ...acts.map((act, ai) => (
                      <tr key={`${day.date}-${ai}`}
                        className={[
                          'border-t border-navy-50 hover:bg-beige/40 transition-colors',
                          day.isFuture ? 'opacity-35' : '',
                          isEMVT ? 'opacity-50 bg-slate-50' : '',
                          day.isPayable && !isEMVT ? 'bg-emerald-50/30' : isWeekend ? 'bg-slate-50/60' : '',
                        ].filter(Boolean).join(' ')}>

                        {ai === 0 && (
                          <td rowSpan={rowSpan} className="px-4 py-3 align-top sticky left-0 bg-white border-r border-navy-50 z-10">
                            <div className="flex flex-col items-start gap-1">
                              <div className="flex items-baseline gap-1.5">
                                <span className="font-heading font-bold text-navy text-base">{String(date.getDate()).padStart(2,'0')}</span>
                                <span className={`text-xs ${isWeekend ? 'text-navy-300' : 'text-navy-400'}`}>{dayName}</span>
                              </div>
                              {day.isPayable && !isEMVT && (
                                <span className="text-xs bg-emerald-100 text-emerald-700 rounded-full px-1.5 py-0.5 font-semibold">✓ pay</span>
                              )}
                              {isEMVT && (
                                <span className="text-xs bg-slate-200 text-slate-500 rounded-full px-1.5 py-0.5 font-medium">EMVT</span>
                              )}
                            </div>
                          </td>
                        )}

                        {act ? (
                          <>
                            <td className="px-2 py-2 align-middle">
                              {act.start_base
                                ? <span className="text-xs font-mono text-navy-400 bg-navy-50 px-1.5 py-0.5 rounded">{act.start_base}</span>
                                : <span className="text-navy-200 text-xs">—</span>}
                            </td>
                            <td className="px-2 py-2 align-middle">
                              {act.end_base
                                ? <span className="text-xs font-mono text-navy-400 bg-navy-50 px-1.5 py-0.5 rounded">{act.end_base}</span>
                                : <span className="text-navy-200 text-xs">—</span>}
                            </td>
                            <td className="px-3 py-2 align-middle">
                              {(() => {
                                const isFlightType = act.ActivityType?.toUpperCase() === 'FLIGHT';
                                const subtype = act.ActivitySubType || (isFlightType ? 'Flight' : '');
                                return (
                                  <span className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full font-medium whitespace-nowrap ${SUBTYPE_STYLES[subtype] || 'bg-gray-100 text-gray-600'}`}>
                                    {SUBTYPE_ICON_COMPONENTS[subtype] || '·'} {subtype || act.ActivityType}
                                    {isFlightType && act.ActivityCode && (
                                      <span className="font-mono font-bold ml-0.5">{act.ActivityCode}</span>
                                    )}
                                  </span>
                                );
                              })()}
                            </td>
                            <td className="px-3 py-2 align-middle">
                              {(() => { const { time, tz } = fmtTime(act.start_activity); return (
                                <div><span className="font-medium text-navy text-xs">{time}</span>{tz && <span className="text-navy-300 text-xs ml-1">{tz}</span>}</div>
                              ); })()}
                            </td>
                            <td className="px-3 py-2 align-middle">
                              {(() => { const { time, tz } = fmtTime(act.end_activity); return (
                                <div><span className="font-medium text-navy text-xs">{time}</span>{tz && <span className="text-navy-300 text-xs ml-1">{tz}</span>}</div>
                              ); })()}
                            </td>
                            {/* BLH HH:MM - from aBLH field directly */}
                            {ai === 0 && (
                              <td rowSpan={rowSpan} className="px-2 py-2 align-middle text-center">
                                {acts.some(a => a?.aBLH)
                                  ? <span className="font-semibold text-emerald-700 text-xs">{acts.find(a => a?.aBLH)?.aBLH}</span>
                                  : <span className="text-navy-200 text-xs">—</span>}
                              </td>
                            )}
                            {/* BLH decimal - convert HH:MM to decimal */}
                            {ai === 0 && (
                              <td rowSpan={rowSpan} className="px-2 py-2 align-middle text-center">
                                {ot && ot.dayBLH > 0
                                  ? <span className="text-navy-500 text-xs">{ot.dayBLH.toFixed(2)}</span>
                                  : <span className="text-navy-200 text-xs">—</span>}
                              </td>
                            )}
                            {/* BLH Rotation - running total in rotation */}
                            {ai === 0 && (
                              <td rowSpan={rowSpan} className="px-2 py-2 align-middle text-center">
                                {ot && ot.runningBLH > 0
                                  ? <span className={`text-xs font-medium ${ot.runningBLH >= 65 ? 'text-red-600' : 'text-navy-500'}`}>{ot.runningBLH.toFixed(1)}</span>
                                  : <span className="text-navy-200 text-xs">—</span>}
                              </td>
                            )}
                            {/* Charge cols */}
                            {ai === 0 && CHARGE_COLS.map(c => (
                              <td key={c.code} rowSpan={rowSpan} className="px-2 py-2 align-middle text-center border-l border-navy-50">
                                {(day.charges[c.code] || 0) > 0
                                  ? <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-navy text-white text-xs font-bold">{day.charges[c.code]}</span>
                                  : <span className="text-navy-100 text-xs">—</span>}
                              </td>
                            ))}
                          </>
                        ) : (
                          <>
                            <td colSpan={5} className="px-3 py-3 text-navy-300 text-xs italic">No activity data for this day</td>
                            <td className="px-2 text-center"><span className="text-navy-100 text-xs">—</span></td>
                            <td className="px-2 text-center"><span className="text-navy-100 text-xs">—</span></td>
                            <td className="px-2 text-center"><span className="text-navy-100 text-xs">—</span></td>
                            {CHARGE_COLS.map(c => (
                              <td key={c.code} className="px-2 text-center border-l border-navy-50"><span className="text-navy-100 text-xs">—</span></td>
                            ))}
                          </>
                        )}
                      </tr>
                    )),

                    // Rotation end / OT summary row
                    isRotEnd ? (
                      <tr key={`${day.date}-rot-end`} className={`border-t-2 ${ot!.rotationOT > 0 ? 'border-amber-300 bg-amber-50' : 'border-navy-200 bg-navy-50/30'}`}>
                        <td className="px-4 py-1.5 sticky left-0 bg-inherit z-10" />
                        <td colSpan={8 + CHARGE_COLS.length} className="px-3 py-1.5 text-xs font-medium text-navy-500">
                          ✂ Rotation end · Total BLH: <strong>{ot!.runningBLH.toFixed(2)}h</strong>
                          {ot!.rotationOT > 0 && (
                            <span className="ml-3 text-amber-700 font-bold">⚡ Overtime: {ot!.rotationOT.toFixed(2)}h</span>
                          )}
                        </td>
                        
                      </tr>
                    ) : null,
                  ].filter(Boolean);
                })}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="mt-3 flex flex-wrap gap-4 text-xs text-navy-400">
            {CHARGE_COLS.map(c => (
              <span key={c.code}><span className="font-semibold text-navy">{c.label}</span> = {c.title}</span>
            ))}
            <span className="border-l border-navy-100 pl-4"><span className="font-semibold text-emerald-600">✓ pay</span> = Payable day</span>
            <span className="border-l border-navy-100 pl-4"><span className="font-semibold text-navy-500">BLH in Rot</span> = Total BLH in rotation</span>
          </div>
          </div>{/* end flex-1 */}

          {/* Right column — Period Summary + Payroll Process stacked */}
          <div className="w-full lg:w-64 shrink-0 flex flex-col gap-4">

          {/* Totals panel */}
          <div className="rounded-xl border border-navy-100 shadow-sm bg-white overflow-hidden">
            <div className="bg-navy px-4 py-3" style={{height:'48px', display:'flex', flexDirection:'column', justifyContent:'center'}}>
              <h3 className="font-heading font-semibold text-white text-sm leading-tight">Period Summary</h3>
              <p className="text-white/50 text-xs leading-tight">{MONTH_NAMES[month - 1]} {year}</p>
            </div>
            <div className="p-4 space-y-1">
              {/* Charges breakdown — invoice style */}
              {CHARGE_COLS.map(c => {
                const totalQty = days.reduce((s, d) => s + (d.charges[c.code] || 0), 0);
                if (totalQty === 0) return null;
                // Get rate from first day that has this charge
                const firstDay = days.find(d => (d.charges[c.code] || 0) > 0);
                const rateInfo = firstDay?.chargeRates?.[c.code];
                const rate     = rateInfo?.rate ?? null;
                const currency = rateInfo?.currency ?? 'EUR';
                const symbol   = currency === 'USD' ? '$' : '€';
                const lineTotal = rate != null ? totalQty * rate : null;
                return (
                  <div key={c.code} className="py-2 border-b border-navy-50 last:border-0">
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm text-navy font-medium">{c.title}</span>
                      {lineTotal != null && (
                        <span className="text-sm font-mono font-semibold text-navy">
                          {symbol}{lineTotal.toFixed(2)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5 text-xs text-navy-400">
                      <span>{totalQty} day{totalQty !== 1 ? 's' : ''}</span>
                      {rate != null && (
                        <>
                          <span>à</span>
                          <span className="font-mono">{symbol}{Number(rate).toFixed(2)}</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {/* Overtime — always show, with rotation detail */}
              {(() => {
                const otCurrency = (() => {
                  for (const d of days) for (const v of Object.values(d.chargeRates || {})) if (v.rate != null) return v.currency ?? 'EUR';
                  return 'EUR';
                })();
                const symbol = otCurrency === 'USD' ? '$' : '€';
                // Build rotation summary lines
                const rotSummary = Array.from(new Set(Array.from(otData.values()).map(d => d.rotationId)))
                  .map(rid => {
                    const rDays = Array.from(otData.values()).filter(d => d.rotationId === rid && d.isInRotation);
                    if (!rDays.length) return null;
                    const blh  = rDays[rDays.length - 1].runningBLH;
                    const ot   = rDays[rDays.length - 1].rotationOT;
                    const from = rDays[0].date.slice(8) + '/' + rDays[0].date.slice(5,7);
                    const to   = rDays[rDays.length-1].date.slice(8) + '/' + rDays[rDays.length-1].date.slice(5,7);
                    return { rid, blh, ot, from, to };
                  }).filter((r): r is NonNullable<typeof r> => r !== null);

                if (totalOT > 0) return (
                  <div className="py-2 border-b border-amber-200 bg-amber-50/40">
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm text-amber-700 font-medium">⚡ Overtime</span>
                      <span className="text-sm font-mono font-semibold text-amber-700">TBD</span>
                    </div>
                    {rotSummary.map(r => (
                      <div key={r.rid} className="text-xs text-amber-600 mt-0.5 flex justify-between">
                        <span>{r.from} / {r.to} = {r.blh.toFixed(2)}h · h &gt; 65 = {r.ot.toFixed(2)}h</span>
                      </div>
                    ))}
                  </div>
                );
                return (
                  <div className="py-2 border-b border-navy-50">
                    <div className="flex justify-between items-baseline">
                      <span className="text-sm text-navy font-medium">Overtime</span>
                      <span className="text-sm font-mono text-navy-400">{symbol}0.00</span>
                    </div>
                    {rotSummary.map(r => (
                      <div key={r.rid} className="text-xs text-navy-300 mt-0.5 flex justify-between">
                        <span>{r.from} / {r.to} = {r.blh.toFixed(2)}h · h &gt; 65 = 0</span>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Grand total */}
              {(() => {
                const grandTotal = CHARGE_COLS.reduce((sum, c) => {
                  const qty = days.reduce((s, d) => s + (d.charges[c.code] || 0), 0);
                  const firstDay = days.find(d => (d.charges[c.code] || 0) > 0);
                  const rate = firstDay?.chargeRates?.[c.code]?.rate ?? null;
                  return rate != null ? sum + qty * rate : sum;
                }, 0);
                const otCurrency = (() => {
                  for (const d of days) for (const v of Object.values(d.chargeRates || {})) if (v.rate != null) return v.currency ?? 'EUR';
                  return 'EUR';
                })();
                const symbol = otCurrency === 'USD' ? '$' : '€';
                return (
                  <div className="flex justify-between items-baseline pt-2 mt-1 border-t-2 border-navy">
                    <span className="text-sm font-bold text-navy">Total</span>
                    <span className="text-sm font-mono font-bold text-navy">
                      {symbol}{grandTotal.toFixed(2)}
                    </span>
                  </div>
                );
              })()}

              {/* Concept Invoice PDF button */}
              {placementId && period && (
                <div className="pt-3 mt-2 border-t border-navy-50">
                  <button
                    onClick={() => {
                      const apiBase = 'https://confair-api-production.up.railway.app';
                      const token = localStorage.getItem('cf_access_token');
                      const periodId = period?.id ?? '';
                      fetch(`${apiBase}/invoice/pdf/${placementId}/${periodId}`, {
                        headers: { Authorization: 'Bearer ' + token }
                      }).then(r => {
                        if (!r.ok) throw new Error('PDF failed: ' + r.status);
                        return r.blob();
                      }).then(blob => {
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = 'CONCEPT_Invoice.pdf';
                        a.click();
                      }).catch(e => alert('PDF generation failed: ' + e.message));
                    }}
                    className="w-full flex items-center justify-center gap-1.5 text-xs bg-navy text-white px-3 py-2 rounded-lg hover:bg-navy/80 transition-colors font-medium"
                  >
                    <svg viewBox="0 0 384 512" width="11" height="11" fill="currentColor"><path d="M64 0C28.7 0 0 28.7 0 64L0 448c0 35.3 28.7 64 64 64l256 0c35.3 0 64-28.7 64-64l0-288-128 0c-17.7 0-32-14.3-32-32L224 0 64 0zM256 0l0 128 128 0L256 0zM216 232l0 102.1 31-31c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9l-72 72c-9.4 9.4-24.6 9.4-33.9 0l-72-72c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l31 31L168 232c0-13.3 10.7-24 24-24s24 10.7 24 24z"/></svg>
                    Concept Invoice PDF
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ── Payroll Process — below Period Summary, same column ── */}
            <PayrollProcess rosterStatus={rosterStatus} corrections={corrections} />

          </div>{/* end right column */}
          </div>{/* end flex gap-6 */}
        </>
      )}
    </div>
  );
}
