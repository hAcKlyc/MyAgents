import { ChevronDownIcon, ChevronUpIcon } from "@/components/icons";
import { useLayoutEffect, useRef, type KeyboardEventHandler } from "react";
import { useTranslation } from "react-i18next";
import { resolveWorkspaceIconId } from "@/assets/workspace-icons";
import WorkspaceIcon from "@/components/launcher/WorkspaceIcon";
import { FileIcon } from "@/components/file-icon";
import {
  findHighlightRanges,
  renderTextWithHighlights,
} from "@/utils/highlightSearchMatches";
import { retainFocusOnMouseDown } from "@/utils/focusRetention";
import { ThoughtPickerRow } from "./ThoughtPickerRow";
import type {
  MentionOption,
  useMentionPicker,
} from "../hooks/useMentionPicker";

type Picker = ReturnType<typeof useMentionPicker>;
export function MentionPicker({
  picker,
  query,
  onChoose,
  onKeyDown,
  localWorkspaceIcons = {},
}: {
  localWorkspaceIcons?: Readonly<Record<string, string | undefined>>;
  picker: Picker;
  query: string;
  onChoose: (option: MentionOption) => void;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
}) {
  const { t } = useTranslation("chat");
  const list = useRef<HTMLDivElement>(null);
  const highlight = (text: string) =>
    query.trim()
      ? renderTextWithHighlights(text, findHighlightRanges(text, query))
      : text;
  useLayoutEffect(() => {
    const selected = list.current?.querySelector('[aria-selected="true"]');
    selected?.scrollIntoView?.({ block: "nearest" });
  }, [picker.selectedKey]);
  const visibleGroups = query.trim()
    ? picker.groups.filter(
        (group) =>
          group.items.length ||
          group.loading ||
          group.error ||
          group.partial ||
          group.unavailable,
      )
    : picker.groups;
  return (
    <div
      ref={list}
      role="listbox"
      aria-label={t("input.mention.results")}
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-auto py-1"
    >
      {picker.loading ? (
        <p role="status" className="px-3 py-3 text-sm text-[var(--ink-muted)]">
          {t("input.mention.searching")}
        </p>
      ) : (
        <>
          {visibleGroups.length === 0 && (
            <p className="px-3 py-3 text-sm text-[var(--ink-muted)]">
              {t("input.mention.noMatches")}
            </p>
          )}
          {visibleGroups.map((group) => (
            <div
              key={group.kind}
              role="group"
              aria-label={t(`input.mention.group.${group.kind}`)}
            >
              <div className="flex items-center gap-2 px-3 pb-1 pt-2 text-xs font-medium text-[var(--ink-muted)]">
                {t(`input.mention.group.${group.kind}`)}
                {group.loading && (
                  <span className="font-normal">
                    {t("input.mention.searching")}
                  </span>
                )}
              </div>
              {picker.options(group).map((option) => {
                const active = option.key === picker.selectedKey;
                const isItem = ["agent", "thought", "file"].includes(
                  option.kind,
                );
                return (
                  <button
                    key={option.key}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseDown={retainFocusOnMouseDown}
                    onFocus={() => picker.select(option.key)}
                    onMouseEnter={() => picker.select(option.key)}
                    onClick={() => onChoose(option)}
                    className={`block w-full text-left ${active ? "bg-[var(--accent)]/10" : "hover:bg-[var(--hover-bg)]"} ${!isItem ? "px-3 py-1.5 text-xs text-[var(--ink-muted)]" : ""}`}
                  >
                    {option.kind === "agent" ? (
                      <span className="flex items-center gap-2.5 px-3 py-2">
                        <WorkspaceIcon
                          icon={
                            option.value.agent.isLocal
                              ? localWorkspaceIcons[option.value.agent.selector]
                              : resolveWorkspaceIconId(option.value.agent.icon || "robot") ?? "robot"
                          }
                          size={16}
                          className="shrink-0"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">
                              {highlight(option.value.agent.name)}
                            </span>
                            <span className="max-w-[45%] truncate text-xs text-[var(--ink-muted)]">
                              {option.value.agent.isLocal
                                ? t("input.mention.local")
                                : highlight(
                                    [option.value.agent.networkName,option.value.agent.deviceName].filter(Boolean).join(" · ") || "—",
                                  )}
                            </span>
                          </span>
                          {option.value.agent.description && (
                            <span
                              title={option.value.agent.description}
                              className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]"
                            >
                              {highlight(option.value.agent.description)}
                            </span>
                          )}
                        </span>
                      </span>
                    ) : option.kind === "thought" ? (
                      <ThoughtPickerRow thought={option.value} query={query} />
                    ) : option.kind === "file" ? (
                      <span className="flex items-center gap-2.5 px-3 py-2">
                        <FileIcon name={option.value.name} />
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--ink)]">
                          {highlight(option.value.name)}
                        </span>
                        <span
                          title={option.value.path}
                          className="max-w-[50%] truncate text-xs text-[var(--ink-muted)]"
                        >
                          {parentPath(
                            option.value.path,
                            t("input.workspaceRoot"),
                          )}
                        </span>
                      </span>
                    ) : (
                      <span className={`flex items-center gap-1 ${option.kind !== "retry" ? "justify-center" : ""}`}>
                        {option.kind === "collapse" ? (
                          <ChevronUpIcon size={12} />
                        ) : (
                          <ChevronDownIcon size={12} />
                        )}
                        {t(`input.mention.${option.kind}`)}
                      </span>
                    )}
                  </button>
                );
              })}
              {group.unavailable && (
                <p className="px-3 py-2 text-xs text-[var(--ink-muted)]">
                  {t("input.mention.unavailable")}
                </p>
              )}
              {!group.loading &&
                !group.error &&
                !group.unavailable &&
                !group.partial &&
                !group.items.length && (
                  <p className="px-3 py-2 text-xs text-[var(--ink-muted)]">
                    {t(
                      query ? "input.mention.noMatches" : "input.mention.empty",
                    )}
                  </p>
                )}
              {group.error && (
                <p
                  role="status"
                  className="px-3 py-1 text-xs text-[var(--ink-muted)]"
                >
                  {t("input.mention.failed")}
                </p>
              )}
              {group.partial && group.kind === "agent" && (
                <p
                  role="status"
                  className="px-3 py-1 text-xs text-[var(--ink-muted)]"
                >
                  {t("input.mention.networkPartial")}
                </p>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
function parentPath(path: string, root: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? root : path.slice(0, index);
}
