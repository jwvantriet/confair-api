/**
 * Confair HR Portal expense proxy
 * Authenticates to hrportal.confair.eu via session cookie (ASP.NET MVC)
 * then proxies /Expenses/GetGridData — no Minggo API needed
 */
import { Router } from 'express';
import { logger } from '../utils/logger.js';
const router = Router();

const PORTAL = 'https://hrportal.confair.eu';
let sessionCache = { cookie: null, expiresAt: 0 };

async function getPortalSession() {
  if (sessionCache.cookie && Date.now() < sessionCache.expiresAt) return sessionCache.cookie;

  const username = process.env.CONFAIR_API_CLIENT_ID;
  const password = process.env.CONFAIR_API_CLIENT_SECRET;
  if (!username || !password) throw new Error('CONFAIR_API_CLIENT_ID / SECRET not set');

  // Step 1: GET login page to get verification token + initial cookies
  const loginPageRes = await fetch(`${PORTAL}/Account/Login`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    redirect: 'follow',
  });

  const setCookieHeader = loginPageRes.headers.get('set-cookie') || '';
  const initialCookie  = setCookieHeader.split(';')[0]; // grab first cookie value
  const html           = await loginPageRes.text();

  // Extract CSRF token
  const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]+value="([^"]+)"/);
  const csrfToken  = tokenMatch?.[1] || '';
  logger.info('Portal login page', { status: loginPageRes.status, hasCsrf: !!csrfToken, cookieLen: initialCookie.length });

  // Step 2: POST login form
  const formBody = new URLSearchParams({
    Username:  username,
    Password:  password,
    ReturnUrl: '/Expenses',
  });

  const loginRes = await fetch(`${PORTAL}/`, {
    method:   'POST',
    headers:  {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept':       'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Cookie:         initialCookie,
      Referer:        `${PORTAL}/Account/Login?U=%2fExpenses`,
      Origin:         PORTAL,
    },
    body:     formBody.toString(),
    redirect: 'manual',
  });

  const authCookies = loginRes.headers.get('set-cookie') || '';
  // Extract all meaningful cookies
  const cookies = [
    ...setCookieHeader.split(',').map(c => c.split(';')[0].trim()),
    ...authCookies.split(',').map(c => c.split(';')[0].trim()),
  ].filter(Boolean).join('; ');

  logger.info('Portal login response', { status: loginRes.status, location: loginRes.headers.get('location'), cookieCount: cookies.split(';').length });

  if (loginRes.status === 302 || loginRes.status === 200) {
    sessionCache = { cookie: cookies, expiresAt: Date.now() + 20 * 60 * 1000 };
    return cookies;
  }

  throw new Error(`Portal login failed: ${loginRes.status}`);
}

// ── GET /confair-expense/test ──────────────────────────────────────────────────
router.get('/test', async (req, res) => {
  // Allow credential override via query params for debugging (test endpoint only)
  const username = req.query.u || process.env.CONFAIR_API_CLIENT_ID;
  const password = req.query.p || process.env.CONFAIR_API_CLIENT_SECRET;
  const result   = { envSet: { clientId: !!username, masked: username?.substring(0,3)+'***', secret: !!password }, steps: [] };

  try {
    // Step 1: get login page
    const loginPageRes = await fetch(`${PORTAL}/Account/Login`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    });
    const html = await loginPageRes.text();
    const csrfToken = html.match(/name="__RequestVerificationToken"[^>]+value="([^"]+)"/)?.[1] || '';
    const setCookie = loginPageRes.headers.get('set-cookie') || '';
    const initCookie = setCookie.split(';')[0];
    result.steps.push({ step: 'GET /Account/Login', status: loginPageRes.status, hasCsrf: !!csrfToken, cookie: initCookie.substring(0,50) });

    // Step 2: POST login
    const formBody = new URLSearchParams({ Username: username, Password: password, ReturnUrl: '/Expenses' });
    const loginRes = await fetch(`${PORTAL}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':       'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie:         initCookie,
        Referer:        `${PORTAL}/Account/Login?U=%2fExpenses`,
        Origin:         PORTAL,
      },
      body: formBody.toString(),
      redirect: 'manual',
    });
    const authCookie = loginRes.headers.get('set-cookie') || '';
    const location   = loginRes.headers.get('location') || '';
    result.steps.push({ step: 'POST /', status: loginRes.status, location, authCookieLen: authCookie.length, success: loginRes.status === 302 && !location.includes('Login') });

    if (loginRes.status === 302 && !location.includes('Login')) {
      // Step 3: try GetGridData
      const allCookies = [initCookie, ...authCookie.split(',').map(c => c.split(';')[0].trim())].filter(Boolean).join('; ');
      const gridRes = await fetch(`${PORTAL}/Expenses/GetGridData?page=1&pageSize=10&sort=&group=&filter=`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Cookie: allCookies, 'X-Requested-With': 'XMLHttpRequest' },
      });
      const gridText = await gridRes.text();
      let gridData; try { gridData = JSON.parse(gridText); } catch { gridData = { raw: gridText.substring(0, 300) }; }
      result.steps.push({ step: 'GET /Expenses/GetGridData', status: gridRes.status, dataKeys: Object.keys(gridData), sample: JSON.stringify(gridData).substring(0, 500) });
    }
  } catch (e) {
    result.error = e.message;
  }

  res.json(result);
});

// ── GET /confair-expense/expenses — fetch expenses via portal session ───────────
router.get('/expenses', async (req, res, next) => {
  try {
    const cookie  = await getPortalSession();
    const gridRes = await fetch(`${PORTAL}/Expenses/GetGridData?page=1&pageSize=50`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest' },
    });
    const data = await gridRes.json();
    res.json(data);
  } catch (err) { next(err); }
});

export default router;
