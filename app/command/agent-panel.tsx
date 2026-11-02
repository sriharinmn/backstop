'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgAiChatMessage, AgAiChatSession, AgAiRunStatus } from 'ag-studio';
import { useHarness } from './store';

const STEP_LABEL: Record<string, string> = {
  get_situation: 'Read the numbers',
  propose_refunds: 'Drafted a refund slip',
  propose_vendor_payment: 'Drafted a vendor slip',
  answer_chargeback: 'Drafted a chargeback answer',
  make_chart: 'Added a chart to the dashboard',
};

const BRIEF_ME = 'Tell me where things stand, then draft whatever should go out now.';

export function AgentPanel() {
  const harness = useHarness();
  const [session, setSession] = useState<AgAiChatSession | null>(null);
  const [messages, setMessages] = useState<ReadonlyArray<AgAiChatMessage>>([]);
  const [status, setStatus] = useState<AgAiRunStatus>('idle');
  const [question, setQuestion] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!harness) return;
    let open: AgAiChatSession | null = null;
    let cancelled = false;
    const read = () => {
      if (!open) return;
      setMessages(open.messages);
      setStatus(open.status);
    };

    harness
      .createThread({ agentId: 'backstop', title: 'Cancelled event' })
      .then((created) => {
        if (cancelled) return;
        open = created;
        created.addEventListener('changed', read);
        setSession(created);
      })
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : 'The agent could not start.');
      });

    return () => {
      cancelled = true;
      open?.removeEventListener('changed', read);
    };
  }, [harness]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages]);

  const running = status === 'running';

  function ask(text: string) {
    if (!session || running || !text.trim()) return;
    setFailure(null);
    session.sendMessage(text.trim());
    setQuestion('');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    ask(question);
  }

  return (
    <section className="agent" aria-label="Agent">
      {messages.length > 0 && (
        <div className="agent-log" ref={log} aria-live="polite">
          {messages.flatMap((message) =>
            message.parts.map((part, index) => {
              const key = `${message.id}-${index}`;
              if (part.type === 'text') {
                return (
                  <p key={key} className={message.role === 'user' ? 'agent-asked' : 'agent-said'}>
                    {part.text.replace(/\*\*/g, '')}
                  </p>
                );
              }
              if (part.type === 'tool_call') {
                return (
                  <p key={key} className="agent-step">
                    {STEP_LABEL[part.toolCall.name] ?? part.toolCall.name}
                  </p>
                );
              }
              if (part.type === 'error') {
                return (
                  <p key={key} className="agent-error">
                    The agent stopped. Slips and approvals still work by hand.
                  </p>
                );
              }
              return null;
            }),
          )}
        </div>
      )}

      {failure && <p className="agent-error">{failure}</p>}

      <div className="agent-actions">
        <button type="button" className="button" disabled={!session || running} onClick={() => ask(BRIEF_ME)}>
          {running ? 'The agent is working' : 'Ask the agent what to do'}
        </button>
        <form onSubmit={submit}>
          <input
            aria-label="Ask the agent a question"
            placeholder="Or ask something specific"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <button type="submit" className="button" disabled={!session || running || !question.trim()}>
            Ask
          </button>
        </form>
      </div>
    </section>
  );
}
