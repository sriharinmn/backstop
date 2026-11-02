// Every PayPal call in the app. Plain fetch, no SDK. Refuses to run against anything but the sandbox.

type RequestOptions = {
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
};

export class PayPalError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issue?: string;

  constructor(status: number, code: string, message: string, issue?: string) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.code = code;
    this.issue = issue;
  }
}

function root(): string {
  const base = (process.env.PAYPAL_BASE_URL ?? '').replace(/\/$/, '');
  if (!/^https:\/\/api(-m)?\.sandbox\.paypal\.com$/.test(base)) {
    throw new Error('PAYPAL_BASE_URL must be the PayPal sandbox.');
  }
  return base;
}

let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${root()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new PayPalError(res.status, 'TOKEN_FAILED', 'Could not get a PayPal access token.');

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const safeToRetry = method === 'GET' || Boolean(options.headers?.['PayPal-Request-Id']);

  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(root() + path, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(options.form ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });

    if (res.status === 401 && attempt === 0) {
      cached = null;
      continue;
    }
    // 409 means an earlier call for this resource is still running, so a retry can succeed.
    if ((res.status === 409 || res.status === 429 || res.status >= 500) && safeToRetry && attempt < 3) {
      await sleep(500 * 2 ** attempt);
      continue;
    }

    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!res.ok) {
      const details = (json.details ?? []) as { issue?: string; description?: string }[];
      throw new PayPalError(
        res.status,
        String(json.name ?? 'PAYPAL_ERROR'),
        String(details[0]?.description ?? json.message ?? `PayPal returned ${res.status}.`),
        details[0]?.issue,
      );
    }
    return json as T;
  }
}

export const toCents = (value: string | number) => Math.round(Number(value) * 100);
export const toMoney = (cents: number) => (cents / 100).toFixed(2);

// ---- Payments ----

export type Capture = {
  orderId: string;
  captureId: string;
  status: string;
  feeCents: number;
  netCents: number;
};

type OrderResponse = {
  id: string;
  status: string;
  purchase_units?: {
    payments?: {
      captures?: {
        id: string;
        status: string;
        seller_receivable_breakdown?: { paypal_fee?: { value: string }; net_amount?: { value: string } };
      }[];
    };
  }[];
};

// Sandbox test card. Used to seed real captures with no buyer login.
export async function captureCard(input: {
  amountCents: number;
  description: string;
  customId: string;
  name: string;
  requestId: string;
}): Promise<Capture> {
  const order = await call<OrderResponse>('POST', '/v2/checkout/orders', {
    headers: { 'PayPal-Request-Id': input.requestId, Prefer: 'return=representation' },
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: { currency_code: 'USD', value: toMoney(input.amountCents) },
          description: input.description,
          custom_id: input.customId,
        },
      ],
      payment_source: {
        card: { number: '4111111111111111', expiry: '2030-12', security_code: '123', name: input.name },
      },
    },
  });

  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new PayPalError(502, 'NO_CAPTURE', `Order ended as ${order.status} with no capture.`);

  return {
    orderId: order.id,
    captureId: capture.id,
    status: capture.status,
    feeCents: toCents(capture.seller_receivable_breakdown?.paypal_fee?.value ?? 0),
    netCents: toCents(capture.seller_receivable_breakdown?.net_amount?.value ?? 0),
  };
}

export type Refund = { refundId: string; status: string; netCents: number | null };

export async function refundCapture(
  captureId: string,
  input: { amountCents?: number; note: string; requestId: string; mockCode?: string },
): Promise<Refund> {
  const res = await call<{
    id: string;
    status: string;
    seller_payable_breakdown?: { net_amount?: { value: string } };
  }>('POST', `/v2/payments/captures/${captureId}/refund`, {
    headers: {
      'PayPal-Request-Id': input.requestId,
      Prefer: 'return=representation',
      ...(input.mockCode
        ? { 'PayPal-Mock-Response': JSON.stringify({ mock_application_codes: input.mockCode }) }
        : {}),
    },
    body: {
      note_to_payer: input.note.slice(0, 255),
      ...(input.amountCents === undefined
        ? {}
        : { amount: { currency_code: 'USD', value: toMoney(input.amountCents) } }),
    },
  });
  const net = res.seller_payable_breakdown?.net_amount?.value;
  return { refundId: res.id, status: res.status, netCents: net === undefined ? null : toCents(net) };
}

export async function getBalanceCents(): Promise<number> {
  const res = await call<{ balances?: { currency: string; available_balance?: { value: string } }[] }>(
    'GET',
    '/v1/reporting/balances?currency_code=USD',
  );
  const usd = res.balances?.find((b) => b.currency === 'USD');
  return toCents(usd?.available_balance?.value ?? 0);
}

// ---- Payouts ----

export type PayoutItem = { email: string; amountCents: number; note: string; itemId: string };

export async function sendPayout(input: {
  batchId: string;
  subject: string;
  items: PayoutItem[];
}): Promise<{ payoutBatchId: string; status: string }> {
  const res = await call<{ batch_header: { payout_batch_id: string; batch_status: string } }>(
    'POST',
    '/v1/payments/payouts',
    {
      body: {
        sender_batch_header: { sender_batch_id: input.batchId, email_subject: input.subject },
        items: input.items.map((item) => ({
          recipient_type: 'EMAIL',
          receiver: item.email,
          note: item.note,
          sender_item_id: item.itemId,
          amount: { currency: 'USD', value: toMoney(item.amountCents) },
        })),
      },
    },
  );
  return { payoutBatchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status };
}

