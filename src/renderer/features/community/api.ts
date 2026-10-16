import { invoke } from "@tauri-apps/api/core";

/** Non-secret identity fence. The bearer remains owned by Rust. */
export interface CommunityScope {
  connectionId: string;
  principalId: string;
  bindingId: string;
}
export type CommunityCategory =
  | "discussion"
  | "question"
  | "showcase"
  | "announcement";
export interface CommunityTopic {
  id: string;
  category: CommunityCategory;
  title: string;
  content: string;
  author_name: string;
  created_at: number;
  updated_at: number;
  revision: number;
  reply_count: number;
  is_owner: boolean;
  pinned: boolean;
  locked: boolean;
  visibility: string;
}
export interface CommunityReply {
  id: string;
  content: string;
  author_name: string;
  created_at: number;
}
export interface CommunityDetail {
  topic: CommunityTopic;
  replies: CommunityReply[];
}
export type CommunityRequest =
  | { kind: "list" }
  | { kind: "detail"; topicId: string }
  | {
      kind: "create";
      mutationId: string;
      category: Exclude<CommunityCategory, "announcement">;
      title: string;
      content: string;
    }
  | { kind: "reply"; mutationId: string; topicId: string; content: string };
type Result<R extends CommunityRequest> = R extends { kind: "list" }
  ? { items: CommunityTopic[] }
  : R extends { kind: "detail" }
    ? CommunityDetail
    : R extends { kind: "create" }
      ? CommunityTopic
      : CommunityReply;

export function communityRequest<R extends CommunityRequest>(
  scope: CommunityScope,
  request: R,
): Promise<Result<R>> {
  return invoke("cmd_owned_community_request", { scope, request });
}
