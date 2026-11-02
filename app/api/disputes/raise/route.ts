import { z } from 'zod';
import { raiseChargeback } from '@/lib/chargebacks';
import { getDb } from '@/lib/db';
import { route } from '@/lib/http';
import { acceptClaim, createChargeback, getDispute, provideEvidence } from '@/lib/paypal';

const body = z.object({ ticketId: z.string() });

// Sandbox only. Stands in for an attendee going to their card company.
export const POST = route(async (request: Request) => {
  const { ticketId } = body.parse(await request.json());
  const id = await raiseChargeback(
    await getDb(),
    { createChargeback, getDispute, provideEvidence, acceptClaim },
    ticketId,
  );
  return { id };
});
