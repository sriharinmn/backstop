// The site is public, so its routes must not become a free AI proxy or a toy for scripts.

import type { Db } from './db';

// Groq's free plan allows 1,000 requests a day. Stay under it, with room for the backup to be unused.
export const DAILY_AI_TURNS = 600;
export const MAX_AI_REQUEST_CHARS = 40_000;

export function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin');
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!origin || !host) return false;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function takeAiTurn(db: Db, now: Date = new Date()): Promise<boolean> {
  const day = now.toISOString().slice(0, 10);
  const [row] = await db.query<{ turns: number }>(
    `insert into llm_usage (day, turns) values ($1, 1)
     on conflict (day) do update set turns = llm_usage.turns + 1
     returning turns`,
    [day],
  );
  return row.turns <= DAILY_AI_TURNS;
}
