import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDownIcon,
  GitBranchIcon,
  LoaderIcon,
  LogInIcon,
  MessageIcon,
  PackageIcon,
  PlusIcon,
  SettingsIcon,
  UserPlusIcon,
  WrenchIcon,
} from '@/components/icons';

import type { SpaceInfo, SpaceListItem, SpaceSession } from "@/api/spaceCloud";
import { APP_WEB_LOGO_SRC as myagentsWebLogo } from "@/components/brand/appBrand";
import { SpaceIcon } from "./SpaceAvatar";
import { PAPER_GRID_STYLE } from "./spaceUi";

export type SpaceViewMode =
  | "issues"
  | "goals"
  | "skills"
  | "tools"
  | "settings";

function joinPolicyLabel(
  policy: string | null | undefined,
  t: (key: string) => string,
): string {
  const normalized = policy?.trim().toLowerCase() ?? "";
  if (normalized === "open_join" || normalized === "open") {
    return t("space.joinPolicies.open");
  }
  if (
    normalized === "approval_required" ||
    normalized === "approval-required"
  ) {
    return t("space.joinPolicies.approvalRequired");
  }
  return t("space.joinPolicies.unknown");
}

function spaceIconAvatarUrl(space: SpaceInfo): string | null {
  return (
    space.avatarUrl ||
    (space.spaceKind === "official" || space.slug === "official"
      ? myagentsWebLogo
      : null)
  );
}

