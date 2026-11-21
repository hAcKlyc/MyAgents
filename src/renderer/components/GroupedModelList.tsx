import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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

/** Keep just the exiting rows until their height transition has finished. */
function ModelGroupPanel({ id, open, renderRows }: { id: string; open: boolean; renderRows: () => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open || !mounted) return;
    let current = true;
    const transitions = ref.current?.getAnimations?.() ?? [];
    void Promise.allSettled(transitions.map(animation => animation.finished)).then(() => {
      if (current) setMounted(false);
    });
    return () => { current = false; };
  }, [mounted, open]);

  return (
    <div ref={ref} id={id} inert={!open} aria-hidden={!open}
      className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
      <div className="min-h-0 overflow-hidden">
        {mounted && <div className="py-0.5 pl-4">{renderRows()}</div>}
      </div>
    </div>
  );
}

export function GroupedModelList({
  groups, selectedGroupId, selectedModelId, preferredGroupId, follow, onDismiss, flat, children,
}: Props) {
  // undefined follows the opening default; null is an explicit collapse for this visit.
  const [browsed, setBrowsed] = useState<string | null>();
  const listRef = useRef<HTMLDivElement>(null);
  const anchorOffset = useRef<number | null>(null);
  const interacted = useRef(false);
  const id = useId();
  const anchor = useContext(PopoverAnchorContext);
  const focusedRow = useRef<HTMLElement | null>(null);
  const preferred = selectedGroupId ?? preferredGroupId;
  if (typeof browsed === 'string' && !groups.some(group => group.id === browsed)) {
    setBrowsed(undefined);
  }
  const expanded = flat || browsed === undefined
    ? groups.find(group => group.id === preferred)?.id ?? groups[0]?.id
    : browsed;
  const selected = groups.find(group => group.id === selectedGroupId)?.models.find(row => row.id === selectedModelId);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !anchor) return;
    const header = list.querySelector<HTMLButtonElement>('[aria-expanded="true"]');
    if (anchorOffset.current !== null && header) {
      // The preceding group may still be shrinking above this header.
      const folds = list.getAnimations?.({ subtree: true }).filter(animation =>
        'transitionProperty' in animation && animation.transitionProperty === 'grid-template-rows');
      let frame = 0;
      const alignHeader = () => {
        if (anchorOffset.current === null) return;
        const target = Math.max(0, Math.min(anchorOffset.current, list.clientHeight - header.offsetHeight - 64));
        list.scrollTop = header.offsetTop - target;
        if (folds?.some(animation => animation.playState === 'running' || animation.pending)) {
          frame = requestAnimationFrame(alignHeader);
        } else {
          anchorOffset.current = null;
        }
      };
      alignHeader();
      return () => cancelAnimationFrame(frame);
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

  function startInteraction() {
    interacted.current = true;
    anchorOffset.current = null;
  }

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
      onPointerDownCapture={startInteraction}
      onWheel={startInteraction}
      onTouchMove={startInteraction}
      onKeyDown={event => {
        if (isImeComposingEvent(event)) return;
        startInteraction();
        if (event.key === 'Escape') {
          event.stopPropagation();
          pick(onDismiss);
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([inert] *)'));
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
        const renderRows = () => (
          <>
            {group.notice}
            {group.models.map(row => rowButton(row, open && group.id === selectedGroupId && row.id === selectedModelId))}
          </>
        );
        return (
          <div key={group.id}>
            {flat ? (group.name && <div className="px-2 py-1 text-xs font-medium text-[var(--ink-muted)]">{group.name}</div>) : (
              <button type="button" aria-expanded={open} aria-controls={groupDomId}
                onClick={event => {
                  event.stopPropagation();
                  interacted.current = true;
                  event.currentTarget.focus({ preventScroll: true });
                  anchorOffset.current = open ? null : event.currentTarget.offsetTop - (listRef.current?.scrollTop ?? 0);
                  setBrowsed(open ? null : group.id);
                }}
                className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm font-semibold text-[var(--ink)] ${open ? 'bg-[var(--paper-inset)]' : 'hover:bg-[var(--hover-bg)]'}`}>
                <ChevronRightIcon aria-hidden="true" className={`h-3 w-3 shrink-0 text-[var(--ink-muted)] transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
                <span className="truncate" title={group.name}>{group.name}</span>{' '}{group.badge}{' '}
                {!open && group.id === selectedGroupId && selected && (
                  <span className="ml-auto flex min-w-0 items-center gap-1 text-xs font-medium text-[var(--accent)]">
                    <span className="truncate">{selected.name}</span>{check}
                  </span>
                )}
              </button>
            )}
            {flat ? (open && renderRows()) : <ModelGroupPanel id={groupDomId} open={open} renderRows={renderRows} />}
          </div>
        );
      })}
      {children}
    </div>
  );
}
