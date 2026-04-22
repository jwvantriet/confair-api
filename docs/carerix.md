# Carerix Integration Reference

Living reference for our integration with Carerix. Keep this up-to-date whenever
we add new queries, change config, or discover undocumented behaviour.

Official docs (behind a login wall for automated fetchers, open in a browser):
- Overview: https://help.carerix.com/en/articles/9482350-graphql-api
- GraphQL schema browser: https://docs.carerix.io/graphql/welcome
- Query examples: https://help.carerix.com/en/articles/10067801-graphql-api-examples
- Identity & Access Management: https://help.carerix.com/en/articles/6865566-identity-access-management-identity-access-menu
- Webhooks guide: https://help.carerix.com/en/articles/9362341-creating-your-first-webhook-a-step-by-step-guide-with-popular-examples

---

## 1. Endpoints

| Purpose | URL |
|---|---|
| GraphQL | `https://api.carerix.io/graphql/v1/graphql` |
| OAuth2 base | `https://id-s4.carerix.io/auth/realms/<tenant>/protocol/openid-connect` |
| Token (derived) | `<base>/token` |
| Authorize (derived) | `<base>/auth` |
| Userinfo (derived) | `<base>/userinfo` |
| Webhooks management | `https://api.carerix.io/webhooks/v1/applications/<applicationId>/webhooks` |
| Legacy REST | `https://api.carerix.com/` |

Our tenant realm is `confair` → token URL `https://id-s4.carerix.io/auth/realms/confair/protocol/openid-connect/token`.

## 2. Authentication

OAuth2 **client_credentials** flow for service-to-service. Token is a JWT bearer
passed as `Authorization: Bearer <token>` on every GraphQL request.

### Creating the service client (one-time, in Carerix admin UI)
1. Identity & Access Management → **Identity Access** menu (maintenance section,
   sys-admin only).
2. **Clients** tab → create a new **Confidential client**.
3. Give it a name and a **Code** (user-defined unique ID).
4. Enable **Service account** / client_credentials grant.
5. **Default scope**:
   - `urn:cx/graphql:data:manage` → required for the GraphQL API (as of July 2024).
   - `urn:cx/xmlapi:data:manage` → required only for the legacy REST API.
6. Save → copy `CLIENT_ID` and `CLIENT_SECRET`. **The secret is shown once**.

### Token request

