/**
 * Per-username login-attempt tracker — backs the lockout that complements
 * the per-IP rate limiter in src/index.js.
 *
 * `login_attempts` is append-only; a successful login does not clear prior
 * failures (the lockout window expires naturally). Rows older than 30 days
 * are pruned by a cron / scheduled function (see migration).
 */

import { adminSupabase } from './supabase.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

function normaliseUsername(u) {
  return String(u || '').trim().toLowerCase();
}

export async function recordLoginAttempt({ username, succeeded, ipAddress, userAgent }) {
  const u = normaliseUsername(username);
  if (!u) return;
  const { error } = await adminSupabase.from('login_attempts').insert({
    username:   u,
    succeeded:  !!succeeded,
    ip_address: ipAddress || null,
    user_agent: userAgent  || null,
  });
  if (error) logger.warn('login_attempts insert failed', { error: error.message });
}

/**
 * @returns {Promise<{ locked: boolean, retryAfterSeconds: number }>}
 */
export async function isUsernameLockedOut(username) {
  const u = normaliseUsername(username);
  if (!u) return { locked: false, retryAfterSeconds: 0 };

  const windowMs = config.loginLockout.windowMinutes * 60 * 1000;
  const sinceIso = new Date(Date.now() - windowMs).toISOString();

  const { data, error } = await adminSupabase
    .from('login_attempts')
    .select('attempted_at, succeeded')
    .eq('username',  u)
    .gte('attempted_at', sinceIso)
    .order('attempted_at', { ascending: false })
    .limit(config.loginLockout.maxAttempts + 5);

  if (error) {
    logger.warn('login_attempts read failed (failing open)', { error: error.message });
    return { locked: false, retryAfterSeconds: 0 };
  }

  const failures = (data || []).filter(r => !r.succeeded);
  if (failures.length < config.loginLockout.maxAttempts) {
    return { locked: false, retryAfterSeconds: 0 };
  }

  const oldestFailureMs = new Date(failures[failures.length - 1].attempted_at).getTime();
  const unlockAtMs      = oldestFailureMs + windowMs;
  const retryAfter      = Math.max(1, Math.ceil((unlockAtMs - Date.now()) / 1000));
  return { locked: true, retryAfterSeconds: retryAfter };
}
