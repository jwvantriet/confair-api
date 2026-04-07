import 'dotenv/config';

const required = (key) => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

export const config = {
  port:    process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  supabase: {
    url:            required('SUPABASE_URL'),
    anonKey:        required('SUPABASE_ANON_KEY'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },
  carerix: {
    graphApiUrl:  required('CARERIX_GRAPH_API_URL'),
    financeApiUrl: required('CARERIX_FINANCE_API_URL'),
    apiKey:       required('CARERIX_API_KEY'),
    tenantId:     required('CARERIX_TENANT_ID'),
  },
  cors: {
    origins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3001').split(','),
  },
};
