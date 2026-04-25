import { Router } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import { adminSupabase, provisionCarerixSession } from '../services/supabase.js';
import {
  syncUserCompanyAccessFromCarerix,
  syncPlacementIdentityFromCarerix,
} from '../services/access.js';
import {
  queryGraphQL,
  getCarerixCheckboxRegistry,
  fetchPlacementIdentityByCrUserId,
} from '../services/carerix.js';
import { requireAuth, requireAgency } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

const router = Router();
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const parseXml = (xml) => { try { return xmlParser.parse(xml); } catch { return null; } };
const getId = (obj) => obj?.['@_id'] || obj?.id || obj?._id || null;

// Carerix CRUserRole IDs → platform roles
// id=1  → Employee (CREmployee linked) → placement
// id=11 → Contact  (CRCompany linked)  → company_admin
// other → Office/recruiter              → agency_admin
const ROLE_CONTACT  = 11;
const ROLE_EMPLOYEE = 1;

async function loginWithCarerix(username, password) {
  const restBase    = config.carerix.restUrl;
  const restAuth    = Buffer.from(`${config.carerix.restUsername}:${config.carerix.restPassword}`).toString('base64');
  const md5password = crypto.createHash('md5').update(password).digest('hex');
  const headers     = { Authorization: `Basic ${restAuth}`, 'User-Agent': 'confair-platform/1.0' };

  let loginXml;
  try {
    const res = await axios.get(`${restBase}CRUser/login-with-encrypted-password`,
      { params: { u: username, p: md5password }, headers, timeout: 15_000, responseType: 'text' });
    loginXml = res.data;
  } catch (err) {
    const d = err.response?.data || '';
    if (typeof d === 'string' && d.includes('AuthorizationFailed')) throw new ApiError('Invalid username or password', 401);
    if ([401, 403].includes(err.response?.status)) throw new ApiError('Invalid username or password', 401);
    throw new ApiError('Could not connect to Carerix', 502);
  }

  if (loginXml?.includes('AuthorizationFailed') || loginXml?.includes('NSException')) {
    throw new ApiError('Invalid username or password', 401);
  }

  const parsed   = parseXml(loginXml);
  const crUser   = parsed?.CRUser || {};
  const crUserId = getId(crUser);
  if (!crUserId) throw new ApiError('Invalid username or password', 401);

  const userRoleId = parseInt(getId(crUser.toUserRole?.CRUserRole || crUser.toUserRole) || '0', 10);

  const empNode  = crUser.toEmployee?.CREmployee || crUser.toEmployee;
  const compNode = crUser.toCompany?.CRCompany   || crUser.toCompany;
  const empId    = getId(empNode);
  const compId   = getId(compNode);

  const fullName = `${crUser.firstName || ''} ${crUser.lastName || ''}`.trim() || username;

  const platformRole = empId || userRoleId === ROLE_EMPLOYEE ? 'placement'
                     : compId || userRoleId === ROLE_CONTACT  ? 'company_admin'
                     : 'agency_admin';

  logger.info('Carerix login', { crUserId, userRoleId, empId, compId, platformRole, username });

  return {
    carerixUserId:     String(crUserId),
    carerixCompanyId:  compId ? String(compId) : null,
    carerixEmployeeId: empId  ? String(empId)  : null,
    email:             crUser.emailAddress || username,
    fullName,
    platformRole,
    userRoleId,
  };
}

