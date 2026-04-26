/**
 * MFA helpers — TOTP, recovery codes, and short-lived challenge JWTs.
 *
 * Storage model on user_profiles (see migration):
 *   mfa_secret          — base32 TOTP secret, set once enrollment is verified
 *   mfa_pending_secret  — base32 secret held while the user is still proving
 *                         they can read codes from it (cleared after verify)
 *   mfa_enrolled_at     — non-null = MFA active for this user
 *   mfa_recovery_codes  — sha256-hashed one-time recovery codes
 *
 * Challenge / enrollment tokens are signed with config.jwt.secret. They are
 * never stored — the JWT itself carries everything we need (userId, type,
 * exp). Type-tagging prevents one ticket from being replayed in the wrong
 * step.
 */

import crypto from 'crypto';
import { authenticator } from 'otplib';
import jwt from 'jsonwebtoken';
import qrcode from 'qrcode';
import { adminSupabase } from './supabase.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// 30-second step, 6 digits, allow ±1 step (handles modest clock drift).
authenticator.options = {
  step:   30,
  digits: 6,
  window: 1,
};

const CHALLENGE_TYPE_LOGIN  = 'mfa_challenge';
const CHALLENGE_TYPE_ENROLL = 'mfa_enrollment';
const RECOVERY_CODE_COUNT   = 10;

// ── Token helpers ─────────────────────────────────────────────────────────

/** Mint a short-lived ticket the client must hand back at /mfa/verify. */
export function signLoginChallenge(userId) {
  return jwt.sign(
    { sub: userId, typ: CHALLENGE_TYPE_LOGIN },
    config.jwt.secret,
    { expiresIn: config.mfa.challengeTtlSeconds },
  );
}

/** Mint a short-lived ticket for /mfa/enroll/verify (post-Carerix-auth, pre-MFA). */
export function signEnrollmentChallenge(userId) {
  return jwt.sign(
    { sub: userId, typ: CHALLENGE_TYPE_ENROLL },
    config.jwt.secret,
    { expiresIn: config.mfa.challengeTtlSeconds },
  );
}

function verifyTypedToken(token, expectedType) {
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded.typ !== expectedType) return null;
    if (!decoded.sub) return null;
    return { userId: decoded.sub };
  } catch {
    return null;
  }
}

export const verifyLoginChallenge      = (t) => verifyTypedToken(t, CHALLENGE_TYPE_LOGIN);
export const verifyEnrollmentChallenge = (t) => verifyTypedToken(t, CHALLENGE_TYPE_ENROLL);

// ── TOTP ──────────────────────────────────────────────────────────────────

export function generateTotpSecret() {
  return authenticator.generateSecret();
}

/**
 * @param account  human-readable label that shows up in the authenticator
 *                 app (typically the email address)
 */
export function buildOtpauthUrl(secret, account) {
  return authenticator.keyuri(account, config.mfa.issuer, secret);
}

export async function buildQrDataUrl(otpauthUrl) {
  return qrcode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', width: 240, margin: 1 });
}

export function verifyTotpCode(secret, code) {
  if (!secret || !code) return false;
  const cleaned = String(code).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  try { return authenticator.check(cleaned, secret); }
  catch { return false; }
}

// ── Recovery codes ────────────────────────────────────────────────────────

/** 10 codes formatted "xxxx-xxxx-xxxx" (12 alphanumerics in 3 groups). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const buf = crypto.randomBytes(9);
    const raw = buf.toString('base64')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 12)
      .toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}

/** Hash for storage; codes are single-use. */
export function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(code.replace(/\s+/g, '').toUpperCase()).digest('hex');
}

/**
 * Try to consume a recovery code. Removes the matching hash from the user's
 * stored list and returns true on success.
 */
export async function consumeRecoveryCode(userId, code) {
  if (!userId || !code) return false;
  const target = hashRecoveryCode(code);
  const { data, error } = await adminSupabase
    .from('user_profiles')
    .select('mfa_recovery_codes')
    .eq('id', userId)
    .single();
  if (error || !data) return false;
  const stored = Array.isArray(data.mfa_recovery_codes) ? data.mfa_recovery_codes : [];
  const idx = stored.indexOf(target);
  if (idx === -1) return false;
  const remaining = [...stored.slice(0, idx), ...stored.slice(idx + 1)];
  const { error: updErr } = await adminSupabase
    .from('user_profiles')
    .update({ mfa_recovery_codes: remaining })
    .eq('id', userId);
  if (updErr) {
    logger.error('Failed to update recovery codes after consume', { userId, error: updErr.message });
    return false;
  }
  return true;
}

// ── Profile helpers ───────────────────────────────────────────────────────

export async function getMfaState(userId) {
  const { data } = await adminSupabase
    .from('user_profiles')
    .select('mfa_secret, mfa_pending_secret, mfa_enrolled_at, mfa_recovery_codes')
    .eq('id', userId)
    .maybeSingle();
  if (!data) return { enrolled: false, pending: false, recoveryCodesRemaining: 0 };
  return {
    enrolled:               !!data.mfa_enrolled_at && !!data.mfa_secret,
    pending:                !!data.mfa_pending_secret,
    recoveryCodesRemaining: Array.isArray(data.mfa_recovery_codes) ? data.mfa_recovery_codes.length : 0,
  };
}

export async function getActiveSecret(userId) {
  const { data } = await adminSupabase
    .from('user_profiles')
    .select('mfa_secret')
    .eq('id', userId)
    .maybeSingle();
  return data?.mfa_secret || null;
}

export async function getPendingSecret(userId) {
  const { data } = await adminSupabase
    .from('user_profiles')
    .select('mfa_pending_secret')
    .eq('id', userId)
    .maybeSingle();
  return data?.mfa_pending_secret || null;
}

export async function setPendingSecret(userId, secret) {
  const { error } = await adminSupabase
    .from('user_profiles')
    .update({ mfa_pending_secret: secret })
    .eq('id', userId);
  if (error) throw new Error(`Failed to stage MFA secret: ${error.message}`);
}

export async function activateMfa(userId, secret, recoveryCodes) {
  const hashed = recoveryCodes.map(hashRecoveryCode);
  const { error } = await adminSupabase
    .from('user_profiles')
    .update({
      mfa_secret:         secret,
      mfa_pending_secret: null,
      mfa_enrolled_at:    new Date().toISOString(),
      mfa_recovery_codes: hashed,
    })
    .eq('id', userId);
  if (error) throw new Error(`Failed to activate MFA: ${error.message}`);
}

export async function clearMfa(userId) {
  const { error } = await adminSupabase
    .from('user_profiles')
    .update({
      mfa_secret:         null,
      mfa_pending_secret: null,
      mfa_enrolled_at:    null,
      mfa_recovery_codes: [],
    })
    .eq('id', userId);
  if (error) throw new Error(`Failed to clear MFA: ${error.message}`);
}
