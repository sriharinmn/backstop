import { z } from 'zod';
import { raiseChargeback } from '@/lib/chargebacks';
import { getDb } from '@/lib/db';
import { route } from '@/lib/http';
import { acceptClaim, createChargeback, getDispute, provideEvidence } from '@/lib/paypal';
import { getTickets } from '@/lib/queries';
import { cancelEvent, simulateReplies } from '@/lib/scenario';

const body = z.object({ eventId: z.string(), reason: z.string().default('Severe storm warning for the venue.') });

export const POST = route(async (request: Request) => {
  const { eventId, reason } = body.parse(await request.json());
  const db = await getDb();
  await cancelEvent(db, eventId, reason);
  const replies = await simulateReplies(db, eventId);

  // Some people go straight to their card company. One who moved to the new date, and one who never replied.
  const tickets = await getTickets(db, eventId);
  const targets = [tickets.find((t) => t.status === 'transferred'), tickets.find((t) => t.status === 'paid')];
  const payments = { createChargeback, getDispute, provideEvidence, acceptClaim };
  let chargebacks = 0;
  for (const ticket of targets) {
    if (!ticket) continue;
    await raiseChargeback(db, payments, ticket.id);
    chargebacks += 1;
  }
  return { replies, chargebacks };
});
