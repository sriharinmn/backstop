import { afterEach, describe, expect, it, vi } from 'vitest';
import { callProviders, LlmUnavailableError, providers } from '@/lib/llm';
import { fromChatCompletion, toChatRequest } from '@/lib/llm-translate';

const userMessage = (text: string) => ({
  id: 'm1',
  kind: 'input' as const,
  type: 'message' as const,
  role: 'user' as const,
  content: [{ type: 'text' as const, text }],
  status: 'completed' as const,
});

describe('toChatRequest', () => {
  it('puts instructions first and turns a user message into chat form', () => {
    const body = toChatRequest({
      instructions: 'You help event organizers.',
      input: [userMessage('What do I owe?')],
      responseFormat: { type: 'text' },
    });

    expect(body.messages).toEqual([
      { role: 'system', content: 'You help event organizers.' },
      { role: 'user', content: 'What do I owe?' },
    ]);
  });

  it('joins a tool call to the assistant message before it, then adds its result', () => {
    const body = toChatRequest({
      responseFormat: { type: 'text' },
      input: [
        userMessage('Refund them'),
        {
          id: 'o1',
          kind: 'output',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'text', text: 'Checking.' }],
        },
        {
          id: 'c1',
          kind: 'output',
          type: 'function_call',
          callId: 'call_1',
          name: 'get_situation',
          arguments: '{}',
        },
        { type: 'function_call_output', callId: 'call_1', output: '{"owed":100}', status: 'completed' },
      ],
    } as never);

    expect(body.messages).toEqual([
      { role: 'user', content: 'Refund them' },
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_situation', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"owed":100}' },
    ]);
  });

  it('gives a lone tool call an assistant message with null content', () => {
    const body = toChatRequest({
      responseFormat: { type: 'text' },
      input: [{ id: 'c1', kind: 'output', type: 'function_call', callId: 'call_1', name: 'a', arguments: '{}' }],
    } as never);

    expect(body.messages[0]).toMatchObject({ role: 'assistant', content: null });
  });

  it('skips reasoning items', () => {
    const body = toChatRequest({
      responseFormat: { type: 'text' },
      input: [userMessage('Hi'), { id: 'r1', kind: 'output', type: 'reasoning', content: [] }],
    } as never);

    expect(body.messages).toHaveLength(1);
  });

  it('declares tools and tool choice in chat form', () => {
    const body = toChatRequest({
      input: [userMessage('Hi')],
      responseFormat: { type: 'text' },
      tools: [{ name: 'a', description: 'Does a', parameters: { type: 'object' } as never }],
      toolChoice: { name: 'a' },
    });

    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'a', description: 'Does a', parameters: { type: 'object' } } },
    ]);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'a' } });
  });

  it('never sends a provider-hosted tool', () => {
    const body = toChatRequest({
      input: [userMessage('Hi')],
      responseFormat: { type: 'text' },
      tools: [{ name: 'web', description: 'Web', parameters: {} as never, kind: 'provided' }],
    });

    expect(body.tools).toBeUndefined();
  });
});

describe('fromChatCompletion', () => {
  const completion = (message: object, finish = 'stop') => ({
    id: 'cmpl1',
    created: 1800000000,
    model: 'openai/gpt-oss-120b',
    choices: [{ finish_reason: finish, message }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });

  it('turns text into a chunk event and an output message', () => {
    const { events, response } = fromChatCompletion(completion({ role: 'assistant', content: 'You owe $100.' }));

    expect(events).toEqual([expect.objectContaining({ type: 'TEXT_MESSAGE_CHUNK', delta: 'You owe $100.', role: 'assistant' })]);
    expect(response.status).toBe('completed');
    expect(response.output[0]).toMatchObject({ type: 'message', role: 'assistant', content: [{ text: 'You owe $100.' }] });
  });

  it('turns a tool call into a chunk event and a function_call output', () => {
    const { events, response } = fromChatCompletion(
      completion({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_situation', arguments: '{"a":1}' } }],
      }),
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: 'TOOL_CALL_CHUNK',
        toolCallId: 'call_9',
        toolCallName: 'get_situation',
        delta: '{"a":1}',
      }),
    ]);
    expect(response.output[0]).toMatchObject({
      type: 'function_call',
      callId: 'call_9',
      name: 'get_situation',
      arguments: '{"a":1}',
    });
  });

  it('reports tokens used and the model', () => {
    const { response } = fromChatCompletion(completion({ role: 'assistant', content: 'Hi' }));

    expect(response.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    expect(response.model).toBe('openai/gpt-oss-120b');
  });

  it('marks a response cut off by the token limit as incomplete', () => {
    const { response } = fromChatCompletion(completion({ role: 'assistant', content: 'Partly' }, 'length'));

    expect(response.status).toBe('incomplete');
    expect(response.incompleteDetails).toEqual({ reason: 'max_output_tokens' });
  });
});

describe('providers', () => {
  it('uses only free providers whose keys are set, Groq first', () => {
    const list = providers({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' });
    expect(list.map((p) => p.name)).toEqual(['groq', 'gemini']);
  });

  it('skips a provider with no key', () => {
    expect(providers({ GEMINI_API_KEY: 'k' }).map((p) => p.name)).toEqual(['gemini']);
  });

  it('offers a local model only when asked to', () => {
    expect(providers({}).map((p) => p.name)).toEqual([]);
    expect(providers({ OLLAMA_MODEL: 'qwen2.5:3b' }).map((p) => p.name)).toEqual(['local']);
  });
});

describe('callProviders', () => {
  const ok = (body: object) => new Response(JSON.stringify(body), { status: 200 });
  const env = { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k' };
  const request = { messages: [{ role: 'user', content: 'Hi' }] };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('moves to the backup when the first provider is rate limited', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(ok({ id: 'x' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callProviders(request, env);

    expect(result.provider).toBe('gemini');
    expect(fetchMock.mock.calls[0][0]).toContain('groq.com');
    expect(fetchMock.mock.calls[1][0]).toContain('generativelanguage');
  });

  it('sends the key only to that key\'s provider and sets the model on the server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ id: 'x' }));
    vi.stubGlobal('fetch', fetchMock);

    await callProviders({ ...request, model: 'something-expensive' }, env);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer g');
    expect(JSON.parse(init.body).model).toBe('openai/gpt-oss-120b');
  });

  it('fails plainly when every provider fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('{}', { status: 503 })));

    await expect(callProviders(request, env)).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('fails plainly when no key is set', async () => {
    await expect(callProviders(request, {})).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
