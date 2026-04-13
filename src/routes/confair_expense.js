/**
 * Minggo Expense API integration (via api.confair.eu/minggo/api/v1)
 * OAuth2 Password grant — client_id=minggo, Auth/login endpoint
 */
import { Router } from 'express';
import { logger } from '../utils/logger.js';
const router = Router();

// Minggo API bases — OrgID=5 confirmed from hrportal.confair.eu AppData
const MINGGO_BASES = [
  'https://api-test.confair.eu/minggo/api/v1',
  'https://api.confair.eu/minggo/api/v1',
];
const ORG_ID = 5; // Wizz Air Group / Confair OrgID from hrportal

let tokenCache = { token: null, expiresAt: 0, base: null };

async function getMinggoToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return { token: tokenCache.token, base: tokenCache.base };

  const username = process.env.CONFAIR_API_CLIENT_ID;
  const password = process.env.CONFAIR_API_CLIENT_SECRET;

  if (!username || !password) throw new Error('CONFAIR_API_CLIENT_ID or CONFAIR_API_CLIENT_SECRET not set in Railway env');

  for (const base of MINGGO_BASES) {
    // Try JSON body first
    for (const [contentType, body] of [
      ['application/json', JSON.stringify({ username, password, client_id: 'minggo' })],
      ['application/json', JSON.stringify({ username, password })],
      ['application/x-www-form-urlencoded', new URLSearchParams({ grant_type: 'password', client_id: 'minggo', client_secret: 'minggo', username, password }).toString()],
      ['application/x-www-form-urlencoded', new URLSearchParams({ grant_type: 'password', username, password }).toString()],
    ]) {
      try {
        const r = await fetch(`${base}/Auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': contentType, 'Accept': 'application/json' },
          body,
        });
        const text = await r.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }

        logger.info('Minggo auth attempt', { base, contentType, status: r.status, keys: Object.keys(data) });

        if (r.ok) {
          const token = data.access_token || data.token || data.accessToken || data.userToken || data.UserToken || data.jwt;
          if (token) {
            tokenCache = { token, base, expiresAt: Date.now() + 55 * 60 * 1000 };
            logger.info('Minggo token obtained!', { base, contentType, tokenPreview: token.substring(0, 20) });
            return { token, base };
          }
          // 200 but no token — log full response
          logger.info('Minggo auth 200 but no token key', { base, contentType, data: JSON.stringify(data).substring(0, 300) });
          return { token: null, base, rawResponse: data };
        }
        if (r.status !== 401 && r.status !== 400) {
          logger.warn('Minggo unexpected status', { base, contentType, status: r.status, data: JSON.stringify(data).substring(0, 200) });
        }
      } catch (e) {
        logger.error('Minggo auth fetch error', { base, contentType, error: e.message });
      }
    }
  }
  throw new Error('All Minggo auth attempts failed');
}

// ── GET /confair-expense/test ──────────────────────────────────────────────────
router.get('/test', async (req, res) => {
  const username = process.env.CONFAIR_API_CLIENT_ID;
  const password = process.env.CONFAIR_API_CLIENT_SECRET;
  const results  = [];

  for (const base of MINGGO_BASES) {
    for (const [label, contentType, body] of [
      // companyID=5 (OrgID from hrportal AppData = Wizz Air Group)
      ['JSON+companyID5',    'application/json', JSON.stringify({ username, password, companyID: 5 })],
      ['JSON+client+org5',   'application/json', JSON.stringify({ username, password, client_id: 'minggo', companyID: 5 })],
      ['FORM+org5',          'application/x-www-form-urlencoded', new URLSearchParams({ grant_type: 'password', client_id: 'minggo', client_secret: 'minggo', username, password, companyID: '5' }).toString()],
      // Also try without companyID  
      ['JSON+client_id',     'application/json', JSON.stringify({ username, password, client_id: 'minggo' })],
      ['JSON only',          'application/json', JSON.stringify({ username, password })],
      ['FORM OAuth2',        'application/x-www-form-urlencoded', new URLSearchParams({ grant_type: 'password', client_id: 'minggo', client_secret: 'minggo', username, password }).toString()],
    ]) {
      try {
        const r    = await fetch(`${base}/Auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': contentType, Accept: 'application/json' },
          body,
        });
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 200) }; }
        results.push({ base, label, status: r.status, keys: Object.keys(data), data });
      } catch (e) {
        results.push({ base, label, error: e.message });
      }
    }
  }

  res.json({
    envSet: { clientId: !!username, clientIdMasked: username ? username.substring(0,3) + '***' : null, secret: !!password },
    results,
  });
});

// ── GET /confair-expense/expenses — proxy list ─────────────────────────────────
router.get('/expenses', async (req, res, next) => {
  try {
    const { token, base } = await getMinggoToken();
    const r = await fetch(`${base}/expenses`, { headers: { Authorization: `Bearer ${token}` } });
    res.json(await r.json());
  } catch (err) { next(err); }
});

export default router;
