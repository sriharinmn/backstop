import { getDb } from '@/lib/db';
import { route } from '@/lib/http';
import { getSnapshot, listEventIds } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request) => {
  const db = await getDb();
  const requested = new URL(request.url).searchParams.get('event');
  const eventId = requested ?? (await listEventIds(db))[0];
  return eventId ? getSnapshot(db, eventId) : null;
});
