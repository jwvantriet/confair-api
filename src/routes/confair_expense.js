/**
 * Confair Expense API integration
 * Tests connection and proxies expense data
 */
import { Router } from 'express';
import { logger } from '../utils/logger.js';
const router = Router();

const CONFAIR_API = 'https://api.confair.eu';

// Token cache
let tokenCache = { token: null, expiresAt: 0 };

async function getConfairToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const clientId     = process.env.CONFAIR_API_CLIENT_ID;
  const clientSecret = process.env.CONFAIR_API_CLIENT_SECRET;

  if (!clientId || !clientSecret) throw new Error('CONFAIR_API_CLIENT_ID or CONFAIR_API_CLIENT_SECRET not set');

  // Try different companyID values (0, 1, 6)
  const companyIDs = [0, 1, 6, 658];
  const roles      = ['EXPENSE_MANAGER', 'ROLE_WEB_USER', undefined];

  for (const companyID of companyIDs) {
    for (const role of roles) {
      const body = { username: clientId, password: clientSecret, companyID };
      if (role) body.role = role;

      try {
        const r = await fetch(`${CONFAIR_API}/api/account/signin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await r.json();
        logger.info('Confair signin attempt', { companyID, role, status: r.status, keys: Object.keys(data) });

        if (r.ok && (data.token || data.userToken || data.accessToken || data.UserToken)) {
          const token = data.token || data.userToken || data.accessToken || data.UserToken;
          tokenCache = { token, expiresAt: Date.now() + 50 * 60 * 1000 };
          logger.info('Confair token obtained', { companyID, role });
          return token;
        }
        if (r.ok) {
          // Log full response to see what keys we get back
          logger.info('Confair signin OK but no token key found', { companyID, role, data: JSON.stringify(data).substring(0, 200) });
        }
      } catch (e) {
        logger.error('Confair signin error', { companyID, role, error: e.message });
      }
    }
  }
  throw new Error('Could not authenticate with Confair API');
}

// ── GET /confair-expense/test — test auth and return result ────────────────────
router.get('/test', async (req, res) => {
  const clientId     = process.env.CONFAIR_API_CLIENT_ID;
  const clientSecret = process.env.CONFAIR_API_CLIENT_SECRET;

  const results = [];

  // Try all companyID / role combos and return full responses
  const companyIDs = [0, 1, 6, 658];
  for (const companyID of companyIDs) {
    const body = { username: clientId, password: clientSecret, companyID };
    try {
      const r   = await fetch(`${CONFAIR_API}/api/account/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      results.push({ companyID, status: r.status, keys: Object.keys(data), data });
    } catch (e) {
      results.push({ companyID, error: e.message });
    }
  }

  res.json({
    clientIdSet: !!clientId,
    clientSecretSet: !!clientSecret,
    clientIdValue: clientId ? `${clientId.substring(0,3)}***` : null,
    results,
  });
});

// ── GET /confair-expense/statuses — fetch expense statuses ─────────────────────
router.get('/statuses', async (req, res, next) => {
  try {
    const token = await getConfairToken();
    const r = await fetch(`${CONFAIR_API}/api/expense-statuses`, {
      headers: { UserToken: token }
    });
    res.json(await r.json());
  } catch (err) { next(err); }
});

// ── GET /confair-expense/list — fetch expenses ─────────────────────────────────
router.get('/list', async (req, res, next) => {
  try {
    const token = await getConfairToken();
    const r = await fetch(`${CONFAIR_API}/api/expenses?limit=20`, {
      headers: { UserToken: token }
    });
    res.json(await r.json());
  } catch (err) { next(err); }
});

export default router;
