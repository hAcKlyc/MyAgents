/**
 * ContextUsageIndicator — 对话框右下角的实时 context 用量指示器（PRD 0.2.32）。
 *
 * 形态（V1 极简）：model 选择器左侧一个环形进度，hover 弹出极简卡片完整展示用量。
 * 支持手动压缩的 runtime 在卡片内提供「智能压缩」入口；能力由 Chat 注入。
 *
 * 关键约束：
 * - **自取数**：通过 `useTabState()` 直接订阅 `contextUsage` 切片，**不**经由
 *   SimpleChatInput 的 props 传入——否则 Codex 亚轮流式更新会重渲整个输入框（含 textarea），
 *   打穿 SimpleChatInput 的 React.memo。由 Chat.tsx 作为 `contextIndicator` slot 注入。
 * - 压缩动作的 model/providerEnv 解析归 Chat.tsx（与正常发送同参），经 `onCompact` 注入，
 *   避免本组件误切 provider。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MinimizeIcon } from '@/components/icons';
import { useTranslation } from 'react-i18next';

import { useTabState } from '@/context/TabContext';
import Popover from './ui/Popover';
import Tip from './Tip';

/** hover 离开后延迟关闭，给「环 → 卡片」鼠标移动留缓冲（safe-bridge 替代）。 */
const HOVER_CLOSE_DELAY_MS = 140;

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(2)}M`;
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

/** SVG 环形进度（从顶部顺时针）。单色 accent，V1 极简。 */
function Ring({ percent, size, stroke }: { percent: number; size: number; stroke: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.min(100, Math.max(0, percent)) / 100);
  const half = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)', display: 'block' }}>
      <circle cx={half} cy={half} r={r} fill="none" stroke="var(--line-strong)" strokeWidth={stroke} />
      <circle
        cx={half}
        cy={half}
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 0.45s cubic-bezier(0.22, 0.61, 0.36, 1)' }}
      />
    </svg>
  );
}

export interface ContextUsageIndicatorProps {
  /**
   * 触发智能压缩。Chat.tsx 负责选择 builtin SDK 命令或 Runtime 原生控制面；
   * 未提供时不渲染压缩按钮。
   */
  onCompact?: () => void;
}

export default function ContextUsageIndicator({ onCompact }: ContextUsageIndicatorProps) {
  const { t } = useTranslation('app');
  const { contextUsage, isLoading } = useTabState();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  }, [cancelClose]);
  const openNow = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]); // clear pending timer on unmount

  // No usage yet (fresh session, before the first turn) — render nothing rather
  // than a meaningless 0% ring.
  // (review #W3 — open/timer local state is reset across sessions by remounting:
  // Chat.tsx keys this component on sessionId, so a session switch can't leave the
  // popover open without a hover.)
  if (!contextUsage) return null;

  const { contextTokens, contextWindow, usedPercent } = contextUsage;
  const showCompact = !!onCompact;

  return (
    <span
      ref={anchorRef}
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      className="flex h-[30px] cursor-default items-center justify-center rounded-lg px-1 transition-colors hover:bg-[var(--hover-bg)]"
      aria-label={t('contextUsage.aria', { percent: usedPercent.toFixed(0) })}
    >
      <Ring percent={usedPercent} size={18} stroke={2} />

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        placement="top"
        offset={10}
        unstyled
        className="w-[250px]"
      >
        {/* unstyled：自带 chrome 但不加 overflow-hidden，让 Tip 气泡可溢出卡片上沿 */}
        <div
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-4 pb-3 pt-3.5 shadow-xl"
        >
          {/* 头部：标题 + runtime capability 驱动的智能压缩入口 */}
          <div className="mb-3 flex min-h-[24px] items-center justify-between">
            <span className="text-xs font-semibold text-[var(--ink-muted)]">{t('contextUsage.title')}</span>
            {showCompact && (
              <Tip label={t('contextUsage.compactTip')} position="top" align="end">
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => {
                    onCompact?.();
                    setOpen(false);
                  }}
                  className="flex items-center gap-1 rounded-lg border border-[var(--accent-warm-muted)] bg-[var(--accent-warm-subtle)] px-2 py-1 text-xs font-semibold leading-none text-[var(--accent)] transition-colors hover:border-[var(--accent)] hover:bg-[var(--accent-warm-muted)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <MinimizeIcon className="h-3 w-3" />
                  {t('contextUsage.compact')}
                </button>
              </Tip>
            )}
          </div>

          {/* 主体：大号百分比 + 小环 */}
          <div className="mb-2.5 flex items-center gap-3.5">
            <div className="flex-1">
              <div className="text-3xl font-bold leading-none tracking-tight tabular-nums text-[var(--ink)]">
                {usedPercent.toFixed(1)}%
              </div>
              <div className="mt-1.5 text-xs text-[var(--ink-muted)]">{t('contextUsage.usedLabel')}</div>
            </div>
            <Ring percent={usedPercent} size={44} stroke={3.5} />
          </div>

          {/* tokens 行 */}
          <div className="text-xs tabular-nums text-[var(--ink-muted)]">
            <span className="font-semibold text-[var(--ink-secondary)]">{formatTokens(contextTokens)}</span>
            {' / '}
            {formatTokens(contextWindow)} tokens
          </div>
          {contextUsage.windowSource === 'safety-budget' && (
            <div className="mt-1.5 text-xs text-[var(--ink-muted)]">
              {t('contextUsage.operationalBudget', {
                capacity: contextUsage.declaredContextWindow ? formatTokens(contextUsage.declaredContextWindow) : '—',
              })}
            </div>
          )}
        </div>
      </Popover>
    </span>
  );
}
