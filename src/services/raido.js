/**
 * RAIDO API service
 * Fetches roster data from the RAIDO aviation crew management API.
 * Mirrors the Python logic from ServerModule1.py.
 *
 * Env vars required:
 *   RAIDO_BASE_URL  — https://aai-apim-prod-northeu-01.azure-api.net/raido/v1/nocrestapi/v1
 *   RAIDO_API_KEY   — Azure APIM subscription key
 */
import axios from 'axios';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const HEADERS = () => ({
  'Ocp-Apim-Subscription-Key': config.raido.apiKey,
  'Accept': 'application/json',
});

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function httpGet(path, params = {}) {
  const url = `${config.raido.baseUrl}${path}`;
  try {
    const res = await axios.get(url, { headers: HEADERS(), params, timeout: 30_000 });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    logger.error('RAIDO API error', { path, params, status, error: err.message, body });
    // Return structured error so callers can detect failure
    return { _raidoError: true, status, message: err.message, body };
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function toExclusiveDateStr(value) {
  if (!value) return '';
  // Cap To date to today — RAIDO rejects future dates
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  let d;
  try { d = new Date(value + 'T00:00:00Z'); } catch { return ''; }
  // Return the lesser of requested date or today
  const valueStr = d.toISOString().split('T')[0];
  return valueStr < todayStr ? valueStr : todayStr;
}

function monthBounds(year, month) {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
}

// ── Roster fetcher ────────────────────────────────────────────────────────────
export async function fetchRosters(from, to) {
  const toExcl = toExclusiveDateStr(to);
  return httpGet('/rosters', { From: from, To: toExcl, RequestData: 'Times' });
}

export async function fetchRostersForCrew(from, to, crewId) {
  // RAIDO does not reliably filter by crew via params — fetch all, filter client-side
  const today  = new Date().toISOString().split('T')[0];
  const safeTo = to < today ? to : today;
  logger.info('RAIDO fetch', { from, to: safeTo, crewId });
  return fetchRosters(from, safeTo);
}

export async function testConnection() {
  const today = new Date().toISOString().split('T')[0];
  const data = await httpGet('/rosters', { From: today, To: today, RequestData: 'Times' });
  return { ok: !!data, keys: Object.keys(data || {}), message: data?.message || 'connected' };
}

// ── Roster parsing helpers ────────────────────────────────────────────────────
export function rosterItemsList(rosters) {
  if (Array.isArray(rosters)) return rosters;
  if (typeof rosters === 'object' && rosters !== null) {
    const items = rosters.items || rosters.data || [];
    return Array.isArray(items) ? items : [];
  }
  return [];
}

function parseIsoDate(value) {
  if (!value) return null;
  try {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

function activityDayFromTimestamp(value) {
  if (!value) return null;
  // Try to extract calendar day from timestamp string
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const d = parseIsoDate(value);
  return d ? d.toISOString().split('T')[0] : null;
}

function isOffSubtype(subtype) {
  if (!subtype) return false;
  const s = String(subtype).toLowerCase();
  return ['off', 'day off', 'rest', 'leave', 'vacation', 'annual leave', 'day-off'].some(t => s.includes(t));
}

function activitySubtypeLabel(act) {
  return String(act?.ActivitySubType || act?.Subtype || act?.subType || '').trim();
}

function string(v) {
  return v == null ? '' : String(v);
}

// ── Daily Allowance eligibility ───────────────────────────────────────────────
// Direct port of _day_is_payable_for_summary from ServerModule1.py
export function dayIsPayable(activities, crewNia) {
  if (!activities?.length) return false;

  const crewNiaVal = string(crewNia).trim().toUpperCase();

  // GRNAW or SIMAW designator = not payable
  for (const act of activities) {
    const des = string(act.Designator || act.RosterDesignator).toUpperCase();
    if (des === 'GRNAW' || des === 'SIMAW') return false;
  }

  // All CBT at home base = not payable
  const allCbt = activities.every(a => string(a.ActivityCode).trim().toUpperCase() === 'CBT');
  if (allCbt && crewNiaVal) {
    const allAtBase = activities.every(a => {
      const base = string(a.start_base || a.StartBase).trim().toUpperCase();
      return base && base === crewNiaVal;
    });
    if (allAtBase) return false;
  }

  // All CNV = not payable
  if (activities.every(a => string(a.ActivityCode).trim().toUpperCase() === 'CNV')) return false;

  // Check each activity
  for (const act of activities) {
    const subtype   = activitySubtypeLabel(act);
    const code      = string(act.ActivityCode).toUpperCase();
    const startBase = string(act.start_base || act.StartBase).trim().toUpperCase();

    if (code === 'CBO') continue;
    if (isOffSubtype(subtype)) {
      if (code === 'PXP') return true;
      continue;
    }
    if (subtype.toLowerCase() === 'illness') {
      if (startBase && crewNiaVal && startBase !== crewNiaVal) return true;
      continue;
    }
    return true;
  }
  return false;
}

// ── Build daily summary per crew ──────────────────────────────────────────────
// Port of _build_default_summary from ServerModule1.py
export function buildDailySummary(rows) {
  const dayMap  = new Map();
  const perCrew = new Map();

  for (const row of rows) {
    const crewId   = row.crew_id || row.CrewId || row.crewId;
    const crewName = row.crew_name || row.CrewName || '';
    const crewNia  = string(row.crew_nia || row.CrewNia || '').trim().toUpperCase();

    const ts  = row._date || row.start_activity || row.StartUtc || row.Start;
    // _date is the explicit local calendar date set by mapRosterToRows
    // For _date we use it directly; for raw timestamps extract the local date prefix
    const day = row._date || activityDayFromTimestamp(ts);
    if (!day) continue;

    const key = `${crewId}|${day}`;
    if (!dayMap.has(key)) {
      dayMap.set(key, {
        crewId, crewName, crewNia,
        day, activities: [],
        hasGround: false, hasSim: false, hasPxp: false,
        soldOff: false, bod: false,
      });
    }
    const info = dayMap.get(key);
    info.activities.push(row);

    const des  = string(row.Designator || row.RosterDesignator).toUpperCase();
    const code = string(row.ActivityCode).toUpperCase();
    if (des  === 'GRNAW') info.hasGround = true;
    if (des  === 'SIMAW') info.hasSim    = true;
    if (code === 'HRD')   info.soldOff   = true;
    if (code === 'BOD')   info.bod       = true;
    if (code === 'PXP')   info.hasPxp    = true;
  }

  for (const info of dayMap.values()) {
    const { crewId, crewName, crewNia, day } = info;

    if (!perCrew.has(crewId)) {
      perCrew.set(crewId, {
        crewId, crewName, crewNia,
        qualification: info.activities[0]?.qualification || null,
        activeRoles: info.activities[0]?.active_roles || null,
        days: new Map(),
        totals: {
          DailyAllowance: 0, AvailabilityPremium: 0, YearsWithClient: 0,
          PerDiem: 0, GroundFee: 0, SimFee: 0, SoldOffDay: 0, BODDays: 0,
        },
      });
    }
    const crew = perCrew.get(crewId);

    // Per day flags
    const dayResult = {
      date:      day,
      isPayable: false,
      hasGround: info.hasGround,
      hasSim:    info.hasSim,
      hasPxp:    info.hasPxp,
      soldOff:   info.soldOff,
      bod:       info.bod,
      activities: info.activities,
      charges:   {},
    };

    if (info.hasGround) {
      dayResult.charges.GroundFee = 1;
      crew.totals.GroundFee++;
    } else if (info.hasSim) {
      dayResult.charges.SimFee = 1;
      crew.totals.SimFee++;
    } else {
      const payable = dayIsPayable(info.activities, crewNia);
      dayResult.isPayable = payable;

      if (payable) {
        // Check WW designator for premium
        const hasWw = info.activities.some(a =>
          string(a.Designator || a.RosterDesignator).trim().toUpperCase() === 'WW'
        );
        dayResult.charges.DailyAllowance      = 1;
        dayResult.charges.AvailabilityPremium = hasWw ? 0 : 1;
        dayResult.charges.PerDiem             = info.hasPxp ? 0 : 1;
        crew.totals.DailyAllowance++;
        if (!hasWw) crew.totals.AvailabilityPremium++;
        crew.totals.PerDiem += info.hasPxp ? 0 : 1;
        // YearsWithClient is tenure-based (≥ 5 years with the client). The
        // per-day quantity is injected later in the sync route where we have
        // the placement's client_start_date. See roster.js sync loop.
      }

      if (info.soldOff) {
        dayResult.charges.SoldOffDay = 1;
        crew.totals.SoldOffDay++;
      }
      if (info.bod) {
        dayResult.charges.BODDays = 1;
        crew.totals.BODDays++;
      }
    }

    crew.days.set(day, dayResult);
  }

  // Convert Maps to arrays for output
  return Array.from(perCrew.values()).map(c => ({
    ...c,
    days: Array.from(c.days.values()).sort((a, b) => a.date.localeCompare(b.date)),
  }));
}

// ── Map RAIDO roster objects to flat activity rows ────────────────────────────
// Matches the Python ServerModule1.py _map_rosters_with_flights logic:
// 1. Date bucketing uses LOCAL string date (not UTC) from act.Start
// 2. Activities crossing UTC midnight are split at 23:59:59Z / 00:00:01Z
// 3. Timestamps shown in base-local time when StartBase == crew NIA
// 4. aBLH is HH:MM string for flights only, from ActualStart/ActualEnd duration

function isoZ(dt) {
  // Convert Date to ISO Z string
  return dt.toISOString().replace('.000Z', 'Z').replace(/\.\d+Z$/, 'Z');
}

function parseIsoStrict(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

function minutesToHHMM(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function withMinutesOffset(isoTs, offsetMinutes) {
  // Convert a UTC ISO timestamp to local time with given offset, returning local ISO string
  if (!isoTs || offsetMinutes == null) return isoTs;
  const dt = parseIsoStrict(isoTs);
  if (!dt) return isoTs;
  const off = Number(offsetMinutes);
  if (isNaN(off)) return isoTs;
  const localMs = dt.getTime() + off * 60000;
  const localDt = new Date(localMs);
  const sign = off >= 0 ? '+' : '-';
  const absOff = Math.abs(off);
  const hh = String(Math.floor(absOff / 60)).padStart(2, '0');
  const mm = String(absOff % 60).padStart(2, '0');
  return localDt.toISOString().replace('Z', '') + `${sign}${hh}:${mm}`;
}

function localDateStr(isoTs) {
  // Extract YYYY-MM-DD from the LOCAL part of an ISO timestamp string
  // e.g. "2026-04-02T00:00:00+02:00" -> "2026-04-02"
  // e.g. "2026-04-01T22:00:00Z" -> "2026-04-01"
  if (!isoTs) return null;
  const m = String(isoTs).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function mapRosterToRows(rosterItems, crewId, crewNia) {
  const rows = [];

  for (const item of rosterItems) {
    if (!item || typeof item !== 'object') continue;

    const crewObj     = typeof item.Crew === 'object' && item.Crew ? item.Crew : item;
    const itemCrewId  = string(crewObj.Number || crewObj.EmployeeNumber || crewObj.Code1 || item.CrewUniqueId || crewId || '').trim();
    const firstName   = crewObj.Firstname || crewObj.FirstName || '';
    const lastName    = crewObj.Lastname  || crewObj.LastName  || '';
    const itemCrewName = `${firstName} ${lastName}`.trim();
    const itemCrewNia  = string(crewObj.Base || crewNia || '').trim().toUpperCase();
    // Qualification and active role — try common RAIDO field names
    const itemQualification = string(
      crewObj.Qualification || crewObj.qualification ||
      crewObj.Rank || crewObj.rank || ''
    ).trim() || null;
    const itemActiveRoles = string(
      crewObj.ActiveRole || crewObj.ActiveRoles || crewObj.activeRoles ||
      crewObj.Role || crewObj.Roles || ''
    ).trim() || null;

    // Filter to only the requested crew when crewId is provided
    if (crewId && itemCrewId && itemCrewId.toUpperCase() !== crewId.toUpperCase()) continue;

    const crewNiaBases = new Set(itemCrewNia.split(',').map(b => b.trim()).filter(Boolean));

    const activities = item.RosterActivities || item.Activities || [];
    if (!Array.isArray(activities)) continue;

    for (const act of activities) {
      if (!act || typeof act !== 'object') continue;

      const times         = act.Times || act.times || {};
      const actualStart   = times.ActualStart || '';
      const actualEnd     = times.ActualEnd   || '';
      const activityType  = string(act.ActivityType || act.Type || '');
      const isFlightActivity = activityType.toUpperCase() === 'FLIGHT';

      // Source timestamps: prefer act.Start (local) for non-flight; ActualStart for flights
      const rawStart = string(isFlightActivity && actualStart ? actualStart : (act.Start || act.StartUtc || act.StartLocal || actualStart));
      const rawEnd   = string(isFlightActivity && actualEnd   ? actualEnd   : (act.End   || act.EndUtc   || act.EndLocal   || actualEnd));

      // Base-local display: if dep/arr airport matches crew NIA, localize using BaseTimeDiff
      const dep = string(act.StartAirportCode || act.DepartureAirport || act.Dep || '').toUpperCase();
      const arr = string(act.EndAirportCode   || act.ArrivalAirport   || act.Arr || '').toUpperCase();
      const sameStartBase = dep && crewNiaBases.has(dep);
      const sameEndBase   = arr && crewNiaBases.has(arr);

      const startTs = sameStartBase && act.StartBaseTimeDiff != null
        ? withMinutesOffset(rawStart, act.StartBaseTimeDiff) : rawStart;
      const endTs   = sameEndBase && act.EndBaseTimeDiff != null
        ? withMinutesOffset(rawEnd, act.EndBaseTimeDiff) : rawEnd;

      // aBLH: HH:MM string for flights only, from ActualStart/ActualEnd duration
      let aBLH = null;
      if (isFlightActivity) {
        const dtS = parseIsoStrict(actualStart || rawStart);
        const dtE = parseIsoStrict(actualEnd   || rawEnd);
        if (dtS && dtE && dtE > dtS) {
          const mins = (dtE - dtS) / 60000;
          aBLH = minutesToHHMM(mins);
        }
      }

      const designator = string(act.RosterDesignator || act.Designator || '');
      // Designator "P" = pseudo/positioning — suppress aBLH
      if (string(designator).toUpperCase() === 'P') aBLH = null;

      // ── Midnight splitting (UTC) then localize ─────────────────────────────
      // Matches Python: split at UTC midnight first, then apply base-local offset per segment
      // Use rawStart/rawEnd (UTC) for splitting, then localize each segment
      const rawDtStart = parseIsoStrict(rawStart || startTs);
      const rawDtEnd   = parseIsoStrict(rawEnd   || endTs);

      let segs = [];
      if (rawDtStart && rawDtEnd && rawDtEnd > rawDtStart) {
        let segStart = new Date(rawDtStart);
        while (true) {
          const segStartDate = segStart.toISOString().split('T')[0];
          const segEndDate   = rawDtEnd.toISOString().split('T')[0];
          if (segStartDate < segEndDate) {
            const nextMidnight = new Date(segStartDate);
            nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
            const endBeforeMidnight = new Date(nextMidnight.getTime() - 1000);
            segs.push({ sUtc: isoZ(segStart), eUtc: isoZ(endBeforeMidnight), isLast: false });
            segStart = new Date(nextMidnight.getTime() + 1000);
          } else {
            segs.push({ sUtc: isoZ(segStart), eUtc: isoZ(rawDtEnd), isLast: true });
            break;
          }
        }
      } else {
        segs = [{ sUtc: string(rawStart || startTs), eUtc: string(rawEnd || endTs), isLast: true }];
      }

      // Emit one row per segment — localize AFTER splitting (match Python)
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        // Apply base-local offset to segment timestamps
        const outStart = (sameStartBase && act.StartBaseTimeDiff != null)
          ? withMinutesOffset(seg.sUtc, act.StartBaseTimeDiff) : seg.sUtc;
        const outEnd   = (sameEndBase && act.EndBaseTimeDiff != null)
          ? withMinutesOffset(seg.eUtc, act.EndBaseTimeDiff) : seg.eUtc;

        // Local date: extract from localized start string
        const segDateStr = si === 0
          ? (localDateStr(outStart) || seg.sUtc.split('T')[0])
          : seg.sUtc.split('T')[0];

        rows.push({
          crew_id:         itemCrewId || crewId || '',
          crew_nia:        itemCrewNia || crewNia || '',
          crew_name:       itemCrewName,
          qualification:   itemQualification,
          active_roles:    itemActiveRoles,
          ActivityCode:    string(act.ActivityCode || act.Code || ''),
          ActivityType:    activityType,
          ActivitySubType: string(act.ActivitySubType || act.SubType || ''),
          Designator:      designator,
          start_activity:  outStart,
          end_activity:    outEnd,
          start_base:      dep || '',
          end_base:        arr || '',
          aBLH:            (isFlightActivity && seg.isLast) ? aBLH : null,
          _date:           segDateStr,
        });
      }
    }
  }
  return rows;
}

export { monthBounds };

// ── Special Roles (Active Role) ────────────────────────────────────────────────
// Whitelist from ServerModule1.py ROLE_WHITELIST
const ROLE_WHITELIST = new Set(['WW','21-14','24-12','20-10','21-21','24-6','28-12','14-14','LEAD','SFO']);

/**
 * Fetch /crew?RequestData=SpecialRoles for the period window.
 * Returns a map of crewKey → comma-joined active role codes.
 * crewKey is the crew's Number/EmployeeNumber/Code1 (matches crew_id in placements).
 */
export async function fetchActiveRolesForPeriod(periodFrom, periodTo) {
  const params = {
    OnlyActive: 'true',
    RequestData: 'SpecialRoles',
    From: periodFrom,
    To: periodTo,
    limit: 5000,
  };

  let resp;
  try {
    resp = await httpGet('/crew', params);
  } catch (e) {
    return {};
  }

  const crews = Array.isArray(resp)
    ? resp
    : (resp?.items || resp?.data || []);

  if (!Array.isArray(crews) || !crews.length) return {};

  const winStart = new Date(periodFrom + 'T00:00:00Z');
  const winEnd   = new Date(periodTo   + 'T23:59:59Z');
  const rolesMap = {};

  for (const crew of crews) {
    if (!crew || typeof crew !== 'object') continue;

    // Get crew key (same fields as in mapRosterToRows)
    const key = (
      crew.Number || crew.EmployeeNumber || crew.Code1 ||
      crew.Code2  || crew.UniqueId || crew.CrewUniqueId || ''
    ).toString().trim();
    if (!key) continue;

    const specialRoles = Array.isArray(crew.SpecialRoles) ? crew.SpecialRoles : [];
    const activeCodes = [];

    for (const role of specialRoles) {
      if (!role || typeof role !== 'object') continue;
      const code = (role.Code || '').toString().trim();
      if (!ROLE_WHITELIST.has(code)) continue;
      if (role.Active === false) continue;

      const vf = role.ValidFrom ? new Date(role.ValidFrom) : new Date(0);
      const vt = role.ValidTo   ? new Date(role.ValidTo)   : new Date('9999-12-31');

      // Role valid if its window overlaps with the period window
      if (vf <= winEnd && vt >= winStart) {
        activeCodes.push(code);
      }
    }

    // Preserve whitelist order (same as Python ROLE_WHITELIST ordering)
    const ordered = [...ROLE_WHITELIST].filter(c => activeCodes.includes(c));
    if (ordered.length > 0) {
      rolesMap[key.toUpperCase()] = ordered.join(', ');
    }
  }

  return rolesMap;
}