export function SpaceLogin({
  authBusy,
  authFlow,
  onLogin,
  reauthRequired = false,
  accountName,
  onForgetAccount,
}: {
  authBusy: boolean;
  authFlow: { token: string; expiresAt: number } | null;
  onLogin: () => void;
  reauthRequired?: boolean;
  accountName?: string | null;
  onForgetAccount?: () => void;
}) {
  const { t } = useTranslation("app");
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-[var(--paper)] px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40"
        style={PAPER_GRID_STYLE}
      />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 shadow-md">
        <div className="mb-6 flex items-center gap-3">
          <img
            src={myagentsWebLogo}
            alt=""
            className="h-11 w-11 rounded-xl shadow-sm"
          />
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--accent-warm)]">
              {t("space.login.eyebrow")}
            </p>
            <h1 className="truncate text-xl font-semibold text-[var(--ink)]">
              {t("space.login.title")}
            </h1>
            <p className="text-sm text-[var(--ink-muted)]">
              {reauthRequired
                ? t("space.login.reauthDescription", { name: accountName })
                : t("space.login.description")}
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={authBusy}
          onClick={onLogin}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
        >
          {authBusy ? (
            <LoaderIcon className="h-4 w-4 animate-spin" />
          ) : (
            <LogInIcon className="h-4 w-4" />
          )}
          {authFlow
            ? t("space.login.waiting")
            : t("space.login.continueWithGoogle")}
        </button>
        <p className="mt-3 text-center text-xs text-[var(--ink-muted)]">
          {t("space.login.returnHint")}
        </p>
        {reauthRequired && onForgetAccount ? (
          <button
            type="button"
            disabled={authBusy}
            onClick={onForgetAccount}
            className="mt-3 flex h-9 w-full items-center justify-center rounded-lg text-sm text-[var(--ink-muted)] hover:bg-[var(--button-secondary-bg-hover)] hover:text-[var(--ink)] disabled:opacity-60"
          >
            {t("space.login.forgetAccount")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function SpaceSidebar({
  session,
  mode,
  onSpaceTabChange,
  onSpaceSwitch,
  onJoinSpace,
  onCreateSpace,
}: {
  session: SpaceSession;
  mode: SpaceViewMode;
  onSpaceTabChange: (mode: SpaceViewMode) => void;
  onSpaceSwitch: (spaceId: string, mode: SpaceViewMode) => void;
  onJoinSpace: () => void;
  onCreateSpace: () => void;
}) {
  const { t } = useTranslation("app");
  const canManageSpace =
    session.membership.role === "owner" || session.membership.role === "admin";
  const activeSpaceId = session.space.id || session.space.slug;
  const [expandedSpaceId, setExpandedSpaceId] = useState<string | null>(
    activeSpaceId,
  );
  const listedSpaces = session.spaces ?? [];
  const activeSpaceListed = listedSpaces.some((space) => {
    const spaceId = space.id || space.slug;
    return spaceId === activeSpaceId || space.slug === session.space.slug;
  });
  const activeSpaceFallback: SpaceListItem = {
    ...session.space,
    membership: session.membership,
    canManage: canManageSpace,
    pendingJoinRequestCount: 0,
  };
  const spaces = activeSpaceListed
    ? listedSpaces
    : [activeSpaceFallback, ...listedSpaces];
  useEffect(() => {
    setExpandedSpaceId(activeSpaceId);
  }, [activeSpaceId]);

  const communityItemsFor = (space: SpaceListItem) => {
    const canManage =
      space.canManage === true ||
      space.membership.role === "owner" ||
      space.membership.role === "admin";
    const items: Array<{
      mode: SpaceViewMode;
      label: string;
      icon: typeof MessageIcon;
      badge?: number;
    }> = [
      { mode: "issues", label: t("space.sidebar.issues"), icon: MessageIcon },
      { mode: "goals", label: t("space.sidebar.goals"), icon: GitBranchIcon },
      { mode: "skills", label: t("space.sidebar.skills"), icon: PackageIcon },
      { mode: "tools", label: t("space.sidebar.tools"), icon: WrenchIcon },
    ];
    if (canManage) {
      items.push({
        mode: "settings",
        label: t("space.sidebar.settings"),
        icon: SettingsIcon,
        badge: space.pendingJoinRequestCount,
      });
    }
    return items;
  };

  return (
    <aside className="grid w-64 shrink-0 grid-rows-[minmax(0,1fr)_auto] gap-3.5 border-r border-[var(--line)] bg-[var(--paper)]/70 p-3.5">
      <div className="min-h-0 overflow-y-auto">
        <div className="mb-2 grid gap-1.5">
          <button
            type="button"
            onClick={onJoinSpace}
            className="grid min-h-8 w-full grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-lg px-2.5 text-left text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <UserPlusIcon className="h-3.5 w-3.5" />
            <span className="truncate">
              {t("space.sidebar.joinSpace", { defaultValue: "加入空间" })}
            </span>
          </button>
          <button
            type="button"
            onClick={onCreateSpace}
            className="grid min-h-8 w-full grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-lg px-2.5 text-left text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
          >
            <PlusIcon className="h-3.5 w-3.5" />
            <span className="truncate">
              {t("space.sidebar.createSpace", { defaultValue: "创建空间" })}
            </span>
          </button>
        </div>
        <ul className="mb-2.5 grid gap-1 border-b border-[var(--line-subtle)] pb-2.5">
          {spaces.map((space) => {
            const spaceId = space.id || space.slug;
            const selected =
              spaceId === activeSpaceId || space.slug === session.space.slug;
            const expanded = expandedSpaceId === spaceId;
            const displaySpace = selected ? session.space : space;
            const communityItems = communityItemsFor(space);
            const identity = (
              <>
                <SpaceIcon
                  name={displaySpace.name}
                  avatarUrl={spaceIconAvatarUrl(displaySpace)}
                  size={32}
                  className="shadow-sm"
                />
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-semibold text-[var(--ink)]">
                    {displaySpace.name}
                  </strong>
                  <span className="mt-0.5 block truncate text-xs font-medium text-[var(--ink-muted)]">
                    {joinPolicyLabel(displaySpace.joinPolicy, t)}
                  </span>
                </span>
              </>
            );

            return (
              <li key={spaceId} className="min-w-0">
                <button
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedSpaceId((current) =>
                      current === spaceId ? null : spaceId,
                    )
                  }
                  className={`grid min-h-10 w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors ${selected ? "hover:bg-[var(--paper-elevated)]/70" : "hover:bg-[var(--hover-bg)]"}`}
                >
                  {identity}
                  <ChevronDownIcon
                    className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
                  />
                </button>
                {expanded ? (
                  <nav
                    className="mt-1 grid gap-1 border-t border-[var(--line-subtle)] pt-2 pl-5"
                    aria-label={displaySpace.name}
                  >
                    {communityItems.map((item) => {
                      const Icon = item.icon;
                      const itemSelected = selected && mode === item.mode;
                      return (
                        <button
                          key={item.mode}
                          type="button"
                          aria-label={item.label}
                          onClick={() => {
                            if (selected) {
                              onSpaceTabChange(item.mode);
                              return;
                            }
                            onSpaceSwitch(spaceId, item.mode);
                          }}
                          className={`flex min-h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-semibold transition-colors ${itemSelected ? "bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]" : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"}`}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">
                            {item.label}
                          </span>
                          {"badge" in item && item.badge ? (
                            <span className="rounded-full bg-[var(--accent-warm-subtle)] px-1.5 text-xs text-[var(--accent-warm)]">
                              {item.badge}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </nav>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

    </aside>
  );
}
