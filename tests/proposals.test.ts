import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb, type Db } from '@/lib/db';
import {
  approveProposal,
  createProposal,
  rejectProposal,
  type Payments,
} from '@/lib/proposals';
import { getSnapshot } from '@/lib/queries';

type Calls = { refunds: { captureId: string; requestId: string }[]; payouts: string[][] };

function fakePayments(calls: Calls, failCaptures: string[] = []): Payments {
  return {
    async refundCapture(captureId, input) {
      calls.refunds.push({ captureId, requestId: input.requestId });
      if (failCaptures.includes(captureId)) throw new Error('PayPal said no');
      return { refundId: `R-${captureId}`, status: 'COMPLETED', netCents: null };
    },
    async sendPayout(input) {
      calls.payouts.push(input.items.map((i) => i.email));
      return { payoutBatchId: 'B1', status: 'PENDING' };
    },
  };
}

let db: Db;
let calls: Calls;

async function seed(cashSpentCents = 0) {
  await db.query(
    `insert into events (id, name, venue, starts_at, status, policy)
     values ('e1', 'Harbor Nights', 'Pier 9', '2026-11-14T19:00:00Z', 'cancelled', $1)`,
    [JSON.stringify({ spentCents: cashSpentCents })],
  );
  const tickets = [
    ['t1', 'CAP1', 'refund_requested', '2026-11-14T06:00:00Z'],
    ['t2', 'CAP2', 'refund_requested', '2026-11-14T06:05:00Z'],
    ['t3', 'CAP3', 'refund_requested', '2026-11-14T06:10:00Z'],
  ];
  for (const [id, capture, status, requested] of tickets) {
    await db.query(
      `insert into tickets (id, event_id, attendee_name, attendee_email, amount_cents, paypal_capture_id, status, requested_at, token)
       values ($1, 'e1', $1, $2, 4000, $3, $4, $5, $1)`,
      [id, `${id}@example.com`, capture, status, requested],
    );
    await db.query(
      `insert into ledger (id, event_id, kind, amount_cents, reason, at)
       values ($1, 'e1', 'ticket_sale', 4000, 'Ticket sale', '2026-11-01T00:00:00Z')`,
      [`sale-${id}`],
    );
  }
  await db.query(
    `insert into vendors (id, event_id, name, role, paypal_email, owed_cents, status)
     values ('v1', 'e1', 'Tide Sound', 'Sound hire', 'v1@example.com', 2000, 'owed')`,
  );
}

const refundInput = (targetIds: string[]) => ({
  eventId: 'e1',
  kind: 'refund_batch' as const,
  targetIds,
  reason: 'Storm cancelled the event; these attendees asked for refunds.',
  createdBy: 'backstop',
});

beforeEach(async () => {
  db = await createMemoryDb();
  calls = { refunds: [], payouts: [] };
});

describe('createProposal', () => {
  it('works out the amount on the server, and moves no money', async () => {
    await seed();

    const { proposal } = await createProposal(db, refundInput(['t1', 't2']));

    expect(proposal.status).toBe('pending');
    expect(proposal.amountCents).toBe(8000);
    expect(calls.refunds).toEqual([]);
  });

  it('requires a reason', async () => {
    await seed();
    await expect(createProposal(db, { ...refundInput(['t1']), reason: '  ' })).rejects.toThrow(/reason/i);
  });

  it('leaves out a ticket with an open chargeback and reports why', async () => {
    await seed();
    await db.query(
      `insert into disputes (id, paypal_dispute_id, event_id, ticket_id, status, stage, reason, amount_cents, updated_at)
       values ('d1', 'PP-D-1', 'e1', 't2', 'OPEN', 'CHARGEBACK', 'NOT_AS_DESCRIBED', 4000, '2026-11-14T07:00:00Z')`,
    );

    const { proposal, blocked } = await createProposal(db, refundInput(['t1', 't2']));

    expect(proposal.targetIds).toEqual(['t1']);
    expect(blocked).toEqual([expect.objectContaining({ id: 't2', code: 'OPEN_DISPUTE' })]);
  });

  it('holds back refunds that cash cannot cover, first asked first paid', async () => {
    await seed(5000); // 12000 sold, 5000 already spent, so 7000 left.

    const { proposal, held } = await createProposal(db, refundInput(['t1', 't2', 't3']));

    expect(proposal.targetIds).toEqual(['t1']);
    expect(proposal.amountCents).toBe(4000);
    expect(held.map((t) => t.id)).toEqual(['t2', 't3']);
  });

  it('refuses a proposal when nothing can run', async () => {
    await seed();
    await db.query(`update tickets set status = 'refunded' where id = 't1'`);
    await expect(createProposal(db, refundInput(['t1']))).rejects.toThrow(/nothing/i);
  });
});