async function refreshUserAccessOnLogin(session, identity) {
  if (!identity?.carerixUserId) return { status: 'skipped', reason: 'no_carerix_user_id' };
  if (identity.platformRole === 'agency_admin' || identity.platformRole === 'agency_operations') {
    return { status: 'skipped', reason: 'agency_role' };
  }

  const { data: profile } = await adminSupabase
    .from('user_profiles')
    .select('access_sync_status, access_sync_last_ok_at')
    .eq('id', session.userId)
    .maybeSingle();
  const hasSyncedBefore = !!profile?.access_sync_last_ok_at;

  let result;
  if (identity.platformRole === 'placement') {
    result = await syncPlacementIdentityFromCarerix(session.userId, identity.carerixUserId);
  } else {
    result = await syncUserCompanyAccessFromCarerix(session.userId, identity.carerixUserId);
  }

  if (result.status === 'synced') {
    if (identity.platformRole !== 'placement') {
      await adminSupabase.rpc('mark_access_sync_outcome', {
        p_user_profile_id: session.userId,
        p_status:          'synced',
        p_error:           null,
      });
    }
    return result;
  }

  const newStatus  = hasSyncedBefore ? 'stale' : 'failed';
  const errorBlurb = `${result.status}:${result.reason}${result.error ? ` (${result.error})` : ''}`;
  await adminSupabase.rpc('mark_access_sync_outcome', {
    p_user_profile_id: session.userId,
    p_status:          newStatus,
    p_error:           errorBlurb,
  });

  if (!hasSyncedBefore) {
    logger.warn('Login blocked: first-time Carerix sync failed', {
      userId: session.userId, role: identity.platformRole, ...result,
    });
    throw new ApiError(
      'Could not load your access from Carerix. Please try again in a moment.',
      503,
    );
  }

  logger.warn('Carerix sync failed on login — degrading to last-known-good', {
    userId: session.userId, role: identity.platformRole, ...result,
  });
  return result;
}

function loginResponse(res, session, identity, syncResult) {
  res.json({
    accessToken:  session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt:    session.expiresAt,
    user: {
      id:                              session.userId,
      email:                           identity.email,
      displayName:                     identity.fullName,
      role:                            identity.platformRole,
      authSource:                      'carerix',
      carerixUserId:                   identity.carerixUserId,
      carerixCompanyId:                identity.carerixCompanyId,
      carerixEmployeeId:               identity.carerixEmployeeId,
      accessSyncStatus:                syncResult?.status === 'synced'   ? 'synced'
                                     : syncResult?.status === 'skipped' ? 'skipped'
                                     : 'stale',
    },
  });
}

router.post('/login/agency', async (req, res, next) => {
  try {
    const user = req.body.username || req.body.email;
    if (!user || !req.body.password) throw new ApiError('Username and password are required', 400);
    const identity   = await loginWithCarerix(user, req.body.password);
    const session    = await provisionCarerixSession(identity);
    const syncResult = await refreshUserAccessOnLogin(session, identity);
    await writeAuditLog({ eventType: 'login', actorUserId: session.userId, actorRole: identity.platformRole, payload: { user }, ipAddress: req.ip });
    loginResponse(res, session, identity, syncResult);
  } catch (err) { next(err); }
});

router.post('/login/carerix', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) throw new ApiError('Username and password are required', 400);
    const identity   = await loginWithCarerix(username, password);
    const session    = await provisionCarerixSession(identity);
    const syncResult = await refreshUserAccessOnLogin(session, identity);
    await writeAuditLog({ eventType: 'login', actorUserId: session.userId, actorRole: identity.platformRole, payload: { username }, ipAddress: req.ip });
    loginResponse(res, session, identity, syncResult);
  } catch (err) { next(err); }
});

router.post('/forgot-password', async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username?.trim()) throw new ApiError('Username or email is required', 400);
    const { data: p } = await adminSupabase.from('user_profiles').select('email').ilike('email', username.trim()).maybeSingle();
    if (p) await adminSupabase.auth.resetPasswordForEmail(p.email, { redirectTo: `${config.cors.origins[0]}/reset-password` });
    res.json({ message: 'If an account exists, a reset link has been sent.' });
  } catch (err) { next(err); }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new ApiError('refreshToken is required', 400);
    const { data, error } = await adminSupabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error) throw new ApiError('Invalid or expired refresh token', 401);
    res.json({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at });
  } catch (err) { next(err); }
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await adminSupabase.auth.admin.signOut(req.token);
    res.json({ message: 'Logged out' });
  } catch (err) { next(err); }
});

router.get('/me', requireAuth, (req, res) => {
  const {
    id, role, auth_source, display_name, email,
    carerix_user_id, carerix_company_id, carerix_employee_id,
    carerix_function_group_level1_code, carerix_function_group_level1_name,
    access_sync_status,
  } = req.user;
  res.json({
    id, role,
    authSource:                          auth_source,
    displayName:                         display_name,
    email,
    carerixUserId:                       carerix_user_id,
    carerixCompanyId:                    carerix_company_id,
    carerixEmployeeId:                   carerix_employee_id,
    carerixFunctionGroupLevel1Code:      carerix_function_group_level1_code,
    carerixFunctionGroupLevel1Name:      carerix_function_group_level1_name,
    accessSyncStatus:                    access_sync_status,
  });
});

