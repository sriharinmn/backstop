import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb, type Db } from '@/lib/db';
import { getSnapshot } from '@/lib/queries';
import { handleWebhook, type WebhookEvent } from '@/lib/webhooks';

let db: Db;

const disputeUpdated = (id = 'WH-1'): WebhookEvent => ({
  id,
  event_type: 'CUSTOMER.DISPUTE.UPDATED',
  resource: { dispute_id: 'PP-D-1', status: 'WAITING_FOR_SELLER_RESPONSE', seller_response_due_date: '2026-12-01T00:00:00Z' },
});

beforeEach(async () => {
  db = await createMemoryDb();
  await db.query(
    `insert into events (id, name, venue, starts_at, status, policy)
     values ('e1', 'Harbor Nights', 'Pier 9', '2026-11-14T19:00:00Z', 'cancelled', '{}')`,
  );
  await db.query(
    `insert into disputes (id, paypal_dispute_id, event_id, status, stage, reason, amount_cents, updated_at)
     values ('d1', 'PP-D-1', 'e1', 'OPEN', 'CHARGEBACK', 'EVENT_CANCELLED', 4000, '2026-11-14T07:00:00Z')`,
  );
});

describe('handleWebhook', () => {
  it('updates a dispute from a verified event', async () => {
    const result = await handleWebhook(db, disputeUpdated(), true);

    expect(result).toBe('applied');
    const { disputes } = await getSnapshot(db, 'e1');
    expect(disputes[0]).toMatchObject({ status: 'WAITING_FOR_SELLER_RESPONSE', dueAt: '2026-12-01T00:00:00Z' });
  });

  it('records but never acts on an event that failed verification', async () => {
    const result = await handleWebhook(db, disputeUpdated(), false);

    expect(result).toBe('rejected');
    const { disputes } = await getSnapshot(db, 'e1');
    expect(disputes[0].status).toBe('OPEN');
    const stored = await db.query<{ verified: boolean }>('select verified from webhook_events');
    expect(stored).toEqual([{ verified: false }]);
  });

  it('applies a repeat delivery only once, because PayPal retries', async () => {
    await handleWebhook(db, disputeUpdated(), true);
    await db.query(`update disputes set status = 'RESOLVED' where id = 'd1'`);

    const result = await handleWebhook(db, disputeUpdated(), true);

    expect(result).toBe('duplicate');
    const { disputes } = await getSnapshot(db, 'e1');
    expect(disputes[0].status).toBe('RESOLVED');
  });

  it('records the money when a webhook says PayPal paid the attendee', async () => {
    await db.query(
      `insert into tickets (id, event_id, attendee_name, attendee_email, amount_cents, paypal_capture_id, status, token)
       values ('t1', 'e1', 'Nora Whitlock', 'n@example.com', 4000, 'CAP1', 'transferred', 'tok')`,
    );
    await db.query(`update disputes set ticket_id = 't1' where id = 'd1'`);

    await handleWebhook(
      db,
      {
        id: 'WH-9',
        event_type: 'CUSTOMER.DISPUTE.RESOLVED',
        resource: {
          dispute_id: 'PP-D-1',
          status: 'RESOLVED',
          dispute_outcome: { outcome_code: 'RESOLVED_WITH_PAYOUT', amount_refunded: { value: '40.00' } },
        },
      },
      true,
    );

    const snapshot = await getSnapshot(db, 'e1');
    expect(snapshot.tickets[0].status).toBe('refunded');
    expect(snapshot.ledger.find((l) => l.kind === 'refund')?.amountCents).toBe(-4000);
  });

  it('ignores a dispute it does not know', async () => {
    const event = disputeUpdated('WH-2');
    event.resource.dispute_id = 'PP-D-OTHER';
    await expect(handleWebhook(db, event, true)).resolves.toBe('ignored');
  });

  it('stores an event type it does not act on', async () => {
    const result = await handleWebhook(db, { id: 'WH-3', event_type: 'BILLING.PLAN.CREATED', resource: {} }, true);
    expect(result).toBe('ignored');
    const stored = await db.query('select id from webhook_events');
    expect(stored).toHaveLength(1);
  });
});