export async function getPayoutStatus(payoutBatchId: string): Promise<string> {
  const res = await call<{ batch_header: { batch_status: string } }>('GET', `/v1/payments/payouts/${payoutBatchId}`);
  return res.batch_header.batch_status;
}

// ---- Disputes ----

export type Dispute = {
  id: string;
  status: string;
  stage: string;
  reason: string;
  amountCents: number;
  dueAt: string | null;
  outcome: string | null;
  refundedCents: number;
  captureId: string | null;
  customId: string | null;
  actions: string[];
};

type DisputeResponse = {
  dispute_id: string;
  status: string;
  dispute_life_cycle_stage?: string;
  reason?: string;
  dispute_amount?: { value: string };
  seller_response_due_date?: string;
  dispute_outcome?: { outcome_code?: string; amount_refunded?: { value: string } };
  disputed_transactions?: { seller_transaction_id?: string; custom?: string }[];
  links?: { rel: string }[];
};

function parseDispute(d: DisputeResponse): Dispute {
  return {
    id: d.dispute_id,
    status: d.status,
    stage: d.dispute_life_cycle_stage ?? 'UNKNOWN',
    reason: d.reason ?? 'UNKNOWN',
    amountCents: toCents(d.dispute_amount?.value ?? 0),
    dueAt: d.seller_response_due_date ?? null,
    outcome: d.dispute_outcome?.outcome_code ?? null,
    refundedCents: toCents(d.dispute_outcome?.amount_refunded?.value ?? 0),
    captureId: d.disputed_transactions?.[0]?.seller_transaction_id ?? null,
    customId: d.disputed_transactions?.[0]?.custom ?? null,
    actions: (d.links ?? []).map((l) => l.rel).filter((rel) => rel !== 'self'),
  };
}

export async function getDispute(id: string): Promise<Dispute> {
  return parseDispute(await call<DisputeResponse>('GET', `/v1/customer/disputes/${id}`));
}

// Sandbox-only endpoint. It raises a real dispute on a real capture, with no buyer login.
export async function createChargeback(input: {
  captureId: string;
  amountCents: number;
  memo: string;
}): Promise<string> {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const value = toMoney(input.amountCents);

  const res = await call<{ dispute_id: string }>('POST', '/v2/customer-support/process-chargeback', {
    body: {
      adjacency: 'PAYPAL',
      file_layout: 'ATCK_CB',
      financial_institution: { processor: 'FDMS' },
      transaction: { id_enc: input.captureId, amount: { currency_code: 'USD', value } },
      instrument: {
        instrument_type: 'CARD',
        card_brand: 'VISA',
        credit_card_transaction_id: String(now),
        external: false,
      },
      dispute: {
        id: null,
        stage: 'CHARGEBACK',
        response_date: iso(now + 20 * 86_400_000),
        status: '2',
        amount: { currency_code: 'USD', value },
        receive_date: iso(now),
        event_code: 'CHARGEBACK_INITIATED',
        money_movement_date: iso(now),
        event_type: 'DEBIT',
        chargeback_type: 'REPORTED_TO_PROCESSOR',
        processor_info: { reference_number: String(now), reason_code: 'C2', notes: input.memo },
      },
    },
  });
  return res.dispute_id;
}

export async function provideEvidence(
  id: string,
  input: { notes: string; carrier?: string; trackingNumber?: string },
): Promise<void> {
  const payload = {
    evidences: [
      {
        evidence_type: 'PROOF_OF_FULFILLMENT',
        notes: input.notes.slice(0, 2000),
        ...(input.trackingNumber
          ? {
              evidence_info: {
                tracking_info: [{ carrier_name: input.carrier ?? 'OTHER', tracking_number: input.trackingNumber }],
              },
            }
          : {}),
      },
    ],
  };
  const form = new FormData();
  form.append('input', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  await call('POST', `/v1/customer/disputes/${id}/provide-evidence`, { form });
}

export async function provideSupportingInfo(id: string, notes: string): Promise<void> {
  const form = new FormData();
  form.append('input', new Blob([JSON.stringify({ notes: notes.slice(0, 2000) })], { type: 'application/json' }));
  await call('POST', `/v1/customer/disputes/${id}/provide-supporting-info`, { form });
}

export async function acceptClaim(id: string, note: string): Promise<void> {
  await call('POST', `/v1/customer/disputes/${id}/accept-claim`, { body: { note: note.slice(0, 2000) } });
}

// Sandbox-only. Stands in for PayPal's decision, so a demo can show an ending.
export async function adjudicate(id: string, outcome: 'SELLER_FAVOR' | 'BUYER_FAVOR'): Promise<void> {
  await call('POST', `/v1/customer/disputes/${id}/adjudicate`, { body: { adjudication_outcome: outcome } });
}

// ---- Webhooks ----

export async function verifyWebhook(headers: Headers, rawBody: string, webhookId: string): Promise<boolean> {
  const res = await call<{ verification_status: string }>('POST', '/v1/notifications/verify-webhook-signature', {
    body: {
      auth_algo: headers.get('paypal-auth-algo'),
      cert_url: headers.get('paypal-cert-url'),
      transmission_id: headers.get('paypal-transmission-id'),
      transmission_sig: headers.get('paypal-transmission-sig'),
      transmission_time: headers.get('paypal-transmission-time'),
      webhook_id: webhookId,
      webhook_event: JSON.parse(rawBody),
    },
  });
  return res.verification_status === 'SUCCESS';
}
