// The only place that moves money. The agent can create a proposal; only an approval here runs it.

import { randomUUID } from 'node:crypto';
import type { Db } from './db';
import { checkPayout, checkRefund, orderRefunds, requestId, type GateCode, type GateTicket } from './gate';
import type { PayoutItem, Refund } from './paypal';
import {
  asGateDisputes,
  computeMoney,
  getDisputes,
  getEvent,
  getLedger,
  getProposal,
  getProposals,
  getTickets,
  getVendors,
  toProposal,
  type ProposalKind,
  type ProposalRow,
} from './queries';

export type Payments = {
  refundCapture(
    captureId: string,
    input: { amountCents?: number; note: string; requestId: string; mockCode?: string },
  ): Promise<Refund>;
  sendPayout(input: {
    batchId: string;
    subject: string;
    items: PayoutItem[];
  }): Promise<{ payoutBatchId: string; status: string }>;
};

export type ProposalInput = {
  eventId: string;
  kind: ProposalKind;
  targetIds: string[];
  reason: string;
  evidence?: Record<string, unknown>;
  createdBy: string;
};

export type Blocked = { id: string; code: GateCode; reason: string };

export type Held = { id: string; amountCents: number };

export type ProposalOutcome = {
  proposal: ProposalRow;
  blocked: Blocked[];
  held: Held[];
};

const now = () => new Date().toISOString();

const ON_SLIP: Pick<Blocked, 'code' | 'reason'> = {
  code: 'ALREADY_ON_SLIP',
  reason: 'Already on a slip waiting for approval.',
};

// Money and targets spoken for by slips that have not finished yet. When drafting, waiting slips count.
// At approval, pass the slip being approved: only money actually going out counts then, so a draft
// that nobody has approved cannot block a slip the organizer just approved.
async function waitingSlips(db: Db, eventId: string, approvingId?: string) {
  const open = (await getProposals(db, eventId)).filter((p) =>
    approvingId ? p.status === 'executing' && p.id !== approvingId : p.status === 'pending' || p.status === 'executing',
  );
  return {
    targetIds: new Set(open.flatMap((p) => p.targetIds)),
    cents: open.filter((p) => p.kind !== 'chargeback_response').reduce((sum, p) => sum + p.amountCents, 0),
  };
}

async function planRefunds(db: Db, eventId: string, targetIds: string[], excludeId?: string) {
  const [event, tickets, vendors, disputes, ledger, waiting] = await Promise.all([
    getEvent(db, eventId),
    getTickets(db, eventId),
    getVendors(db, eventId),
    getDisputes(db, eventId),
    getLedger(db, eventId),
    waitingSlips(db, eventId, excludeId),
  ]);
  const gateDisputes = asGateDisputes(disputes);
  const blocked: Blocked[] = [];
  const allowed: GateTicket[] = [];

  for (const id of targetIds) {
    const ticket = tickets.find((t) => t.id === id);
    if (!ticket) continue;
    if (waiting.targetIds.has(id)) {
      blocked.push({ id, ...ON_SLIP });
      continue;
    }
    const check = checkRefund(ticket, gateDisputes);
    if (check.ok) allowed.push(ticket);
    else blocked.push({ id, code: check.code, reason: check.reason });
  }

  const { cashCents } = computeMoney(event, tickets, vendors, ledger);
  return { blocked, ...orderRefunds(allowed, Math.max(0, cashCents - waiting.cents)) };
}

