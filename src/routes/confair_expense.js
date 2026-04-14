/**
 * Confair expense integration
 * Two approaches tested in parallel:
 * 1. Portal session (hrportal.confair.eu)
 * 2. Minggo production API (api.confair.eu/minggo/api/v1)
 */
import { Router } from 'express';
import { logger } from '../utils/logger.js';
const router = Router();

const PORTAL      = 'https://hrportal.confair.eu';
const MINGGO_PROD = 'https://api.confair.eu/minggo/api/v1';

const formEncode = s => encodeURIComponent(String(s))
  .replace(/!/g,'%21').replace(/~/g,'%7E')
  .replace(/'/g,'%27').replace(/\(/g,'%28').replace(/\)/g,'%29');

// ── GET /confair-expense/test ──────────────────────────────────────────────────
router.get('/test', async (req, res) => {
  const username = req.query.u || process.env.CONFAIR_API_CLIENT_ID;
  const password = req.query.p || process.env.CONFAIR_API_CLIENT_SECRET;
  const result   = { env: { masked: username?.substring(0,3)+'***', secretSet: !!password }, portal: [], minggo: [] };

  // ── PORTAL LOGIN ─────────────────────────────────────────────────────────────
  try {
    // Step 1: GET login page
    const r1 = await fetch(`${PORTAL}/Account/Login`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html1 = await r1.text();
    const cookie1 = (r1.headers.get('set-cookie') || '').split(';')[0].trim();

    // Extract ALL hidden inputs from the form
    const hidden = [...html1.matchAll(/type=["']hidden["'][^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi),
                   ...html1.matchAll(/name=["']([^"']+)["'][^>]*type=["']hidden["'][^>]*value=["']([^"']*)["']/gi)]
      .map(m => ({ name: m[1], value: m[2] }));

    const formAction = html1.match(/action=["']([^"']+)["']/)?.[1] || '/';

    logger.info('[expense] portal step1', { status: r1.status, cookie: cookie1.substring(0,40), hidden, formAction });
    result.portal.push({ step: 'GET /Account/Login', status: r1.status, cookie: cookie1.substring(0,40), hidden, formAction });

    // Step 2: POST login — include all hidden fields
    const parts = [`ReturnUrl=`, `Username=${formEncode(username)}`, `Password=${formEncode(password)}`];
    for (const h of hidden) parts.push(`${formEncode(h.name)}=${formEncode(h.value)}`);
    const bodyStr = parts.join('&');

    logger.info('[expense] portal step2 body (masked)', { body: bodyStr.replace(formEncode(password), '***') });

    const r2 = await fetch(`${PORTAL}${formAction.startsWith('http') ? '' : ''}${formAction.startsWith('http') ? formAction : formAction === '/' ? '/' : '/' + formAction.replace(/^\//,'')}`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/x-www-form-urlencoded',
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin':          PORTAL,
        'Referer':         `${PORTAL}/Account/Login`,
        'Cookie':          cookie1,
      },
      body:     bodyStr,
      redirect: 'manual',
    });

    const cookie2   = r2.headers.get('set-cookie') || '';
    const location2 = r2.headers.get('location')   || '';
    const allHeaders2 = Object.fromEntries([...r2.headers.entries()]);
    const body2Preview = ''; // don't await body on redirect
    const success = r2.status === 302 && !location2.toLowerCase().includes('login');

    logger.info('[expense] portal step2 response', { status: r2.status, location: location2, setCookieLen: cookie2.length, success, allHeaders: allHeaders2 });
    result.portal.push({ step: 'POST login', status: r2.status, location: location2, setCookieLen: cookie2.length, success, responseHeaders: allHeaders2 });

    if (success) {
      const allCookies = [cookie1, ...cookie2.split(',').map(c => c.split(';')[0].trim())].filter(Boolean).join('; ');
      const gridBody   = new URLSearchParams({ sort:'', page:'1', pageSize:'5', group:'', filter:'', filterData: JSON.stringify({ Status:'', HomeBase:'', Employee:'', Category:'', Month:'' }) });
      const r3 = await fetch(`${PORTAL}/Expenses/GetGridData`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': allCookies, 'Referer': `${PORTAL}/Expenses` },
        body: gridBody.toString(),
      });
      let data3; try { data3 = await r3.json(); } catch { data3 = { raw: (await r3.text()).substring(0,300) }; }
      logger.info('[expense] GetGridData', { status: r3.status, total: data3.Total, count: data3.Data?.length });
      result.portal.push({ step: 'GetGridData', status: r3.status, total: data3.Total, count: data3.Data?.length, sample: data3.Data?.[0] });
    }
  } catch(e) {
    logger.error('[expense] portal error', { error: e.message, stack: e.stack });
    result.portal.push({ error: e.message });
  }

  // ── MINGGO PRODUCTION API ─────────────────────────────────────────────────────
  const minggoAttempts = [
    { label: 'JSON u/p + companyID5',  ct: 'application/json',                    body: JSON.stringify({ username, password, companyID: 5 }) },
    { label: 'JSON u/p only',          ct: 'application/json',                    body: JSON.stringify({ username, password }) },
    { label: 'FORM OAuth2 pwd grant',  ct: 'application/x-www-form-urlencoded',   body: new URLSearchParams({ grant_type:'password', client_id:'minggo', client_secret:'minggo', username, password }).toString() },
    { label: 'FORM no client_secret',  ct: 'application/x-www-form-urlencoded',   body: new URLSearchParams({ grant_type:'password', client_id:'minggo', username, password }).toString() },
  ];

  for (const { label, ct, body } of minggoAttempts) {
    try {
      const r = await fetch(`${MINGGO_PROD}/Auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': ct, 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body,
      });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text.substring(0,200) }; }
      logger.info('[expense] minggo attempt', { label, status: r.status, keys: Object.keys(data), preview: JSON.stringify(data).substring(0,150) });
      result.minggo.push({ label, status: r.status, keys: Object.keys(data), data });
      if (r.ok && (data.access_token || data.token || data.userToken)) {
        result.minggo.push({ label: '✅ TOKEN FOUND', token: (data.access_token || data.token || data.userToken)?.substring(0,30) + '...' });
        break;
      }
    } catch(e) {
      logger.error('[expense] minggo error', { label, error: e.message });
      result.minggo.push({ label, error: e.message });
    }
  }

  res.json(result);
});

export default router;
