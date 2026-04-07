import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes        from './routes/auth.js';
import payrollRoutes     from './routes/payroll.js';
import correctionsRoutes from './routes/corrections.js';
import approvalsRoutes   from './routes/approvals.js';
import runsRoutes        from './routes/runs.js';
import invoicesRoutes    from './routes/invoices.js';
import importRoutes      from './routes/import.js';
import carerixRoutes     from './routes/carerix.js';

const app = express();

app.use(helmet());
app.use(cors({ origin: config.cors.origins, credentials: true }));
app.use(express.json({ limit: '10mb' }));

const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const authLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many login attempts' } });
app.use(globalLimiter);

app.get('/health', (_, res) => res.json({ status: 'ok', env: config.nodeEnv, ts: new Date().toISOString() }));

app.use('/auth',        authLimiter, authRoutes);
app.use('/payroll',     payrollRoutes);
app.use('/corrections', correctionsRoutes);
app.use('/approvals',   approvalsRoutes);
app.use('/runs',        runsRoutes);
app.use('/invoices',    invoicesRoutes);
app.use('/import',      importRoutes);
app.use('/carerix',     carerixRoutes);

app.use(errorHandler);

app.listen(config.port, () => logger.info(`Confair API on :${config.port} [${config.nodeEnv}]`));
export default app;
