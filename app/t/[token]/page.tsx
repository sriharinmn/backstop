import { notFound } from 'next/navigation';
import { getDb } from '@/lib/db';
import { getEvent, getTicketByToken } from '@/lib/queries';
import { Choice } from './choice';

export const dynamic = 'force-dynamic';

export default async function TicketPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = await getDb();
  const ticket = await getTicketByToken(db, token);
  if (!ticket) notFound();
  const event = await getEvent(db, ticket.eventId);

  return (
    <main className="stub-page">
      <Choice
        token={token}
        eventName={event.name}
        venue={event.venue}
        cancelled={event.status === 'cancelled'}
        attendee={ticket.attendeeName}
        amountCents={ticket.amountCents}
        status={ticket.status}
      />
    </main>
  );
}
