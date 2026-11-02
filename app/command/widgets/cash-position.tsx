'use client';

import { useEffect } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { usd } from '../format';
import { useSnapshot } from '../store';

// Money owed drawn as one bar: the part cash can cover, and the part it cannot.
export function CashPosition({ widgetApi }: AgWidgetParams) {
  const snapshot = useSnapshot();

  useEffect(() => {
    widgetApi.setDisplayState(snapshot ? 'displayed' : 'loading');
  }, [snapshot, widgetApi]);

  if (!snapshot) return null;

  const { cashCents, owedRefundsCents, owedVendorsCents, shortfallCents, refundedCents, paidOutCents } = snapshot.money;
  const owedCents = owedRefundsCents + owedVendorsCents;
  const settledCents = refundedCents + paidOutCents;
  const totalCents = owedCents + settledCents;

  if (totalCents === 0) {
    return (
      <div className="widget">
        <h3>What you can cover</h3>
        <p className="widget-note">Nobody has asked for money back yet.</p>
      </div>
    );
  }

  const coveredCents = Math.min(cashCents, owedCents);
  const percent = (cents: number) => `${(cents / totalCents) * 100}%`;

  return (
    <div className="widget">
      <h3>What you can cover</h3>
      <p className="widget-lead">
        {shortfallCents > 0 ? (
          <>
            Cash covers <span className="dots">{usd(coveredCents)}</span> of the{' '}
            <span className="dots">{usd(owedCents)}</span> still owed.
          </>
        ) : (
          <>Cash covers everything still owed.</>
        )}
      </p>

      <div className="cover-bar" role="img" aria-label={`${usd(settledCents)} paid, ${usd(coveredCents)} covered, ${usd(shortfallCents)} short`}>
        <span className="cover-paid" style={{ width: percent(settledCents) }} />
        <span className="cover-covered" style={{ width: percent(coveredCents) }} />
        <span className="cover-short" style={{ width: percent(shortfallCents) }} />
      </div>

      <dl className="cover-key">
        <div>
          <dt>Paid out</dt>
          <dd className="dots">{usd(settledCents)}</dd>
        </div>
        <div>
          <dt>Covered by cash</dt>
          <dd className="dots">{usd(coveredCents)}</dd>
        </div>
        <div>
          <dt>Short</dt>
          <dd className="dots">{usd(shortfallCents)}</dd>
        </div>
      </dl>
    </div>
  );
}
