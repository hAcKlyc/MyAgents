/** MoxBots update handoff. SimpleChatInput retains live draft ownership; this
 * single-renderer registry only freezes and checkpoints that owner before exit.
 * No Session execution, model calls, or localStorage durability assumptions. */
import { z } from 'zod';
import { join } from '@tauri-apps/api/path';
import { exists, remove } from '@tauri-apps/plugin-fs';
import { getConfigDir, safeLoadJson, safeWriteJson } from '@/config/services/configStore';
import { isBrowserDevMode } from '@/utils/browserMock';
import type { PersistedTabState } from './tabPersistence';
import type { Tab } from '@/types/tab';
import { agentMentionSnapshotSchema, desktopPrimaryContextSchema, type QueryMentionContext } from '@/../shared/agentMentions';
import { isPendingSessionId } from '@/../shared/constants';
import { assertKnownProductSystemSkillRequirement } from '@/../shared/systemSkills';
import { composerWorkflowDraftSchema, type ComposerWorkflowDraft } from './composerWorkflowDraft';

export interface ComposerScope {
  tabId: string;
  sessionId: string | null;
  workspacePath: string | null;
  mode: 'chat' | 'launcher';
  discussionId?: string;
}
export interface ComposerSnapshot {
  scope: ComposerScope;
  text: string;
  context: QueryMentionContext;
  imageCount: number;
  pendingAttachments: boolean;
  composing: boolean;
  sending: boolean;
  stagedWorkflow: boolean;
  workflowDraft?: ComposerWorkflowDraft;
  /** A live editor which cannot yet be safely serialized must refuse exit. */
  blockingReason?: string;
}
export interface ComposerOwner {
  snapshot: () => ComposerSnapshot;
  freeze: (locked: boolean) => void;
}
interface DurableDraft { scope: ComposerScope; text: string; context: QueryMentionContext; workflowDraft?: ComposerWorkflowDraft }
interface Handoff { version: 1 | 2; tabs: PersistedTabState; drafts: DurableDraft[] }
const scopeSchema = z.strictObject({
  tabId: z.string().min(1), sessionId: z.string().min(1).nullable(),
  workspacePath: z.string().min(1).nullable(), mode: z.enum(['chat', 'launcher']),
  discussionId: z.string().optional(),
});
const contextSchema = z.strictObject({
  agentMentions: z.array(agentMentionSnapshotSchema).optional(),
  primaryContext: desktopPrimaryContextSchema.optional(),
  requiredSystemSkill: z.unknown().optional(),
});
const draftSchema = z.strictObject({ scope: scopeSchema, text: z.string(), context: contextSchema,
  workflowDraft: composerWorkflowDraftSchema.optional() });
const owners = new Set<ComposerOwner>();
let ownerRevision = 0;
let locked = false;
let loaded: Handoff | null = null;
let handoffChecked = false;
let handoffBlocked = false;
let ioTail: Promise<unknown> = Promise.resolve();
const FILE = 'update-composer-drafts.json';

export function isComposerUpdateCheckpointLocked(): boolean { return locked; }

/** Remote sessions have a separate draft/RPC owner. Until its formal update
 * attestation exists, presence cannot be treated as idle or restorable. */
export function assertUpdateTabsSafe(tabs: readonly Pick<Tab, 'view'>[]): void {
  if (tabs.some(tab => tab.view === 'remote-session'))
    throw new Error('远程会话尚未接入安全更新检查，当前无法安装更新；请保留会话并稍后更新。');
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = ioTail.then(operation, operation);
  ioTail = result.catch(() => undefined);
  return result;
}
async function filePath() { return join(await getConfigDir(), FILE); }
async function handoffExists(path: string): Promise<boolean> {
  for (const entry of [path, `${path}.bak`, `${path}.tmp`]) if (await exists(entry)) return true;
  return false;
}
async function removeHandoff() {
  const path = await filePath();
  // Remove recoverable siblings first, main last. Failure keeps the main as
  // the authority rather than allowing a stale .bak to resurrect a draft.
  for (const entry of [`${path}.bak`, `${path}.tmp`, path]) {
    if (await exists(entry)) await remove(entry);
  }
}
function scopeKey(scope: ComposerScope): string {
  return JSON.stringify([scope.tabId, scope.sessionId, scope.workspacePath, scope.mode, scope.discussionId ?? null]);
}
function validateDraft(raw: unknown): DurableDraft {
  const draft = draftSchema.parse(raw);
  if (draft.context.requiredSystemSkill !== undefined)
    assertKnownProductSystemSkillRequirement(draft.context.requiredSystemSkill);
  return draft as DurableDraft;
}
function hasDraft(snapshot: ComposerSnapshot): boolean {
  return !!snapshot.text || snapshot.imageCount > 0 || !!snapshot.context.primaryContext
    || !!snapshot.context.requiredSystemSkill || !!snapshot.context.agentMentions?.length || snapshot.stagedWorkflow || !!snapshot.workflowDraft;
}
function assertSafeSnapshot(snapshot: ComposerSnapshot): void {
      if (snapshot.blockingReason) throw new Error(snapshot.blockingReason);
      if (snapshot.composing) throw new Error('输入法尚未完成。请完成输入后再更新；草稿已保留。');
      if (snapshot.sending || snapshot.pendingAttachments)
        throw new Error('输入或附件仍在处理中。请等待完成后再更新；草稿已保留。');
      if (snapshot.imageCount) throw new Error('草稿包含暂不能安全恢复的图片附件。请处理附件后再更新；草稿已保留。');
      if (snapshot.context.primaryContext?.kind === 'floating-context' && snapshot.context.primaryContext.input.screenshotAttached)
        throw new Error('草稿引用尚不能恢复的截图，请处理后再更新；草稿已保留。');
      if (snapshot.stagedWorkflow && !snapshot.workflowDraft)
        throw new Error('此任务草稿尚不能安全恢复，请保留草稿并稍后更新。');
}