// ── Diagnostic login probe ───────────────────────────────────────────────────

async function probeCompanyAccess(crUserId) {
  const out = {
    registryAvailable:     false,
    registryEntries:       0,
    additionalInfoKeysSet: [],
    decodedFunctionGroups: [],
    linkedCompanies:       [],
    unknownCompanies:      [],
  };
  const crUserIdNum = Number(crUserId);
  if (!Number.isFinite(crUserIdNum)) return out;

  let userResp, linksResp, registry;
  try {
    [userResp, linksResp, registry] = await Promise.all([
      queryGraphQL(`
        query CRUser($qualifier: String) {
          crUserPage(qualifier: $qualifier, pageable: { page: 0, size: 1 }) {
            items { _id userID additionalInfo }
          }
        }
      `, { qualifier: `userID == ${crUserIdNum}` }),
      queryGraphQL(`
        query UserCompanies($qualifier: String, $pageable: Pageable) {
          crUserCompanyPage(qualifier: $qualifier, pageable: $pageable) {
            totalElements
            items { _id toCompany { _id companyID name } }
          }
        }
      `, {
        qualifier: `toUser.userID == ${crUserIdNum}`,
        pageable:  { page: 0, size: 100 },
      }),
      getCarerixCheckboxRegistry(),
    ]);
  } catch (err) {
    out.error = `carerix_unreachable: ${err.message}`;
    return out;
  }

  out.registryAvailable = registry !== null;
  out.registryEntries   = registry ? Object.keys(registry).length : 0;

  const additionalInfo = userResp?.data?.crUserPage?.items?.[0]?.additionalInfo || {};
  if (registry) {
    for (const [key, value] of Object.entries(additionalInfo)) {
      if (String(value).trim() !== '1') continue;
      const rawKey = key.startsWith('_') ? key.slice(1) : key;
      out.additionalInfoKeysSet.push(rawKey);
      const code = registry[rawKey];
      if (code) out.decodedFunctionGroups.push(code);
    }
  }

  const links = linksResp?.data?.crUserCompanyPage?.items || [];
  const carerixCompanies = links
    .map(l => l?.toCompany)
    .filter(c => c?.companyID != null);
  const carerixCompanyIds = Array.from(new Set(carerixCompanies.map(c => String(c.companyID))));

  let resolvedRows = [];
  if (carerixCompanyIds.length) {
    const { data } = await adminSupabase
      .from('companies')
      .select('id, name, carerix_company_id')
      .in('carerix_company_id', carerixCompanyIds);
    resolvedRows = data || [];
  }
  const resolvedMap = new Map(resolvedRows.map(r => [r.carerix_company_id, r]));

  out.linkedCompanies = carerixCompanyIds.map(cid => {
    const carerixSrc = carerixCompanies.find(c => String(c.companyID) === cid);
    const platform   = resolvedMap.get(cid);
    return {
      carerixCompanyId:    cid,
      nameInCarerix:       carerixSrc?.name || null,
      platformCompanyId:   platform?.id   || null,
      platformCompanyName: platform?.name || null,
      imported:            !!platform,
    };
  });
  out.unknownCompanies = out.linkedCompanies.filter(c => !c.imported).map(c => c.carerixCompanyId);

  return out;
}

