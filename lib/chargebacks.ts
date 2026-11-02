// Chargebacks. The honest answer is not always to fight: an attendee who never got their money
// back is owed it. Contest only when the organizer would otherwise pay twice.

import { randomUUID } from 'node:crypto';
import type { Db } from './db';
import type { Dispute } from './paypal';
import { getDisputes, getTickets, type DisputeRow, type ProposalRow, type TicketRow } from './queries';

export type DisputePayments = {
  createChargeback(input: { captureId: string; amountCents: number; memo: string }): Promise<string>;
  getDispute(id: string): Promise<Dispute>;
  provideEvidence(id: string, input: { notes: string }): Promise<void>;
  acceptClaim(id: string, note: string): Promise<void>;
};

export type Recommendation = {
  action: 'accept' | 'contest';
  why: string;
  notes: string;
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'an earlier date');

export function recommendResponse(
  ticket: Pick<TicketRow, 'attendeeName' | 'status' | 'refundedAt' | 'requestedAt' | 'amountCents'>,
): Recommendation {
  if (ticket.status === 'refunded') {
    return {
      action: 'contest',
      why: `${ticket.attendeeName} was already refunded, so accepting would pay them twice.`,
      notes: `The event was cancelled and this attendee was refunded ${money(ticket.amountCents)} in full through PayPal on ${day(ticket.refundedAt)}. The refund is recorded against this transaction.`,
    };
  }
  if (ticket.status === 'transferred') {
    return {
      action: 'contest',
      why: `${ticket.attendeeName} chose to keep their ticket for the new date, and it is still valid.`,
      notes: `The event was rescheduled. On ${day(ticket.requestedAt)} this attendee chose to move their ticket to the new date instead of taking a refund. The ticket remains valid.`,
    };
  }
  return {
    action: 'accept',
    why: `${ticket.attendeeName} has not been refunded, so they are owed this money.`,
    notes: 'The event was cancelled and this attendee has not been refunded. The organizer accepts the claim.',
  };
}

export async function raiseChargeback(db: Db, payments: DisputePayments, ticketId: string): Promise<string> {
  const [ticket] = await db.query<{ event_id: string; paypal_capture_id: string | null; amount_cents: number }>(
    'select event_id, paypal_capture_id, amount_cents from tickets where id = $1',
    [ticketId],
  );
  if (!ticket?.paypal_capture_id) throw new Error('This ticket has no PayPal capture to dispute.');

  const paypalDisputeId = await payments.createChargeback({
    captureId: ticket.paypal_capture_id,
    amountCents: ticket.amount_cents,
    memo: 'Event cancelled',
  });

  const id = randomUUID();
  await db.query(
    `insert into disputes (id, paypal_dispute_id, event_id, ticket_id, status, stage, reason, amount_cents, updated_at)
     values ($1, $2, $3, $4, 'OPEN', 'CHARGEBACK', 'EVENT_CANCELLED', $5, $6)`,
    [id, paypalDisputeId, ticket.event_id, ticketId, ticket.amount_cents, new Date().toISOString()],
  );
  return id;
}

// PayPal closed the case and the attendee got the money. It has left the organizer's account whatever
// was argued, so it goes in the ledger exactly once, or cash would be overstated.
export async function recordChargebackPayout(db: Db, paypalDisputeId: string, refundedCents: number): Promise<void> {
  if (refundedCents <= 0) return;

  const [row] = await db.query<{ id: string; event_id: string; ticket_id: string | null }>(
    'select id, event_id, ticket_id from disputes where paypal_dispute_id = $1',
    [paypalDisputeId],
  );
  if (!row) return;

  const recorded = await db.query(`select id from ledger where kind = 'refund' and paypal_ref = $1`, [paypalDisputeId]);
  if (recorded.length > 0) return;

  const [ticket] = row.ticket_id
    ? await db.query<{ attendee_name: string }>('select attendee_name from tickets where id = $1', [row.ticket_id])
    : [];
  const at = new Date().toISOString();

  await db.query(
    `insert into ledger (id, event_id, kind, amount_cents, paypal_ref, reason, at)
     values ($1, $2, 'refund', $3, $4, $5, $6)
     on conflict (id) do nothing`,
    [
      `chargeback-${row.id}`,
      row.event_id,
      -refundedCents,
      paypalDisputeId,
      `PayPal closed this chargeback and paid ${ticket?.attendee_name ?? 'the attendee'} back.`,
      at,
    ],
  );
  if (row.ticket_id) {
    await db.query(`update tickets set status = 'refunded', refunded_at = coalesce(refunded_at, $2) where id = $1`, [
      row.ticket_id,
      at,
    ]);
  }
}

