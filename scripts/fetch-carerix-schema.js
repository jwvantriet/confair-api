#!/usr/bin/env node
/**
 * Fetch the Carerix GraphQL schema via introspection and write it to
 *   docs/carerix-schema.json   (raw introspection result)
 *   docs/carerix-schema.graphql (SDL, human-readable)
 *
 * Usage:
 *   CARERIX_CLIENT_ID=… CARERIX_API_KEY=… npm run carerix:schema
 *
 * Requires env:
 *   CARERIX_CLIENT_ID, CARERIX_API_KEY
 * Optional env (defaults match src/config.js):
 *   CARERIX_AUTH_URL, CARERIX_GRAPH_API_URL
 *
 * Self-contained — does not import src/config.js so it runs without
 * Supabase credentials.
 */
import 'dotenv/config';
import axios from 'axios';
import { getIntrospectionQuery, buildClientSchema, printSchema } from 'graphql';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOCS = join(ROOT, 'docs');

const AUTH_URL  = process.env.CARERIX_AUTH_URL  || 'https://id-s4.carerix.io/auth/realms/confair/protocol/openid-connect';
const GRAPH_URL = process.env.CARERIX_GRAPH_API_URL || 'https://api.carerix.io/graphql/v1/graphql';
const CLIENT_ID = process.env.CARERIX_CLIENT_ID;
const CLIENT_SECRET = process.env.CARERIX_API_KEY;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('✗ CARERIX_CLIENT_ID and CARERIX_API_KEY must be set in env or .env');
  process.exit(1);
}

async function getServiceToken() {
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  try {
    const r = await axios.post(`${AUTH_URL}/token`, body, {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'User-Agent':    'confair-schema-fetcher/1.0',
      },
      timeout: 10_000,
    });
    return r.data.access_token;
  } catch (err) {
    const s = err.response?.status;
    if (s === 400 || s === 401 || s === 403) {
      const body2 = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      });
      const r2 = await axios.post(`${AUTH_URL}/token`, body2, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10_000,
      });
      return r2.data.access_token;
    }
    throw err;
  }
}

async function introspect(token) {
  const query = getIntrospectionQuery({ descriptions: true, inputValueDeprecation: true });
  const r = await axios.post(GRAPH_URL, { query }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'User-Agent':    'confair-schema-fetcher/1.0',
    },
    timeout: 60_000,
  });
  if (r.data.errors?.length) {
    throw new Error('GraphQL introspection errors: ' + JSON.stringify(r.data.errors, null, 2));
  }
  if (!r.data.data?.__schema) {
    throw new Error('Introspection returned no __schema — it may be disabled on this endpoint.');
  }
  return r.data.data;
}

(async () => {
  console.log('→ fetching Carerix service token…');
  const token = await getServiceToken();
  console.log('✓ got token');

  console.log('→ running introspection query…');
  const introspection = await introspect(token);
  console.log(`✓ schema has ${introspection.__schema.types.length} types`);

  mkdirSync(DOCS, { recursive: true });

  const jsonPath = join(DOCS, 'carerix-schema.json');
  writeFileSync(jsonPath, JSON.stringify(introspection, null, 2) + '\n', 'utf8');
  console.log(`✓ wrote ${jsonPath}`);

  const schema = buildClientSchema(introspection);
  const sdl = printSchema(schema);
  const sdlPath = join(DOCS, 'carerix-schema.graphql');
  writeFileSync(sdlPath, sdl + '\n', 'utf8');
  console.log(`✓ wrote ${sdlPath}`);
})().catch((err) => {
  console.error('✗', err.message);
  if (err.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
});
