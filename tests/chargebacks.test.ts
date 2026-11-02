import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb, type Db } from '@/lib/db';
import {
  chargebackExecutor,
  raiseChargeback,
  recommendResponse,
  syncDisputes,
  type DisputePayments,
} from '@/lib/chargebacks';
import type { TicketStatus } from '@/lib/gate';
import type { Dispute } from '@/lib/paypal';
import { approveProposal, createProposal, type Payments } from '@/lib/proposals';
import { getSnapshot } from '@/lib/queries';

describe('recommendResponse', () => {
  const ticket = {
    attendeeName: 'Maya Okafor',
    status: 'paid' as TicketStatus,
    refundedAt: null,
    requestedAt: null,
    amountCents: 3500,
  };

  it('accepts when the attendee has not been refunded, because they are owed the money', () => {
    expect(recommendResponse({ ...ticket, status: 'refund_requested' as TicketStatus })).toMatchObject({ action: 'accept' });
    expect(recommendResponse(ticket)).toMatchObject({ action: 'accept' });
  });

  it('contests when the attendee was already refunded, so the organizer does not pay twice', () => {
    const result = recommendResponse({ ...ticket, status: 'refunded', refundedAt: '2026-11-14T06:30:00Z' });
    expect(result.action).toBe('contest');
    expect(result.notes).toContain('2026-11-14');
    expect(result.notes).toContain('$35.00');
  });

  it('contests when the attendee moved their ticket to the new date', () => {
    const result = recommendResponse({ ...ticket, status: 'transferred', requestedAt: '2026-11-14T06:40:00Z' });
    expect(result.action).toBe('contest');
    expect(result.notes).toContain('new date');
  });
});

const liveDispute = (over: Partial<Dispute> = {}): Dispute => ({
  id: 'PP-D-1',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'CHARGEBACK',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
  amountCents: 4000,
  dueAt: '2026-12-01T00:00:00Z',
  outcome: null,
  captureId: 'CAP1',
  customId: 't1',
  actions: ['accept_claim', 'provide_evidence'],
  ...over,
});

type Calls = { evidence: string[]; accepted: string[]; created: string[] };

function fakeDisputes(calls: Calls, dispute: Dispute = liveDispute()): DisputePayments {
  return {
    async createChargeback(input) {
      calls.created.push(input.captureId);
      return 'PP-D-1';
    },
    async getDispute() {
      return dispute;
    },
    async provideEvidence(_id, input) {
      calls.evidence.push(input.notes);
    },
    async acceptClaim(_id, note) {
      calls.accepted.push(note);
    },
  };
}

const noPayments: Payments = {
  refundCapture: async () => {
    throw new Error('Not expected');
  },
  sendPayout: async () => {
    throw new Error('Not expected');
  },
};

let db: Db;
let calls: Calls;

async function seed(status: string, refundedAt: string | null = null) {
  await db.query(
    `insert into events (id, name, venue, starts_at, status, policy)
     values ('e1', 'Harbor Nights', 'Pier 9', '2026-11-14T19:00:00Z', 'cancelled', '{}')`,
  );
  await db.query(
    `insert into tickets (id, event_id, attendee_name, attendee_email, amount_cents, paypal_capture_id, status, refunded_at, token)
     values ('t1', 'e1', 'Maya Okafor', 'maya@example.com', 4000, 'CAP1', $1, $2, 'tok')`,
    [status, refundedAt],
  );
  await db.query(
    `insert into ledger (id, event_id, kind, amount_cents, reason, at)
     values ('sale', 'e1', 'ticket_sale', 4000, 'Ticket sale', '2026-11-01T00:00:00Z')`,
  );
}

beforeEach(async () => {
  db = await createMemoryDb();
  calls = { evidence: [], accepted: [], created: [] };
});

describe('raiseChargeback', () => {
  it('records the dispute against the ticket', async () => {
    await seed('paid');

    await raiseChargeback(db, fakeDisputes(calls), 't1');

    const { disputes } = await getSnapshot(db, 'e1');
    expect(calls.created).toEqual(['CAP1']);
    expect(disputes).toHaveLength(1);
    expect(disputes[0]).toMatchObject({ ticketId: 't1', status: 'OPEN', paypalDisputeId: 'PP-D-1' });
  });
});

describe('syncDisputes', () => {
  it('copies status, deadline and actions from PayPal', async () => {
    await seed('paid');
    await raiseChargeback(db, fakeDisputes(calls), 't1');

    await syncDisputes(db, fakeDisputes(calls), 'e1');

    const { disputes } = await getSnapshot(db, 'e1');
    expect(disputes[0]).toMatchObject({
      status: 'WAITING_FOR_SELLER_RESPONSE',
      dueAt: '2026-12-01T00:00:00Z',
      actions: ['accept_claim', 'provide_evidence'],
    });
  });
});

describe('chargeback responses', () => {
  async function respond(action: 'accept' | 'contest') {
    await raiseChargeback(db, fakeDisputes(calls), 't1');
    await syncDisputes(db, fakeDisputes(calls), 'e1');
    const { disputes } = await getSnapshot(db, 'e1');
    const { proposal } = await createProposal(db, {
      eventId: 'e1',
      kind: 'chargeback_response',
      targetIds: [disputes[0].id],
      reason: 'Answering the chargeback.',
      evidence: { action, notes: 'Refunded on Nov 14.' },
      createdBy: 'backstop',
    });
    return approveProposal(db, noPayments, proposal.id, {
      executors: { chargebackResponse: chargebackExecutor(fakeDisputes(calls)) },
    });
  }

  it('submits evidence when contesting', async () => {
    await seed('refunded', '2026-11-14T06:30:00Z');

    const done = await respond('contest');

    expect(done.status).toBe('done');
    expect(calls.evidence).toEqual(['Refunded on Nov 14.']);
    expect(calls.accepted).toEqual([]);
  });

  it('accepts the claim, closes the ticket so it cannot be refunded again, and records the money', async () => {
    await seed('refund_requested');

    const done = await respond('accept');

    expect(done.status).toBe('done');
    expect(calls.accepted).toHaveLength(1);
    const snapshot = await getSnapshot(db, 'e1');
    expect(snapshot.tickets[0].status).toBe('refunded');
    expect(snapshot.ledger.some((l) => l.kind === 'refund' && l.amountCents === -4000)).toBe(true);
  });

  it('fails clearly when PayPal is not ready for that answer yet', async () => {
    await seed('paid');
    await raiseChargeback(db, fakeDisputes(calls), 't1');
    const early = fakeDisputes(calls, liveDispute({ status: 'UNDER_REVIEW', actions: ['provide_supporting_info'] }));
    await syncDisputes(db, early, 'e1');
    const { disputes } = await getSnapshot(db, 'e1');
    const { proposal } = await createProposal(db, {
      eventId: 'e1',
      kind: 'chargeback_response',
      targetIds: [disputes[0].id],
      reason: 'Answering the chargeback.',
      evidence: { action: 'accept', notes: 'Owed.' },
      createdBy: 'backstop',
    });

    const done = await approveProposal(db, noPayments, proposal.id, {
      executors: { chargebackResponse: chargebackExecutor(early) },
    });

    expect(done.status).toBe('failed');
    expect(JSON.stringify(done.result)).toMatch(/not ready/i);
    expect(calls.accepted).toEqual([]);
  });
});
