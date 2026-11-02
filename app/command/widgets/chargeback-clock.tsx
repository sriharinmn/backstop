'use client';

import { useEffect, useState } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { usd } from '../format';
import { useSnapshot } from '../store';

const STATUS: Record<string, string> = {
  OPEN: 'New. PayPal is gathering details.',
  UNDER_REVIEW: 'With PayPal',
  WAITING_FOR_SELLER_RESPONSE: 'Needs your answer',
  WAITING_FOR_BUYER_RESPONSE: 'Waiting on the attendee',
  RESOLVED: 'Closed',
};

const OUTCOME: Record<string, string> = {
  RESOLVED_BUYER_FAVOUR: 'Closed in the attendee\'s favor',
  RESOLVED_SELLER_FAVOUR: 'Closed in your favor',
  RESOLVED_WITH_PAYOUT: 'Closed. PayPal paid the attendee back.',
  ACCEPTED: 'Closed. You accepted.',
};

function daysLeft(dueAt: string | null) {
  if (!dueAt) return null;
  return Math.ceil((new Date(dueAt).getTime() - Date.now()) / 86_400_000);
}

async function send(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'That did not work.');
}

export function ChargebackClock({ widgetApi }: AgWidgetParams) {
  const snapshot = useSnapshot();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    widgetApi.setDisplayState(snapshot ? 'displayed' : 'loading');
  }, [snapshot, widgetApi]);

  if (!snapshot) return null;

  const names = new Map(snapshot.tickets.map((t) => [t.id, t.attendeeName]));
  const eventId = snapshot.event.id;
  const drafted = new Set(
    snapshot.proposals
      .filter((p) => p.kind === 'chargeback_response' && ['pending', 'executing', 'done'].includes(p.status))
      .flatMap((p) => p.targetIds),
  );

  async function act(id: string, url: string) {
    setBusy(id);
    setError(null);
    try {
      await send(url, { eventId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="widget">
      <h3>Chargebacks</h3>
      {error && <p className="slip-error">{error}</p>}
      {snapshot.disputes.length === 0 ? (
        <p className="widget-note">No chargebacks. Refunding quickly is what keeps it that way.</p>
      ) : (
        <ul className="clock-list">
          {snapshot.disputes.map((dispute) => {
            const days = daysLeft(dispute.dueAt);
            const resolved = dispute.status === 'RESOLVED';
            return (
              <li key={dispute.id} data-urgent={!resolved && days !== null && days <= 3}>
                <span className="clock-days dots">{resolved || days === null ? '--' : `${days}d`}</span>
                <span>
                  <strong>{dispute.ticketId ? names.get(dispute.ticketId) : 'Unknown ticket'}</strong>
                  <small>
                    {resolved
                      ? (OUTCOME[dispute.outcome ?? ''] ?? 'Closed')
                      : (STATUS[dispute.status] ?? dispute.status)}
                  </small>
                </span>
                <span className="clock-amount dots">{usd(dispute.amountCents)}</span>

                {!resolved && (
                  <span className="clock-actions">
                    {!drafted.has(dispute.id) &&
                      (dispute.actions.includes('accept_claim') || dispute.actions.includes('provide_evidence')) && (
                        <button
                          type="button"
                          className="link-button"
                          disabled={busy !== null}
                          onClick={() => act(dispute.id, `/api/disputes/${dispute.id}/draft`)}
                        >
                          Draft an answer
                        </button>
                      )}
                    {dispute.actions.includes('adjudicate') && (
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy !== null}
                        onClick={() => act(dispute.id, `/api/disputes/${dispute.id}/decide`)}
                      >
                        Ask PayPal to decide (sandbox only)
                      </button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