function assertRestorable(draft: DurableDraft, state: PersistedTabState | null): void {
  const tab = state?.tabs.find(tab => tab.id === draft.scope.tabId);
  if (!draft.scope.sessionId || isPendingSessionId(draft.scope.sessionId) || !tab || tab.view !== 'chat' || draft.scope.mode !== 'chat'
    || tab.sessionId !== draft.scope.sessionId || tab.agentDir !== draft.scope.workspacePath
    || (tab.discussionId ?? null) !== (draft.scope.discussionId ?? null))
    throw new Error('此草稿尚无可恢复的会话。请保留草稿并稍后更新，或自行处理草稿后重试。');
}

export function registerComposerUpdateOwner(owner: ComposerOwner): () => void {
  owners.add(owner); ownerRevision++;
  if (locked) owner.freeze(true);
  return () => { owners.delete(owner); ownerRevision++; };
}

/** Freeze synchronously before any await: input cannot move past the snapshot. */
// App owns the edition composition. Accept its existing codec rather than
// importing the UI composition root back into a leaf composer dependency.
export function beginComposerUpdateCheckpoint(serializeTabs: (tabs: readonly Tab[], activeTabId: string | null) => PersistedTabState | null) {
  if (!handoffChecked || handoffBlocked) throw new Error('正在检查或暂时无法读取上次更新草稿，请先恢复草稿再更新。');
  if (loaded?.drafts.length) throw new Error('上次更新的草稿尚未恢复，请先恢复会话或明确关闭恢复提示。');
  if (locked) throw new Error('正在安全保存更新草稿，请稍候。');
  const participants = [...owners];
  // Reject in-flight imports/sends before freeze can suppress their completion;
  // reject IME before readOnly/inert can trigger a browser composition commit.
  for (const owner of participants) assertSafeSnapshot(owner.snapshot());
  locked = true;
  const revision = ownerRevision;
  for (const owner of participants) owner.freeze(true);
  let captured = '';
  let attemptedWrite = false;
  const collect = () => {
    if (revision !== ownerRevision) throw new Error('输入窗口已变化，请重新确认更新。');
    const snapshots = participants.map(owner => owner.snapshot());
    for (const snapshot of snapshots) assertSafeSnapshot(snapshot);
    return snapshots.filter(hasDraft).map(({ scope, text, context, workflowDraft }) =>
      validateDraft({ scope, text, context, ...(workflowDraft ? { workflowDraft } : {}) }));
  };
  return {
    async persist(tabs: readonly Tab[], activeTabId: string | null) {
      assertUpdateTabsSafe(tabs);
      const drafts = collect();
      const state = serializeTabs(tabs, activeTabId);
      const keys = new Set<string>();
      for (const draft of drafts) {
        assertRestorable(draft, state);
        const key = scopeKey(draft.scope);
        if (keys.has(key)) throw new Error('输入草稿身份重复，无法安全更新。');
        keys.add(key);
      }
      if (isBrowserDevMode()) throw new Error('当前环境无法安全保存更新草稿。');
      captured = JSON.stringify(drafts);
      await enqueue(async () => {
        const path = await filePath();
        // A failed consumption, corrupt file, or unexpected writer may have
        // left evidence. This attempt cannot overwrite or own its cleanup.
        if (handoffBlocked || await handoffExists(path)) {
          handoffBlocked = true;
          throw new Error('上次更新草稿交接仍未恢复，不能覆盖。请先恢复草稿。');
        }
        if (!state || !drafts.length) return;
        attemptedWrite = true; // Own even a failed tmp/fsync/rename attempt.
        await safeWriteJson(path, { version: drafts.some(draft => draft.workflowDraft) ? 2 : 1,
          tabs: state, drafts } satisfies Handoff);
      });
      if (captured !== JSON.stringify(collect())) throw new Error('输入草稿已变化，请重新确认更新。');
    },
    verify(tabs: readonly Tab[], activeTabId: string | null) {
      assertUpdateTabsSafe(tabs);
      const drafts = collect();
      for (const draft of drafts) assertRestorable(draft, serializeTabs(tabs, activeTabId));
      if (captured !== JSON.stringify(drafts)) throw new Error('输入草稿已变化，请重新确认更新。');
    },
    async abort() {
      if (!attemptedWrite) return;
      await enqueue(async () => {
        try { await removeHandoff(); attemptedWrite = false; }
        catch (error) { handoffBlocked = true; throw error; }
      });
    },
    release() {
      locked = false;
      for (const owner of owners) owner.freeze(false);
    },
  };
}