describe('approveProposal', () => {
  it('refunds every ticket, records each in the ledger with the reason', async () => {
    await seed();
    const { proposal } = await createProposal(db, refundInput(['t1', 't2']));

    const done = await approveProposal(db, fakePayments(calls), proposal.id);

    expect(done.status).toBe('done');
    expect(calls.refunds.map((r) => r.captureId).sort()).toEqual(['CAP1', 'CAP2']);

    const snapshot = await getSnapshot(db, 'e1');
    expect(snapshot.tickets.find((t) => t.id === 't1')?.status).toBe('refunded');
    const refunds = snapshot.ledger.filter((l) => l.kind === 'refund');
    expect(refunds).toHaveLength(2);
    expect(refunds[0].reason).toContain('Storm');
  });

  it('cannot be run twice', async () => {
    await seed();
    const { proposal } = await createProposal(db, refundInput(['t1']));

    await approveProposal(db, fakePayments(calls), proposal.id);

    await expect(approveProposal(db, fakePayments(calls), proposal.id)).rejects.toThrow(/pending/i);
    expect(calls.refunds).toHaveLength(1);
  });

  it('rechecks the rules at approval, because things change', async () => {
    await seed();
    const { proposal } = await createProposal(db, refundInput(['t1', 't2']));
    await db.query(
      `insert into disputes (id, paypal_dispute_id, event_id, ticket_id, status, stage, reason, amount_cents, updated_at)
       values ('d1', 'PP-D-1', 'e1', 't1', 'OPEN', 'CHARGEBACK', 'NOT_AS_DESCRIBED', 4000, '2026-11-14T07:00:00Z')`,
    );

    const done = await approveProposal(db, fakePayments(calls), proposal.id);

    expect(calls.refunds.map((r) => r.captureId)).toEqual(['CAP2']);
    expect(done.result).toMatchObject({ skipped: [expect.objectContaining({ id: 't1', code: 'OPEN_DISPUTE' })] });
  });

  it('keeps going when one refund fails, and records the failure', async () => {
    await seed();
    const { proposal } = await createProposal(db, refundInput(['t1', 't2']));

    const done = await approveProposal(db, fakePayments(calls, ['CAP1']), proposal.id);

    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ failed: [expect.objectContaining({ id: 't1' })] });
    const snapshot = await getSnapshot(db, 'e1');
    expect(snapshot.tickets.find((t) => t.id === 't1')?.status).toBe('refund_failed');
    expect(snapshot.tickets.find((t) => t.id === 't2')?.status).toBe('refunded');
  });

  it('treats an already-refunded capture as settled, and corrects the record instead of failing', async () => {
    await seed();
    const { proposal } = await createProposal(db, refundInput(['t1', 't2']));
    const payments = fakePayments(calls);
    const paypalSaysNo = Object.assign(new Error('The capture has already been fully refunded'), {
      issue: 'CAPTURE_FULLY_REFUNDED',
    });

    const done = await approveProposal(
      db,
      {
        ...payments,
        refundCapture: async (captureId, input) => {
          if (captureId === 'CAP1') throw paypalSaysNo;
          return payments.refundCapture(captureId, input);
        },
      },
      proposal.id,
    );

    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ reconciled: ['t1'], failed: [] });
    const snapshot = await getSnapshot(db, 'e1');
    expect(snapshot.tickets.find((t) => t.id === 't1')?.status).toBe('refunded');
    const entry = snapshot.ledger.find((l) => l.kind === 'refund' && l.reason.includes('outside Backstop'));
    expect(entry?.amountCents).toBe(-4000);
  });

  it.each(['FAILED', 'CANCELLED'])('does not count a refund PayPal answers with %s as paid', async (status) => {
    await seed();
    const { proposal } = await createProposal(db, refundInput(['t1', 't2']));
    const payments = fakePayments(calls);

    const done = await approveProposal(
      db,
      {
        ...payments,
        refundCapture: async (captureId, input) => {
          const refund = await payments.refundCapture(captureId, input);
          return captureId === 'CAP1' ? { ...refund, status } : refund;
        },
      },
      proposal.id,
    );

    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({ failed: [expect.objectContaining({ id: 't1' })] });
    const snapshot = await getSnapshot(db, 'e1');
    expect(snapshot.tickets.find((t) => t.id === 't1')?.status).toBe('refund_failed');
    expect(snapshot.ledger.filter((l) => l.kind === 'refund')).toHaveLength(1);
    expect(snapshot.money.refundedCents).toBe(4000);
  });

  it('counts a PENDING refund as paid, because PayPal has accepted it', async () => {
    await seed();
    const { proposal } = await createProposal(db, refundInput(['t1']));
    const payments = fakePayments(calls);

    const done = await approveProposal(
      db,
      {
        ...payments,
        refundCapture: async (captureId, input) => ({
          ...(await payments.refundCapture(captureId, input)),
          status: 'PENDING',
        }),
      },
      proposal.id,
    );

    expect(done.status).toBe('done');
    const snapshot = await getSnapshot(db, 'e1');
    expect(snapshot.tickets[0].status).toBe('refunded');
  });

  it('marks the proposal failed when every refund fails', async () => {
    await seed();
    const { proposal } = await createProposal(db, refundInput(['t1']));

    const done = await approveProposal(db, fakePayments(calls, ['CAP1']), proposal.id);

    expect(done.status).toBe('failed');
  });

  it('uses a stable request id per ticket', async () => {
    await seed();
    const { proposal } = await createProposal(db, refundInput(['t1']));

    await approveProposal(db, fakePayments(calls), proposal.id);

    expect(calls.refunds[0].requestId).toMatch(/^[0-9a-f]{36}$/);
  });

  it('pays a vendor and marks them paid', async () => {
    await seed();
    const { proposal } = await createProposal(db, {
      eventId: 'e1',
      kind: 'vendor_payout',
      targetIds: ['v1'],
      reason: 'Sound hire is contractually due on cancellation.',
      createdBy: 'backstop',
    });

    const done = await approveProposal(db, fakePayments(calls), proposal.id);

    expect(done.status).toBe('done');
    expect(calls.payouts).toEqual([['v1@example.com']]);
    const snapshot = await getSnapshot(db, 'e1');
    expect(snapshot.vendors[0].status).toBe('paid');
    expect(snapshot.ledger.some((l) => l.kind === 'payout' && l.amountCents === -2000)).toBe(true);
  });
});

