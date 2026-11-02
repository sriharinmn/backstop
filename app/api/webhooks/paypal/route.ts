import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { verifyWebhook } from '@/lib/paypal';
import { handleWebhook, type WebhookEvent } from '@/lib/webhooks';

export async function POST(request: Request) {
  const raw = await request.text();
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  let verified = false;
  if (webhookId) {
    try {
      verified = await verifyWebhook(request.headers, raw, webhookId);
    } catch {
      verified = false;
    }
  }

  const result = await handleWebhook(await getDb(), JSON.parse(raw) as WebhookEvent, verified);

  // PayPal retries anything but a 2xx. Only an event that failed verification gets refused.
  return NextResponse.json({ result }, { status: result === 'rejected' ? 401 : 200 });
}
