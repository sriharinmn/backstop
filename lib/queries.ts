// Reads. The dashboard, the agent and the proposal rules all see the same numbers.

import type { Db } from './db';
import { cashAvailable, type GateDispute, type GateTicket, type GateVendor, type TicketStatus, type VendorStatus } from './gate';

export type EventRow = {
  id: string;
  name: string;
  venue: string;
  startsAt: string;
  status: 'on_sale' | 'cancelled';
  cancelledAt: string | null;
  policy: { spentCents?: number; spentNote?: string };
};

export type TicketRow = GateTicket & {
  attendeeName: string;
  attendeeEmail: string;
  token: string;
  refundedAt: string | null;
  checkedInAt: string | null;
};

export type VendorRow = GateVendor & { name: string; role: string; email: string };

export type DisputeRow = {
  id: string;
  paypalDisputeId: string;
  ticketId: string | null;
  status: string;
  stage: string;
  reason: string;
  amountCents: number;
  dueAt: string | null;
  outcome: string | null;
  actions: string[];
};

export type ProposalKind = 'refund_batch' | 'vendor_payout' | 'chargeback_response';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'executing' | 'done' | 'failed';

export type ProposalRow = {
  id: string;
  eventId: string;
  kind: ProposalKind;
  targetIds: string[];
  amountCents: number;
  reason: string;
  evidence: Record<string, unknown>;
  status: ProposalStatus;
  createdBy: string;
  createdAt: string;
  decidedAt: string | null;
  result: Record<string, unknown> | null;
};

export type LedgerRow = {
  id: string;
  kind: string;
  amountCents: number;
  paypalRef: string | null;
  proposalId: string | null;
  reason: string;
  at: string;
};

export type Money = {
  soldCents: number;
  spentCents: number;
  refundedCents: number;
  paidOutCents: number;
  cashCents: number;
  owedRefundsCents: number;
  owedVendorsCents: number;
  shortfallCents: number;
};

export type Snapshot = {
  event: EventRow;
  tickets: TicketRow[];
  vendors: VendorRow[];
  disputes: DisputeRow[];
  proposals: ProposalRow[];
  ledger: LedgerRow[];
  money: Money;
  lastWebhook: { type: string; verified: boolean; receivedAt: string } | null;
};

type EventSql = {
  id: string;
  name: string;
  venue: string;
  starts_at: string;
  status: EventRow['status'];
  cancelled_at: string | null;
  policy: EventRow['policy'];
};

export async function getEvent(db: Db, eventId: string): Promise<EventRow> {
  const [row] = await db.query<EventSql>('select * from events where id = $1', [eventId]);
  if (!row) throw new Error(`No event ${eventId}.`);
  return {
    id: row.id,
    name: row.name,
    venue: row.venue,
    startsAt: row.starts_at,
    status: row.status,
    cancelledAt: row.cancelled_at,
    policy: row.policy,
  };
}

export async function listEventIds(db: Db): Promise<string[]> {
  const rows = await db.query<{ id: string }>('select id from events where ready order by starts_at desc');
  return rows.map((r) => r.id);
}

type TicketSql = {
  id: string;
  amount_cents: number;
  paypal_capture_id: string | null;
  status: TicketStatus;
  requested_at: string | null;
  attendee_name: string;
  attendee_email: string;
  token: string;
  refunded_at: string | null;
  checked_in_at: string | null;
};

const toTicket = (r: TicketSql): TicketRow => ({
  id: r.id,
  amountCents: r.amount_cents,
  captureId: r.paypal_capture_id,
  status: r.status,
  requestedAt: r.requested_at,
  attendeeName: r.attendee_name,
  attendeeEmail: r.attendee_email,
  token: r.token,
  refundedAt: r.refunded_at,
  checkedInAt: r.checked_in_at,
});

export async function getTickets(db: Db, eventId: string): Promise<TicketRow[]> {
  const rows = await db.query<TicketSql>('select * from tickets where event_id = $1 order by id', [eventId]);
  return rows.map(toTicket);
}

export async function getTicketByToken(db: Db, token: string): Promise<(TicketRow & { eventId: string }) | null> {
  const [row] = await db.query<TicketSql & { event_id: string }>('select * from tickets where token = $1', [token]);
  return row ? { ...toTicket(row), eventId: row.event_id } : null;
}

export async function getVendors(db: Db, eventId: string): Promise<VendorRow[]> {
  const rows = await db.query<{
    id: string;
    owed_cents: number;
    status: VendorStatus;
    name: string;
    role: string;
    paypal_email: string;
  }>('select * from vendors where event_id = $1 order by id', [eventId]);
  return rows.map((r) => ({
    id: r.id,
    owedCents: r.owed_cents,
    status: r.status,
    name: r.name,
    role: r.role,
    email: r.paypal_email,
  }));
}

