import { invoke } from "@tauri-apps/api/core";

import type { CommunityScope } from "@/features/community/api";

export type FeedbackCategory = "bug" | "suggestion" | "help";
export type FeedbackStatus = "new" | "in_progress" | "resolved";

export interface FeedbackEvent {
  id: string;
  kind: string;
  status: FeedbackStatus | null;
  reply: string | null;
  created_at: number;
}

export interface FeedbackItem {
  id: string;
  title: string;
  description: string;
  category: FeedbackCategory;
  status: FeedbackStatus;
  revision: number;
  created_at: number;
  updated_at: number;
  events: FeedbackEvent[];
}

export interface FeedbackDraft {
  mutationId: string;
  category: FeedbackCategory;
  title: string;
  description: string;
}

export function listFeedback(
  scope: CommunityScope,
): Promise<{ items: FeedbackItem[] }> {
  return invoke("cmd_owned_feedback_request", {
    scope,
    request: { kind: "list" },
  });
}

export function createFeedback(
  scope: CommunityScope,
  draft: FeedbackDraft,
): Promise<FeedbackItem> {
  return invoke("cmd_owned_feedback_request", {
    scope,
    request: { kind: "create", ...draft },
  });
}
