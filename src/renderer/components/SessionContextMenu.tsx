import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChartIcon,
  CopyIcon,
  EditIcon,
  PinIcon,
  PinOffIcon,
  StarIcon,
  TrashIcon,
} from '@/components/icons';
import { useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { updateSession, type SessionMetadata } from '@/api/sessionClient';
import { useToast } from '@/components/Toast';
import { MenuItem } from '@/components/ui/MenuItem';
import { Popover, type PopoverPlacement } from '@/components/ui/Popover';
import SessionTagMenuItem, { type GlobalUserTagChange } from '@/components/session-tags/SessionTagMenuItem';
import SessionRenameDialog from '@/components/SessionRenameDialog';

interface SessionContextMenuProps {
    open: boolean;
    onClose: () => void;
    anchorRef: RefObject<HTMLElement | null>;
    placement?: PopoverPlacement;
    session: SessionMetadata;
    deleteProtected: boolean;
    onCopySessionId: () => void | Promise<void>;
    onToggleFavorite: () => void | Promise<void>;
    onTogglePin?: () => void | Promise<void>;
    onRenameSession: (sessionId: string, title: string) => Promise<SessionMetadata | null>;
    onShowStats: (origin?: HTMLElement | null) => void;
    onDelete: (origin?: HTMLElement | null) => void;
    onSessionMutationStart: (sessionId: string, scope?: 'session' | 'global') => number;
    onSessionUpdated?: (session: SessionMetadata, mutationSequence: number) => boolean;
    onGlobalTagChange?: (change: GlobalUserTagChange) => void;
    onArchiveChanged?: () => void;
    onRefreshSessions: () => void;
}

/**
 * The single owner of the Session resource menu shared by the global sidebar
 * and history-search overlay. Keep item order, labels and action hints here
 * so the two entry points cannot drift.
 */
export default function SessionContextMenu({
    open,
    onClose,
    anchorRef,
    placement = 'bottom-end',
    session,
    deleteProtected,
    onCopySessionId,
    onToggleFavorite,
    onTogglePin,
    onRenameSession,
    onShowStats,
    onDelete,
    onSessionMutationStart,
    onSessionUpdated,
    onGlobalTagChange,
    onArchiveChanged,
    onRefreshSessions,
}: SessionContextMenuProps) {
    const { t } = useTranslation('launcher');
    const toast = useToast();
    const archivePending = useRef(false);
    const [archiving, setArchiving] = useState(false);
    const [tagLayerOpen, setTagLayerOpen] = useState(false);
    const [renameOpen, setRenameOpen] = useState(false);

    const toggleArchive = async () => {
        if (archivePending.current) return;
        archivePending.current = true;
        setArchiving(true);
        const archived = session.archived !== true;
        const sequence = onSessionMutationStart(session.id);
        try {
            const updated = await updateSession(session.id, { archived });
            if (!updated) throw new Error('Session no longer exists.');
            const applied = onSessionUpdated?.(updated, sequence);
            onClose();
            onArchiveChanged?.();
            if (applied === false) {
                onRefreshSessions();
                toast.info(t('rightRail.archiveStateRefreshing'));
            } else {
                toast.success(t(archived ? 'rightRail.archivedSuccess' : 'rightRail.restoredSuccess'));
            }
        } catch (error) {
            console.error('[SessionContextMenu] Failed to update archive state:', error);
            toast.error(t('rightRail.archiveFailedRetry'));
        } finally {
            archivePending.current = false;
            setArchiving(false);
        }
    };

    const closeRename = () => {
        setRenameOpen(false);
        onClose();
    };

    return (
        <>
            <Popover
                open={open && !renameOpen}
                onClose={onClose}
                anchorRef={anchorRef}
                placement={placement}
                offset={placement === 'bottom-start' ? 0 : undefined}
                className="session-context-menu global-sidebar-nested-layer w-44 py-1"
                closeOnOutsideClick={!tagLayerOpen}
                closeOnEscape={!tagLayerOpen}
            >
                <MenuItem
                    icon={<CopyIcon className="h-3.5 w-3.5" />}
                    label={t('rightRail.copySessionId')}
                    onClick={() => {
                        onClose();
                        void onCopySessionId();
                    }}
                />
                <MenuItem
                    icon={<EditIcon className="h-3.5 w-3.5" />}
                    label={t('rightRail.rename')}
                    onClick={() => setRenameOpen(true)}
                />
                {onTogglePin && (
                    <MenuItem
                        icon={session.pinnedAt
                            ? <PinOffIcon className="h-3.5 w-3.5" />
                            : <PinIcon className="h-3.5 w-3.5" />}
                        label={session.pinnedAt ? t('rightRail.unpin') : t('rightRail.pin')}
                        onClick={() => {
                            onClose();
                            void onTogglePin();
                        }}
                    />
                )}
                <MenuItem
                    icon={<StarIcon className="h-3.5 w-3.5" fill={session.favorite ? 'currentColor' : 'none'} />}
                    label={session.favorite ? t('rightRail.unfavorite') : t('rightRail.favorite')}
                    onClick={() => {
                        onClose();
                        void onToggleFavorite();
                    }}
                />
                <SessionTagMenuItem
                    session={session}
                    onMutationStart={onSessionMutationStart}
                    onSessionUpdated={onSessionUpdated ?? (() => true)}
                    onGlobalTagChange={onGlobalTagChange}
                    onSubmenuOpenChange={setTagLayerOpen}
                />
                <MenuItem
                    icon={<ChartIcon className="h-3.5 w-3.5" />}
                    label={t('rightRail.viewStats')}
                    onClick={() => {
                        onClose();
                        onShowStats(anchorRef.current);
                    }}
                />
                <MenuItem
                    icon={session.archived
                        ? <ArchiveRestoreIcon className="h-3.5 w-3.5" />
                        : <ArchiveIcon className="h-3.5 w-3.5" />}
                    label={t(session.archived ? 'rightRail.restore' : 'rightRail.archive')}
                    disabled={archiving}
                    onClick={() => { void toggleArchive(); }}
                />
                <MenuItem
                    icon={<TrashIcon className="h-3.5 w-3.5" />}
                    label={t('rightRail.delete')}
                    tone="danger"
                    title={deleteProtected ? t('rightRail.deleteBlockedByOwner') : undefined}
                    onClick={() => {
                        onClose();
                        onDelete(anchorRef.current);
                    }}
                />
            </Popover>
            {renameOpen && (
                <SessionRenameDialog
                    currentTitle={session.title}
                    onCancel={closeRename}
                    onConfirm={async (title) => {
                        const updated = await onRenameSession(session.id, title);
                        if (!updated) throw new Error('Session no longer exists.');
                        closeRename();
                    }}
                />
            )}
        </>
    );
}
