import 'dotenv/config';

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
};
const optional = (key, fallback = '') => process.env[key] || fallback;

// Comma-separated env → array of trimmed non-empty strings.
const list = (key) => (process.env[key] || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Same, but parsed as integers (for Carerix CRUserRole IDs).
const intList = (key) => list(key).map(Number).filter(Number.isFinite);

export const config = {
  raido: {
    baseUrl:    process.env.RAIDO_BASE_URL || 'https://aai-apim-prod-northeu-01.azure-api.net/raido/v1/nocrestapi/v1',
    apiKey:     process.env.RAIDO_API_KEY  || '',
  },
  port:    process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  supabase: {
    url:            required('SUPABASE_URL'),
    anonKey:        required('SUPABASE_ANON_KEY'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },

  carerix: {
    // GraphQL API endpoint
    graphApiUrl:   optional('CARERIX_GRAPH_API_URL', 'https://api.carerix.io/graphql/v1/graphql'),
    financeApiUrl: optional('CARERIX_FINANCE_API_URL', 'https://api.carerix.io/graphql/v1/graphql'),

    // OAuth2 / OpenID Connect
    authUrl:       optional('CARERIX_AUTH_URL', 'https://id-s4.carerix.io/auth/realms/confair/protocol/openid-connect'),
    clientId:      optional('CARERIX_CLIENT_ID', ''),
    clientSecret:  optional('CARERIX_API_KEY', ''),     // client secret = API key
    tenantId:      optional('CARERIX_TENANT_ID', 'confair'),

    // Carerix legacy REST API (api.carerix.com) — used for user authentication
    restUrl:       optional('CARERIX_REST_URL', 'https://api.carerix.com/'),
    restUsername:  optional('CARERIX_REST_USERNAME', 'confair'),
    restPassword:  optional('CARERIX_REST_PASSWORD', ''),

    // CRUserRole IDs that map to platform agency roles. No defaults — an
    // unmapped role is rejected at login (no silent privilege elevation).
    // Configure both as comma-separated CRUserRole.id values in the env.
    agencyAdminRoleIds:      intList('CARERIX_AGENCY_ADMIN_ROLE_IDS'),
    agencyOperationsRoleIds: intList('CARERIX_AGENCY_OPERATIONS_ROLE_IDS'),

  // Derived OAuth2 endpoints
    get tokenUrl()   { return `${this.authUrl}/token`; },
    get authCodeUrl() { return `${this.authUrl}/auth`; },
    get userInfoUrl() { return `${this.authUrl}/userinfo`; },
  },

  // OAuth2 callback URL — must match what's registered in Carerix client
  appUrl: optional('APP_URL', 'https://confair-api-production.up.railway.app'),

  // Used to sign short-lived MFA challenge / enrollment tokens. No default —
  // a missing or default value would let an attacker mint their own tokens.
  jwt: {
    secret:    required('JWT_SECRET'),
    expiresIn: '8h',
  },

  // Multi-factor authentication.
  mfa: {
    issuer: optional('MFA_ISSUER', 'Confair'),
    // Roles that MUST have MFA enrolled. Users in these roles who haven't
    // enrolled yet are bounced into the enrollment flow at login. Other
    // users may enrol voluntarily but are not forced.
    enforceForRoles: list('MFA_ENFORCE_ROLES'),
    // Validity window for the short-lived challenge token returned after
    // step-1 (Carerix) succeeds and we're waiting on the TOTP code.
    challengeTtlSeconds: Number(process.env.MFA_CHALLENGE_TTL_SECONDS || 300),
  },

  // Per-username lockout. Counts failed login attempts in a sliding window
  // and refuses further attempts (regardless of credentials) once the
  // threshold is hit. Complements the per-IP rate limiter.
  loginLockout: {
    windowMinutes:  Number(process.env.LOGIN_LOCKOUT_WINDOW_MINUTES || 15),
    maxAttempts:    Number(process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS   || 10),
  },

  cors: {
    origins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3001').split(','),
  },
};
