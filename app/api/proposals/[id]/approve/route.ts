import { chargebackExecutor } from '@/lib/chargebacks';
import { getDb } from '@/lib/db';
import { route } from '@/lib/http';
import { acceptClaim, createChargeback, getDispute, provideEvidence, refundCapture, sendPayout } from '@/lib/paypal';
import { approveProposal } from '@/lib/proposals';

export const POST = route(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const db = await getDb();
  return approveProposal(db, { refundCapture, sendPayout }, id, {
    executors: {
      chargebackResponse: chargebackExecutor({ createChargeback, getDispute, provideEvidence, acceptClaim }),
    },
  });
});
