import 'dotenv/config';

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
};
const optional = (key, fallback = '') => process.env[key] || fallback;

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

  // Derived OAuth2 endpoints
    get tokenUrl()   { return `${this.authUrl}/token`; },
    get authCodeUrl() { return `${this.authUrl}/auth`; },
    get userInfoUrl() { return `${this.authUrl}/userinfo`; },
  },

  // OAuth2 callback URL — must match what's registered in Carerix client
  appUrl: optional('APP_URL', 'https://confair-api-production.up.railway.app'),

  jwt: {
    secret:    optional('JWT_SECRET', 'dev-secret-change-in-production'),
    expiresIn: '8h',
  },

  cors: {
    origins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3001').split(','),
  },
};
