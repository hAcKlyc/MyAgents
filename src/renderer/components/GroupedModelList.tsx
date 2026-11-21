import { useContext, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Provider } from '@/config/types';
import { CheckIcon, ChevronRightIcon } from '@/components/icons';
import { ModalityBadges } from '@/components/ModalityBadges';
import { PopoverAnchorContext } from '@/components/ui/Popover';
import { isImeComposingEvent } from '@/utils/imeKeyboard';

interface ModelListRow {
  id: string;
  name: string;
  suffix?: ReactNode;
  select: () => void;
}

export interface ModelListGroup {
  id: string;
  name: string;
  models: ModelListRow[];
  badge?: ReactNode;
  notice?: ReactNode;
}

/** Group an existing, ordered catalogue without reinterpreting eligibility or selection. */
export function groupModelRows<T>(
  options: readonly T[],
  describe: (option: T) => { groupId: string; groupName: string; row: ModelListRow },
): ModelListGroup[] {
  const groups = new Map<string, ModelListGroup>();
  for (const option of options) {
    const { groupId, groupName, row } = describe(option);
    let group = groups.get(groupId);
    if (!group) {
      group = { id: groupId, name: groupName, models: [] };
      groups.set(groupId, group);
    }
    group.models.push(row);
  }
  return [...groups.values()];
}

export function providerModelGroups(
  providers: readonly Provider[],
  select: (providerId: string, model: string) => void,
  showModalities = false,
  decorations?: (provider: Provider) => Pick<ModelListGroup, 'badge' | 'notice'>,
): ModelListGroup[] {
  return providers.map(provider => ({
    ...decorations?.(provider),
    id: provider.id,
    name: provider.name,
    models: provider.models.map(model => ({
      id: model.model,
      name: model.modelName || model.model,
      suffix: showModalities && <ModalityBadges modalities={model.inputModalities} />,
      select: () => select(provider.id, model.model),
    })),
  }));
}

interface Props {
  groups: ModelListGroup[];
  selectedGroupId?: string;
  selectedModelId?: string;
  /** May point at the inherited provider while the follow option owns the checkmark. */
  preferredGroupId?: string;
  follow?: { name: string; selected: boolean; select: () => void };
  onDismiss: () => void;
  /** A CLI owns one catalogue with no provider navigation. */
  flat?: boolean;
  children?: ReactNode;
}

const check = <CheckIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />;

export function GroupedModelList({
  groups, selectedGroupId, selectedModelId, preferredGroupId, follow, onDismiss, flat, children,
}: Props) {
  const [browsed, setBrowsed] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const anchorOffset = useRef<number | null>(null);
  const interacted = useRef(false);
  const id = useId();
  const anchor = useContext(PopoverAnchorContext);
  const focusedRow = useRef<HTMLElement | null>(null);
  const preferred = selectedGroupId ?? preferredGroupId;
  if (browsed !== null && !groups.some(group => group.id === browsed)) {
    setBrowsed(null);
  }
  const expanded = browsed ?? groups.find(group => group.id === preferred)?.id ?? groups[0]?.id;
  const selected = groups.find(group => group.id === selectedGroupId)?.models.find(row => row.id === selectedModelId);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !anchor) return;
    const header = list.querySelector<HTMLButtonElement>('[aria-expanded="true"]');
    if (anchorOffset.current !== null && header) {
      const target = Math.max(0, Math.min(anchorOffset.current, list.clientHeight - header.offsetHeight - 64));
      list.scrollTop = header.offsetTop - target;
      anchorOffset.current = null;
    } else if (!interacted.current || (focusedRow.current && !focusedRow.current.isConnected && document.activeElement === document.body)) {
      const row = list.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? header ?? list.querySelector('button');
      if (row) {
        list.scrollTop = Math.max(0, Math.min(list.scrollHeight - list.clientHeight,
          row.offsetTop - (list.clientHeight - row.offsetHeight) / 2));
        if (!focusedRow.current || !focusedRow.current.isConnected) {
          row.focus({ preventScroll: true });
        }
      }
    }
  }, [anchor, expanded, groups, selected?.id, selectedGroupId, follow?.selected]);

  function pick(action: () => void) {
    anchor?.current?.focus({ preventScroll: true });
    action();
  }

  function rowButton(row: ModelListRow, active: boolean) {
    return (
      <button key={row.id} type="button" data-selected-model-row={active ? '' : undefined}
        aria-current={active || undefined} title={row.name}
        onClick={event => { event.stopPropagation(); pick(row.select); }}
        className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm ${active
          ? 'bg-[var(--accent)]/10 font-medium text-[var(--accent)]'
          : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'}`}>
        <span className="min-w-0 truncate">{row.name}</span>{active && check}{' '}{row.suffix}
      </button>
    );
  }

  return (
    <div ref={listRef} data-model-list className="relative min-h-0 max-h-[364px] overflow-y-auto overscroll-contain p-1.5 [overflow-anchor:none]"
      onFocusCapture={event => { focusedRow.current = event.target; }}
      onPointerDownCapture={() => { interacted.current = true; }}
      onWheel={() => { interacted.current = true; }}
      onTouchMove={() => { interacted.current = true; }}
      onKeyDown={event => {
        if (isImeComposingEvent(event)) return;
        interacted.current = true;
        if (event.key === 'Escape') {
          event.stopPropagation();
          pick(onDismiss);
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = index + (event.key === 'ArrowUp' ? -1 : 1);
          event.preventDefault();
          buttons[Math.max(0, Math.min(next, buttons.length - 1))]?.focus();
        }
      }}>
      {follow && rowButton({ ...follow, id: 'follow' }, follow.selected)}
      {groups.map((group, index) => {
        const open = group.id === expanded;
        const groupDomId = `${id}-${index}`;
        return (
          <div key={group.id}>
            {flat ? (group.name && <div className="px-2 py-1 text-xs font-medium text-[var(--ink-muted)]">{group.name}</div>) : (
              <button type="button" aria-expanded={open} aria-controls={groupDomId}
                onClick={event => {
                  event.stopPropagation();
                  interacted.current = true;
                  event.currentTarget.focus({ preventScroll: true });
                  if (open) return;
                  anchorOffset.current = event.currentTarget.offsetTop - (listRef.current?.scrollTop ?? 0);
                  setBrowsed(group.id);
                }}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-semibold text-[var(--ink)] ${open ? 'bg-[var(--paper-inset)]' : 'hover:bg-[var(--hover-bg)]'}`}>
                <ChevronRightIcon aria-hidden="true" className={`h-3 w-3 shrink-0 text-[var(--ink-muted)] ${open ? 'rotate-90' : ''}`} />
                <span className="truncate" title={group.name}>{group.name}</span>{' '}{group.badge}{' '}
                {!open && group.id === selectedGroupId && selected && (
                  <span className="ml-auto flex min-w-0 items-center gap-1 text-xs font-medium text-[var(--accent)]">
                    <span className="truncate">{selected.name}</span>{check}
                  </span>
                )}
              </button>
            )}
            <div id={groupDomId} hidden={!open} className={flat ? undefined : "py-0.5 pl-4"}>
              {open && <>{group.notice}{group.models.map(row => rowButton(row, group.id === selectedGroupId && row.id === selectedModelId))}</>}
            </div>
          </div>
        );
      })}
      {children}
    </div>
  );
}
