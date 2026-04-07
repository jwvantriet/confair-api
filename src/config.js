import 'dotenv/config';

// For required vars that will crash the server if missing
const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
};

// For optional vars that can be added later (e.g. Carerix, not needed at boot)
const optional = (key, fallback = '') => process.env[key] || fallback;

export const config = {
  port:    process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  supabase: {
    url:            required('SUPABASE_URL'),
    anonKey:        required('SUPABASE_ANON_KEY'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },

  // Carerix — optional at boot, validated at request time
  carerix: {
    graphApiUrl:  optional('CARERIX_GRAPH_API_URL', 'https://placeholder.carerix.com/graphql'),
    financeApiUrl: optional('CARERIX_FINANCE_API_URL', 'https://placeholder.carerix.com/finance'),
    apiKey:       optional('CARERIX_API_KEY', 'not-configured'),
    tenantId:     optional('CARERIX_TENANT_ID', 'not-configured'),
  },

  jwt: {
    secret:    optional('JWT_SECRET', 'dev-secret-change-in-production'),
    expiresIn: '8h',
  },

  cors: {
    origins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3001').split(','),
  },
};
