import { getDb } from '@/lib/db';
import { route } from '@/lib/http';
import { rejectProposal } from '@/lib/proposals';

export const POST = route(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  return rejectProposal(await getDb(), id);
});