describe('slips that overlap', () => {
  it('will not put a ticket on a second waiting slip', async () => {
    await seed();
    await createProposal(db, refundInput(['t1', 't2']));

    const { proposal, blocked } = await createProposal(db, refundInput(['t2', 't3']));

    expect(proposal.targetIds).toEqual(['t3']);
    expect(blocked).toEqual([expect.objectContaining({ id: 't2', code: 'ALREADY_ON_SLIP' })]);
  });

  it('says so plainly when everything is already on a waiting slip', async () => {
    await seed();
    await createProposal(db, refundInput(['t1', 't2']));

    await expect(createProposal(db, refundInput(['t1', 't2']))).rejects.toThrow(/already waiting/i);
  });

  it('allows a ticket again once its slip is rejected', async () => {
    await seed();
    const { proposal } = await createProposal(db, refundInput(['t1']));
    await rejectProposal(db, proposal.id);

    const { proposal: again } = await createProposal(db, refundInput(['t1']));

    expect(again.targetIds).toEqual(['t1']);
  });

  it('counts money on a waiting slip as spoken for', async () => {
    await seed(5000); // 12000 sold, 5000 spent, 7000 left. Each ticket is 4000.
    await createProposal(db, refundInput(['t1'])); // 4000 spoken for, 3000 left.

    const { held } = await createProposal(db, {
      ...refundInput(['t2']),
      reason: 'A later batch.',
    }).catch(() => ({ held: [{ id: 't2', amountCents: 4000 }] }));

    expect(held.map((t) => t.id)).toEqual(['t2']);
  });

  it('counts a waiting refund slip when drafting a vendor payment', async () => {
    await seed(5000); // 7000 left. The refund takes 4000, leaving 3000. The vendor is owed 2000.
    await db.query(`update vendors set owed_cents = 3500 where id = 'v1'`);
    await createProposal(db, refundInput(['t1']));

    await expect(
      createProposal(db, {
        eventId: 'e1',
        kind: 'vendor_payout',
        targetIds: ['v1'],
        reason: 'Sound hire is due.',
        createdBy: 'backstop',
      }),
    ).rejects.toThrow(/nothing/i);
  });

  it('rechecks cash at approval, so two slips cannot spend the same money', async () => {
    await seed(5000); // 7000 left. One ticket fits, two do not.
    const first = await createProposal(db, refundInput(['t1']));
    const second = await db.query<{ id: string }>(
      `insert into proposals (id, event_id, kind, target_ids, amount_cents, reason, evidence, status, created_by, created_at)
       values ('p2', 'e1', 'refund_batch', '["t2"]', 4000, 'Forced second slip.', '{}', 'pending', 'test', '2026-11-14T07:00:00Z')
       returning id`,
    );

    await approveProposal(db, fakePayments(calls), first.proposal.id);
    const done = await approveProposal(db, fakePayments(calls), second[0].id);

    expect(calls.refunds.map((r) => r.captureId)).toEqual(['CAP1']);
    expect(done.result).toMatchObject({ skipped: [expect.objectContaining({ id: 't2', code: 'NOT_ENOUGH_CASH' })] });
  });
});

