import { NextResponse } from 'next/server';
import { callProviders, LlmUnavailableError } from '@/lib/llm';

export async function POST(request: Request) {
  try {
    const { provider, completion } = await callProviders((await request.json()) as Record<string, unknown>);
    return NextResponse.json(completion, { headers: { 'x-backstop-provider': provider } });
  } catch (error) {
    const status = error instanceof LlmUnavailableError ? 503 : 400;
    const message = error instanceof Error ? error.message : 'The AI request failed.';
    return NextResponse.json({ error: message }, { status });
  }
}
