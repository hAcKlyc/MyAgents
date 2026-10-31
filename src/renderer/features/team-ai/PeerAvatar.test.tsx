import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GROUP_AVATAR_IMAGES } from '@/assets/team-avatars';
import { PeerAvatar } from './PeerList';
import { PEER_AVATAR_PALETTE } from './peerAvatarPalette';

function luminance(hex: string) {
  const rgb = hex.match(/[\da-f]{2}/gi)!.map(channel => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

describe('Team AI private contact avatars', () => {
  it('keeps every nickname colour pair above 4.5:1 contrast', () => {
    for (const colors of PEER_AVATAR_PALETTE) {
      const values = [luminance(colors.background), luminance(colors.foreground)];
      const ratio = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
      expect(ratio, colors.background).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('preserves nickname text, stable identity colour, dimensions and the platform badge', () => {
    const peer = { sourceType: 'private' as const, sourceId: 'contact-42', name: '李奕晨' };
    const { container, rerender } = render(<PeerAvatar peer={peer} platform="weixin" />);
    const avatar = container.firstElementChild as HTMLElement;
    expect(avatar).toHaveTextContent('晨');
    expect(avatar).toHaveStyle({ width: '32px', height: '32px' });
    const background = avatar.style.background;
    const foreground = avatar.style.color;
    const badge = avatar.querySelector('.absolute');
    expect(badge).not.toBeNull();
    rerender(<PeerAvatar peer={{ ...peer, name: 'Ethan' }} size={40} />);
    expect(avatar).toHaveTextContent('n');
    expect(avatar.style.background).toBe(background);
    expect(avatar.style.color).toBe(foreground);
    expect(avatar).toHaveStyle({ width: '40px', height: '40px' });
    rerender(<PeerAvatar peer={{ ...peer, name: peer.sourceId }} />);
    expect(avatar).toHaveTextContent('?');
  });
});

describe('Team AI group avatars', () => {
  it('renders all three locally packaged multi-person variants', () => {
    const renderedSources = new Set<string>();
    for (const sourceId of ['group:a', 'group:b', 'group:c']) {
      const { container, unmount } = render(<PeerAvatar peer={{ sourceType: 'group', sourceId, name: '讨论组' }} />);
      const image = container.querySelector('img')!;
      renderedSources.add(image.getAttribute('src')!);
      expect(image).toHaveAttribute('alt', '');
      expect(image).toHaveAttribute('aria-hidden', 'true');
      expect(image).toHaveAttribute('draggable', 'false');
      expect(image).toHaveAttribute('width', '32');
      expect(image).toHaveAttribute('height', '32');
      expect(container.querySelector('svg')).toBeNull();
      unmount();
    }
    expect(renderedSources).toEqual(new Set(GROUP_AVATAR_IMAGES));
    for (const src of GROUP_AVATAR_IMAGES) {
      const png = readFileSync(resolve(import.meta.dirname, '../../assets/team-avatars', src.split('/').at(-1)!));
      expect(png.readUInt32BE(16)).toBe(128);
      expect(png.readUInt32BE(20)).toBe(128);
    }
  });

  it('keeps the same image in the list and detail after renaming, with an unclipped platform badge', () => {
    const peer = { sourceType: 'group' as const, sourceId: 'group:stable', name: '设计讨论组' };
    const { container, rerender } = render(<PeerAvatar peer={peer} platform="telegram" />);
    const avatar = container.firstElementChild as HTMLElement;
    const image = avatar.querySelector('img[alt=""]')!;
    const source = image.getAttribute('src');
    expect(avatar).toHaveStyle({ width: '32px', height: '32px' });
    expect(image).toHaveClass('rounded-[inherit]');
    const badge = avatar.querySelector('.absolute')!;
    expect(badge.parentElement).toBe(avatar);
    expect(badge).toContainElement(avatar.querySelector('img[alt="Telegram"]'));
    expect(image.parentElement).toBe(avatar);
    expect(avatar).not.toHaveClass('overflow-hidden');
    rerender(<PeerAvatar peer={{ ...peer, name: '新的组名' }} size={40} />);
    expect(container.querySelector('img')).toHaveAttribute('src', source);
    expect(container.firstElementChild).toHaveStyle({ width: '40px', height: '40px' });
    expect(container.querySelector('img')).toHaveAttribute('width', '40');
    expect(container.querySelector('.absolute')).toBeNull();
  });
});
