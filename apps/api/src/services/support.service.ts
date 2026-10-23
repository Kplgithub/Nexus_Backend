import { AuditLog, Counter } from '../models/misc.models.js';
import { logger } from '../lib/logger.js';
import type { AuthedAdmin } from '../middleware/auth.js';

/** Atomically allocate a human-readable lead id like "NX-E-2026-00042". */
export async function nextLeadId(prefix: 'E' | 'L'): Promise<string> {
  const year = new Date().getFullYear();
  const key = `${prefix}-${year}`;
  const c = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  ).lean();
  return `NX-${prefix}-${year}-${String(c!.seq).padStart(5, '0')}`;
}

/** Records sensitive admin actions. Failures are logged but never break the request. */
export async function audit(
  admin: AuthedAdmin | undefined,
  action: string,
  entity: string,
  entityId?: string,
  summary?: string,
) {
  try {
    await AuditLog.create({
      actor: admin?.id ?? null,
      actorEmail: admin?.email,
      action,
      entity,
      entityId,
      summary: summary?.slice(0, 500),
    });
  } catch (err) {
    logger.warn({ err, action, entity }, 'audit log write failed');
  }
}
