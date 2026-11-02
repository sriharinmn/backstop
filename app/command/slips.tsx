'use client';

import { useState } from 'react';
import type { ProposalRow } from '@/lib/queries';
import { plural, serial, usd } from './format';

const TITLES: Record<ProposalRow['kind'], string> = {
  refund_batch: 'Refund attendees',
  vendor_payout: 'Pay vendors',
  chargeback_response: 'Answer chargeback',
};

const NOUNS: Record<ProposalRow['kind'], string> = {
  refund_batch: 'attendee',
  vendor_payout: 'vendor',
  chargeback_response: 'case',
};

const VERBS: Record<ProposalRow['kind'], string> = {
  refund_batch: 'Approve refunds',
  vendor_payout: 'Approve payment',
  chargeback_response: 'Approve response',
};

const STAMPS: Record<ProposalRow['kind'], string> = {
  refund_batch: 'PAID',
  vendor_payout: 'PAID',
  chargeback_response: 'FILED',
};

type Evidence = {
  held?: { id: string }[];
  blocked?: { id: string; reason: string }[];
  action?: 'accept' | 'contest';
  notes?: string;
};

type SlipProps = {
  proposal: ProposalRow;
  onStart: (id: string) => void;
  onSettled: (id: string) => void;
};

export function Slip({ proposal, onStart, onSettled }: SlipProps) {
  const [acting, setActing] = useState(false);
  const [stamped, setStamped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = acting || proposal.status === 'executing';
  const evidence = proposal.evidence as Evidence;
  const heldCount = evidence.held?.length ?? 0;
  const blockedCount = evidence.blocked?.length ?? 0;

  async function decide(action: 'approve' | 'reject') {
    setActing(true);
    setError(null);
    onStart(proposal.id);

    const res = await fetch(`/api/proposals/${proposal.id}/${action}`, { method: 'POST' });
    const json = (await res.json()) as { error?: string; status?: string };

    if (!res.ok) {
      setActing(false);
      setError(json.error ?? 'PayPal did not accept this. Nothing was moved.');
      return;
    }
    if (action === 'approve' && json.status === 'done') {
      setStamped(true);
      window.setTimeout(() => onSettled(proposal.id), 1400);
    } else {
      onSettled(proposal.id);
    }
  }

  return (
    <article className="slip" aria-busy={busy}>
      <header className="slip-top">
        <h3>
          {proposal.kind === 'chargeback_response'
            ? evidence.action === 'contest'
              ? 'Contest chargeback'
              : 'Accept chargeback'
            : TITLES[proposal.kind]}
        </h3>
        <span className="slip-serial dots">{serial(proposal.id)}</span>
      </header>

      <p className="slip-amount dots">{usd(proposal.amountCents)}</p>
      <p className="slip-count">To {plural(proposal.targetIds.length, NOUNS[proposal.kind])}</p>

      <p className="slip-reason">{proposal.reason}</p>
      {proposal.kind === 'chargeback_response' && evidence.notes && (
        <p className="slip-evidence">Sent to PayPal: {evidence.notes}</p>
      )}
      <p className="slip-author">Drafted by {proposal.createdBy === 'backstop' ? 'the agent' : 'you'}</p>

      {heldCount + blockedCount > 0 && (
        <div className="slip-held">
          {heldCount > 0 && <p>{plural(heldCount, 'refund')} held back: not enough cash yet.</p>}
          {blockedCount > 0 && <p>{plural(blockedCount, 'ticket')} left out: {evidence.blocked?.[0].reason}</p>}
        </div>
      )}

      {error && <p className="slip-error">{error}</p>}

      <div className="slip-actions">
        <button type="button" className="button" disabled={busy} onClick={() => decide('approve')}>
          {busy && !stamped ? 'Sending to PayPal' : VERBS[proposal.kind]}
        </button>
        <button type="button" className="button-quiet" disabled={busy} onClick={() => decide('reject')}>
          Reject
        </button>
      </div>

      {stamped && <div className="stamp">{STAMPS[proposal.kind]}</div>}
    </article>
  );
}