async function runLoginProbe(username, password) {
  const tStart  = Date.now();
  const timings = {};
  const warnings = [];

  const t1 = Date.now();
  let identity;
  try {
    identity = await loginWithCarerix(username, password);
  } catch (err) {
    timings.carerixRestLogin = Date.now() - t1;
    timings.total            = Date.now() - tStart;
    return {
      approved: false,
      error: {
        status:  err.statusCode || err.status || 500,
        message: err.message || 'Login failed',
      },
      timings,
    };
  }
  timings.carerixRestLogin = Date.now() - t1;

  const result = {
    approved:          true,
    platformRole:      identity.platformRole,
    email:             identity.email,
    fullName:          identity.fullName,
    carerixUserId:     identity.carerixUserId,
    carerixCompanyId:  identity.carerixCompanyId,
    carerixEmployeeId: identity.carerixEmployeeId,
    userRoleIdInCarerix: identity.userRoleId,
    placement:         null,
    company:           null,
    agency:            null,
    warnings,
  };

  if (identity.platformRole === 'placement') {
    const t2 = Date.now();
    const fg = await fetchPlacementIdentityByCrUserId(identity.carerixUserId);
    timings.placementLookup = Date.now() - t2;
    if (!fg) {
      warnings.push('No CREmployee linked to this CRUser; placement-scoped queries will return nothing.');
      result.placement = { found: false };
    } else {
      result.placement = {
        found:                true,
        carerixEmployeeId:    fg.employeeID,
        functionGroupLevel1:  {
          id:   fg.fgLevel1Id,
          code: fg.fgLevel1Code,
          name: fg.fgLevel1Name,
        },
      };
      if (!fg.fgLevel1Code) {
        warnings.push('Placement has no toFunction1Level1Node set in Carerix — function-group linking will not work for them.');
      }
    }
  } else if (identity.platformRole === 'agency_admin' || identity.platformRole === 'agency_operations') {
    result.agency = {
      note: 'Agency role — will see all companies and placements (no per-company access scoping).',
    };
  } else {
    const t2 = Date.now();
    const probe = await probeCompanyAccess(identity.carerixUserId);
    timings.companyAccessLookup = Date.now() - t2;
    result.company = probe;

    if (probe.error)                                              warnings.push(probe.error);
    if (!probe.registryAvailable)                                 warnings.push('Carerix checkbox registry could not be loaded — function groups cannot be decoded right now.');
    if (probe.registryAvailable && probe.registryEntries === 0)   warnings.push('Carerix checkbox registry is empty — there are no Attribute-contact CRDataNodes with tag=checkboxType. Function groups cannot be decoded.');
    if (probe.linkedCompanies.length === 0)                       warnings.push('No CRUserCompany links — this user will see no companies after login.');
    if (probe.unknownCompanies.length > 0)                        warnings.push(`${probe.unknownCompanies.length} Carerix company(s) linked to this user are NOT yet imported into the platform companies table; they will be invisible after login. Run syncCarerixCompany for: ${probe.unknownCompanies.join(', ')}`);
    if (probe.registryAvailable && probe.decodedFunctionGroups.length === 0 && probe.linkedCompanies.length > 0) {
      warnings.push('No function-group checkboxes ticked on this CRUser — the user will be granted zero function groups (explicit deny) on each linked company.');
    }
  }

  timings.total = Date.now() - tStart;
  return { ...result, timings };
}

router.post('/probe', requireAuth, requireAgency, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) throw new ApiError('username and password are required', 400);

    const probeResult = await runLoginProbe(username, password);

    await writeAuditLog({
      eventType:    'login_probe',
      actorUserId:  req.user.id,
      actorRole:    req.user.role,
      payload: {
        probedUsername: username,
        approved:       probeResult.approved,
        role:           probeResult.platformRole || null,
        warnings:       probeResult.warnings?.length || 0,
        totalMs:        probeResult.timings?.total ?? null,
      },
      ipAddress: req.ip,
    });

    res.json(probeResult);
  } catch (err) { next(err); }
});

// ── Probe UI (HTML page served from the API itself) ──────────────────────────
//
// GET /auth/probe-ui
//
// Self-contained HTML page that calls /auth/probe. Same-origin = no CORS. The
// page is public (no auth on the route), but every probe call needs a valid
// agency JWT, which the user pastes into the page.
//
// Token + last-used inputs are persisted to localStorage so reloads don't lose
// state. No external dependencies — Tailwind is loaded from a CDN; everything
// else is inline.

