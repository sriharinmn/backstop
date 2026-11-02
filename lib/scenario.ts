// Builds an event out of real sandbox captures, then cancels it.
// Attendee names are invented. The money is real sandbox money.

import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db';
import type { Capture } from './paypal';

export type Capturer = (input: {
  amountCents: number;
  description: string;
  customId: string;
  name: string;
  requestId: string;
}) => Promise<Capture>;

export type VendorSeed = { name: string; role: string; email: string; owedCents: number };

export type SeedOptions = {
  name: string;
  venue: string;
  startsAt: string;
  ticketCount: number;
  spentCents: number;
  spentNote: string;
  vendors: VendorSeed[];
};

const FIRST = [
  'Maya', 'Tomas', 'Priya', 'Owen', 'Lucia', 'Dev', 'Hannah', 'Kofi', 'Ines', 'Sam',
  'Nora', 'Rafael', 'Aiko', 'Ben', 'Zara', 'Leo', 'Farah', 'Jonah', 'Elena', 'Marcus',
];
const LAST = [
  'Okafor', 'Lindqvist', 'Rao', 'Brennan', 'Marin', 'Shah', 'Keller', 'Mensah', 'Duarte', 'Whitlock',
  'Haddad', 'Sato', 'Novak', 'Reyes', 'Abara', 'Moreau',
];

// General admission, a family pass and a front-of-stage ticket, in a realistic mix.
const PRICES = [3500, 3500, 3500, 3500, 3500, 6000, 6000, 9500];

const pick = <T,>(list: T[], index: number) => list[index % list.length];

export function attendee(index: number) {
  const first = pick(FIRST, index);
  const last = pick(LAST, index * 7 + 3);
  return {
    name: `${first} ${last}`,
    email: `${first}.${last}.${index}@example.com`.toLowerCase(),
    amountCents: pick(PRICES, index * 3 + 1),
  };
}

const token = (eventId: string, index: number) =>
  createHash('sha256').update(`${eventId}:${index}`).digest('hex').slice(0, 16);

export const DEFAULT_VENDORS: VendorSeed[] = [
  { name: 'Tidewater Sound & Light', role: 'Sound and lighting', email: 'tidewater.sound@example.com', owedCents: 42000 },
  { name: 'Pier 9 Stage Crew', role: 'Stage crew', email: 'crew.pier9@example.com', owedCents: 28500 },
  { name: 'Lantern Street Food Co-op', role: 'Food vendors', email: 'lantern.coop@example.com', owedCents: 15000 },
];

export async function seedEvent(db: Db, capture: Capturer, options: SeedOptions): Promise<string> {
  const eventId = randomUUID();

  await db.query(
    `insert into events (id, name, venue, starts_at, status, policy, ready) values ($1, $2, $3, $4, 'on_sale', $5, false)`,
    [
      eventId,
      options.name,
      options.venue,
      options.startsAt,
      JSON.stringify({ spentCents: options.spentCents, spentNote: options.spentNote }),
    ],
  );

  for (const [index, vendor] of options.vendors.entries()) {
    await db.query(
      `insert into vendors (id, event_id, name, role, paypal_email, owed_cents, status)
       values ($1, $2, $3, $4, $5, $6, 'owed')`,
      [`${eventId}-v${index}`, eventId, vendor.name, vendor.role, vendor.email, vendor.owedCents],
    );
  }

  const indexes = Array.from({ length: options.ticketCount }, (_, i) => i);
  for (let i = 0; i < indexes.length; i += 4) {
    await Promise.all(
      indexes.slice(i, i + 4).map(async (index) => {
        const person = attendee(index);
        const ticketId = `${eventId}-t${index}`;
        const result = await capture({
          amountCents: person.amountCents,
          description: `${options.name}: ticket ${index + 1}`,
          customId: ticketId.slice(0, 127),
          name: person.name,
          requestId: createHash('sha256').update(ticketId).digest('hex').slice(0, 36),
        });
        await db.query(
          `insert into tickets (id, event_id, attendee_name, attendee_email, amount_cents, paypal_order_id, paypal_capture_id, status, token)
           values ($1, $2, $3, $4, $5, $6, $7, 'paid', $8)`,
          [ticketId, eventId, person.name, person.email, person.amountCents, result.orderId, result.captureId, token(eventId, index)],
        );
        await db.query(
          `insert into ledger (id, event_id, kind, amount_cents, paypal_ref, reason, at)
           values ($1, $2, 'ticket_sale', $3, $4, $5, $6)`,
          [randomUUID(), eventId, result.netCents, result.captureId, `Ticket sold to ${person.name}`, new Date().toISOString()],
        );
      }),
    );
  }

  // Only now does the event appear, so nobody can act on a half-sold event.
  await db.query('update events set ready = true where id = $1', [eventId]);
  return eventId;
}

export async function cancelEvent(db: Db, eventId: string, reason: string): Promise<void> {
  const at = new Date().toISOString();
  await db.query(`update events set status = 'cancelled', cancelled_at = $2 where id = $1`, [eventId, at]);
  await db.query(
    `insert into ledger (id, event_id, kind, amount_cents, reason, at) values ($1, $2, 'note', 0, $3, $4)`,
    [randomUUID(), eventId, reason, at],
  );
}

export type AttendeeChoice = 'refund' | 'transfer';

export async function recordChoice(db: Db, ticketToken: string, choice: AttendeeChoice): Promise<boolean> {
  const status = choice === 'refund' ? 'refund_requested' : 'transferred';
  const updated = await db.query(
    `update tickets set status = $2, requested_at = $3
     where token = $1 and status in ('paid', 'refund_requested', 'transfer_requested') returning id`,
    [ticketToken, status, new Date().toISOString()],
  );
  return updated.length > 0;
}

// Attendees' replies in the demo are simulated, and the screen says so.
// Roughly seven in ten ask for a refund and one in five move to the new date. The rest stay quiet.
export async function simulateReplies(db: Db, eventId: string): Promise<number> {
  const tickets = await db.query<{ id: string }>(`select id from tickets where event_id = $1 and status = 'paid' order by id`, [
    eventId,
  ]);
  const start = Date.now();
  let replies = 0;

  for (const [index, ticket] of tickets.entries()) {
    const roll = (index * 37 + 11) % 100;
    if (roll >= 90) continue;

    const refund = roll < 70;
    // Replies come fastest right after the announcement and tail off.
    const minutes = Math.round(((roll % 70) / 70) ** 2 * 90);
    await db.query(`update tickets set status = $2, requested_at = $3 where id = $1`, [
      ticket.id,
      refund ? 'refund_requested' : 'transferred',
      new Date(start + minutes * 60_000).toISOString(),
    ]);
    replies += 1;
  }
  return replies;
}
