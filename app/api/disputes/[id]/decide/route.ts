import { z } from 'zod';
import { applyDispute } from '@/lib/chargebacks';
import { getDb } from '@/lib/db';
import { route } from '@/lib/http';
import { adjudicate, getDispute } from '@/lib/paypal';
import { getDisputes } from '@/lib/queries';

const body = z.object({ eventId: z.string() });

// Sandbox only. In production PayPal makes this decision itself, on its own timeline.
export const POST = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const { eventId } = body.parse(await request.json());
  const db = await getDb();

  const row = (await getDisputes(db, eventId)).find((d) => d.id === id);
  if (!row) throw new Error('No such chargeback.');

  await adjudicate(row.paypalDisputeId, 'SELLER_FAVOR');
  await applyDispute(db, row, await getDispute(row.paypalDisputeId));
  return { decided: true };
});
