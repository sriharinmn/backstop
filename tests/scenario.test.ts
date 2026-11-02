import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb, type Db } from '@/lib/db';
import { listEventIds } from '@/lib/queries';
import { seedEvent, type Capturer, type SeedOptions } from '@/lib/scenario';

const options: SeedOptions = {
  name: 'Harbor Nights',
  venue: 'Pier 9 Lawn',
  startsAt: '2026-11-14T19:00:00Z',
  ticketCount: 6,
  spentCents: 1000,
  spentNote: 'Deposits.',
  vendors: [],
};

const capture = (onCall?: () => Promise<void>): Capturer => {
  let count = 0;
  return async () => {
    count += 1;
    await onCall?.();
    return { orderId: `O${count}`, captureId: `C${count}`, status: 'COMPLETED', feeCents: 100, netCents: 3400 };
  };
};

let db: Db;

beforeEach(async () => {
  db = await createMemoryDb();
});

describe('seedEvent', () => {
  it('keeps an event hidden until every ticket is sold, so nobody can cancel it halfway', async () => {
    const seenDuringSale: string[][] = [];

    const eventId = await seedEvent(
      db,
      capture(async () => {
        seenDuringSale.push(await listEventIds(db));
      }),
      options,
    );

    expect(seenDuringSale.length).toBe(6);
    expect(seenDuringSale.every((ids) => ids.length === 0)).toBe(true);
    await expect(listEventIds(db)).resolves.toEqual([eventId]);
  });

  it('leaves a failed sale hidden', async () => {
    const failing: Capturer = async () => {
      throw new Error('PayPal said no');
    };

    await expect(seedEvent(db, failing, options)).rejects.toThrow();
    await expect(listEventIds(db)).resolves.toEqual([]);
  });

  it('creates every ticket with a real capture and records the sale', async () => {
    const eventId = await seedEvent(db, capture(), options);

    const tickets = await db.query<{ paypal_capture_id: string }>('select paypal_capture_id from tickets where event_id = $1', [eventId]);
    const sales = await db.query(`select id from ledger where event_id = $1 and kind = 'ticket_sale'`, [eventId]);

    expect(tickets).toHaveLength(6);
    expect(tickets.every((t) => t.paypal_capture_id)).toBe(true);
    expect(sales).toHaveLength(6);
  });
});
