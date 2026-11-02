import { z } from 'zod';
import { getDb } from '@/lib/db';
import { route } from '@/lib/http';
import { captureCard } from '@/lib/paypal';
import { startEvent } from '@/lib/scenario';

const body = z.object({ ticketCount: z.number().int().min(4).max(150).default(24) });

export const POST = route(async (request: Request) => {
  const { ticketCount } = body.parse(await request.json());
  const eventId = await startEvent(await getDb(), captureCard, ticketCount);
  return { eventId };
});
