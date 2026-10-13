import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  GripIcon,
  MoreIcon,
  FolderIcon,
  EditIcon,
  TrashIcon,
} from '@/components/icons';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import CustomSelect from '@/components/CustomSelect';
import { MenuItem } from '@/components/ui/MenuItem';
import { Popover } from '@/components/ui/Popover';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { isImeComposingEvent } from '@/utils/imeKeyboard';
import type { SidebarSection } from '@/utils/sidebarOrganization';

export function SortableSidebarRow({
  id,
  container,
  label,
  disabled,
  children,
}: {
  id: string;
  container: string;
  label: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation('app');
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled,
    data: { kind: 'item', container, label },
  });
  return (
    <div
      ref={setNodeRef}
      className="group/drag relative"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.35 : undefined,
      }}
      data-sidebar-item={id}
      onPointerDown={(event) => {
        const target = event.target;
        if (disabled || !(target instanceof Element) || target.closest('[data-sidebar-item]') !== event.currentTarget) return;
        if (target.closest('[data-sidebar-drag-surface]')) listeners?.onPointerDown?.(event);
      }}
    >
      {children}
      {!disabled && (
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          className="absolute left-0 top-0 z-[1] flex h-8 w-4 cursor-grab touch-none items-center justify-center rounded text-[var(--ink-muted)] opacity-0 hover:bg-[var(--hover-bg)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] group-hover/drag:opacity-100 active:cursor-grabbing"
          aria-label={t('globalSidebar.dragItem', { name: label })}
          title={t('globalSidebar.dragHint')}
        >
          <GripIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function SidebarContainer({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `container:${id}`,
    data: { kind: 'container', container: id },
  });
  return (
    <div
      ref={setNodeRef}
      data-sidebar-container={id}
      className={`min-h-8 rounded-lg ${isOver ? 'bg-[var(--accent-subtle)] ring-1 ring-inset ring-[var(--accent)]' : ''}`}
    >
      {children}
    </div>
  );
}

export function SidebarSectionHeader({
  section,
  onToggle,
  onRename,
  onDelete,
  onMenuChange,
}: {
  section: SidebarSection;
  onToggle: () => void;
  onRename: (origin: HTMLElement) => void;
  onDelete: () => void;
  onMenuChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('app');
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
  } = useSortable({
    id: `section-drag:${section.id}`,
    data: { kind: 'section', container: section.id, label: section.name },
  });
  const setMenu = (open: boolean) => {
    setMenuOpen(open);
    onMenuChange(open);
  };
  const onMenuChangeRef = useRef(onMenuChange);
  useEffect(() => { onMenuChangeRef.current = onMenuChange; }, [onMenuChange]);
  useEffect(() => () => onMenuChangeRef.current(false), []);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className="group/section relative flex h-8 items-center gap-1"
      data-sidebar-section-header={section.id}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('globalSidebar.dragItem', { name: section.name })}
        className="flex h-8 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-[var(--ink-muted)] opacity-0 focus-visible:opacity-100 group-hover/section:opacity-100"
      >
        <GripIcon className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!section.collapsed}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-xs font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        {section.collapsed ? (
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="truncate">{section.name}</span>
      </button>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setMenu(!menuOpen)}
        aria-label={t('globalSidebar.sectionOptions', { name: section.name })}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
      >
        <MoreIcon className="h-3.5 w-3.5" />
      </button>
      <Popover
        open={menuOpen}
        onClose={() => setMenu(false)}
        anchorRef={anchorRef}
        placement="bottom-end"
        className="global-sidebar-nested-layer w-48 py-1"
      >
        <MenuItem
          icon={<EditIcon className="h-3.5 w-3.5" />}
          label={t('globalSidebar.renameSection')}
          onClick={() => {
            setMenu(false);
            if (anchorRef.current) onRename(anchorRef.current);
          }}
        />
        <MenuItem
          icon={<TrashIcon className="h-3.5 w-3.5" />}
          label={t('globalSidebar.deleteSection')}
          title={t('globalSidebar.deleteSectionHint')}
          onClick={() => {
            setMenu(false);
            onDelete();
          }}
        />
      </Popover>
    </div>
  );
}

export type OrganizationDialogState =
  | {
      kind: 'create' | 'rename';
      sectionId?: string;
      name: string;
      origin: HTMLElement | null;
    }
  | {
      kind: 'move';
      itemId: string;
      name: string;
      container: string;
      defaultContainer: string;
      origin: HTMLElement | null;
    };

export function SidebarOrganizationDialog({
  state,
  sections,
  onClose,
  onSubmit,
}: {
  state: OrganizationDialogState;
  sections: readonly SidebarSection[];
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const { t } = useTranslation('app');
  const [value, setValue] = useState(
    state.kind === 'move' ? state.container : state.name,
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const normalized = value.trim();
  useCloseLayer(() => {
    onClose();
    return true;
  }, 100);
  useEffect(() => {
    (inputRef.current ?? dialogRef.current?.querySelector<HTMLButtonElement>('button'))?.focus();
    inputRef.current?.select();
  }, []);
  const title = t(
    state.kind === 'create'
      ? 'globalSidebar.createSection'
      : state.kind === 'rename'
        ? 'globalSidebar.renameSection'
        : 'globalSidebar.moveToSection',
  );
  return (
    <OverlayBackdrop portal className="z-[210] px-4" onClose={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidebar-organization-title"
        className="w-full max-w-sm rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl"
        onKeyDown={(event) => {
          if (isImeComposingEvent(event)) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key === 'Tab') {
            const nodes = Array.from(
              dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input, select',
              ) ?? [],
            );
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2
          id="sidebar-organization-title"
          className="mb-4 text-lg font-semibold text-[var(--ink)]"
        >
          {title}
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (normalized) onSubmit(normalized);
          }}
        >
          <label
            className="mb-2 block text-sm text-[var(--ink-muted)]"
            htmlFor="sidebar-organization-value"
          >
            {state.kind === 'move'
              ? state.name
              : t('globalSidebar.sectionName')}
          </label>
          {state.kind === 'move' ? (
            <CustomSelect value={value} onChange={setValue} size="md" ariaLabel={state.name}
              options={[{ value: state.defaultContainer, label: t(state.itemId.startsWith('session:') ? 'globalSidebar.originalAgent' : 'globalSidebar.unsectioned') }, ...sections.map((section) => ({ value: section.id, label: section.name }))]} />
          ) : (
            <input
              ref={inputRef}
              id="sidebar-organization-value"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={80}
              className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)]"
            />
          )}
          {state.kind === 'move' && (
            <p className="mt-2 text-xs text-[var(--ink-muted)]">
              {t('globalSidebar.organizeOnly')}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-lg px-3 text-sm text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
            >
              {t('globalSidebar.cancel')}
            </button>
            <button
              type="submit"
              disabled={!normalized}
              className="h-9 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm text-[var(--button-primary-text)] disabled:opacity-50"
            >
              {t('globalSidebar.save')}
            </button>
          </div>
        </form>
      </div>
    </OverlayBackdrop>
  );
}

export function SidebarMoveMenuItem({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('app');
  return (
    <MenuItem
      icon={<FolderIcon className="h-3.5 w-3.5" />}
      label={t('globalSidebar.moveToSection')}
      onClick={onClick}
    />
  );
}
