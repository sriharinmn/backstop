'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import type { Snapshot } from '@/lib/queries';
import { AgentPanel } from './agent-panel';
import { clock, plural, usd } from './format';
import { myEvent, setMyEvent, snapshotUrl } from './my-event';
import { SheetTabs } from './sheet-tabs';
import { Slip } from './slips';

const WEBHOOK_LABEL: Record<string, string> = {
  'CUSTOMER.DISPUTE.CREATED': 'a new chargeback',
  'CUSTOMER.DISPUTE.UPDATED': 'a chargeback update',
  'CUSTOMER.DISPUTE.RESOLVED': 'a closed chargeback',
  'PAYMENT.CAPTURE.REFUNDED': 'a refund',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED': 'a payout waiting to be claimed',
  'PAYMENT.PAYOUTSBATCH.SUCCESS': 'a finished payout',
};

// AG Studio only runs in the browser.
const StudioSheet = dynamic(() => import('./studio-sheet'), { ssr: false });

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'That did not work.');
  return json as T;
}

export function CommandCenter({ licenseKey }: { licenseKey?: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Slips the organizer is acting on stay on the rail until their stamp has landed.
  const [acting, setActing] = useState<ReadonlySet<string>>(new Set());

  const refresh = useCallback(async () => {
    const asked = myEvent();
    const res = await fetch(snapshotUrl(asked), { cache: 'no-store' });
    const next = res.ok ? ((await res.json()) as Snapshot | null) : undefined;
    // The visitor may have cancelled or moved on while this was in flight.
    if (asked !== myEvent()) return;
    if (next !== undefined) setSnapshot(next);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Chargebacks move on PayPal's side. Keep open cases in step while this screen is open.
  const eventId = snapshot?.event.id;
  const hasOpenDisputes = snapshot?.disputes.some((d) => d.status !== 'RESOLVED') ?? false;

  useEffect(() => {
    if (!eventId || !hasOpenDisputes) return;
    const sync = () => {
      void post('/api/disputes/sync', { eventId }).catch(() => undefined);
    };
    sync();
    const timer = window.setInterval(sync, 20000);
    return () => window.clearInterval(timer);
  }, [eventId, hasOpenDisputes]);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) return <main className="empty-sheet" aria-busy="true" />;

  if (!snapshot) {
    return (
      <main className="empty-sheet">
        <h2>Nothing is on sale yet</h2>
        <p>
          This sells 24 tickets to a demo concert through the PayPal sandbox, so every payment and refund after it is
          real sandbox money. It takes about 20 seconds.
        </p>
        <button
          type="button"
          className="button"
          disabled={busy !== null}
          onClick={() => run('seed', () => post('/api/scenario', { ticketCount: 24 }))}
        >
          {busy ? 'Selling tickets' : 'Sell the tickets'}
        </button>
        {error && <p className="slip-error">{error}</p>}
      </main>
    );
  }

  const { event, money, proposals, tickets, vendors, lastWebhook } = snapshot;
  const cancelled = event.status === 'cancelled';
  // Oldest first, so the first thing drafted is the first thing the organizer sees.
  const pending = proposals
    .filter((p) => p.status === 'pending' || p.status === 'executing' || acting.has(p.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const filed = proposals.filter((p) => ['done', 'failed', 'rejected'].includes(p.status) && !acting.has(p.id));
  const wantRefund = tickets.filter((t) => t.status === 'refund_requested' || t.status === 'refund_failed');
  const unpaidVendors = vendors.filter((v) => v.status !== 'paid');
  // Someone who has not replied and has no chargeback, so the page still offers the choice.
  const disputedIds = new Set(snapshot.disputes.map((d) => d.ticketId));
  const sampleTicket = tickets.find((t) => t.status === 'paid' && !disputedIds.has(t.id)) ?? tickets[0];

  const cancelThisEvent = () =>
    run('cancel', async () => {
      // Claimed first, so a refresh mid-cancel stays here instead of moving to an untouched event.
      setMyEvent(event.id);
      const { taken } = await post<{ taken?: boolean }>('/api/scenario/cancel', { eventId: event.id });
      if (taken) {
        setMyEvent(null);
        void refresh();
        throw new Error('Someone else cancelled that event first, so it is theirs now.');
      }
    });

  const startNewEvent = () =>
    run('storm', async () => {
      await post('/api/scenario', { ticketCount: 24 });
      setMyEvent(null);
    });

  const draftRefunds = () =>
    run('refunds', () =>
      post('/api/proposals', {
        eventId: event.id,
        kind: 'refund_batch',
        targetIds: wantRefund.map((t) => t.id),
        reason: 'The event is cancelled and these attendees asked for their money back.',
      }),
    );

  const draftVendors = () =>
    run('vendors', () =>
      post('/api/proposals', {
        eventId: event.id,
        kind: 'vendor_payout',
        targetIds: unpaidVendors.map((v) => v.id),
        reason: 'These vendors are owed for work already booked.',
      }),
    );

  return (
    <main className="command">
      <header className="form-head">
        <div className="form-title">
          <h1>{event.name}</h1>
          <p>
            {event.venue}.{' '}
            {cancelled ? `Cancelled at ${clock(event.cancelledAt)}.` : `On sale, ${plural(tickets.length, 'ticket')} sold.`}
          </p>
          <div className="actions">
            {!cancelled && (
              <button type="button" className="button" disabled={busy !== null} onClick={cancelThisEvent}>
                {busy === 'cancel' ? 'Cancelling' : 'Cancel the event'}
              </button>
            )}
            {cancelled && (
              <button type="button" className="button-quiet" disabled={busy !== null} onClick={startNewEvent}>
                {busy === 'storm' ? 'Selling 24 tickets through PayPal' : 'Start a new event'}
              </button>
            )}
          </div>
        </div>
        <div className="fields">
          <div className="field">
            <span>Owed to attendees</span>
            <strong className="dots">{usd(money.owedRefundsCents)}</strong>
          </div>
          <div className="field">
            <span>Owed to vendors</span>
            <strong className="dots">{usd(money.owedVendorsCents)}</strong>
          </div>
          <div className="field">
            <span>Cash you can use</span>
            <strong className="dots">{usd(money.cashCents)}</strong>
          </div>
          <div className="field" data-short={money.shortfallCents > 0}>
            <span>Short by</span>
            <strong className="dots">{usd(money.shortfallCents)}</strong>
          </div>
        </div>
        {cancelled && (
          <p className="banner">
            <span>
              Attendee replies here are simulated for the demo. All money is real PayPal sandbox money.{' '}
              {sampleTicket && (
                <a href={`/t/${sampleTicket.token}`} target="_blank" rel="noreferrer">
                  See what an attendee sees
                </a>
              )}
            </span>
            {lastWebhook && (
              <span>
                PayPal last reported {WEBHOOK_LABEL[lastWebhook.type] ?? 'an update'} at {clock(lastWebhook.receivedAt)}
                {lastWebhook.verified ? ', signature verified' : ', signature not verified'}.
              </span>
            )}
          </p>
        )}
      </header>

      <section className="sheet" aria-label="Event dashboard">
        <SheetTabs key={event.id} />
        <div className="studio-sheet">
          <StudioSheet key={event.id} snapshot={snapshot} licenseKey={licenseKey} />
        </div>
      </section>

      <aside className="rail" aria-label="Slips waiting for your approval">
        <header className="rail-head">
          <h2>Waiting for your approval</h2>
          <p>Nothing moves until you approve it.</p>
        </header>
        <div className="rail-body">
          {cancelled && <AgentPanel />}

          {pending.map((proposal) => (
            <Slip
              key={proposal.id}
              proposal={proposal}
              onStart={(id) => setActing((current) => new Set(current).add(id))}
              onSettled={(id) => {
                setActing((current) => {
                  const next = new Set(current);
                  next.delete(id);
                  return next;
                });
                void refresh();
              }}
            />
          ))}

          {pending.length === 0 && (
            <div className="rail-empty">
              <p>{cancelled ? 'No slips yet. Draft one below.' : 'Slips appear here after a cancellation.'}</p>
            </div>
          )}

          {cancelled && pending.length === 0 && (
            <div>
              <button
                type="button"
                className="button-quiet"
                disabled={busy !== null || wantRefund.length === 0}
                onClick={draftRefunds}
              >
                Draft refunds for {plural(wantRefund.length, 'attendee')}
              </button>
              <button
                type="button"
                className="button-quiet"
                disabled={busy !== null || unpaidVendors.length === 0}
                onClick={draftVendors}
              >
                Draft payment for {plural(unpaidVendors.length, 'vendor')}
              </button>
            </div>
          )}

          {error && <p className="slip-error">{error}</p>}

          {filed.length > 0 && (
            <section className="filed" aria-label="Filed slips">
              <h3>Filed</h3>
              <ul>
                {filed.map((proposal) => (
                  <li key={proposal.id}>
                    <span>
                      {proposal.kind === 'vendor_payout' ? 'Vendors' : proposal.kind === 'refund_batch' ? 'Refunds' : 'Chargeback'}
                    </span>
                    <span className="dots">{usd(proposal.amountCents)}</span>
                    <span className="filed-state" data-state={proposal.status}>
                      {proposal.status === 'done'
                        ? proposal.kind === 'chargeback_response'
                          ? 'Filed'
                          : 'Paid'
                        : proposal.status === 'failed'
                          ? 'Failed'
                          : 'Rejected'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </aside>
    </main>
  );
}
