import { z } from 'zod';
import { syncDisputes } from '@/lib/chargebacks';
import { getDb } from '@/lib/db';
import { route } from '@/lib/http';
import { getDispute } from '@/lib/paypal';

const body = z.object({ eventId: z.string() });

export const POST = route(async (request: Request) => {
  const { eventId } = body.parse(await request.json());
  await syncDisputes(await getDb(), { getDispute }, eventId);
  return { synced: true };
});
