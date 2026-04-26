import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { ApiError } from '../middleware/errorHandler.js';
import { writeAuditLog } from '../utils/audit.js';
import {
  signEnrollmentChallenge, verifyEnrollmentChallenge,
  generateTotpSecret, buildOtpauthUrl, buildQrDataUrl, verifyTotpCode,
  generateRecoveryCodes,
  getMfaState, getActiveSecret, getPendingSecret, setPendingSecret,
  activateMfa, clearMfa,
} from '../services/mfa.js';

const router = Router();

router.get('/status', requireAuth, async (req, res, next) => {
  try { res.json(await getMfaState(req.user.id)); }
  catch (err) { next(err); }
});

router.post('/enroll/start', requireAuth, async (req, res, next) => {
  try {
    const state = await getMfaState(req.user.id);
    if (state.enrolled) throw new ApiError('MFA already enrolled. Disable first to re-enrol.', 409);
    const secret      = generateTotpSecret();
    const otpauthUrl  = buildOtpauthUrl(secret, req.user.email);
    const qrDataUrl   = await buildQrDataUrl(otpauthUrl);
    await setPendingSecret(req.user.id, secret);
    const challenge   = signEnrollmentChallenge(req.user.id);
    res.json({ secret, otpauthUrl, qrDataUrl, challenge });
  } catch (err) { next(err); }
});

router.post('/enroll/verify', requireAuth, async (req, res, next) => {
  try {
    const { challenge, code } = req.body || {};
    if (!challenge || !code) throw new ApiError('challenge and code are required', 400);
    const decoded = verifyEnrollmentChallenge(challenge);
    if (!decoded || decoded.userId !== req.user.id) throw new ApiError('Invalid or expired enrollment challenge', 401);
    const pending = await getPendingSecret(req.user.id);
    if (!pending) throw new ApiError('No pending enrollment. Start over.', 409);
    if (!verifyTotpCode(pending, code)) throw new ApiError('Invalid code. Try again.', 401);
    const recoveryCodes = generateRecoveryCodes();
    await activateMfa(req.user.id, pending, recoveryCodes);
    await writeAuditLog({
      eventType:   'mfa_enrolled',
      actorUserId: req.user.id,
      actorRole:   req.user.role,
      ipAddress:   req.ip,
    });
    res.json({ ok: true, recoveryCodes });
  } catch (err) { next(err); }
});

router.post('/disable', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body || {};
    const state    = await getMfaState(req.user.id);
    if (!state.enrolled) return res.json({ ok: true });
    if (!code) throw new ApiError('Current TOTP code is required to disable MFA', 400);
    const secret = await getActiveSecret(req.user.id);
    if (!secret || !verifyTotpCode(secret, code)) throw new ApiError('Invalid code', 401);
    await clearMfa(req.user.id);
    await writeAuditLog({
      eventType:   'mfa_disabled',
      actorUserId: req.user.id,
      actorRole:   req.user.role,
      ipAddress:   req.ip,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