export async function createProposal(db: Db, input: ProposalInput): Promise<ProposalOutcome> {
  if (!input.reason.trim()) throw new Error('A proposal needs a reason.');

  let targetIds: string[] = [];
  let amountCents = 0;
  let blocked: Blocked[] = [];
  const held: Held[] = [];

  if (input.kind === 'refund_batch') {
    const plan = await planRefunds(db, input.eventId, input.targetIds);
    targetIds = plan.paid.map((t) => t.id);
    amountCents = plan.paid.reduce((sum, t) => sum + t.amountCents, 0);
    blocked = plan.blocked;
    held.push(...plan.held.map((t) => ({ id: t.id, amountCents: t.amountCents })));
  } else if (input.kind === 'vendor_payout') {
    const [event, tickets, vendors, ledger, waiting] = await Promise.all([
      getEvent(db, input.eventId),
      getTickets(db, input.eventId),
      getVendors(db, input.eventId),
      getLedger(db, input.eventId),
      waitingSlips(db, input.eventId),
    ]);
    let cash = Math.max(0, computeMoney(event, tickets, vendors, ledger).cashCents - waiting.cents);

    for (const id of input.targetIds) {
      const vendor = vendors.find((v) => v.id === id);
      if (!vendor) continue;
      const check = checkPayout(vendor);
      if (waiting.targetIds.has(id)) {
        blocked.push({ id, ...ON_SLIP });
      } else if (!check.ok) {
        blocked.push({ id, code: check.code, reason: check.reason });
      } else if (check.amountCents > cash) {
        held.push({ id, amountCents: check.amountCents });
      } else {
        targetIds.push(id);
        amountCents += check.amountCents;
        cash -= check.amountCents;
      }
    }
  } else {
    const waiting = await waitingSlips(db, input.eventId);
    targetIds = input.targetIds.filter((id) => !waiting.targetIds.has(id));
    blocked = input.targetIds.filter((id) => waiting.targetIds.has(id)).map((id) => ({ id, ...ON_SLIP }));
    const disputes = await getDisputes(db, input.eventId);
    amountCents = disputes
      .filter((d) => targetIds.includes(d.id))
      .reduce((sum, d) => sum + d.amountCents, 0);
  }

  if (targetIds.length === 0) {
    if (blocked.some((b) => b.code === 'ALREADY_ON_SLIP')) {
      throw new Error('A slip for this is already waiting for approval.');
    }
    throw new Error(
      held.length > 0
        ? 'Nothing in this proposal can run: there is not enough cash left.'
        : 'Nothing in this proposal can run.',
    );
  }

  const evidence = { ...input.evidence, blocked, held };

  const [row] = await db.query<Parameters<typeof toProposal>[0]>(
    `insert into proposals (id, event_id, kind, target_ids, amount_cents, reason, evidence, status, created_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)
     returning *`,
    [
      randomUUID(),
      input.eventId,
      input.kind,
      JSON.stringify(targetIds),
      amountCents,
      input.reason.trim(),
      JSON.stringify(evidence),
      input.createdBy,
      now(),
    ],
  );

  return { proposal: toProposal(row), blocked, held };
}

type TargetFailure = { id: string; message: string };

async function runRefunds(db: Db, payments: Payments, proposal: ProposalRow, mockCode?: string) {
  // Everything is rechecked now, because cash and disputes may have changed since this was drafted.
  const { blocked, paid, held } = await planRefunds(db, proposal.eventId, proposal.targetIds, proposal.id);
  const payableIds = new Set(paid.map((t) => t.id));
  const tickets = (await getTickets(db, proposal.eventId)).filter((t) => payableIds.has(t.id));
  const skipped: Blocked[] = [
    ...blocked,
    ...held.map((t) => ({ id: t.id, code: 'NOT_ENOUGH_CASH' as const, reason: 'Cash ran out before this refund.' })),
  ];

  const failed: TargetFailure[] = [];
  const reconciled: string[] = [];
  let succeeded = 0;

  // PayPal is called a few at a time so a large batch stays within sandbox rate limits.
  for (let i = 0; i < tickets.length; i += 3) {
    await Promise.all(
      tickets.slice(i, i + 3).map(async (ticket) => {
        try {
          const refund = await payments.refundCapture(ticket.captureId as string, {
            note: proposal.reason,
            requestId: requestId(proposal.id, ticket.id),
            mockCode,
          });
          const at = now();
          await db.query(`update tickets set status = 'refunded', refunded_at = $2 where id = $1`, [ticket.id, at]);
          await db.query(
            `insert into ledger (id, event_id, kind, amount_cents, paypal_ref, proposal_id, reason, at)
             values ($1, $2, 'refund', $3, $4, $5, $6, $7)`,
            [
              randomUUID(),
              proposal.eventId,
              -ticket.amountCents,
              refund.refundId,
              proposal.id,
              `Refund to ${ticket.attendeeName}. ${proposal.reason}`,
              at,
            ],
          );
          succeeded += 1;
        } catch (error) {
          // The organizer refunded this one by hand in PayPal. The money has gone, so our record was wrong.
          if ((error as { issue?: string }).issue === 'CAPTURE_FULLY_REFUNDED') {
            const at = now();
            await db.query(`update tickets set status = 'refunded', refunded_at = $2 where id = $1`, [ticket.id, at]);
            await db.query(
              `insert into ledger (id, event_id, kind, amount_cents, paypal_ref, proposal_id, reason, at)
               values ($1, $2, 'refund', $3, $4, $5, $6, $7)`,
              [
                randomUUID(),
                proposal.eventId,
                -ticket.amountCents,
                ticket.captureId,
                proposal.id,
                `${ticket.attendeeName} was already refunded outside Backstop. PayPal confirmed it, so the record was corrected and nothing was paid twice.`,
                at,
              ],
            );
            reconciled.push(ticket.id);
            succeeded += 1;
            return;
          }

          await db.query(`update tickets set status = 'refund_failed' where id = $1`, [ticket.id]);
          failed.push({ id: ticket.id, message: error instanceof Error ? error.message : 'Refund failed.' });
        }
      }),
    );
  }

  return { succeeded, failed, skipped, reconciled };
}

