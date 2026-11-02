// The server side of the agent. Free providers only, tried in order. Keys never leave the server.

type Env = Record<string, string | undefined>;

export type Provider = {
  name: 'groq' | 'gemini' | 'local';
  baseUrl: string;
  model: string;
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
      model: env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
      key: env.GROQ_API_KEY,
    });
  }
  if (env.GEMINI_API_KEY) {
    list.push({
      name: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: env.GEMINI_MODEL ?? 'gemini-3.6-flash',
      key: env.GEMINI_API_KEY,
    });
  }
  // A model on this machine, for development with no key at all.
  if (env.OLLAMA_MODEL) {
    list.push({ name: 'local', baseUrl: 'http://localhost:11434/v1', model: env.OLLAMA_MODEL, key: null });
  }

  return list;
}

const MAX_OUTPUT_TOKENS = 700;

export async function callProviders(
  request: Record<string, unknown>,
  env: Env = process.env,
): Promise<{ provider: Provider['name']; completion: unknown }> {
  const available = providers(env);
  if (available.length === 0) throw new LlmUnavailableError('No AI provider is configured.');

  const failures: string[] = [];

  for (const provider of available) {
    try {
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.key ? { Authorization: `Bearer ${provider.key}` } : {}),
        },
        body: JSON.stringify({ ...request, model: provider.model, stream: false, max_tokens: MAX_OUTPUT_TOKENS }),
      });

      if (res.ok) return { provider: provider.name, completion: await res.json() };
      failures.push(`${provider.name}: ${res.status}`);
    } catch {
      failures.push(`${provider.name}: unreachable`);
    }
  }

  throw new LlmUnavailableError(`Every AI provider failed (${failures.join(', ')}).`);
}