export async function applyDispute(db: Db, row: DisputeRow, live: Dispute): Promise<void> {
  await db.query(
    `update disputes set status = $2, stage = $3, reason = $4, due_at = $5, outcome = $6, actions = $7, updated_at = $8
     where id = $1`,
    [row.id, live.status, live.stage, live.reason, live.dueAt, live.outcome, JSON.stringify(live.actions), new Date().toISOString()],
  );
  if (live.status === 'RESOLVED') await recordChargebackPayout(db, row.paypalDisputeId, live.refundedCents);
}

export async function syncDisputes(db: Db, payments: Pick<DisputePayments, 'getDispute'>, eventId: string): Promise<void> {
  const open = (await getDisputes(db, eventId)).filter((d) => d.status !== 'RESOLVED');
  await Promise.all(open.map(async (row) => applyDispute(db, row, await payments.getDispute(row.paypalDisputeId))));
}

type ResponseEvidence = { action?: 'accept' | 'contest'; notes?: string };

export function chargebackExecutor(payments: DisputePayments) {
  return async (db: Db, proposal: ProposalRow) => {
    const { action = 'accept', notes = '' } = proposal.evidence as ResponseEvidence;
    const disputes = (await getDisputes(db, proposal.eventId)).filter((d) => proposal.targetIds.includes(d.id));
    const tickets = await getTickets(db, proposal.eventId);

    const failed: { id: string; message: string }[] = [];
    let succeeded = 0;

    for (const row of disputes) {
      try {
        const live = await payments.getDispute(row.paypalDisputeId);
        await applyDispute(db, row, live);

        const needed = action === 'accept' ? 'accept_claim' : 'provide_evidence';
        if (!live.actions.includes(needed)) {
          failed.push({ id: row.id, message: `PayPal is not ready for this answer yet. The case is ${live.status}.` });
          continue;
        }

        if (action === 'accept') {
          await payments.acceptClaim(row.paypalDisputeId, notes);
          const ticket = tickets.find((t) => t.id === row.ticketId);
          const at = new Date().toISOString();
          if (ticket && ticket.status !== 'refunded') {
            await db.query(`update tickets set status = 'refunded', refunded_at = $2 where id = $1`, [ticket.id, at]);
            await db.query(
              `insert into ledger (id, event_id, kind, amount_cents, paypal_ref, proposal_id, reason, at)
               values ($1, $2, 'refund', $3, $4, $5, $6, $7)`,
              [
                randomUUID(),
                proposal.eventId,
                -row.amountCents,
                row.paypalDisputeId,
                proposal.id,
                `Chargeback accepted for ${ticket.attendeeName}. ${proposal.reason}`,
                at,
              ],
            );
          }
        } else {
          await payments.provideEvidence(row.paypalDisputeId, { notes });
          await db.query(
            `insert into ledger (id, event_id, kind, amount_cents, paypal_ref, proposal_id, reason, at)
             values ($1, $2, 'note', 0, $3, $4, $5, $6)`,
            [randomUUID(), proposal.eventId, row.paypalDisputeId, proposal.id, `Evidence sent to PayPal. ${proposal.reason}`, new Date().toISOString()],
          );
        }
        succeeded += 1;
      } catch (error) {
        failed.push({ id: row.id, message: error instanceof Error ? error.message : 'PayPal rejected this answer.' });
      }
    }

    return { succeeded, failed, skipped: [] };
  };
}
