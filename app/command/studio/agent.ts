import { createAiHarness, directLlmRunner, type AgStudioApi } from 'ag-studio';
import { latestSnapshot } from '../store';
import { backstopAdapter } from './adapter';
import { CHART_PRESETS, hasWidget, insertChart, type ChartPreset, type ReportState } from './charts';

// Kept short on purpose: every word here is spent on every turn, and the AI is on a free tier.
const INSTRUCTIONS = `You help a small event organizer through a cancelled event. Be brief and plain.
Call get_situation before you state any number, and never guess one.
You cannot move money. You draft slips, and the organizer approves them.
Each slip's reason is one short sentence on why this money is going out, in plain words. Do not put amounts in it, and never mention a server, a tool or a system.
Attendees come before vendors. If cash runs short, some are held back automatically; tell the organizer how many.
For a chargeback, call answer_chargeback. The app decides whether to accept or contest it. Explain why in one line.
Finish in two or three sentences: what you drafted, why, and what the organizer should do next.`;

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? 'The server refused this.'));
  return json;
}

function situation() {
  const snapshot = latestSnapshot();
  if (!snapshot) throw new Error('No event is loaded yet.');

  const { event, money, tickets, vendors, disputes, proposals } = snapshot;
  const count = (status: string) => tickets.filter((t) => t.status === status).length;
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return {
    event: event.name,
    status: event.status,
    attendees: {
      waitingForRefund: count('refund_requested') + count('refund_failed'),
      refunded: count('refunded'),
      movedToNewDate: count('transferred'),
      noReply: count('paid'),
    },
    money: {
      owedToAttendees: dollars(money.owedRefundsCents),
      owedToVendors: dollars(money.owedVendorsCents),
      cashAvailable: dollars(money.cashCents),
      shortBy: dollars(money.shortfallCents),
      alreadySpent: dollars(money.spentCents),
    },
    vendorsUnpaid: vendors
      .filter((v) => v.status !== 'paid')
      .map((v) => ({ id: v.id, name: v.name, owed: dollars(v.owedCents) })),
    chargebacks: disputes
      .filter((d) => d.status !== 'RESOLVED')
      .map((d) => ({
        id: d.id,
        attendee: tickets.find((t) => t.id === d.ticketId)?.attendeeName,
        status: d.status,
        canAnswer: d.actions.includes('accept_claim') || d.actions.includes('provide_evidence'),
      })),
    slipsWaitingForApproval: proposals.filter((p) => p.status === 'pending').length,
  };
}

