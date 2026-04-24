# Confair Platform — Backend API

Node.js / Express API deployed on Railway.  
Handles authentication, Carerix integration, payroll workflow, and invoicing.

## Architecture

```
Browser / Vercel Frontend
        │
        ▼
  Railway API (this repo)
        │
   ┌────┴──────────────┐
   ▼                   ▼
Supabase DB       Carerix APIs
(auth + data)     (Graph + Finance)
```

## Authentication flows

All users authenticate against the Carerix **legacy REST API**
(`api.carerix.com`). The returned `CRUser` XML is inspected to determine the
platform role, and a Supabase session is then provisioned for the user so the
rest of the API can authenticate via a Supabase JWT.

### Login

```
POST /auth/login/agency      (alias: POST /auth/login/carerix)
  { username, password }
  → GET  https://api.carerix.com/CRUser/login-with-encrypted-password
         ?u=<username>&p=<md5(password)>
         Basic auth: CARERIX_REST_USERNAME : CARERIX_REST_PASSWORD
  → parse CRUser XML, derive platformRole from toUserRole / toEmployee / toCompany
  → provisionCarerixSession() creates/syncs the Supabase user
  → returns { accessToken, refreshToken, expiresAt, user }
```

Both `/auth/login/agency` and `/auth/login/carerix` are thin wrappers around
the same REST call — there is no separate Supabase-password path today.

### Platform role derivation

| Carerix signal                                 | Platform role    |
|------------------------------------------------|------------------|
| `toEmployee` linked, or `toUserRole.id = 1`    | `placement`      |
| `toCompany` linked,  or `toUserRole.id = 11`   | `company_admin`  |
| otherwise                                      | `agency_admin`   |

### Session usage

All subsequent requests use `Authorization: Bearer <accessToken>` — a Supabase
JWT — regardless of where the user originated. Data reads (jobs, companies,
finances) use the Carerix **GraphQL API** at
`api.carerix.io/graphql/v1/graphql`; only the initial login touches the legacy
REST endpoint.

## Setup

### 1. Clone and install
```bash
git clone <your-repo>
cd confair-api
npm install
```

### 2. Environment variables
```bash
cp .env.example .env
# Fill in all values — see .env.example for descriptions
```

### 3. Run locally
```bash
npm run dev
```

### 4. Deploy to Railway
```bash
# Connect your GitHub repo in the Railway dashboard
# Set all environment variables from .env.example in Railway → Variables
# Railway auto-deploys on push to main
```

## Key environment variables

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_ANON_KEY` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API |
| `CARERIX_GRAPH_API_URL` | Your Carerix account manager (GraphQL data API) |
| `CARERIX_FINANCE_API_URL` | Your Carerix account manager |
| `CARERIX_API_KEY` | Your Carerix account manager |
| `CARERIX_TENANT_ID` | Your Carerix account manager |
| `CARERIX_REST_URL` | Legacy REST base, default `https://api.carerix.com/` |
| `CARERIX_REST_USERNAME` | Basic-auth user for the legacy REST API |
| `CARERIX_REST_PASSWORD` | Basic-auth password for the legacy REST API |
| `JWT_SECRET` | `openssl rand -hex 64` |
| `ALLOWED_ORIGINS` | Your Vercel frontend URL |

## API endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/login/agency` | Public | Login via Carerix REST (alias of `/auth/login/carerix`) |
| POST | `/auth/login/carerix` | Public | Login via Carerix REST |
| POST | `/auth/refresh` | Public | Refresh session token |
| POST | `/auth/logout` | Required | Revoke session |
| GET | `/auth/me` | Required | Current user profile |
| GET | `/payroll/periods` | Required | List pay periods |
| POST | `/payroll/periods` | Agency | Create pay period |
| GET | `/payroll/periods/:id/planner` | Required | Monthly planner matrix |
| GET | `/payroll/entries/:id` | Required | Declaration entry detail |
| POST | `/import/declarations` | Agency | Upload CSV/XLSX file |
| GET | `/import/batches` | Agency | Import history |
| GET | `/approvals` | Required | Pending approvals for current user |
| POST | `/approvals/:id/approve` | Required | Approve entry |
| POST | `/approvals/:id/decline` | Required | Decline entry (reason mandatory) |
| GET | `/corrections` | Required | List corrections |
| POST | `/corrections` | Placement | Create correction request |
| POST | `/corrections/:id/approve` | Company+ | Approve correction |
| POST | `/corrections/:id/decline` | Company+ | Decline correction (reason mandatory) |
| GET | `/runs` | Required | List payroll runs |
| POST | `/runs/:id/finalize` | Agency | Finalize run + generate invoices |
| GET | `/invoices` | Required | List invoices |
| POST | `/carerix/sync/fees/:periodId` | Agency | Re-trigger fee retrieval |
| GET | `/carerix/fees/status/:periodId` | Agency | Fee retrieval status |

## Carerix integration notes

Login uses the legacy REST API (`api.carerix.com`). The
`CRUser/login-with-encrypted-password` endpoint accepts the password as an
**MD5 hex digest** in the `p` query parameter, under HTTP Basic auth using
`CARERIX_REST_USERNAME` / `CARERIX_REST_PASSWORD`. Response is XML; see
`src/routes/auth.js → loginWithCarerix` for the parsing logic.

Everything else (jobs, companies, rates, finance) goes through the Carerix
GraphQL API at `api.carerix.io/graphql/v1/graphql`. The Finance endpoint
(`GET /rates`) request params and response shape should be confirmed with your
Carerix account manager — they may differ per tenant.
