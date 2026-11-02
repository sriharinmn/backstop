// Real sandbox check: what PayPal says when a refund cannot go through.
// Run: node --experimental-strip-types --no-warnings --env-file=.env scripts/sandbox-failures.ts

import { randomUUID } from 'node:crypto';
import { captureCard, PayPalError, refundCapture } from '../lib/paypal.ts';

const show = (label: string, error: unknown) => {
  if (error instanceof PayPalError) {
    console.log(`${label}: ${error.status} ${error.code} issue=${error.issue ?? ''} - ${error.message.slice(0, 110)}`);
  } else {
    console.log(`${label}: unexpected`, error);
  }
};

const capture = await captureCard({
  amountCents: 3500,
  description: 'Failure test ticket',
  customId: 'failure-test',
  name: 'Failure Test',
  requestId: randomUUID(),
});

// Refunded once, as if by hand in PayPal's own dashboard.
await refundCapture(capture.captureId, { note: 'First refund', requestId: randomUUID() });
console.log('first refund ok');

try {
  await refundCapture(capture.captureId, { note: 'Second refund', requestId: randomUUID() });
  console.log('second refund: NOT rejected');
} catch (error) {
  show('second refund', error);
}

const fresh = await captureCard({
  amountCents: 3500,
  description: 'Failure test ticket 2',
  customId: 'failure-test-2',
  name: 'Failure Test',
  requestId: randomUUID(),
});

try {
  await refundCapture(fresh.captureId, { amountCents: 9000, note: 'Too much', requestId: randomUUID() });
  console.log('over-refund: NOT rejected');
} catch (error) {
  show('over-refund', error);
}

for (const code of ['REFUND_FAILED_INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS', 'INTERNAL_SERVER_ERROR', 'PERMISSION_DENIED']) {
  try {
    await refundCapture(fresh.captureId, { note: 'Mock', requestId: randomUUID(), mockCode: code });
    console.log(`mock ${code}: NOT rejected`);
    break;
  } catch (error) {
    show(`mock ${code}`, error);
  }
}
