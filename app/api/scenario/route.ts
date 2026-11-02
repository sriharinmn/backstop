import { z } from 'zod';
import { getDb } from '@/lib/db';
import { route } from '@/lib/http';
import { captureCard } from '@/lib/paypal';
import { DEFAULT_VENDORS, seedEvent } from '@/lib/scenario';

const body = z.object({ ticketCount: z.number().int().min(4).max(150).default(24) });

export const POST = route(async (request: Request) => {
  const { ticketCount } = body.parse(await request.json());
  const db = await getDb();

  // Most of the ticket money has already gone on deposits, which is why cancelling hurts.
  const averageTicketCents = 4700;
  const spentCents = Math.round(ticketCount * averageTicketCents * 0.55);

  const eventId = await seedEvent(db, captureCard, {
    name: 'Harbor Nights',
    venue: 'Pier 9 Lawn',
    startsAt: new Date(Date.now() + 13 * 3_600_000).toISOString(),
    ticketCount,
    spentCents,
    spentNote: 'Venue and marquee deposits, paid in advance and not yet recovered.',
    vendors: DEFAULT_VENDORS.map((vendor) => ({
      ...vendor,
      owedCents: Math.round((vendor.owedCents * ticketCount) / 120),
    })),
  });

  return { eventId };
});
