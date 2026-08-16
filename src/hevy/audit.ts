import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { formatUnknownError } from '../errors.js';

export interface HevyAuditEvent {
  requestId?: string;
  actingAs?: string;
  tool: string;
  action: 'start' | 'finish' | 'error';
  target?: unknown;
  status?: string;
  error?: unknown;
}

/**
 * No-op unless HEVY_AUDIT_LOG is set. Records only a hash of the target, never
 * workout contents — training data is personal, so the trail stays
 * who/what/when/outcome rather than the data itself.
 */
export async function writeAuditEvent(event: HevyAuditEvent): Promise<void> {
  const auditPath = process.env.HEVY_AUDIT_LOG;
  if (!auditPath) {
    return;
  }
  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? randomUUID(),
    actingAs: event.actingAs,
    tool: event.tool,
    action: event.action,
    targetHash: event.target === undefined ? undefined : createHash('sha256').update(JSON.stringify(event.target)).digest('hex'),
    status: event.status,
    error: event.error === undefined ? undefined : formatUnknownError(event.error),
  };
  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}
