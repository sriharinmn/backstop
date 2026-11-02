// Translates between AG Studio's agent format and the OpenAI-compatible Chat Completions format
// that Groq and Gemini's free tiers both accept. Pure: no network.

import type { AgAiEvent, AgAiOutputItem, AgLlmRequest, AgLlmResponse } from 'ag-studio';

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type ChatToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: { type: 'function'; function: { name: string; description: string; parameters: unknown } }[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
};

export type ChatCompletion = {
  id: string;
  created?: number;
  model?: string;
  choices: {
    finish_reason?: string | null;
    message: { content?: string | null; tool_calls?: ChatToolCall[] | null };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export function toChatRequest(request: AgLlmRequest): ChatRequest {
  const messages: ChatMessage[] = [];
  if (request.instructions) messages.push({ role: 'system', content: request.instructions });

  for (const item of request.input) {
    if (item.type === 'reasoning') continue;

    if (item.type === 'message' && item.kind === 'input') {
      const text = item.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
      messages.push({ role: item.role, content: text });
    } else if (item.type === 'message') {
      const text = item.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
      messages.push({ role: 'assistant', content: text });
    } else if (item.type === 'function_call') {
      const call: ChatToolCall = {
        id: item.callId,
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' },
      };
      // A chat API wants a turn's tool calls on the assistant message that made them.
      const last = messages.at(-1);
      if (last?.role === 'assistant') {
        last.tool_calls = [...(last.tool_calls ?? []), call];
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      }
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output });
    }
  }

  const body: ChatRequest = { messages };

  const tools = (request.tools ?? [])
    .filter((tool) => tool.kind !== 'provided')
    .map((tool) => ({
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

  if (tools.length > 0) {
    body.tools = tools;
    const choice = request.toolChoice;
    if (typeof choice === 'object') {
      body.tool_choice = { type: 'function', function: { name: choice.name } };
    } else if (choice) {
      body.tool_choice = choice;
    }
  }

  return body;
}

export function fromChatCompletion(completion: ChatCompletion): { events: AgAiEvent[]; response: AgLlmResponse } {
  const choice = completion.choices[0];
  const message = choice?.message;
  const events: AgAiEvent[] = [];
  const output: AgAiOutputItem[] = [];

  if (message?.content) {
    const messageId = `${completion.id}-text`;
    events.push({ type: 'TEXT_MESSAGE_CHUNK', messageId, role: 'assistant', delta: message.content });
    output.push({
      id: messageId,
      kind: 'output',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'text', text: message.content, annotations: [] }],
    });
  }

  for (const call of message?.tool_calls ?? []) {
    events.push({
      type: 'TOOL_CALL_CHUNK',
      toolCallId: call.id,
      toolCallName: call.function.name,
      delta: call.function.arguments,
    });
    output.push({
      id: call.id,
      kind: 'output',
      type: 'function_call',
      callId: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      status: 'completed',
    });
  }

  const cutOff = choice?.finish_reason === 'length';

  return {
    events,
    response: {
      id: completion.id,
      createdAt: (completion.created ?? 0) * 1000,
      output,
      status: cutOff ? 'incomplete' : 'completed',
      ...(cutOff ? { incompleteDetails: { reason: 'max_output_tokens' as const } } : {}),
      model: completion.model,
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        totalTokens: completion.usage?.total_tokens ?? 0,
      },
    },
  };
}
