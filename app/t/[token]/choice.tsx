'use client';

import { useState } from 'react';
import type { TicketStatus } from '@/lib/gate';
import { serial, usd } from '@/app/command/format';

type ChoiceProps = {
  token: string;
  eventName: string;
  venue: string;
  cancelled: boolean;
  attendee: string;
  amountCents: number;
  status: TicketStatus;
};

const SETTLED: Partial<Record<TicketStatus, (amount: string) => string>> = {
  refund_requested: (amount) => `You asked for your ${amount} back. The organizer is working through refunds now, and PayPal will show it when it lands.`,
  refunded: (amount) => `Your ${amount} has been refunded through PayPal.`,
  transferred: () => 'Your ticket is good for the new date. There is nothing else you need to do.',
};

export function Choice({ token, eventName, venue, cancelled, attendee, amountCents, status }: ChoiceProps) {
  const [current, setCurrent] = useState(status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = usd(amountCents);
  const settled = SETTLED[current];

  async function choose(choice: 'refund' | 'transfer') {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/tickets/${token}/choice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice }),
    });
    setBusy(false);
    if (!res.ok) {
      const json = (await res.json()) as { error?: string };
      setError(json.error ?? 'That did not go through. Try again.');
      return;
    }
    setCurrent(choice === 'refund' ? 'refund_requested' : 'transferred');
  }

  return (
    <article className="stub">
      <header className="stub-head">
        <p className="dots stub-serial">{serial(token)}</p>
        <h1>{eventName}</h1>
        <p>{venue}</p>
      </header>

      <div className="stub-body">
        <p className="stub-name">{attendee}</p>
        <p className="dots stub-amount">{amount}</p>

        {!cancelled && <p>This event is still on. Your ticket is valid.</p>}

        {cancelled && settled && <p>{settled(amount)}</p>}

        {cancelled && !settled && (
          <>
            <p>This event is cancelled because of the storm warning. Your money is safe. Choose what you want to happen.</p>
            <div className="stub-actions">
              <button type="button" className="button" disabled={busy} onClick={() => choose('refund')}>
                Refund my {amount}
              </button>
              <button type="button" className="button button-outline" disabled={busy} onClick={() => choose('transfer')}>
                Keep my ticket for the new date
              </button>
            </div>
            {error && <p className="slip-error">{error}</p>}
          </>
        )}
      </div>
    </article>
  );
}
