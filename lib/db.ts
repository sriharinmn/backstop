// One query interface over two databases: PGlite locally, Neon when DATABASE_URL is set.

import { mkdirSync } from 'node:fs';
import type { PGlite } from '@electric-sql/pglite';
import { neon } from '@neondatabase/serverless';
import { SCHEMA } from './schema';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  migrate(): Promise<void>;
}

function wrapPglite(pg: PGlite): Db {
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await pg.query<T>(sql, params);
      return result.rows;
    },
    async migrate() {
      for (const statement of SCHEMA) await pg.query(statement);
    },
  };
  return db;
}

function wrapNeon(url: string): Db {
  const client = neon(url);
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      return (await client.query(sql, params)) as T[];
    },
    async migrate() {
      for (const statement of SCHEMA) await client.query(statement);
    },
  };
  return db;
}

// Loaded only when needed, so a hosted build on Neon never pulls in PGlite's WASM.
async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite: Engine } = await import('@electric-sql/pglite');
  return wrapPglite(new Engine(dataDir));
}

export async function createMemoryDb(): Promise<Db> {
  const db = await openPglite();
  await db.migrate();
  return db;
}

// Survives hot reloads in development, so PGlite opens its data folder only once.
const holder = globalThis as unknown as { backstopDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  holder.backstopDb ??= (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) mkdirSync('.data', { recursive: true });
    const db = url ? wrapNeon(url) : await openPglite('.data/pglite');
    await db.migrate();
    return db;
  })().catch((error) => {
    // A failed start must not be remembered, or every later request would fail too.
    holder.backstopDb = undefined;
    throw error;
  });
  return holder.backstopDb;
}
