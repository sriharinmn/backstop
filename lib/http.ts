// Small helpers shared by the API routes.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isSameOrigin } from './guard';
import { PayPalError } from './paypal';

export function route<Args extends unknown[]>(handler: (...args: Args) => Promise<unknown>) {
  return async (...args: Args) => {
    const [request] = args;
    if (request instanceof Request && request.method !== 'GET' && !isSameOrigin(request.headers)) {
      return NextResponse.json({ error: 'This action only works from the Backstop site.' }, { status: 403 });
    }

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
