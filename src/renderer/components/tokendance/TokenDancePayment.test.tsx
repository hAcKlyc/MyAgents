import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import type { TokenDancePaymentSession } from '../../../shared/tokendance';
import { TokenDancePayment } from './TokenDancePayment';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), prepare: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: unknown) =>
    command === 'cmd_tokendance_prepare_payment_request'
      ? mocks.prepare()
      : mocks.invoke(command, args),
}));
vi.mock('@/hooks/useCloseLayer', () => ({ useCloseLayer: vi.fn() }));
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,fixture') },
}));

const version = Promise.resolve('test-account-version');
const session = (
  id = 'order-1',
  status: TokenDancePaymentSession['status'] = 'pending',
): TokenDancePaymentSession => ({
  id,
  amount: 50,
  status,
  payment_url: 'https://example.test/pay',
  status_url: `https://tokendance.space/portal/api/v1/payment/sessions/${id}`,
  created_at: Date.now() / 1000,
  expired_at: Date.now() / 1000 + 600,
  paid_at: null,
});
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const open = (onBalanceChanged = vi.fn(async () => {}), onClose = vi.fn()) =>
  render(
    <TokenDancePayment
      accountVersion={version}
      balance={<span>Account balance ¥48.76</span>}
      onBalanceChanged={onBalanceChanged}
      onClose={onClose}
    />,
  );
const submits = () =>
  mocks.invoke.mock.calls.filter(
    ([command, args]) =>
      command === 'cmd_tokendance_payment' && args.amount !== null,
  );

describe('Token Dance payment attempt lifecycle', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
    vi.useFakeTimers();
    mocks.invoke.mockReset().mockResolvedValue(undefined);
    mocks.prepare
      .mockReset()
      .mockImplementation(async () => crypto.randomUUID());
  });
  afterEach(() => vi.useRealTimers());

  it('cancels a late registration acknowledgement without submitting payment after the panel closes', async () => {
    let acknowledge!: (id: string) => void;
    mocks.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const panel = open();
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate payment QR code' }),
    );
    await flush();
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    panel.unmount();
    await act(async () => acknowledge('registered-request'));
    expect(mocks.invoke).toHaveBeenCalledWith(
      'cmd_tokendance_cancel_payment_request',
      { requestId: 'registered-request' },
    );
    expect(submits()).toHaveLength(0);
  });

  it('only creates on a valid submit, cancels a closed attempt, and ignores its late response', async () => {
    let finish!: (value: TokenDancePaymentSession) => void;
    mocks.invoke.mockImplementation((command) =>
      command === 'cmd_tokendance_payment'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(),
    );
    const first = open();
    expect(submits()).toHaveLength(0);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '1.5' } });
    expect(
      screen.getByRole('button', { name: 'Generate payment QR code' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '50' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate payment QR code' }),
    );
    await flush();
    expect(submits()).toHaveLength(1);
    const firstId = submits()[0][1].requestId;
    first.unmount();
    expect(mocks.invoke).toHaveBeenCalledWith(
      'cmd_tokendance_cancel_payment_request',
      { requestId: firstId },
    );
    open();
    await act(async () => finish(session()));
    expect(screen.queryByRole('img', { name: 'Payment QR code' })).toBeNull();
    expect(screen.getByRole('textbox')).toHaveValue('50');
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate payment QR code' }),
    );
    await flush();
    expect(submits()).toHaveLength(2);
    expect(submits()[1][1].requestId).not.toBe(firstId);
  });

  it('polls only while open, requires paid, and refreshes balance without closing the success page', async () => {
    const changed = vi.fn(async () => {});
    const close = vi.fn();
    mocks.invoke.mockImplementation((command, args) =>
      Promise.resolve(
        command === 'cmd_tokendance_payment'
          ? session('order-1', args.amount ? 'pending' : 'paid')
          : undefined,
      ),
    );
    open(changed, close);
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate payment QR code' }),
    );
    await flush();
    expect(
      screen.getByRole('img', { name: 'Payment QR code' }),
    ).toBeInTheDocument();
    expect(document.querySelector('[role=dialog] footer')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText('Payment received')).toBeInTheDocument();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    const count = mocks.invoke.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(count);
  });

  it('keeps a query error distinct from failed payment and never creates a replacement automatically', async () => {
    mocks.invoke.mockImplementation((command, args) =>
      command !== 'cmd_tokendance_payment'
        ? Promise.resolve()
        : args.amount
          ? Promise.resolve(session())
          : Promise.reject({ code: 'network_error' }),
    );
    open();
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate payment QR code' }),
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(
      screen.getByText('Payment status unavailable. Retrying.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Payment did not complete')).toBeNull();
    expect(submits()).toHaveLength(1);
  });

  it('expires only the QR code, stops polling, and does not assert payment failure or create a new order', async () => {
    mocks.invoke.mockImplementation((command) =>
      Promise.resolve(
        command === 'cmd_tokendance_payment'
          ? { ...session(), expired_at: Date.now() / 1000 + 4 }
          : undefined,
      ),
    );
    open();
    fireEvent.click(
      screen.getByRole('button', { name: 'Generate payment QR code' }),
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.queryByRole('img', { name: 'Payment QR code' })).toBeNull();
    expect(screen.queryByText('Payment did not complete')).toBeNull();
    const calls = mocks.invoke.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(calls);
    expect(submits()).toHaveLength(1);
  });
});
