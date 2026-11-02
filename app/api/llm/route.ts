import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { isSameOrigin, MAX_AI_REQUEST_CHARS, takeAiTurn } from '@/lib/guard';
import { callProviders, LlmUnavailableError } from '@/lib/llm';

export async function POST(request: Request) {
  if (!isSameOrigin(request.headers)) {
    return NextResponse.json({ error: 'This action only works from the Backstop site.' }, { status: 403 });
  }

  const raw = await request.text();
  if (raw.length > MAX_AI_REQUEST_CHARS) {
    return NextResponse.json({ error: 'That request is too long.' }, { status: 413 });
  }

  try {
    if (!(await takeAiTurn(await getDb()))) {
      return NextResponse.json(
        { error: "The agent has reached today's free limit. Slips still work by hand." },
        { status: 429 },
      );
    }

    const { provider, completion } = await callProviders(JSON.parse(raw) as Record<string, unknown>);
    return NextResponse.json(completion, { headers: { 'x-backstop-provider': provider } });
  } catch (error) {
    const status = error instanceof LlmUnavailableError ? 503 : 400;
    const message = error instanceof Error ? error.message : 'The AI request failed.';
    return NextResponse.json({ error: message }, { status });
  }
}
