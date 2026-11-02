// The money rules. Pure functions: no database, no network, no AI.
// Nothing moves money unless these say it may.

import { createHash } from 'node:crypto';

export type TicketStatus =
  | 'paid'
  | 'refund_requested'
  | 'transfer_requested'
  | 'refunded'
  | 'transferred'
  | 'refund_failed';

export type VendorStatus = 'owed' | 'paid' | 'failed';

export type GateTicket = {
  id: string;
  amountCents: number;
  captureId: string | null;
  status: TicketStatus;
  requestedAt: string | null;
};

export type GateVendor = {
  id: string;
  owedCents: number;
  status: VendorStatus;
};

export type GateDispute = {
  ticketId: string | null;
  status: string;
};

export type GateResult =
  | { ok: true; amountCents: number }
  | { ok: false; code: GateCode; reason: string };

export type GateCode =
  | 'NO_CAPTURE'
  | 'ALREADY_REFUNDED'
  | 'TRANSFERRED'
  | 'OPEN_DISPUTE'
  | 'BAD_AMOUNT'
  | 'OVER_CAPTURE'
  | 'ALREADY_PAID'
  | 'NOTHING_OWED'
  | 'ALREADY_ON_SLIP'
  | 'NOT_ENOUGH_CASH';

const deny = (code: GateCode, reason: string): GateResult => ({ ok: false, code, reason });

export function checkRefund(ticket: GateTicket, disputes: GateDispute[], amountCents?: number): GateResult {
  if (!ticket.captureId) return deny('NO_CAPTURE', 'This ticket has no PayPal capture to refund.');
  if (ticket.status === 'refunded') return deny('ALREADY_REFUNDED', 'This ticket was already refunded.');
  if (ticket.status === 'transferred') {
    return deny('TRANSFERRED', 'This attendee moved their ticket to the new date.');
  }

  const open = disputes.some((d) => d.ticketId === ticket.id && d.status !== 'RESOLVED');
  if (open) {
    return deny('OPEN_DISPUTE', 'A chargeback is open on this ticket. Refunding now could pay this attendee twice.');
  }

  const amount = amountCents ?? ticket.amountCents;
  if (amount <= 0) return deny('BAD_AMOUNT', 'A refund must be more than zero.');
  if (amount > ticket.amountCents) return deny('OVER_CAPTURE', 'A refund cannot exceed what the attendee paid.');

  return { ok: true, amountCents: amount };
}

export function checkPayout(vendor: GateVendor): GateResult {
  if (vendor.status === 'paid') return deny('ALREADY_PAID', 'This vendor was already paid.');
  if (vendor.owedCents <= 0) return deny('NOTHING_OWED', 'Nothing is owed to this vendor.');
  return { ok: true, amountCents: vendor.owedCents };
}

export function cashAvailable(balanceCents: number, committedCents: number): number {
  return Math.max(0, balanceCents - committedCents);
}

export type RefundOrder = {
  paid: GateTicket[];
  held: GateTicket[];
  shortfallCents: number;
};

// First to ask is first paid. On the same moment, the smaller refund goes first,
// because it clears more people for the same money.
export function orderRefunds(tickets: GateTicket[], cashCents: number): RefundOrder {
  const queue = [...tickets].sort(
    (a, b) => (a.requestedAt ?? '').localeCompare(b.requestedAt ?? '') || a.amountCents - b.amountCents,
  );

  const paid: GateTicket[] = [];
  const held: GateTicket[] = [];
  let remaining = cashCents;

  for (const ticket of queue) {
    if (ticket.amountCents <= remaining) {
      paid.push(ticket);
      remaining -= ticket.amountCents;
    } else {
      held.push(ticket);
    }
  }

  const heldCents = held.reduce((sum, t) => sum + t.amountCents, 0);
  return { paid, held, shortfallCents: Math.max(0, heldCents - remaining) };
}

// PayPal treats a repeat of the same request id as the same request,
// so a retry of an approved proposal cannot move the money twice.
export function requestId(proposalId: string, targetId: string): string {
  return createHash('sha256').update(`${proposalId}:${targetId}`).digest('hex').slice(0, 36);
}