export function buildAgent(api: AgStudioApi) {
  const getSituation = api.defineAiTool({
    name: 'get_situation',
    description: 'Current money owed, cash, attendees, vendors and open chargebacks.',
    params: (s) => s.object({}),
    execute: async (_args, ctx) => ctx.success('Current situation.', situation()),
  });

  const proposeRefunds = api.defineAiTool({
    name: 'propose_refunds',
    description: 'Draft a slip refunding every attendee who is waiting. The server works out amounts and holds back what cash cannot cover.',
    params: (s) => s.object({ reason: s.string({ description: 'Why, for the organizer, in one sentence.' }) }),
    execute: async (args, ctx) => {
      const snapshot = latestSnapshot();
      if (!snapshot) return ctx.error('No event is loaded yet.');
      const targetIds = snapshot.tickets
        .filter((t) => t.status === 'refund_requested' || t.status === 'refund_failed')
        .map((t) => t.id);
      if (targetIds.length === 0) return ctx.error('Nobody is waiting for a refund.');

      try {
        const { proposal, held, blocked } = (await post('/api/proposals', {
          eventId: snapshot.event.id,
          kind: 'refund_batch',
          targetIds,
          reason: args.reason,
          createdBy: 'backstop',
        })) as { proposal: { targetIds: string[]; amountCents: number }; held: unknown[]; blocked: unknown[] };

        // Spelled out, because a bare number gets misread as dollars.
        const total = `$${(proposal.amountCents / 100).toFixed(2)}`;
        return ctx.success(
          `Slip drafted for ${proposal.targetIds.length} attendees, ${total} in total. ` +
            `${held.length} more attendees are held back because cash is short. ` +
            `${blocked.length} are left out. It waits for the organizer.`,
        );
      } catch (error) {
        return ctx.error(error instanceof Error ? error.message : 'Could not draft the slip.');
      }
    },
  });

  const proposePayment = api.defineAiTool({
    name: 'propose_vendor_payment',
    description: 'Draft a slip paying unpaid vendors. Only do this after attendees are refunded or when asked.',
    params: (s) => s.object({ reason: s.string({ description: 'Why, for the organizer, in one sentence.' }) }),
    execute: async (args, ctx) => {
      const snapshot = latestSnapshot();
      if (!snapshot) return ctx.error('No event is loaded yet.');

      // Attendees first is a rule, not advice: the model cannot talk its way past it.
      const waiting = snapshot.tickets.some((t) => t.status === 'refund_requested' || t.status === 'refund_failed');
      if (waiting && snapshot.money.shortfallCents > 0) {
        return ctx.error('Attendees are still waiting and cash cannot cover everyone. Do not pay vendors yet.');
      }

      const targetIds = snapshot.vendors.filter((v) => v.status !== 'paid').map((v) => v.id);

      try {
        const { proposal, held } = (await post('/api/proposals', {
          eventId: snapshot.event.id,
          kind: 'vendor_payout',
          targetIds,
          reason: args.reason,
          createdBy: 'backstop',
        })) as { proposal: { targetIds: string[]; amountCents: number }; held: unknown[] };
        const total = `$${(proposal.amountCents / 100).toFixed(2)}`;
        return ctx.success(
          `Slip drafted for ${proposal.targetIds.length} vendors, ${total} in total. ` +
            `${held.length} more vendors are held back because cash is short. It waits for the organizer.`,
        );
      } catch (error) {
        return ctx.error(error instanceof Error ? error.message : 'Could not draft the slip.');
      }
    },
  });

  const answerChargeback = api.defineAiTool({
    name: 'answer_chargeback',
    description: 'Draft the answer to one chargeback that canAnswer. The app chooses accept or contest.',
    params: (s) => s.object({ id: s.string({ description: 'The chargeback id from get_situation.' }) }),
    execute: async (args, ctx) => {
      const snapshot = latestSnapshot();
      if (!snapshot) return ctx.error('No event is loaded yet.');

      try {
        const { proposal } = (await post(`/api/disputes/${args.id}/draft`, {
          eventId: snapshot.event.id,
          createdBy: 'backstop',
        })) as { proposal: { reason: string } };
        return ctx.success('Chargeback answer drafted.', { why: proposal.reason });
      } catch (error) {
        return ctx.error(error instanceof Error ? error.message : 'Could not draft the answer.');
      }
    },
  });

  const makeChart = api.defineAiTool({
    name: 'make_chart',
    description: 'Add a bar chart to the dashboard, above the attendee list.',
    params: (s) =>
      s.object({
        chart: s.enum(Object.keys(CHART_PRESETS) as [ChartPreset, ...ChartPreset[]], {
          description: 'What to chart.',
        }),
        title: s.string({ description: 'A short title in plain words.' }),
      }),
    execute: async (args, ctx) => {
      const id = `agent-chart-${Date.now()}`;
      try {
        const next = insertChart(api.getState() as unknown as ReportState, args.chart, args.title, id);
        api.setState(next as never);
      } catch (error) {
        return ctx.error(error instanceof Error ? error.message : 'Could not add the chart.');
      }

      // Never report success on faith. Check that the chart is really there.
      if (!hasWidget(api.getState() as unknown as ReportState, id)) {
        return ctx.error('The dashboard did not accept the chart.');
      }
      return ctx.success('Chart added to the dashboard.', { title: args.title });
    },
  });

  return createAiHarness(api, () => ({
    agents: [
      directLlmRunner({
        id: 'backstop',
        name: 'Backstop',
        description: 'Gets an organizer through a cancelled event.',
        adapter: backstopAdapter,
        instructions: () => INSTRUCTIONS,
        tools: () => [getSituation, proposeRefunds, proposePayment, answerChargeback, makeChart],
      }),
    ],
    primary: 'backstop',
  }));
}