export async function clearComposerUpdateHandoff(): Promise<void> {
  if (!isBrowserDevMode()) await enqueue(removeHandoff);
  loaded = null;
  handoffChecked = true;
  handoffBlocked = false;
}

/** A restore-pill dismissal only owns successfully loaded drafts. A corrupt
 * or unreadable handoff is not covered by dismissing legacy tab restoration. */
export async function dismissLoadedComposerUpdateHandoff(): Promise<void> {
  if (loaded?.drafts.length) await clearComposerUpdateHandoff();
}

/** Retain disk evidence until the exact composer owner mounts. Unlike tabs,
 * this must not be consumed just because the user hasn't clicked restore yet. */
export async function loadComposerUpdateHandoff(deserializeTabs: (raw: string | null) => PersistedTabState | null): Promise<PersistedTabState | null> {
  if (isBrowserDevMode()) return null;
  handoffChecked = false;
  return enqueue(async () => {
    const path = await filePath();
    const raw = await safeLoadJson<unknown>(path);
    if (raw == null) {
      if (await handoffExists(path)) throw new Error('旧草稿交接文件损坏或无法读取，已保留。');
      loaded = null;
      return null;
    }
    const legacyDraftSchema = draftSchema.omit({ workflowDraft: true });
    const parsed = z.discriminatedUnion('version', [
      z.strictObject({ version: z.literal(1), tabs: z.unknown(), drafts: z.array(legacyDraftSchema).min(1) }),
      z.strictObject({ version: z.literal(2), tabs: z.unknown(), drafts: z.array(draftSchema).min(1) }),
    ]).parse(raw);
    const tabs = deserializeTabs(JSON.stringify(parsed.tabs));
    if (!tabs) throw new Error('更新草稿的会话列表无效。');
    const drafts = parsed.drafts.map(validateDraft);
    const keys = new Set<string>();
    for (const draft of drafts) {
      assertRestorable(draft, tabs);
      const key = scopeKey(draft.scope);
      if (keys.has(key)) throw new Error('更新草稿身份重复。');
      keys.add(key);
    }
    loaded = { version: parsed.version, tabs, drafts };
    return tabs;
  }).then(state => {
    handoffChecked = true;
    handoffBlocked = false;
    return state;
  }).catch(error => {
    handoffChecked = true;
    handoffBlocked = true;
    throw error;
  });
}

/** Restores data only; never calls onSend or starts a Session. Exact Tab ID,
 * Session ID, workspace and discussion must all match. Existing text wins. */
export function restoreComposerUpdateDraft(scope: ComposerScope, empty: boolean,
  restoreWorkflow?: (draft: ComposerWorkflowDraft) => boolean): DurableDraft | null {
  if (!loaded || !empty) return null;
  const index = loaded.drafts.findIndex(draft => scopeKey(draft.scope) === scopeKey(scope));
  if (index < 0) return null;
  // The existing Chat/config owner must accept the draft first. In particular,
  // an initial scheduler read must not overwrite it after disk consumption.
  const candidate = loaded.drafts[index];
  if (candidate.workflowDraft && !restoreWorkflow?.(candidate.workflowDraft)) return null;
  const [draft] = loaded.drafts.splice(index, 1);
  const remaining = JSON.parse(JSON.stringify(loaded)) as Handoff;
  void enqueue(async () => {
    if (remaining.drafts.length) await safeWriteJson(await filePath(), remaining);
    else await removeHandoff();
  }).catch(error => {
    handoffBlocked = true;
    console.error('[composer] Unable to consume restored update draft:', error);
  });
  return draft;
}
