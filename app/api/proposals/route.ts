import { z } from 'zod';
import { getDb } from '@/lib/db';
import { route } from '@/lib/http';
import { createProposal } from '@/lib/proposals';

const body = z.object({
  eventId: z.string(),
  kind: z.enum(['refund_batch', 'vendor_payout', 'chargeback_response']),
  targetIds: z.array(z.string()).min(1).max(200),
  reason: z.string().min(1).max(500),
  evidence: z.record(z.string(), z.unknown()).optional(),
  createdBy: z.string().default('organizer'),
});

export const POST = route(async (request: Request) => {
  const db = await getDb();
  return createProposal(db, body.parse(await request.json()));
});
