// Small helpers shared by the API routes.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PayPalError } from './paypal';

export function route<Args extends unknown[]>(handler: (...args: Args) => Promise<unknown>) {
  return async (...args: Args) => {
    try {
      return NextResponse.json(await handler(...args));
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json({ error: 'Invalid request.', issues: error.issues }, { status: 400 });
      }
      if (error instanceof PayPalError) {
        return NextResponse.json({ error: error.message, paypalCode: error.code }, { status: 502 });
      }
      const message = error instanceof Error ? error.message : 'Something went wrong.';
      return NextResponse.json({ error: message }, { status: 400 });
    }
  };
}