```http
POST {tokenUrl}
Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

Fallback if Basic Auth returns 400/401/403: put `client_id` and `client_secret`
in the body. Our implementation (`src/services/carerix.js:32-85`) tries Basic
first, then body — matches the behaviour of Carerix's reference Python sample.

Response:
```json
{ "access_token": "eyJ…", "expires_in": 3600, "token_type": "Bearer" }
```

We cache the token for `expires_in - 60s` in-process.

## 3. Query shape

Pattern for "list" queries: `cr<Entity>Page(qualifier, pageable, sort)`.

### Pageable

```graphql
input Pageable { page: Int!, size: Int! }
```

- `page` is zero-indexed.
- Typical `size` limit is 100 (Carerix-documented soft cap; larger may work but
  can time out).
- Returns `{ totalElements, items[…] }`.

### Qualifier

A SQL-like string. Think of it as the `WHERE` clause (only).

Known operators from production queries and Carerix examples:

| Category | Operators / syntax |
|---|---|
| Equality / inequality | `=`, `!=` |
| Comparison | `<`, `<=`, `>`, `>=` |
| Pattern match | `like 'prefix*'` (wildcards as `*`) |
| Logical | `AND`, `OR`, parentheses |
| Null check | `= nil` |
| Typed literal (date) | `(NSCalendarDate) '2024-11-08 23:59:59'` |
| Path navigation | `toStatusNode.parentNodes.value` (dot-walks relations) |
| Numeric ID compare | `toJob.jobID == 5319` *(double `==` is how our production queries read `jobID`; the examples page shows single `=` works too — prefer single `=`)* |

Example (filter active candidates):
```graphql
query {
  crEmployeePage(
    qualifier: "toStatusNode.parentNodes.value = 'CandidateActiveTag'"
  ) { items { lastName employeeID } }
}
```

Example (published jobs right now):
```
publicationStart <= (NSCalendarDate) '2024-11-08 23:59:59'
AND (publicationEnd > (NSCalendarDate) '2024-11-09 00:00:00' OR publicationEnd = nil)
```

### Errors

GraphQL-standard:
```json
{ "data": null, "errors": [{ "message": "...", "extensions": {...} }] }
```
`carerixGQL()` logs `res.data.errors` but does not throw — callers must inspect
`result?.data?.<field>`.

### Rate limits / timeouts

Not documented publicly. Observed behaviour from our code:
- `crJobFinancePage` typically returns in <2s for a single `jobID`.
- `crJobPage` full scan (≈100 per page) can take 10+ pages → each page must
  respond within our per-request timeout.
- Our axios timeout is **6 seconds per request** (`carerix.js:101`). No retries.

## 4. Root queries & types we use

Built from `grep -rn "cr[A-Z]" src/` on 2026-04-22.

| Query / Type | Where | Purpose |
|---|---|---|
| `crEmployee(_id)` | `routes/carerix_public.js`, `routes/carerix.js` | Fetch one employee (IBAN, BIC, address, etc.) |
| `crEmployeePage(pageable)` | `services/carerix.js:355` | Connection-test query (pulls 1 row) |
| `crEmployeeFinancePage` | referenced in schema exploration | Employee-level finance records |
| `crJob(_id)` | `routes/carerix_public.js`, `routes/carerix.js:118` | Fetch one job by _id (incl. `additionalInfo`, `toEmployee`, `toCompany`) |
| `crJobPage(pageable)` | `services/carerix.js:438 buildCrewCodeToJobMap` | Full-scan jobs to map crew code → jobID via `additionalInfo[10189]` |
| `crJobFinancePage(qualifier, pageable)` | `services/carerix.js:383 fetchCarerixRatesForJob` | Rate lookup per placement |
| `crMatch(_id)` / `crMatchPage` | `services/carerix.js:244` | Match (candidate↔job) records; we currently fetch one by qualifier |
| `crMatchConditions` | schema exploration | Match criteria on a match |
| `crCompany(_id)` | `routes/carerix.js:158` | Company lookup |
| `crAgency` | (exploration) | Agency lookup |
| `crRateTable` / `crRateTableLines` | (exploration) | Rate card source, alternative to per-job finance rows |
| `crUserId` | schema discovery | Current authenticated user id |

### Known field conventions
- `_id` is the stable internal ID (string).
- `<entity>ID` (e.g. `jobID`, `employeeID`) is the human-visible sequential ID.
- `to<Name>` prefix = relation to another entity.
- `additionalInfo` = dynamic key-value map. We use field **`10189`** on `crJob`
  to store crew code (4-letter, e.g. `DAGF`). Keys may appear as `10189` or
  `_10189` depending on entity.
- `*Node` fields reference the hierarchical "data nodes" system
  (`dataNodeID`, `value`, `parentNodes`).

## 5. Our service module cheat-sheet

`src/services/carerix.js`

| Export | What it does |
|---|---|
| `queryGraphQL(query, variables)` | Single GraphQL request with cached service token (6s timeout) |
| `getCarerixAuthUrl(state, redirectUri)` | Builds authorization_code redirect for user login |
| `exchangeCodeForTokens(code, redirectUri)` | Trades auth code for access/id/refresh tokens |
| `fetchUserInfo(accessToken)` | Calls `/userinfo` for the logged-in user |
| `fetchCarerixRatesForJob(jobId)` | `crJobFinancePage` → `{ kindId → { amount, currency } }` |
| `buildCrewCodeToJobMap()` | Paginates `crJobPage`; maps crew code → jobID |
| `autoMatchPlacementsCarerixIds()` | Bulk-fills missing `carerix_job_id` on `placements` |
| `fetchFeeFromCarerix(...)` / `fetchAndCacheFee(...)` / `bulkFetchFees(...)` | Fee retrieval with Supabase cache in `carerix_fee_cache` |
| `testCarerixConnection()` | Discovery + token + sample query; exposed as `GET /carerix/test` |

### Built-in diagnostics
- `GET /carerix/test` — no auth; runs the full connect chain and returns
  `{ config, steps[], overallStatus }`. Use this first whenever anything acts
  weird.
- `GET /carerix/explorer` — HTML GraphiQL-style UI for ad-hoc queries
  (`src/routes/carerix_explorer.html`).
- `GET /carerix/probe` — various sanity probes.
- `GET /carerix/inspect-login?u=&p=` — diagnose the legacy REST login payload.

## 6. Environment variables

Defined in `src/config.js`:

| Var | Required | Default | Notes |
|---|---|---|---|
| `CARERIX_CLIENT_ID` | **yes** | `''` | Service client ID (from Identity Access) |
| `CARERIX_API_KEY` | **yes** | `''` | Service client SECRET (Carerix calls this "API key") |
| `CARERIX_GRAPH_API_URL` | no | `https://api.carerix.io/graphql/v1/graphql` | |
| `CARERIX_FINANCE_API_URL` | no | same as GRAPH | Kept separate in case finance moves to its own endpoint |
| `CARERIX_AUTH_URL` | no | `https://id-s4.carerix.io/auth/realms/confair/protocol/openid-connect` | Realm-scoped base; `/token`, `/auth`, `/userinfo` derived |
| `CARERIX_TENANT_ID` | no | `confair` | |
| `CARERIX_REST_URL` | no | `https://api.carerix.com/` | Legacy SOAP/REST for username/password login |
| `CARERIX_REST_USERNAME` | no | `confair` | |
| `CARERIX_REST_PASSWORD` | no | `''` | Legacy REST basic auth |

