import { z } from 'zod';
import { getDb } from '@/lib/db';
import { route } from '@/lib/http';
import { recordChoice } from '@/lib/scenario';

const body = z.object({ choice: z.enum(['refund', 'transfer']) });

export const POST = route(async (request: Request, context: { params: Promise<{ token: string }> }) => {
  const { token } = await context.params;
  const { choice } = body.parse(await request.json());
  const recorded = await recordChoice(await getDb(), token, choice);
  if (!recorded) throw new Error('This ticket has already been settled.');
  return { recorded };
});