export async function getDisputes(db: Db, eventId: string): Promise<DisputeRow[]> {
  const rows = await db.query<{
    id: string;
    paypal_dispute_id: string;
    ticket_id: string | null;
    status: string;
    stage: string;
    reason: string;
    amount_cents: number;
    due_at: string | null;
    outcome: string | null;
    actions: string[];
  }>('select * from disputes where event_id = $1 order by due_at nulls last', [eventId]);
  return rows.map((r) => ({
    id: r.id,
    paypalDisputeId: r.paypal_dispute_id,
    ticketId: r.ticket_id,
    status: r.status,
    stage: r.stage,
    reason: r.reason,
    amountCents: r.amount_cents,
    dueAt: r.due_at,
    outcome: r.outcome,
    actions: r.actions,
  }));
}

export const asGateDisputes = (disputes: DisputeRow[]): GateDispute[] =>
  disputes.map((d) => ({ ticketId: d.ticketId, status: d.status }));

type ProposalSql = {
  id: string;
  event_id: string;
  kind: ProposalKind;
  target_ids: string[];
  amount_cents: number;
  reason: string;
  evidence: Record<string, unknown>;
  status: ProposalStatus;
  created_by: string;
  created_at: string;
  decided_at: string | null;
  result: Record<string, unknown> | null;
};

export const toProposal = (r: ProposalSql): ProposalRow => ({
  id: r.id,
  eventId: r.event_id,
  kind: r.kind,
  targetIds: r.target_ids,
  amountCents: r.amount_cents,
  reason: r.reason,
  evidence: r.evidence,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  result: r.result,
});

export async function getProposal(db: Db, id: string): Promise<ProposalRow> {
  const [row] = await db.query<ProposalSql>('select * from proposals where id = $1', [id]);
  if (!row) throw new Error(`No proposal ${id}.`);
  return toProposal(row);
}

export async function getProposals(db: Db, eventId: string): Promise<ProposalRow[]> {
  const rows = await db.query<ProposalSql>('select * from proposals where event_id = $1 order by created_at desc', [
    eventId,
  ]);
  return rows.map(toProposal);
}

export async function getLedger(db: Db, eventId: string): Promise<LedgerRow[]> {
  const rows = await db.query<{
    id: string;
    kind: string;
    amount_cents: number;
    paypal_ref: string | null;
    proposal_id: string | null;
    reason: string;
    at: string;
  }>('select * from ledger where event_id = $1 order by at desc, id', [eventId]);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountCents: r.amount_cents,
    paypalRef: r.paypal_ref,
    proposalId: r.proposal_id,
    reason: r.reason,
    at: r.at,
  }));
}

export function computeMoney(event: EventRow, tickets: TicketRow[], vendors: VendorRow[], ledger: LedgerRow[]): Money {
  const sumOf = (kind: string) => ledger.filter((l) => l.kind === kind).reduce((sum, l) => sum + l.amountCents, 0);

  const soldCents = sumOf('ticket_sale');
  const spentCents = event.policy.spentCents ?? 0;
  const refundedCents = 0 - sumOf('refund');
  const paidOutCents = 0 - sumOf('payout');
  const cashCents = cashAvailable(soldCents, spentCents + refundedCents + paidOutCents);

  const owedRefundsCents = tickets
    .filter((t) => t.status === 'refund_requested' || t.status === 'refund_failed')
    .reduce((sum, t) => sum + t.amountCents, 0);
  const owedVendorsCents = vendors.filter((v) => v.status !== 'paid').reduce((sum, v) => sum + v.owedCents, 0);

  return {
    soldCents,
    spentCents,
    refundedCents,
    paidOutCents,
    cashCents,
    owedRefundsCents,
    owedVendorsCents,
    shortfallCents: Math.max(0, owedRefundsCents + owedVendorsCents - cashCents),
  };
}

async function getLastWebhook(db: Db): Promise<Snapshot['lastWebhook']> {
  const [row] = await db.query<{ type: string; verified: boolean; received_at: string }>(
    'select type, verified, received_at from webhook_events order by received_at desc limit 1',
  );
  return row ? { type: row.type, verified: row.verified, receivedAt: row.received_at } : null;
}

export async function getSnapshot(db: Db, eventId: string): Promise<Snapshot> {
  const [event, tickets, vendors, disputes, proposals, ledger, lastWebhook] = await Promise.all([
    getEvent(db, eventId),
    getTickets(db, eventId),
    getVendors(db, eventId),
    getDisputes(db, eventId),
    getProposals(db, eventId),
    getLedger(db, eventId),
    getLastWebhook(db),
  ]);
  return {
    event,
    tickets,
    vendors,
    disputes,
    proposals,
    ledger,
    lastWebhook,
    money: computeMoney(event, tickets, vendors, ledger),
  };
}
