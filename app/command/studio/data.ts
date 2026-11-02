import type { AgDataSourcesDefinition } from 'ag-studio';
import type { Snapshot } from '@/lib/queries';

const STATUS_LABEL: Record<string, string> = {
  paid: 'No reply yet',
  refund_requested: 'Wants a refund',
  transfer_requested: 'Wants the new date',
  refunded: 'Refunded',
  transferred: 'Moved to new date',
  refund_failed: 'Refund failed',
};

const dollars = (cents: number) => cents / 100;

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';

const money = {
  format: 'currencyFormat' as const,
  formatOptions: { format: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }) },
};

// Requests per ten minutes after the cancellation. This is the wave the organizer watches.
function refundWave(snapshot: Snapshot) {
  const start = new Date(snapshot.event.cancelledAt ?? 0).getTime();
  const buckets = new Map<number, number>();

  for (const ticket of snapshot.tickets) {
    if (!ticket.requestedAt) continue;
    const minutes = Math.max(0, (new Date(ticket.requestedAt).getTime() - start) / 60_000);
    const bucket = Math.floor(minutes / 10) * 10;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }

  const last = Math.max(0, ...buckets.keys());
  const rows = [];
  for (let minute = 0; minute <= last; minute += 10) {
    rows.push({ after: `${minute}m`, requests: buckets.get(minute) ?? 0 });
  }
  return rows;
}

export function buildStudioData(snapshot: Snapshot): AgDataSourcesDefinition {
  return {
    sources: [
      {
        id: 'attendees',
        name: 'Attendees',
        fields: [
          { id: 'attendee', name: 'Attendee', format: 'textFormat' },
          { id: 'status', name: 'Status', format: 'textFormat' },
          { id: 'paid', name: 'Paid', ...money },
          { id: 'asked', name: 'Asked at', format: 'textFormat' },
        ],
        data: snapshot.tickets.map((t) => ({
          attendee: t.attendeeName,
          status: STATUS_LABEL[t.status] ?? t.status,
          paid: dollars(t.amountCents),
          asked: time(t.requestedAt),
        })),
      },
      {
        id: 'wave',
        name: 'Refund wave',
        fields: [
          { id: 'after', name: 'After the announcement', format: 'textFormat' },
          { id: 'requests', name: 'Requests', format: 'integerFormat' },
        ],
        data: refundWave(snapshot),
      },
      {
        id: 'vendors',
        name: 'Vendors',
        fields: [
          { id: 'vendor', name: 'Vendor', format: 'textFormat' },
          { id: 'for', name: 'For', format: 'textFormat' },
          { id: 'owed', name: 'Owed', ...money },
          { id: 'status', name: 'Status', format: 'textFormat' },
        ],
        data: snapshot.vendors.map((v) => ({
          vendor: v.name,
          for: v.role,
          owed: dollars(v.owedCents),
          status: v.status === 'paid' ? 'Paid' : v.status === 'failed' ? 'Payment failed' : 'Owed',
        })),
      },
      {
        id: 'ledger',
        name: 'Ledger',
        fields: [
          { id: 'when', name: 'When', format: 'textFormat' },
          { id: 'what', name: 'What happened and why', format: 'textFormat' },
          { id: 'amount', name: 'Amount', ...money },
          { id: 'paypal', name: 'PayPal reference', format: 'textFormat' },
        ],
        data: snapshot.ledger
          .filter((l) => l.kind !== 'ticket_sale')
          .map((l) => ({
            when: time(l.at),
            what: l.reason,
            amount: dollars(l.amountCents),
            paypal: l.paypalRef ?? '',
          })),
      },
    ],
  };
}
