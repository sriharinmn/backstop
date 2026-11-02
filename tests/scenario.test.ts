import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb, type Db } from '@/lib/db';
import { freshEventIds } from '@/lib/queries';
import { cancelEvent, keepSpareEvents, seedEvent, SPARE_EVENTS, startEvent, type Capturer, type SeedOptions } from '@/lib/scenario';

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
        seenDuringSale.push(await freshEventIds(db));
      }),
      options,
    );

    expect(seenDuringSale.length).toBe(6);
    expect(seenDuringSale.every((ids) => ids.length === 0)).toBe(true);
    await expect(freshEventIds(db)).resolves.toEqual([eventId]);
  });

  it('leaves a failed sale hidden', async () => {
    const failing: Capturer = async () => {
      throw new Error('PayPal said no');
    };

    await expect(seedEvent(db, failing, options)).rejects.toThrow();
    await expect(freshEventIds(db)).resolves.toEqual([]);
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

describe('who gets which event', () => {
  const eventCount = async () => (await db.query('select id from events')).length;
  const notes =(eventId: string) => db.query(`select id from ledger where event_id = $1 and kind = 'note'`, [eventId]);

  it('lands a new visitor on the newest event nobody has cancelled', async () => {
    const older = await seedEvent(db, capture(), { ...options, startsAt: '2026-11-14T19:00:00Z' });
    const newer = await seedEvent(db, capture(), { ...options, startsAt: '2026-11-15T19:00:00Z' });

    await expect(freshEventIds(db)).resolves.toEqual([newer, older]);

    await cancelEvent(db, newer, 'Storm.');
    await expect(freshEventIds(db)).resolves.toEqual([older]);

    await cancelEvent(db, older, 'Storm.');
    await expect(freshEventIds(db)).resolves.toEqual([]);
  });

  it('lets only the first visitor cancel an event, so a second click cannot raise more chargebacks', async () => {
    const eventId = await seedEvent(db, capture(), options);

    await expect(cancelEvent(db, eventId, 'Storm.')).resolves.toBe(true);
    await expect(cancelEvent(db, eventId, 'Storm.')).resolves.toBe(false);

    expect(await notes(eventId)).toHaveLength(1);
  });

  it('hands over a waiting event instead of selling another one', async () => {
    const waiting = await seedEvent(db, capture(), options);

    await expect(startEvent(db, capture())).resolves.toBe(waiting);
    expect(await eventCount()).toBe(1);
  });

  it('sells a new event when none is waiting', async () => {
    const used = await seedEvent(db, capture(), options);
    await cancelEvent(db, used, 'Storm.');

    const started = await startEvent(db, capture());

    expect(started).not.toBe(used);
    await expect(freshEventIds(db)).resolves.toEqual([started]);
  });

  it('sells a new event for a custom size, since a waiting one has the wrong number of tickets', async () => {
    const waiting = await seedEvent(db, capture(), options);

    const started = await startEvent(db, capture(), 6);

    expect(started).not.toBe(waiting);
    expect(await db.query('select id from tickets where event_id = $1', [started])).toHaveLength(6);
  });

  it('tops up the waiting events after one is taken', async () => {
    const used = await seedEvent(db, capture(), options);
    await cancelEvent(db, used, 'Storm.');

    await keepSpareEvents(db, capture());

    await expect(freshEventIds(db)).resolves.toHaveLength(SPARE_EVENTS);
  });

  it('sells nothing when enough events are already waiting', async () => {
    for (let i = 0; i < SPARE_EVENTS; i += 1) await seedEvent(db, capture(), options);

    await keepSpareEvents(db, capture());

    expect(await eventCount()).toBe(SPARE_EVENTS);
  });
});
