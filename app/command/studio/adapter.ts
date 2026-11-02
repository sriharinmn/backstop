import type { AgAiEvent, AgLlmAdapter, AgLlmResponse, AgLlmResponseHandler } from 'ag-studio';
import { fromChatCompletion, toChatRequest, type ChatCompletion } from '@/lib/llm-translate';

// Runs one agent turn through this app's own /api/llm route, so no key reaches the browser.
export const backstopAdapter: AgLlmAdapter = {
  executeTurn(request, options): AgLlmResponseHandler {
    const turn = (async () => {
      const res = await fetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toChatRequest(request)),
        signal: options?.signal,
      });
      const json = (await res.json()) as ChatCompletion & { error?: string };

      if (!res.ok) {
        const response: AgLlmResponse = {
          id: 'failed-turn',
          createdAt: Date.now(),
          output: [],
          status: 'failed',
          error: { code: String(res.status), message: json.error ?? 'The AI is unavailable.' },
        };
        return { events: [] as AgAiEvent[], response };
      }
      return fromChatCompletion(json);
    })();

    return {
      stream: {
        async *[Symbol.asyncIterator]() {
          yield* (await turn).events;
        },
      },
      complete: turn.then(({ response }) => response),
    };
  },
};
