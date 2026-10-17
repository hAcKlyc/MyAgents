import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import CustomSelect from "@/components/CustomSelect";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import type { CommunityScope } from "@/features/community/api";

import {
  createFeedback,
  listFeedback,
  type FeedbackCategory,
  type FeedbackDraft,
  type FeedbackItem,
} from "./api";

const categories: FeedbackCategory[] = ["bug", "suggestion", "help"];
const field =
  "w-full rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] px-3 py-2 text-sm text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-60";

function emptyDraft(): FeedbackDraft {
  return { mutationId: crypto.randomUUID(), category: "bug", title: "", description: "" };
}

/** A retry must reuse the same mutation only when the body is unchanged; the server rejects reuse with a different body. */
function sameBody(a: FeedbackDraft, b: FeedbackDraft) {
  return a.category === b.category && a.title === b.title && a.description === b.description;
}

export default function FeedbackDialog({
  scope,
  onClose,
}: {
  scope: CommunityScope;
  onClose: () => void;
}) {
  const { t } = useTranslation("feedback");
  const [items, setItems] = useState<FeedbackItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<FeedbackDraft>(emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const pending = useRef<FeedbackDraft | null>(null);
  const mounted = useRef(true);

  useCloseLayer(() => {
    onClose();
    return true;
  }, 40);

  const load = useCallback(() => {
    setLoadFailed(false);
    listFeedback(scope)
      .then((result) => {
        if (mounted.current) setItems(result.items);
      })
      .catch(() => {
        if (mounted.current) setLoadFailed(true);
      });
  }, [scope]);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const update = (patch: Partial<FeedbackDraft>) => {
    setSubmitted(false);
    setSubmitError(false);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const canSubmit = !submitting && draft.title.trim() !== "" && draft.description.trim() !== "";

  const submit = async () => {
    if (!canSubmit) return;
    const body = { ...draft, title: draft.title.trim(), description: draft.description.trim() };
    const retry = pending.current;
    const attempt = retry && sameBody(retry, body) ? retry : { ...body, mutationId: crypto.randomUUID() };
    pending.current = attempt;
    setSubmitting(true);
    setSubmitError(false);
    try {
      await createFeedback(scope, attempt);
      pending.current = null;
      if (!mounted.current) return;
      setDraft(emptyDraft());
      setSubmitted(true);
      load();
    } catch {
      if (mounted.current) setSubmitError(true);
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[220]" portal>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("title")}
        className="flex max-h-[85vh] w-full max-w-lg flex-col gap-4 overflow-hidden rounded-2xl bg-[var(--paper-elevated)] p-5 text-[var(--ink)] shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="rounded-md px-2 py-1 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
          >
            ×
          </button>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--ink-muted)]">{t("categoryLabel")}</span>
            <CustomSelect
              size="md"
              ariaLabel={t("categoryLabel")}
              value={draft.category}
              disabled={submitting}
              onChange={(value) => update({ category: value as FeedbackCategory })}
              options={categories.map((category) => ({
                value: category,
                label: t(`categories.${category}`),
              }))}
            />
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--ink-muted)]">{t("titleLabel")}</span>
            <input
              className={field}
              maxLength={120}
              value={draft.title}
              placeholder={t("titlePlaceholder")}
              disabled={submitting}
              onChange={(event) => update({ title: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--ink-muted)]">{t("descriptionLabel")}</span>
            <textarea
              className={`${field} min-h-28 resize-y`}
              maxLength={8000}
              value={draft.description}
              placeholder={t("descriptionPlaceholder")}
              disabled={submitting}
              onChange={(event) => update({ description: event.target.value })}
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            <span role="status" className="text-sm text-[var(--ink-muted)]">
              {submitted ? t("submitted") : submitError ? t("submitFailed") : ""}
            </span>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm text-[var(--button-primary-text)] disabled:opacity-60"
            >
              {submitting ? t("submitting") : t("submit")}
            </button>
          </div>
        </form>

        <div className="flex min-h-0 flex-col gap-2">
          <h3 className="text-sm font-medium text-[var(--ink-muted)]">{t("history")}</h3>
          <div className="min-h-0 space-y-2 overflow-y-auto">
            {loadFailed && (
              <div role="alert" className="flex items-center gap-3 text-sm">
                <span>{t("loadFailed")}</span>
                <button type="button" onClick={load} className="underline">
                  {t("retry")}
                </button>
              </div>
            )}
            {!loadFailed && items === null && (
              <p role="status" className="text-sm text-[var(--ink-muted)]">
                {t("loading")}
              </p>
            )}
            {items?.length === 0 && (
              <p className="text-sm text-[var(--ink-muted)]">{t("empty")}</p>
            )}
            {items?.map((item) => {
              const reply = [...item.events].reverse().find((event) => event.reply);
              return (
                <article key={item.id} className="rounded-lg border border-[var(--line)] p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <strong className="truncate">{item.title}</strong>
                    <span className="shrink-0 text-xs text-[var(--ink-muted)]">
                      {t(`statuses.${item.status}`)}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[var(--ink-muted)]">{item.description}</p>
                  {reply?.reply && (
                    <p className="mt-2 whitespace-pre-wrap">
                      <span className="text-xs text-[var(--ink-muted)]">{t("reply")}: </span>
                      {reply.reply}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
