import { cloneElement, isValidElement } from 'react';
import type { ReactNode } from 'react';

import type { ToolUseSimple } from '@/types/chat';

import {
  getThinkingBadgeConfig,
  getThinkingExpandedLabel,
  getToolBadgeConfig,
  getToolExpandedLabel
} from './toolBadgeConfig';

// Legacy function for backward compatibility - now uses unified config
export function getToolColors(toolName: string): {
  text: string;
  icon: string;
} {
  const config = getToolBadgeConfig(toolName);
  return {
    text: config.colors.text,
    icon: config.colors.iconColor
  };
}

interface ToolHeaderProps {
  icon?: ReactNode;
  label?: string;
  toolName?: string;
  tool?: ToolUseSimple;
}

export function ToolHeader({ icon, label, toolName, tool }: ToolHeaderProps) {
  const config = toolName ? getToolBadgeConfig(toolName) : null;
  // Always use icon from unified config if toolName is provided (single source of truth)
  // Otherwise fall back to passed icon for backward compatibility
  let displayIcon = config?.icon || icon;

  // If using config icon (size-2.5), resize it to size-3 for header visibility
  // This ensures icons match between badge and header while maintaining readability
  if (config?.icon && isValidElement(displayIcon)) {
    const element = displayIcon as React.ReactElement<{ className?: string }>;
    const existingProps = element.props as { className?: string };
    const existingClassName = existingProps?.className || '';
    // Replace size-2.5 with size-3, or add size-3 if no size class exists
    const newClassName =
      existingClassName ? existingClassName.replace(/size-\d+(\.\d+)?/g, 'size-3') : 'size-3';
    displayIcon = cloneElement(element, {
      ...existingProps,
      className: newClassName
    });
  }

  // Use unified expanded label if tool is provided, otherwise use passed label or toolName
  const displayLabel = tool ? getToolExpandedLabel(tool) : label || toolName || '';

  return (
    <div
      className={`flex items-center gap-1.5 text-sm font-medium ${config?.colors.text || 'text-[var(--ink-muted)]'}`}
    >
      {displayIcon && (
        <span
          className={`flex h-4 w-4 items-center justify-center ${config?.colors.iconColor || 'text-[var(--ink-muted)]'}`}
        >
          {displayIcon}
        </span>
      )}
      <span className="tracking-tight">{displayLabel}</span>
    </div>
  );
}

export function MonoText({
  children,
  className = ''
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <code
      className={`font-mono text-sm tracking-tight text-[var(--ink)] ${className}`}
    >
      {children}
    </code>
  );
}

export function FilePath({ path }: { path: string }) {
  return (
    <MonoText className="rounded border border-[var(--line-subtle)] bg-[var(--paper-contrast)]/50 px-1.5 py-0.5">
      {path}
    </MonoText>
  );
}

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <MonoText className="rounded border border-[var(--line-subtle)] bg-[var(--paper-contrast)]/50 px-1.5 py-0.5">
      {children}
    </MonoText>
  );
}

interface ThinkingHeaderProps {
  isComplete: boolean;
  durationMs?: number;
}

export function ThinkingHeader({ isComplete, durationMs }: ThinkingHeaderProps) {
  const config = getThinkingBadgeConfig();
  const label = getThinkingExpandedLabel(isComplete, durationMs);

  // Resize icon from size-2.5 to size-3 for header visibility
  let displayIcon = config.icon;
  if (isValidElement(displayIcon)) {
    const element = displayIcon as React.ReactElement<{ className?: string }>;
    const existingProps = element.props as { className?: string };
    const existingClassName = existingProps?.className || '';
    const newClassName =
      existingClassName ? existingClassName.replace(/size-\d+(\.\d+)?/g, 'size-3') : 'size-3';
    displayIcon = cloneElement(element, {
      ...existingProps,
      className: newClassName
    });
  }

  return (
    <div className={`flex items-center gap-1.5 text-sm font-medium ${config.colors.text}`}>
      {displayIcon && (
        <span className={`flex h-4 w-4 items-center justify-center ${config.colors.iconColor}`}>
          {displayIcon}
        </span>
      )}
      <span className="tracking-wide">{label}</span>
    </div>
  );
}
