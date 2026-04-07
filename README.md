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

### Agency users (Atoms Cloud / Supabase)
```
POST /auth/login/agency
  { email, password }
  → Supabase signInWithPassword()
  → returns { accessToken, refreshToken, user }
```

### Placement & Company users (Carerix)
```
POST /auth/login/carerix
  { email, password, roleHint? }
  → Carerix Graph API mutation Login()
  → provisionCarerixSession() creates/syncs Supabase user
  → returns { accessToken, refreshToken, user }
```

All subsequent requests use the same `Authorization: Bearer <accessToken>` header regardless of auth source.

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
| `CARERIX_GRAPH_API_URL` | Your Carerix account manager |
| `CARERIX_FINANCE_API_URL` | Your Carerix account manager |
| `CARERIX_API_KEY` | Your Carerix account manager |
| `CARERIX_TENANT_ID` | Your Carerix account manager |
| `JWT_SECRET` | `openssl rand -hex 64` |
| `ALLOWED_ORIGINS` | Your Vercel frontend URL |

## API endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/login/agency` | Public | Agency login (Supabase) |
| POST | `/auth/login/carerix` | Public | Placement/Company login (Carerix) |
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

The Carerix GraphQL mutation shape (`mutation Login`) may need adjusting  
to match your exact Carerix tenant configuration. Update `src/services/carerix.js`  
with the correct field names from your Carerix API documentation.

Similarly, the Finance API endpoint (`GET /rates`) should be confirmed  
with your Carerix account manager — request params and response shape  
may differ per tenant.
