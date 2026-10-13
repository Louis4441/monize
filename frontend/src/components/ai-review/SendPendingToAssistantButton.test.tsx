import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { render, renderHook, screen, fireEvent, act } from '@/test/render';
import { peekChatHandoff } from '@/lib/ai-chat-handoff';
import { SendPendingToAssistantButton } from './SendPendingToAssistantButton';
import { makeReviewItem } from './ai-review-fixtures';

const assistant = vi.hoisted(() => ({ canAnswer: vi.fn() }));
vi.mock('@/lib/assistant-ready', () => ({ assistantCanAnswerNow: assistant.canAnswer }));

// The mocked router is one object for the whole run (`test/setup.ts`).
const router = vi.mocked(renderHook(() => useRouter()).result.current);

const items = [
  makeReviewItem({ id: 'a', status: 'pending' }),
  makeReviewItem({ id: 'b', status: 'pending' }),
  makeReviewItem({ id: 'c', status: 'proposed' }),
];

async function press() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send 2 pending requests to the AI assistant' }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  assistant.canAnswer.mockResolvedValue(true);
});

describe('SendPendingToAssistantButton', () => {
  it('is not offered while nothing is pending, loaded or not', () => {
    const { rerender } = render(<SendPendingToAssistantButton items={null} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<SendPendingToAssistantButton items={[makeReviewItem({ status: 'proposed' })]} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('stages the prompt for the chat and opens it, so the user still presses Send', async () => {
    render(<SendPendingToAssistantButton items={items} />);
    await press();

    expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/ai\?handoff=[0-9a-f-]{36}$/));
    const id = (router.push.mock.calls.at(-1)?.[0] as string).replace('/ai?handoff=', '');
    const handoff = peekChatHandoff(id);
    expect(handoff?.files).toEqual([]);
    expect(handoff?.draft).toContain('ai_review_requests');
    expect(toast.success).toHaveBeenCalledWith('Opened the chat with a prepared message. Read it and press Send.');
  });

  it('keeps the requests here and says why when the assistant cannot answer now', async () => {
    assistant.canAnswer.mockResolvedValue(false);
    render(<SendPendingToAssistantButton items={items} />);
    await press();

    expect(router.push).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'The AI assistant cannot answer now. Connect an AI provider in Settings, or connect your MCP client. The requests keep waiting here.',
    );
  });
});
