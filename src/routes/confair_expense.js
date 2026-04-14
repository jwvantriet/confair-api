/**
 * Confair HR Portal expense proxy
 * Auth: POST to https://hrportal.confair.eu/ with Username + Password form fields
 * Data: POST to /Expenses/GetGridData with filterData JSON + Kendo paging params
 */
import { Router } from 'express';
import { logger } from '../utils/logger.js';
const router = Router();

const PORTAL = 'https://hrportal.confair.eu';
let sessionCache = { cookie: null, expiresAt: 0 };

async function getPortalSession(usernameOverride, passwordOverride) {
  if (!usernameOverride && sessionCache.cookie && Date.now() < sessionCache.expiresAt) return sessionCache.cookie;

  const username = usernameOverride || process.env.CONFAIR_API_CLIENT_ID;
  const password = passwordOverride || process.env.CONFAIR_API_CLIENT_SECRET;
  if (!username || !password) throw new Error('No credentials');

  // Step 1: GET login page for session cookie
  const step1 = await fetch(`${PORTAL}/Account/Login`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  const rawCookie = step1.headers.get('set-cookie') || '';
  const sessionCookie = rawCookie.split(';')[0].trim();

  logger.info('Portal step1', { status: step1.status, sessionCookie: sessionCookie.substring(0, 40) });

  // Step 2: POST login - exact same as the browser form
  // Exact body the browser sends (ReturnUrl empty, ! encoded as %21)
  const formBody = `ReturnUrl=&Username=${encodeURIComponent(username)}&Password=${encodeURIComponent(password)}`;

  const step2 = await fetch(`${PORTAL}/`, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/x-www-form-urlencoded',
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin':          PORTAL,
      'Referer':         `${PORTAL}/Account/Login`,
      'Cookie':          sessionCookie,
    },
    body:     formBody,
    redirect: 'manual',
  });

  const authSetCookie  = step2.headers.get('set-cookie') || '';
  const location       = step2.headers.get('location') || '';
  const loginFailed    = location.includes('Login');

  logger.info('Portal step2', { status: step2.status, location, authCookieLen: authSetCookie.length, loginFailed });

  if (loginFailed) throw new Error(`Login failed — redirected to ${location}`);

  // Combine all cookies
  const allCookies = [sessionCookie, ...authSetCookie.split(',').map(c => c.split(';')[0].trim())].filter(Boolean).join('; ');
  sessionCache = { cookie: allCookies, expiresAt: Date.now() + 20 * 60 * 1000 };
  return allCookies;
}

async function fetchExpenses(cookie, filters = {}, page = 1, pageSize = 50) {
  const filterData = JSON.stringify({
    Status:   filters.status   || '',
    HomeBase: filters.homeBase || '',
    Employee: filters.employee || '',
    Category: filters.category || '',
    Month:    filters.month    || '',
    ...filters.extra,
  });

  const body = new URLSearchParams({
    sort:       '',
    page:       String(page),
    pageSize:   String(pageSize),
    group:      '',
    filter:     '',
    filterData,
  });

  const r = await fetch(`${PORTAL}/Expenses/GetGridData`, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept':            '*/*',
      'X-Requested-With':  'XMLHttpRequest',
      'User-Agent':        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer':           `${PORTAL}/Expenses`,
      'Cookie':            cookie,
    },
    body: body.toString(),
  });

  if (!r.ok) throw new Error(`GetGridData failed: ${r.status}`);
  return r.json();
}

// ── GET /confair-expense/test ──────────────────────────────────────────────────
router.get('/test', async (req, res) => {
  const username = req.query.u || process.env.CONFAIR_API_CLIENT_ID;
  const password = req.query.p || process.env.CONFAIR_API_CLIENT_SECRET;
  const result   = { env: { masked: username?.substring(0,3)+'***', secretSet: !!password }, steps: [] };

  try {
    // Step 1: get session cookie
    const step1 = await fetch(`${PORTAL}/Account/Login`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    });
    const rawCookie    = step1.headers.get('set-cookie') || '';
    const sessionCookie = rawCookie.split(';')[0].trim();
    result.steps.push({ step: '1. GET /Account/Login', status: step1.status, cookie: sessionCookie.substring(0,50) });

    // Step 2: POST login
    // Exact body the browser sends: ReturnUrl empty, ! encoded as %21
    const formBody = `ReturnUrl=&Username=${encodeURIComponent(username)}&Password=${encodeURIComponent(password)}`;
    const step2 = await fetch(`${PORTAL}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':       'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Origin':       PORTAL,
        'Referer':      `${PORTAL}/Account/Login`,
        'Cookie':       sessionCookie,
      },
      body: formBody,
      redirect: 'manual',
    });
    const authCookie = step2.headers.get('set-cookie') || '';
    const location   = step2.headers.get('location') || '';
    const success    = step2.status === 302 && !location.includes('Login');
    result.steps.push({ step: '2. POST / (login)', status: step2.status, location, authCookieLen: authCookie.length, success });

    if (success) {
      // Step 3: POST GetGridData
      const allCookies = [sessionCookie, ...authCookie.split(',').map(c => c.split(';')[0].trim())].filter(Boolean).join('; ');
      const filterData = JSON.stringify({ Status: '', HomeBase: '', Employee: '', Category: '', Month: '' });
      const gridBody   = new URLSearchParams({ sort: '', page: '1', pageSize: '10', group: '', filter: '', filterData });

      const step3 = await fetch(`${PORTAL}/Expenses/GetGridData`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept':       '*/*',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer':      `${PORTAL}/Expenses`,
          'Cookie':       allCookies,
        },
        body: gridBody.toString(),
      });
      let data; try { data = await step3.json(); } catch { data = { raw: await step3.text().then(t => t.substring(0,200)) }; }
      result.steps.push({ step: '3. POST /Expenses/GetGridData', status: step3.status, total: data.Total, count: data.Data?.length, sample: data.Data?.[0] });
    }
  } catch(e) {
    result.error = e.message;
  }

  res.json(result);
});

// ── GET /confair-expense/expenses ─────────────────────────────────────────────
router.get('/expenses', async (req, res, next) => {
  try {
    const cookie = await getPortalSession();
    const data   = await fetchExpenses(cookie, {
      status:   req.query.status,
      homeBase: req.query.homeBase,
      employee: req.query.employee,
      month:    req.query.month,
    }, Number(req.query.page || 1), Number(req.query.pageSize || 50));
    res.json(data);
  } catch(err) { next(err); }
});

export default router;
