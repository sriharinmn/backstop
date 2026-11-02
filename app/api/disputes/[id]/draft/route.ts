import { z } from 'zod';
import { recommendResponse } from '@/lib/chargebacks';
import { getDb } from '@/lib/db';
import { route } from '@/lib/http';
import { createProposal } from '@/lib/proposals';
import { getDisputes, getTickets } from '@/lib/queries';

const body = z.object({
  eventId: z.string(),
  createdBy: z.string().default('organizer'),
  note: z.string().max(1500).optional(),
});

export const POST = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const { eventId, createdBy, note } = body.parse(await request.json());
  const db = await getDb();

  const dispute = (await getDisputes(db, eventId)).find((d) => d.id === id);
  if (!dispute) throw new Error('No such chargeback.');
  const ticket = (await getTickets(db, eventId)).find((t) => t.id === dispute.ticketId);
  if (!ticket) throw new Error('This chargeback is not linked to a ticket.');

  // The rule decides accept or contest. The agent may improve the wording, never the decision.
  const advice = recommendResponse(ticket);

  return createProposal(db, {
    eventId,
    kind: 'chargeback_response',
    targetIds: [id],
    reason: advice.why,
    evidence: { action: advice.action, notes: note ?? advice.notes },
    createdBy,
  });
});
