// Money is whole cents. Timestamps are ISO 8601 UTC strings, so they sort as text
// and reach the browser unchanged.

export const SCHEMA: string[] = [
  `create table if not exists events (
    id text primary key,
    name text not null,
    venue text not null,
    starts_at text not null,
    status text not null check (status in ('on_sale', 'cancelled')),
    policy jsonb not null default '{}',
    cancelled_at text
  )`,
  `create table if not exists tickets (
    id text primary key,
    event_id text not null references events (id) on delete cascade,
    attendee_name text not null,
    attendee_email text not null,
    amount_cents integer not null check (amount_cents > 0),
    paypal_order_id text,
    paypal_capture_id text,
    status text not null check (status in (
      'paid', 'refund_requested', 'transfer_requested', 'refunded', 'transferred', 'refund_failed'
    )),
    requested_at text,
    refunded_at text,
    checked_in_at text,
    token text not null unique
  )`,
  `create index if not exists tickets_event on tickets (event_id, status)`,
  `create table if not exists vendors (
    id text primary key,
    event_id text not null references events (id) on delete cascade,
    name text not null,
    role text not null,
    paypal_email text not null,
    owed_cents integer not null check (owed_cents >= 0),
    status text not null check (status in ('owed', 'paid', 'failed')),
    payout_batch_id text
  )`,
  `create table if not exists disputes (
    id text primary key,
    paypal_dispute_id text not null unique,
    event_id text not null references events (id) on delete cascade,
    ticket_id text references tickets (id) on delete set null,
    status text not null,
    stage text not null,
    reason text not null,
    amount_cents integer not null,
    due_at text,
    outcome text,
    actions jsonb not null default '[]',
    updated_at text not null
  )`,
  `alter table disputes add column if not exists actions jsonb not null default '[]'`,
  `create table if not exists proposals (
    id text primary key,
    event_id text not null references events (id) on delete cascade,
    kind text not null check (kind in ('refund_batch', 'vendor_payout', 'chargeback_response')),
    target_ids jsonb not null,
    amount_cents integer not null,
    reason text not null,
    evidence jsonb not null default '{}',
    status text not null check (status in ('pending', 'approved', 'rejected', 'executing', 'done', 'failed')),
    created_by text not null,
    created_at text not null,
    decided_at text,
    result jsonb
  )`,
  `create table if not exists ledger (
    id text primary key,
    event_id text not null references events (id) on delete cascade,
    kind text not null,
    amount_cents integer not null,
    paypal_ref text,
    proposal_id text references proposals (id) on delete set null,
    reason text not null,
    at text not null
  )`,
  `create index if not exists ledger_event on ledger (event_id, at)`,
  `create table if not exists webhook_events (
    id text primary key,
    type text not null,
    verified boolean not null,
    payload jsonb not null,
    received_at text not null
  )`,
];