async function runPayouts(db: Db, payments: Payments, proposal: ProposalRow) {
  const [event, tickets, allVendors, ledger, waiting] = await Promise.all([
    getEvent(db, proposal.eventId),
    getTickets(db, proposal.eventId),
    getVendors(db, proposal.eventId),
    getLedger(db, proposal.eventId),
    waitingSlips(db, proposal.eventId, proposal.id),
  ]);
  const vendors = allVendors.filter((v) => proposal.targetIds.includes(v.id));

  let cash = Math.max(0, computeMoney(event, tickets, allVendors, ledger).cashCents - waiting.cents);
  const payable: typeof vendors = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const vendor of vendors) {
    if (!checkPayout(vendor).ok) {
      skipped.push({ id: vendor.id, reason: 'No longer payable.' });
    } else if (vendor.owedCents > cash) {
      skipped.push({ id: vendor.id, reason: 'Cash ran out before this payment.' });
    } else {
      payable.push(vendor);
      cash -= vendor.owedCents;
    }
  }

  if (payable.length === 0) return { succeeded: 0, failed: [] as TargetFailure[], skipped };

  try {
    const batch = await payments.sendPayout({
      batchId: requestId(proposal.id, 'payout'),
      subject: 'Payment from your event organizer',
      items: payable.map((v) => ({
        email: v.email,
        amountCents: v.owedCents,
        note: proposal.reason.slice(0, 200),
        itemId: v.id,
      })),
    });
    const at = now();
    for (const vendor of payable) {
      await db.query(`update vendors set status = 'paid', payout_batch_id = $2 where id = $1`, [
        vendor.id,
        batch.payoutBatchId,
      ]);
      await db.query(
        `insert into ledger (id, event_id, kind, amount_cents, paypal_ref, proposal_id, reason, at)
         values ($1, $2, 'payout', $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          proposal.eventId,
          -vendor.owedCents,
          batch.payoutBatchId,
          proposal.id,
          `Payout to ${vendor.name}. ${proposal.reason}`,
          at,
        ],
      );
    }
    return { succeeded: payable.length, failed: [] as TargetFailure[], skipped };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Payout failed.';
    for (const vendor of payable) await db.query(`update vendors set status = 'failed' where id = $1`, [vendor.id]);
    return { succeeded: 0, failed: payable.map((v) => ({ id: v.id, message })), skipped };
  }
}

export type Executors = {
  chargebackResponse?: (db: Db, proposal: ProposalRow) => Promise<{ succeeded: number; failed: TargetFailure[]; skipped: unknown[] }>;
};

export async function approveProposal(
  db: Db,
  payments: Payments,
  id: string,
  options: { mockCode?: string; executors?: Executors } = {},
): Promise<ProposalRow> {
  // Only one caller can win this update, so a double click cannot pay twice.
  const claimed = await db.query(
    `update proposals set status = 'executing', decided_at = $2 where id = $1 and status = 'pending' returning id`,
    [id, now()],
  );
  if (claimed.length === 0) throw new Error('This proposal is not pending.');

  const proposal = await getProposal(db, id);

  let outcome: { succeeded: number; failed: TargetFailure[]; skipped: unknown[] };
  if (proposal.kind === 'refund_batch') {
    outcome = await runRefunds(db, payments, proposal, options.mockCode);
  } else if (proposal.kind === 'vendor_payout') {
    outcome = await runPayouts(db, payments, proposal);
  } else {
    if (!options.executors?.chargebackResponse) throw new Error('No chargeback executor configured.');
    outcome = await options.executors.chargebackResponse(db, proposal);
  }

  // A slip that moved nothing must never read as paid.
  const status = outcome.succeeded === 0 ? 'failed' : 'done';
  await db.query(`update proposals set status = $2, result = $3 where id = $1`, [id, status, JSON.stringify(outcome)]);
  return getProposal(db, id);
}

export async function rejectProposal(db: Db, id: string): Promise<ProposalRow> {
  const updated = await db.query(
    `update proposals set status = 'rejected', decided_at = $2 where id = $1 and status = 'pending' returning id`,
    [id, now()],
  );
  if (updated.length === 0) throw new Error('This proposal is not pending.');
  return getProposal(db, id);
}
