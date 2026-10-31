import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
