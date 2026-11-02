import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '@/lib/db';

describe('db', () => {
  it('migrates and round-trips a row', async () => {
    const db = await createMemoryDb();
    await db.query(
      `insert into events (id, name, venue, starts_at, status, policy)
       values ($1, $2, $3, $4, $5, $6)`,
      ['e1', 'Harbor Nights', 'Pier 9', '2026-11-14T19:00:00Z', 'on_sale', JSON.stringify({ refundWindowDays: 30 })],
    );

    const rows = await db.query<{ name: string; status: string }>('select name, status from events where id = $1', ['e1']);

    expect(rows).toEqual([{ name: 'Harbor Nights', status: 'on_sale' }]);
  });

  it('can migrate twice without error', async () => {
    const db = await createMemoryDb();
    await expect(db.migrate()).resolves.toBeUndefined();
  });

  it('rejects a ticket for an unknown event', async () => {
    const db = await createMemoryDb();
    await expect(
      db.query(
        `insert into tickets (id, event_id, attendee_name, attendee_email, amount_cents, status, token)
         values ('t1', 'missing', 'A', 'a@example.com', 2500, 'paid', 'tok')`,
      ),
    ).rejects.toThrow();
  });
});
