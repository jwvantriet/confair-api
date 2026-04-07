import { adminSupabase } from '../services/supabase.js';
import { logger } from './logger.js';

/**
 * Append-only audit log writer.
 * Never throws — a failed log write must not break the main flow.
 */
export async function writeAuditLog({
  eventType,
  actorUserId = null,
  actorRole   = null,
  entityType  = null,
  entityId    = null,
  payload     = null,
  ipAddress   = null,
}) {
  const { error } = await adminSupabase.from('audit_log').insert({
    event_type:    eventType,
    actor_user_id: actorUserId,
    actor_role:    actorRole,
    entity_type:   entityType,
    entity_id:     entityId,
    payload,
    ip_address:    ipAddress,
  });
  if (error) logger.error('Audit log write failed', { error, eventType });
}
