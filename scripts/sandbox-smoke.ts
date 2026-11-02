// Real sandbox check of lib/paypal.ts: capture, refund, a rejected refund, balance.
// Run: node --experimental-strip-types --env-file=.env scripts/sandbox-smoke.ts

import { randomUUID } from 'node:crypto';
import { captureCard, getBalanceCents, PayPalError, refundCapture } from '../lib/paypal.ts';

const before = await getBalanceCents();
console.log('balance before:', before);

const capture = await captureCard({
  amountCents: 3500,
  description: 'Smoke test ticket',
  customId: 'smoke',
  name: 'Smoke Test',
  requestId: randomUUID(),
});
console.log('capture:', capture.status, 'fee', capture.feeCents, 'net', capture.netCents);

const rejectRequest = randomUUID();
try {
  await refundCapture(capture.captureId, {
    note: 'Smoke test',
    requestId: rejectRequest,
    mockCode: 'INSUFFICIENT_AMOUNT',
  });
  console.log('mock refund: NOT rejected');
} catch (error) {
  if (error instanceof PayPalError) {
    console.log('mock refund rejected:', error.status, error.code, error.issue ?? '', '-', error.message.slice(0, 90));
  } else {
    throw error;
  }
}

const refundRequest = randomUUID();
const refund = await refundCapture(capture.captureId, { note: 'Smoke test', requestId: refundRequest });
console.log('refund:', refund.status);

const repeat = await refundCapture(capture.captureId, { note: 'Smoke test', requestId: refundRequest });
console.log('same request id again:', repeat.status, 'same refund:', repeat.refundId === refund.refundId);

console.log('balance after:', await getBalanceCents());