## 7. Troubleshooting

| Symptom | Likely cause | What to check |
|---|---|---|
| `/carerix/test` → discovery `failed` | Wrong `CARERIX_AUTH_URL`, DNS, or egress blocked | URL in Railway env; try `curl` from the Railway shell |
| `/carerix/test` → client_credentials `failed` | Wrong client ID/secret, grant type disabled, scope missing | Recreate client in Identity Access; ensure `urn:cx/graphql:data:manage` default scope |
| `/carerix/test` → graphql `failed` | Token works but service account lacks data permissions | Check client's role/scope mapping in Identity Access |
| Sync stalls after `rates` in roster log | Downstream of Carerix (Supabase) | See `docs` on roster sync; not a Carerix issue |
| `fetchCarerixRatesForJob` returns `{}` | 6s timeout or schema error | Enable debug logging; inspect `/carerix/explorer` with the same query |
| `buildCrewCodeToJobMap` returns `{}` | One page timed out; whole scan aborts | Lower `size`, add retries, or run during off-peak |
| Rates present in Carerix but none returned | All finance rows have `endDate` in the past | See filter in `fetchCarerixRatesForJob` (`endDate < today` is skipped) |

## 8. Webhooks (for future expansion)

- Management URL: `POST https://api.carerix.io/webhooks/v1/applications/<applicationId>/webhooks`
- Same OAuth2 bearer.
- Carerix POSTs to your URL when subscribed events occur. Payloads are JSON.
- Useful to replace polling for: placement created/updated, job updates, finance
  changes.

## 9. Refreshing the schema snapshot

```bash
# needs CARERIX_CLIENT_ID + CARERIX_API_KEY in env or .env
npm run carerix:schema
```

Writes two files into `docs/`:
- `carerix-schema.json` — raw introspection result (machine-readable).
- `carerix-schema.graphql` — SDL form (human-readable; diff-friendly in PRs).

Re-run whenever Carerix updates their API so we can spot breaking changes in
review. If introspection is disabled on the endpoint, the script will exit with
a clear error — in that case, ask Carerix to enable it for our service client
or accept that the schema doc will fall out of date.

## 10. Things we don't know yet (open items)

- Exact rate limits (requests / sec, daily quota).
- Max `Pageable.size` server-side hard cap.
- Whether `crJobPage` supports `sort` parameter (for incremental sync by
  `lastModified`).
- Full list of scopes and which permit which entities.
- Whether Carerix offers an introspection endpoint we can snapshot into the
  repo.
- Stability guarantees / versioning of the `v1` path.

When any of these get clarified, update this file rather than scattering notes
across issues.
