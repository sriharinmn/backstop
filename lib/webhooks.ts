// PayPal tells us when things change. An event that fails verification is stored but never acted on.

import type { Db } from './db';

export type WebhookEvent = {
  id: string;
  event_type: string;
  resource: {
    dispute_id?: string;
    status?: string;
    dispute_life_cycle_stage?: string;
    seller_response_due_date?: string;
    dispute_outcome?: { outcome_code?: string };
  };
};

export type WebhookResult = 'applied' | 'ignored' | 'duplicate' | 'rejected';

export async function handleWebhook(db: Db, event: WebhookEvent, verified: boolean): Promise<WebhookResult> {
  const inserted = await db.query(
    `insert into webhook_events (id, type, verified, payload, received_at)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do nothing
     returning id`,
    [event.id, event.event_type, verified, JSON.stringify(event), new Date().toISOString()],
  );

  if (inserted.length === 0) return 'duplicate';
  if (!verified) return 'rejected';
  if (!event.event_type.startsWith('CUSTOMER.DISPUTE.')) return 'ignored';

  const { dispute_id: disputeId, status, dispute_life_cycle_stage: stage, seller_response_due_date: dueAt } = event.resource;
  if (!disputeId) return 'ignored';

  const updated = await db.query(
    `update disputes
     set status = coalesce($2, status),
         stage = coalesce($3, stage),
         due_at = coalesce($4, due_at),
         outcome = coalesce($5, outcome),
         updated_at = $6
     where paypal_dispute_id = $1
     returning id`,
    [
      disputeId,
      status ?? null,
      stage ?? null,
      dueAt ?? null,
      event.resource.dispute_outcome?.outcome_code ?? null,
      new Date().toISOString(),
    ],
  );

  return updated.length > 0 ? 'applied' : 'ignored';
}
