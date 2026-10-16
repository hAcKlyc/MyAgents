import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

vi.mock('@/context/ImagePreviewContext', () => ({ useImagePreview: () => ({ openPreview: vi.fn() }) }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));
vi.mock('@/utils/clipboard', () => ({ copyPlainText: vi.fn().mockResolvedValue(undefined) }));

import Message from './Message';
import { copyPlainText } from '@/utils/clipboard';

function userMsg(
  content: string,
  overrides: Partial<MessageType> = {}
): MessageType {
  return {
    id: 'u1',
    role: 'user',
    content,
    timestamp: new Date(),
    ...overrides,
  } as MessageType;
}

describe('Message — user bubble spacing', () => {
  it('keeps copy and rewind bound to the user message in the floating action bar', async () => {
    const onRewind = vi.fn();
    render(<Message message={userMsg('保留原始换行\n**重点内容**')} onRewind={onRewind} />);
    fireEvent.click(screen.getByRole('button', { name: /^复制$/ }));
    await waitFor(() => expect(copyPlainText).toHaveBeenCalledWith('保留原始换行\n**重点内容**'));
    fireEvent.click(screen.getByRole('button', { name: /^时间回溯$/ }));
    expect(onRewind).toHaveBeenCalledExactlyOnceWith('u1');
    expect(screen.getByText('重点内容').tagName).toBe('STRONG');
  });
  it.each(['sending', 'failed'] as const)('keeps a %s user bubble visible without native rewind', status => {
    const { container } = render(<Message message={userMsg('hello', { deliveryStatus: status })} onRewind={vi.fn()} />);
    expect(container.querySelector('article')).toHaveTextContent('hello');
    expect(container.querySelector('[data-rewind-btn]')).toBeNull();
    if (status === 'failed') expect(screen.getByText('发送失败')).toBeInTheDocument();
  });

  it('keeps background task notifications hidden from the chat flow', () => {
    const { container } = render(
      <Message
        message={userMsg(
          '<task-notification>{"taskId":"bg-1","status":"completed","description":"Audit repo","summary":"Long completion summary that should stay out of chat."}</task-notification>',
          { id: 'task-notification-bg-1' },
        )}
      />
    );

    expect(container.firstChild).toBeNull();
    expect(container).not.toHaveTextContent('Long completion summary');
    expect(container).not.toHaveTextContent('Audit repo');
  });

  it('uses compact bubble padding and scopes Markdown paragraph margins', () => {
    const { container } = render(<Message message={userMsg('你可以帮我写个 v3')} />);

    const bubble = container.querySelector('article');
    expect(bubble).toHaveClass('px-3', 'py-2');
    expect(bubble).not.toHaveClass('p-4');

    const content = container.querySelector('.user-message-content');
    expect(content).toBeInTheDocument();
    expect(content?.querySelector('p')).toHaveTextContent('你可以帮我写个 v3');
  });

  it('scopes timestamp and action visibility to the local user bubble group', () => {
    render(
      <Message
        message={userMsg('检查一下 hover 行为', {
          timestamp: new Date(2026, 5, 25, 22, 43, 15),
        })}
      />
    );

    const timestamp = screen.getByText('2026-06-25 22:43:15');
    const actionRow = timestamp.parentElement;
    expect(actionRow).toHaveClass(
      'opacity-0',
      'group-hover/user-actions:opacity-100',
      'group-focus-within/user-actions:opacity-100',
    );

    const localHoverScope = actionRow?.parentElement;
    expect(localHoverScope).toHaveClass('group/user-actions', 'w-fit', 'max-w-[85%]');
  });

  it('renders sent image attachments as a fixed-height ratio-preserving strip', () => {
    const { container } = render(
      <Message
        message={userMsg('能看到我的屏幕嘛', {
          attachments: [
            {
              id: 'att-1',
              name: 'wide-terminal.png',
              size: 42_000,
              mimeType: 'image/png',
              previewUrl: 'data:image/png;base64,abc',
              isImage: true,
            },
            {
              id: 'att-2',
              name: 'portrait.png',
              size: 21_000,
              mimeType: 'image/png',
              previewUrl: 'data:image/png;base64,def',
              isImage: true,
            },
            {
              id: 'att-3',
              name: 'notes.txt',
              size: 128,
              mimeType: 'text/plain',
              relativePath: 'notes.txt',
              isImage: false,
            },
          ],
        })}
      />
    );

    const images = Array.from(container.querySelectorAll('img:not([data-file-icon-id])'));
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image).toHaveClass('h-full', 'w-auto', 'max-w-none', 'object-contain');
      expect(image).not.toHaveClass('object-cover');

      const imageFrame = image.parentElement;
      expect(imageFrame).toHaveClass('h-24');
      expect(imageFrame).not.toHaveClass('max-w-full');

      const imageCard = imageFrame?.parentElement;
      expect(imageCard).toHaveClass('w-fit', 'shrink-0');
      expect(imageCard).not.toHaveClass('max-w-full');
    }

    const attachmentStrip = images[0]?.closest('.flex-nowrap');
    expect(attachmentStrip).toBeInTheDocument();
    expect(attachmentStrip).toHaveClass('overflow-x-auto');
    expect(attachmentStrip).not.toHaveClass('grid-cols-5');
    expect(attachmentStrip).toHaveTextContent('notes.txt');
  });
});

it('updates attachment-only changes while skipping an unchanged message row', () => {
  const before = userMsg('unchanged text');
  const formatTimestamp = vi.spyOn(before.timestamp, 'getFullYear');
  const { container, rerender } = render(<Message message={before} />);
  const renders = formatTimestamp.mock.calls.length;
  rerender(<Message message={before} />);
  expect(formatTimestamp).toHaveBeenCalledTimes(renders);
  const next = {
    ...before,
    attachments: [
      {
        id: 'new-image',
        name: 'receipt.png',
        size: 10,
        mimeType: 'image/png',
        previewUrl: 'data:image/png;base64,abc',
        isImage: true,
      },
    ],
  };
  rerender(<Message message={next} />);
  const image = container.querySelector('img:not([data-file-icon-id])');
  expect(image).not.toBeNull();
  expect(formatTimestamp.mock.calls.length).toBeGreaterThan(renders);
  const changed = {
    ...next,
    attachments: [{ ...next.attachments[0], previewUrl: 'data:image/png;base64,def' }],
  };
  rerender(<Message message={changed} />);
  expect(container.querySelector('img:not([data-file-icon-id])')).toHaveAttribute(
    'src',
    'data:image/png;base64,def',
  );
  rerender(<Message message={{ ...changed, attachments: [] }} />);
  expect(container.querySelector('img:not([data-file-icon-id])')).toBeNull();
});
