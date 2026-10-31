/**
 * PRD 0.2.27 fork migration — SDK↔SDK uuid remap.
 * See specs/prd/prd_0.2.27_fork_standalone_migration.md.
 *
 * The standalone SDK `forkSession()` copies the source transcript into a new session with
 * raw record UUIDs remapped (fresh), preserving order + the parentUuid chain. Queued
 * input aliases in getSessionMessages can remain unchanged; they are not native user anchors. Our MyAgents
 * store keeps the OLD (source) sdkUuids on the copied rows, so after an eager fork those
 * anchors no longer resolve against the fork's transcript (fork-internal rewind would break).
 *
 * We rebuild the old→new map by aligning the source-sliced transcript with the fork
 * transcript position-by-position — BOTH read via `getSessionMessages` (the same SDK
 * reconstruction), so they are same-length, same-role-sequence, only uuids renamed
 * (empirically verified, PoC G4: 2 real sources × 3 anchors = 6/6 clean bijections). Then we
 * re-stamp our stored sdkUuids through the map.
 *
 * IMPORTANT: do NOT align our UI `messages[]` to the SDK transcript — different granularity
 * (one UI assistant row folds several SDK assistant/thinking/tool entries). The map MUST be
 * built at SDK granularity (source transcript ↔ fork transcript), then applied to the SDK
 * uuids we stored on each UI row. (This is the Codex BLOCKER the redesign fixed.)
 *
 * Hard rule: on ANY structural mismatch these return `ok:false`, so the caller ABORTS the
 * eager fork and falls back to the (default) lazy path — never a partial/guessed map.
 */

/** Minimal shape of a `getSessionMessages()` entry this needs. */
export interface ForkTranscriptEntry {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
}

export type ForkUuidRemapResult =
  | { ok: true; map: Map<string, string> }
  | { ok: false; reason: string };

/**
 * Build the old→new uuid map by positional alignment of the source-sliced vs fork
 * transcripts. Validates equal length, identical type sequence, and bijectivity (no
 * duplicate old or new uuid). Returns `ok:false` on the first violation.
 */
export function buildForkUuidRemap(
  sourceSliced: readonly ForkTranscriptEntry[],
  fork: readonly ForkTranscriptEntry[],
): ForkUuidRemapResult {
  if (sourceSliced.length !== fork.length) {
    return { ok: false, reason: `length mismatch: source=${sourceSliced.length} fork=${fork.length}` };
  }
  const map = new Map<string, string>();
  const seenNew = new Set<string>();
  for (let i = 0; i < sourceSliced.length; i++) {
    const s = sourceSliced[i];
    const f = fork[i];
    if (s.type !== f.type) {
      return { ok: false, reason: `type mismatch at index ${i}: source=${s.type} fork=${f.type}` };
    }
    if (map.has(s.uuid)) return { ok: false, reason: `duplicate source uuid at index ${i}: ${s.uuid}` };
    if (seenNew.has(f.uuid)) return { ok: false, reason: `duplicate fork uuid at index ${i}: ${f.uuid}` };
    map.set(s.uuid, f.uuid);
    seenNew.add(f.uuid);
  }
  return { ok: true, map };
}

export type RemapStoredResult =
  | { ok: true; remapped: (string | undefined)[] }
  | { ok: false; reason: string };

/**
 * Re-stamp a list of stored sdkUuids (undefined entries pass through unchanged) through the
 * map. Returns `ok:false` if ANY present uuid is missing from the map — that would leave a
 * stale anchor in the forked store, so the caller MUST abort the eager fork.
 */
export function remapStoredSdkUuids(
  storedUuids: readonly (string | undefined)[],
  map: ReadonlyMap<string, string>,
): RemapStoredResult {
  const remapped: (string | undefined)[] = [];
  for (const u of storedUuids) {
    if (u === undefined) { remapped.push(undefined); continue; }
    const n = map.get(u);
    if (n === undefined) return { ok: false, reason: `stored sdkUuid not in remap: ${u}` };
    remapped.push(n);
  }
  return { ok: true, remapped };
}
