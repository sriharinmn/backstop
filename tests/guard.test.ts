import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryDb, type Db } from '@/lib/db';
import { DAILY_AI_TURNS, isSameOrigin, takeAiTurn } from '@/lib/guard';

const headers = (values: Record<string, string>) => new Headers(values);

describe('isSameOrigin', () => {
  it('accepts a request from this site', () => {
    expect(isSameOrigin(headers({ origin: 'https://backstop-zeta.vercel.app', host: 'backstop-zeta.vercel.app' }))).toBe(true);
  });

  it('uses the forwarded host behind Vercel', () => {
    expect(
      isSameOrigin(
        headers({
          origin: 'https://backstop-zeta.vercel.app',
          host: 'internal.vercel.run',
          'x-forwarded-host': 'backstop-zeta.vercel.app',
        }),
      ),
    ).toBe(true);
  });

  it('accepts local development', () => {
    expect(isSameOrigin(headers({ origin: 'http://localhost:3100', host: 'localhost:3100' }))).toBe(true);
  });

  it('refuses another site', () => {
    expect(isSameOrigin(headers({ origin: 'https://evil.example', host: 'backstop-zeta.vercel.app' }))).toBe(false);
  });

  it('refuses a request with no origin, such as a script', () => {
    expect(isSameOrigin(headers({ host: 'backstop-zeta.vercel.app' }))).toBe(false);
  });

  it('refuses a malformed origin', () => {
    expect(isSameOrigin(headers({ origin: 'not a url', host: 'backstop-zeta.vercel.app' }))).toBe(false);
  });
});

describe('takeAiTurn', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createMemoryDb();
  });

  it('allows turns up to the daily cap, then refuses', async () => {
    const day = new Date('2026-11-05T10:00:00Z');
    await db.query(`insert into llm_usage (day, turns) values ('2026-11-05', $1)`, [DAILY_AI_TURNS - 1]);

    await expect(takeAiTurn(db, day)).resolves.toBe(true);
    await expect(takeAiTurn(db, day)).resolves.toBe(false);
  });

  it('starts fresh the next day', async () => {
    await db.query(`insert into llm_usage (day, turns) values ('2026-11-05', $1)`, [DAILY_AI_TURNS]);

    await expect(takeAiTurn(db, new Date('2026-11-06T00:10:00Z'))).resolves.toBe(true);
  });

  it('stays well inside the free Groq limit of 1,000 requests a day', () => {
    expect(DAILY_AI_TURNS).toBeLessThan(1000);
  });
});
