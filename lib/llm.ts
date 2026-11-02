// The server side of the agent. Free providers only, tried in order. Keys never leave the server.

type Env = Record<string, string | undefined>;

export type Provider = {
  name: 'groq' | 'gemini' | 'local';
  baseUrl: string;
  // Tried in order. Free models get busy, and Groq's limits are per model.
  models: string[];
  key: string | null;
};

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export function providers(env: Env = process.env): Provider[] {
  const list: Provider[] = [];

  if (env.GROQ_API_KEY) {
    list.push({
      name: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      models: env.GROQ_MODEL ? [env.GROQ_MODEL] : ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
      key: env.GROQ_API_KEY,
    });
  }
  if (env.GEMINI_API_KEY) {
    list.push({
      name: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      models: env.GEMINI_MODEL
        ? [env.GEMINI_MODEL]
        : ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'],
      key: env.GEMINI_API_KEY,
    });
  }
  // A model on this machine, for development with no key at all.
  if (env.OLLAMA_MODEL) {
    list.push({ name: 'local', baseUrl: 'http://localhost:11434/v1', models: [env.OLLAMA_MODEL], key: null });
  }

  return list;
}

const MAX_OUTPUT_TOKENS = 700;

type ToolCall = { extra_content?: unknown };
type Message = { tool_calls?: ToolCall[] };

// Gemini refuses a tool call in the history without a thought signature. The real signature does not
// survive AG Studio's conversation format, so send the value Google accepts for calls it did not sign.
// This also lets Gemini take over a conversation that Groq started.
function forProvider(provider: Provider, request: Record<string, unknown>): Record<string, unknown> {
  if (provider.name !== 'gemini' || !Array.isArray(request.messages)) return request;

  return {
    ...request,
    messages: (request.messages as Message[]).map((message) =>
      message.tool_calls
        ? {
            ...message,
            tool_calls: message.tool_calls.map((call) => ({
              ...call,
              extra_content: { google: { thought_signature: 'skip_thought_signature_validator' } },
            })),
          }
        : message,
    ),
  };
}

export async function callProviders(
  request: Record<string, unknown>,
  env: Env = process.env,
): Promise<{ provider: Provider['name']; completion: unknown }> {
  const available = providers(env);
  if (available.length === 0) throw new LlmUnavailableError('No AI provider is configured.');

  const failures: string[] = [];

  for (const provider of available) {
    for (const model of provider.models) {
      try {
        const res = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(provider.key ? { Authorization: `Bearer ${provider.key}` } : {}),
          },
          body: JSON.stringify({
            ...forProvider(provider, request),
            model,
            stream: false,
            max_tokens: MAX_OUTPUT_TOKENS,
          }),
        });

        if (res.ok) return { provider: provider.name, completion: await res.json() };
        failures.push(`${model}: ${res.status}`);

        // A rejected key fails for every model, so go straight to the next provider.
        if (res.status === 401 || res.status === 403) break;
      } catch {
        failures.push(`${model}: unreachable`);
      }
    }
  }

  throw new LlmUnavailableError(`Every AI provider failed (${failures.join(', ')}).`);
}