const PROBE_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Confair · Login Probe</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  pre  { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pill { display: inline-block; padding: .15rem .5rem; border-radius: 9999px; font-size: .75rem; font-weight: 500; }
  details > summary { cursor: pointer; user-select: none; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before { content: "▸ "; transition: transform .15s; display: inline-block; }
  details[open] > summary::before { content: "▾ "; }
  .bar { height: 18px; background: linear-gradient(90deg,#4f46e5,#6366f1); border-radius: 4px; min-width: 2px; }
</style>
</head>
<body class="bg-slate-50 text-slate-800">
<div class="max-w-4xl mx-auto p-6 space-y-6">

  <header class="space-y-1">
    <h1 class="text-2xl font-semibold">Login Probe</h1>
    <p class="text-sm text-slate-600">
      Tests Carerix credentials end-to-end without creating a session. Shows the role, identity, function-group linkage, and company access this user would get on real login. Agency token required.
    </p>
  </header>

  <!-- ── Setup ─────────────────────────────────────────────────────────────── -->
  <section class="bg-white rounded-lg shadow-sm border border-slate-200 p-5 space-y-4">
    <h2 class="font-semibold text-slate-700">Setup</h2>

    <div class="space-y-1">
      <label class="text-sm font-medium text-slate-700">Agency access token</label>
      <textarea id="token" rows="3" class="w-full font-mono text-xs px-3 py-2 border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Paste your accessToken from /auth/login/agency"></textarea>
      <p class="text-xs text-slate-500">Stored in your browser's localStorage. Required because /auth/probe is agency-only.</p>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="space-y-1">
        <label class="text-sm font-medium text-slate-700">Test username</label>
        <input id="username" type="text" autocomplete="off" class="w-full px-3 py-2 border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      </div>
      <div class="space-y-1">
        <label class="text-sm font-medium text-slate-700">Test password</label>
        <input id="password" type="password" autocomplete="new-password" class="w-full px-3 py-2 border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      </div>
    </div>

    <div class="flex items-center gap-3">
      <button id="probeBtn" class="px-4 py-2 bg-indigo-600 text-white rounded font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">
        Run probe
      </button>
      <button id="clearBtn" class="px-3 py-2 text-sm text-slate-600 hover:text-slate-900">Clear</button>
      <span id="status" class="text-sm text-slate-500"></span>
    </div>
  </section>

  <!-- ── Results ────────────────────────────────────────────────────────────── -->
  <section id="results" class="hidden space-y-5"></section>

</div>

<script>
  const $ = (id) => document.getElementById(id);
  const tokenEl  = $('token');
  const userEl   = $('username');
  const passEl   = $('password');
  const btn      = $('probeBtn');
  const statusEl = $('status');
  const results  = $('results');

  // Restore from localStorage
  tokenEl.value = localStorage.getItem('probeToken')    || '';
  userEl.value  = localStorage.getItem('probeUsername') || '';
  tokenEl.addEventListener('change', () => localStorage.setItem('probeToken',    tokenEl.value.trim()));
  userEl .addEventListener('change', () => localStorage.setItem('probeUsername', userEl.value.trim()));

  $('clearBtn').addEventListener('click', () => {
    userEl.value = ''; passEl.value = ''; results.innerHTML = ''; results.classList.add('hidden');
    statusEl.textContent = '';
    localStorage.removeItem('probeUsername');
  });

  btn.addEventListener('click', async () => {
    const token    = tokenEl.value.trim();
    const username = userEl.value.trim();
    const password = passEl.value;
    if (!token)    return setStatus('Paste an agency token first.', 'rose');
    if (!username) return setStatus('Enter a username.',            'rose');
    if (!password) return setStatus('Enter a password.',            'rose');

    btn.disabled = true; setStatus('Probing…', 'slate');
    const t0 = performance.now();
    try {
      const res = await fetch('/auth/probe', {
        method:  'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password }),
      });
      const wallMs = Math.round(performance.now() - t0);
      let body;
      try { body = await res.json(); } catch { body = { rawBody: await res.text() }; }
      if (!res.ok && res.status === 401) {
        setStatus('Token rejected (401). Re-login as agency and paste a fresh token.', 'rose');
        return;
      }
      if (!res.ok && res.status === 403) {
        setStatus('Forbidden (403). The pasted token is not an agency token.', 'rose');
        return;
      }
      render(body, wallMs);
      setStatus('Done.', 'emerald');
    } catch (err) {
      setStatus('Network error: ' + err.message, 'rose');
    } finally {
      btn.disabled = false;
    }
  });

  function setStatus(msg, tone) {
    const colorMap = { rose:'text-rose-600', emerald:'text-emerald-600', slate:'text-slate-500' };
    statusEl.className = 'text-sm ' + (colorMap[tone] || colorMap.slate);
    statusEl.textContent = msg;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function pill(text, tone) {
    const tones = {
      green: 'bg-emerald-100 text-emerald-800',
      red:   'bg-rose-100 text-rose-800',
      blue:  'bg-indigo-100 text-indigo-800',
      slate: 'bg-slate-100 text-slate-700',
      amber: 'bg-amber-100 text-amber-800',
    };
    return '<span class="pill ' + (tones[tone] || tones.slate) + '">' + esc(text) + '</span>';
  }

  function timingRows(timings, wallMs) {
    if (!timings) return '';
    const total = timings.total || 1;
    const rows  = Object.entries(timings)
      .filter(([k]) => k !== 'total')
      .map(([k, v]) => {
        const pct = Math.max(2, Math.round((v / total) * 100));
        return '<div class="flex items-center gap-3 text-xs">' +
                 '<div class="w-44 text-slate-600 font-mono">' + esc(k) + '</div>' +
                 '<div class="flex-1 bg-slate-100 rounded">' +
                   '<div class="bar" style="width:' + pct + '%"></div>' +
                 '</div>' +
                 '<div class="w-16 text-right font-mono text-slate-700">' + v + ' ms</div>' +
               '</div>';
      }).join('');
    const networkMs = wallMs - total;
    return '<div class="space-y-1.5">' + rows +
           '<div class="flex items-center gap-3 text-xs pt-1 border-t border-slate-200">' +
             '<div class="w-44 text-slate-600 font-mono">total (server)</div>' +
             '<div class="flex-1"></div>' +
             '<div class="w-16 text-right font-mono font-semibold text-slate-800">' + total + ' ms</div>' +
           '</div>' +
           '<div class="flex items-center gap-3 text-xs">' +
             '<div class="w-44 text-slate-500 font-mono">network roundtrip</div>' +
             '<div class="flex-1"></div>' +
             '<div class="w-16 text-right font-mono text-slate-500">~' + networkMs + ' ms</div>' +
           '</div>' +
           '<div class="flex items-center gap-3 text-xs">' +
             '<div class="w-44 text-slate-500 font-mono">wall (browser)</div>' +
             '<div class="flex-1"></div>' +
             '<div class="w-16 text-right font-mono text-slate-500">' + wallMs + ' ms</div>' +
           '</div>' +
           '</div>';
  }

  function warningsBlock(warnings) {
    if (!warnings || warnings.length === 0) {
      return '<div class="text-sm text-emerald-700">No warnings — configuration looks healthy.</div>';
    }
    return warnings.map(w =>
      '<div class="flex gap-2 items-start p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-900">' +
        '<svg class="w-4 h-4 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" /></svg>' +
        '<span>' + esc(w) + '</span>' +
      '</div>'
    ).join('');
  }

  function placementBlock(p) {
    if (!p) return '';
    if (!p.found) {
      return '<div class="text-sm text-rose-700">No linked CREmployee found for this CRUser.</div>';
    }
    const fg = p.functionGroupLevel1 || {};
    return '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">' +
             field('Employee ID',           p.carerixEmployeeId) +
             field('Function group code',   fg.code || '—') +
             field('Function group name',   fg.name || '—') +
             field('Function group node',   fg.id   || '—') +
           '</div>';
  }

  function companyBlock(c) {
    if (!c) return '';
    const tableRows = (c.linkedCompanies || []).map(co => {
      const tone = co.imported ? 'green' : 'amber';
      return '<tr class="border-t border-slate-200">' +
               '<td class="py-1.5 pr-3 font-mono text-xs">' + esc(co.carerixCompanyId) + '</td>' +
               '<td class="py-1.5 pr-3">' + esc(co.nameInCarerix || '—') + '</td>' +
               '<td class="py-1.5 pr-3">' + esc(co.platformCompanyName || '—') + '</td>' +
               '<td class="py-1.5">' + pill(co.imported ? 'imported' : 'NOT imported', tone) + '</td>' +
             '</tr>';
    }).join('');
    const fgs = (c.decodedFunctionGroups || []).map(g => pill(g, 'blue')).join(' ') || '<span class="text-slate-500">none ticked</span>';
    return '<div class="space-y-3 text-sm">' +
             '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">' +
               field('Registry available',         String(c.registryAvailable)) +
               field('Registry entries',           String(c.registryEntries)) +
               field('Checkboxes ticked',          String(c.additionalInfoKeysSet?.length || 0)) +
               field('Linked companies',           String(c.linkedCompanies?.length || 0)) +
             '</div>' +
             '<div class="space-y-1">' +
               '<div class="text-xs font-medium text-slate-500 uppercase tracking-wide">Decoded function groups</div>' +
               '<div class="flex gap-1.5 flex-wrap">' + fgs + '</div>' +
             '</div>' +
             (c.linkedCompanies?.length
               ? '<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-xs uppercase tracking-wide text-slate-500"><th class="text-left py-1 pr-3">Carerix ID</th><th class="text-left py-1 pr-3">Name in Carerix</th><th class="text-left py-1 pr-3">Platform company</th><th class="text-left py-1">Status</th></tr></thead><tbody>' + tableRows + '</tbody></table></div>'
               : '') +
           '</div>';
  }

  function field(label, value) {
    return '<div><div class="text-xs font-medium text-slate-500 uppercase tracking-wide">' + esc(label) + '</div><div class="font-mono text-sm">' + esc(value ?? '—') + '</div></div>';
  }

  function render(body, wallMs) {
    results.classList.remove('hidden');
    if (!body.approved) {
      const err = body.error || {};
      results.innerHTML =
        '<div class="bg-white rounded-lg shadow-sm border border-rose-200 p-5 space-y-3">' +
          '<div class="flex items-center gap-2">' +
            pill('Login rejected', 'red') +
            '<span class="text-sm text-slate-600">HTTP ' + esc(err.status || '?') + '</span>' +
          '</div>' +
          '<div class="text-slate-700">' + esc(err.message || 'Unknown error') + '</div>' +
          '<details><summary class="text-xs text-slate-500">Timings</summary><div class="pt-2">' + timingRows(body.timings, wallMs) + '</div></details>' +
        '</div>';
      return;
    }

    const role = body.platformRole;
    const roleTone = role === 'placement' ? 'blue' : (role && role.startsWith('agency') ? 'green' : 'slate');

    const headerCard =
      '<div class="bg-white rounded-lg shadow-sm border border-emerald-200 p-5 space-y-3">' +
        '<div class="flex items-center gap-2 flex-wrap">' +
          pill('Approved', 'green') +
          pill(role || 'unknown', roleTone) +
          (body.userRoleIdInCarerix != null ? '<span class="text-xs text-slate-500">CRUserRole id=' + esc(body.userRoleIdInCarerix) + '</span>' : '') +
        '</div>' +
        '<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">' +
          field('Display name',      body.fullName) +
          field('Email',             body.email) +
          field('Carerix user ID',   body.carerixUserId) +
          field('Carerix company ID', body.carerixCompanyId) +
        '</div>' +
      '</div>';

    let detail = '';
    if (body.placement) {
      detail =
        '<div class="bg-white rounded-lg shadow-sm border border-slate-200 p-5 space-y-3">' +
          '<h3 class="font-semibold text-slate-700">Placement identity</h3>' +
          placementBlock(body.placement) +
        '</div>';
    } else if (body.company) {
      detail =
        '<div class="bg-white rounded-lg shadow-sm border border-slate-200 p-5 space-y-3">' +
          '<h3 class="font-semibold text-slate-700">Company access</h3>' +
          companyBlock(body.company) +
        '</div>';
    } else if (body.agency) {
      detail =
        '<div class="bg-white rounded-lg shadow-sm border border-slate-200 p-5 space-y-3">' +
          '<h3 class="font-semibold text-slate-700">Agency access</h3>' +
          '<div class="text-sm text-slate-700">' + esc(body.agency.note) + '</div>' +
        '</div>';
    }

    const warningsCard =
      '<div class="bg-white rounded-lg shadow-sm border border-slate-200 p-5 space-y-3">' +
        '<h3 class="font-semibold text-slate-700">Warnings</h3>' +
        '<div class="space-y-2">' + warningsBlock(body.warnings) + '</div>' +
      '</div>';

    const timingsCard =
      '<div class="bg-white rounded-lg shadow-sm border border-slate-200 p-5 space-y-3">' +
        '<h3 class="font-semibold text-slate-700">Timings</h3>' +
        timingRows(body.timings, wallMs) +
      '</div>';

    const rawCard =
      '<details class="bg-white rounded-lg shadow-sm border border-slate-200 p-5">' +
        '<summary class="font-semibold text-slate-700">Raw response</summary>' +
        '<pre class="mt-3 text-xs bg-slate-50 p-3 rounded overflow-x-auto">' + esc(JSON.stringify(body, null, 2)) + '</pre>' +
      '</details>';

    results.innerHTML = headerCard + detail + warningsCard + timingsCard + rawCard;
  }
</script>
</body>
</html>`;

router.get('/probe-ui', (req, res) => {
  res.setHeader('Content-Type',  'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(PROBE_UI_HTML);
});

export default router;
