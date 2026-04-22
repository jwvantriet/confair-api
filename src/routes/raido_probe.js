/**
 * No-auth RAIDO probe — disposable diagnostic endpoint used to discover
 * the exact shape of RAIDO's /crew responses so we can wire fields
 * (years_since_start, etc.) into the sync. Mount at `/raido-probe`.
 *
 * REMOVE ONCE FIELD NAMES ARE CONFIRMED.
 */
import { Router } from 'express';
import axios from 'axios';
import { config } from '../config.js';

const router = Router();

// Try multiple RequestData values at once and dump the first crew
// matching :crewId (or the first crew overall) from each.
router.get('/crew/:crewId?', async (req, res) => {
  const crewId = req.params.crewId?.toUpperCase() || null;
  const today  = new Date().toISOString().split('T')[0];
  const requestDataVariants = ['', 'SpecialRoles', 'Basic', 'Years', 'StartDate', 'Meta', 'Personal', 'All'];

  const out = {
    endpoint: `${config.raido.baseUrl}/crew`,
    params_common: { OnlyActive: 'true', From: '2000-01-01', To: today, limit: 5000 },
    crewIdRequested: crewId,
    results: [],
  };

  for (const rd of requestDataVariants) {
    const params = { OnlyActive: 'true', From: '2000-01-01', To: today, limit: 5000 };
    if (rd) params.RequestData = rd;
    try {
      const r = await axios.get(`${config.raido.baseUrl}/crew`, {
        headers: { 'Ocp-Apim-Subscription-Key': config.raido.apiKey, 'Accept': 'application/json' },
        params, timeout: 30_000,
      });
      const list = Array.isArray(r.data) ? r.data : (r.data?.items || r.data?.data || []);
      const match = crewId
        ? list.find(c => [c?.Number, c?.EmployeeNumber, c?.Code1, c?.Code2]
            .some(v => String(v || '').toUpperCase() === crewId))
        : list[0];
      out.results.push({
        RequestData: rd || '(none)',
        status: r.status,
        totalCrew: list.length,
        rawSampleKeys: match ? Object.keys(match).sort() : null,
        raw: match || null,
      });
    } catch (err) {
      out.results.push({
        RequestData: rd || '(none)',
        error: err.message,
        status: err.response?.status,
        body: err.response?.data,
      });
    }
  }
  res.json(out);
});

export default router;
