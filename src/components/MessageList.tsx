import { useRef, useEffect } from 'react';
import type { ChatMessage } from '../types/a2a';
import { MessageBubble } from './MessageBubble';

interface Props {
  messages: ChatMessage[];
}

export function MessageList({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="message-list message-list--empty">
        <div className="empty-state">
          <div className="empty-state-icon">💬</div>
          <p>Connect an agent to start chatting</p>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list">
      {messages.map(msg => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
