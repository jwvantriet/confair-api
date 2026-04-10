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
    logger.error('RAIDO API error', { path, params, status: err.response?.status, error: err.message });
    return {};
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function toExclusiveDateStr(value) {
  if (!value) return '';
  // Cap to today to avoid API rejections
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  let d;
  try { d = new Date(value); } catch { return ''; }
  if (d > today) d = today;
  // Add one day for exclusive end
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
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
  if (!crewId?.trim()) return fetchRosters(from, to);
  const toExcl = toExclusiveDateStr(to);
  const cid    = crewId.trim();

  // Try candidate param names — RAIDO API varies
  const candidates = [
    { From: from, To: toExcl, UniqueId:       cid, RequestData: 'Times' },
    { From: from, To: toExcl, CrewUniqueId:   cid, RequestData: 'Times' },
    { From: from, To: toExcl, Crew:           cid, RequestData: 'Times' },
    { From: from, To: toExcl, EmployeeNumber: cid, RequestData: 'Times' },
    { From: from, To: toExcl, CrewCode:       cid, RequestData: 'Times' },
  ];

  for (const params of candidates) {
    try {
      const resp = await httpGet('/rosters', params);
      const items = rosterItemsList(resp);
      if (items.length > 0) {
        logger.info('RAIDO roster fetched', { crewId, param: Object.keys(params).find(k => !['From','To','RequestData'].includes(k)), count: items.length });
        return resp;
      }
    } catch { /* try next */ }
  }
  // Fallback to full window
  return fetchRosters(from, to);
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

    const ts  = row.start_activity || row.StartUtc || row.Start;
    const day = activityDayFromTimestamp(ts);
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
        dayResult.charges.DailyAllowance     = 1;
        dayResult.charges.AvailabilityPremium = hasWw ? 0 : 1;
        dayResult.charges.PerDiem             = info.hasPxp ? 0 : 1;
        crew.totals.DailyAllowance++;
        if (!hasWw) crew.totals.AvailabilityPremium++;
        crew.totals.PerDiem += info.hasPxp ? 0 : 1;
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
// RAIDO API structure:
// Each roster item has: { Crew: { Number, Firstname, Lastname, Base, Bases, ... }, Activities: [...] }
// Each activity has: { ActivityCode, ActivityType, ActivitySubType, Designator, Start, End, Times: {...} }
export function mapRosterToRows(rosterItems, crewId, crewNia) {
  const rows = [];
  for (const item of rosterItems) {
    if (!item || typeof item !== 'object') continue;

    // Extract crew info from nested Crew object or top-level
    const crewObj = typeof item.Crew === 'object' && item.Crew ? item.Crew : item;
    const itemCrewId = string(
      crewObj.Number || crewObj.EmployeeNumber || crewObj.Code1 || crewObj.Code2 ||
      item.CrewUniqueId || item.CrewId || crewId || ''
    ).trim();

    const firstName = crewObj.Firstname || crewObj.FirstName || '';
    const lastName  = crewObj.Lastname  || crewObj.LastName  || '';
    const itemCrewName = `${firstName} ${lastName}`.trim() || crewObj.FullName || crewObj.Name || '';

    // Extract crew NIA/base
    let itemCrewNia = crewNia || '';
    if (!itemCrewNia) {
      itemCrewNia = string(crewObj.Base || '').trim().toUpperCase();
      if (!itemCrewNia && Array.isArray(crewObj.Bases) && crewObj.Bases.length > 0) {
        const baseObj = crewObj.Bases[0]?.Base || crewObj.Bases[0];
        itemCrewNia = string(baseObj?.Code || baseObj?.ShortCode || '').trim().toUpperCase();
      }
    }

    const activities = item.Activities || item.RosterActivities || [];
    if (!Array.isArray(activities) || activities.length === 0) continue;

    for (const act of activities) {
      if (!act || typeof act !== 'object') continue;

      // Times can be nested: act.Times.ActualStart / act.Times.PlannedStart
      const times    = act.Times || act.times || {};
      const startTs  = times.ActualStart || times.PlannedStart || act.Start || act.StartUtc || act.StartLocal || '';
      const endTs    = times.ActualEnd   || times.PlannedEnd   || act.End   || act.EndUtc   || act.EndLocal   || '';
      const startBase = string(act.StartBase || act.DepartureStation || act.StartAirport || '').toUpperCase();
      const endBase   = string(act.EndBase   || act.ArrivalStation  || act.EndAirport   || '').toUpperCase();

      rows.push({
        crew_id:         itemCrewId  || crewId || '',
        crew_nia:        itemCrewNia || crewNia || '',
        crew_name:       itemCrewName,
        ActivityCode:    string(act.ActivityCode || act.Code || ''),
        ActivityType:    string(act.ActivityType || act.Type || ''),
        ActivitySubType: string(act.ActivitySubType || act.SubType || ''),
        Designator:      string(act.Designator || act.RosterDesignator || ''),
        start_activity:  startTs,
        end_activity:    endTs,
        start_base:      startBase,
        end_base:        endBase,
        Times:           times,
      });
    }
  }
  return rows;
}

export { monthBounds };
