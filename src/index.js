import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes          from './routes/auth.js';
import authMfaRoutes       from './routes/auth_mfa.js';
import authProbeRoutes     from './routes/auth_probe.js';
import authOidcProbeRoutes from './routes/auth_oidc_probe.js';
import carerixFinanceProbeRoutes from './routes/carerix_finance_probe.js';
import payrollRoutes     from './routes/payroll.js';
import correctionsRoutes from './routes/corrections.js';
import approvalsRoutes   from './routes/approvals.js';
import runsRoutes        from './routes/runs.js';
import invoicesRoutes    from './routes/invoices.js';
import importRoutes      from './routes/import.js';
import carerixRoutes     from './routes/carerix.js';
import carerixPublicRoutes from './routes/carerix_public.js';
import invoiceRoutes     from './routes/invoice.js';
import rosterRoutes      from './routes/roster.js';
import payrollRosterRoutes from './routes/payroll_roster.js';
import diagnosticsRoutes     from './routes/diagnostics.js';
import confairExpenseRoutes  from './routes/confair_expense.js';
import expenseRoutes         from './routes/expenses.js';
import payrollApprovalRoutes from './routes/payroll_approval.js';
import errorLogRoutes        from './routes/errors.js';
import rotationsAdminRoutes  from './routes/rotations_admin.js';
import chargeConfigRoutes    from './routes/charge_config.js';

const app = express();

const corsOptions = {
  origin: config.cors.origins,
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
};

app.use(helmet({ crossOriginResourcePolicy: false }));
app.set('trust proxy', 1);
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 15*60*1000, max: 200, standardHeaders: true, legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15*60*1000, max: 20, standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  message: { error: 'Too many login attempts. Please try again later.' },
});

app.use(limiter);

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', env: config.nodeEnv, ts: new Date().toISOString() })
);

// /auth/mfa is mounted before /auth so the more specific prefix wins.
app.use('/auth/mfa',    authLimiter, authMfaRoutes);
app.use('/auth',        authLimiter, authRoutes);
app.use('/auth',        authLimiter, authProbeRoutes);     // /auth/probe
app.use('/auth',        authLimiter, authOidcProbeRoutes); // /auth/oidc-probe
app.use('/payroll',     payrollRoutes);
app.use('/corrections', correctionsRoutes);
app.use('/approvals',   approvalsRoutes);
app.use('/runs',        runsRoutes);
app.use('/invoices',    invoicesRoutes);
app.use('/import',      importRoutes);
app.use('/carerix',     carerixRoutes);
app.use('/carerix',     carerixFinanceProbeRoutes); // /carerix/probe/job-finance
app.use('/cx-pub',       carerixPublicRoutes);
app.use('/confair-expense', confairExpenseRoutes);
app.use('/expenses',         expenseRoutes);
app.use('/payroll-approval', payrollApprovalRoutes);
app.use('/invoice',      invoiceRoutes);
app.use('/roster',      rosterRoutes);
app.use('/payroll-roster', payrollRosterRoutes);
app.use('/diagnostics',    diagnosticsRoutes);
app.use('/errors',         errorLogRoutes);
app.use('/rotations',      rotationsAdminRoutes);
app.use('/charge-config',  chargeConfigRoutes);
app.use(errorHandler);

app.listen(config.port, () =>
  logger.info(`Confair API · port ${config.port} · ${config.nodeEnv}`)
);

export default app;