describe('vendor payouts and cash', () => {
  const payoutInput = {
    eventId: 'e1',
    kind: 'vendor_payout' as const,
    targetIds: ['v1', 'v2'],
    reason: 'Vendors are contractually due on cancellation.',
    createdBy: 'backstop',
  };

  async function secondVendor(owedCents: number) {
    await db.query(
      `insert into vendors (id, event_id, name, role, paypal_email, owed_cents, status)
       values ('v2', 'e1', 'Pier Crew', 'Stage crew', 'v2@example.com', $1, 'owed')`,
      [owedCents],
    );
  }

  it('holds back a vendor that cash cannot cover', async () => {
    await seed(9000); // 12000 sold, 9000 spent, so 3000 left. v1 is owed 2000.
    await secondVendor(2000);

    const { proposal, held } = await createProposal(db, payoutInput);

    expect(proposal.targetIds).toEqual(['v1']);
    expect(proposal.amountCents).toBe(2000);
    expect(held.map((v) => v.id)).toEqual(['v2']);
  });

  it('refuses a payout when there is no cash for any vendor', async () => {
    await seed(11000);
    await expect(createProposal(db, payoutInput)).rejects.toThrow(/nothing/i);
  });
});

describe('rejectProposal', () => {
  it('moves no money and cannot then be approved', async () => {
    await seed();
    const { proposal } = await createProposal(db, refundInput(['t1']));

    await rejectProposal(db, proposal.id);

    await expect(approveProposal(db, fakePayments(calls), proposal.id)).rejects.toThrow(/pending/i);
    expect(calls.refunds).toEqual([]);
  });
});

describe('getSnapshot money', () => {
  it('derives cash from real amounts: sold, minus spent, minus refunds and payouts', async () => {
    await seed(5000);
    const { proposal } = await createProposal(db, refundInput(['t1']));
    await approveProposal(db, fakePayments(calls), proposal.id);

    const { money } = await getSnapshot(db, 'e1');

    expect(money.soldCents).toBe(12000);
    expect(money.spentCents).toBe(5000);
    expect(money.refundedCents).toBe(4000);
    expect(money.cashCents).toBe(3000);
    expect(money.owedRefundsCents).toBe(8000);
    expect(money.owedVendorsCents).toBe(2000);
    expect(money.shortfallCents).toBe(7000);
  });
});
