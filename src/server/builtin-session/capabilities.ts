import type { SlashCommand as SdkSlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type {
  EffectiveProjectCapabilitySnapshot,
  ProjectCapabilityCandidate,
} from '../../shared/projectCapabilities';
import type { SlashCommand } from '../../shared/slashCommands';
import { isReservedSlashCommandName } from '../../shared/slashCommands';

export interface RejectedSdkSkillName {
  name: string;
  reason: string;
}

export interface SdkSkillAllowlistCompatibility {
  allowlist: string[];
  rejected: RejectedSdkSkillName[];
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasSdkDisallowedSkillNameCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      character === '(' || character === ')' || character === ','
      || codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
    ) return true;
  }
  return false;
}

/**
 * Mirror the SDK 0.3.221+ `Options.skills` admission contract at Query birth.
 *
 * The SDK throws before spawning when any one entry is malformed. MyAgents has
 * a real installed base whose project/global/plugin Skills predate that stricter
 * contract, so one incompatible name must not make an otherwise valid historical
 * Session impossible to resume. Keep this exact-name filter narrow: names the SDK
 * still accepts (including `plugin:skill`) must continue through unchanged.
 */
export function sdkSkillNameRejectionReason(name: string): string | null {
  if (!name.trim()) return 'name is empty';
  if (hasUnpairedSurrogate(name)) return 'name contains an unpaired UTF-16 surrogate';
  if (name !== name.trim()) return 'leading or trailing whitespace is not allowed';
  if (hasSdkDisallowedSkillNameCharacter(name)) {
    return 'parentheses, commas, and control characters are not allowed';
  }
  if (name === '*') return "use skills: 'all' instead of the '*' name";
  if (name.endsWith(':*') || name.endsWith(' *')) return 'wildcard suffixes are not allowed';
  if (name.startsWith('/')) return "the canonical name must not start with '/'";
  if (name.includes('\\\\')) return 'consecutive backslashes are not allowed';
  if (name.endsWith('\\')) return 'a trailing unpaired backslash is not allowed';
  return null;
}

export function sanitizeSdkSkillAllowlist(names: Iterable<string>): SdkSkillAllowlistCompatibility {
  const allowlist: string[] = [];
  const rejected: RejectedSdkSkillName[] = [];
  for (const name of new Set(names)) {
    const reason = sdkSkillNameRejectionReason(name);
    if (reason) rejected.push({ name, reason });
    else allowlist.push(name);
  }
  return {
    allowlist: allowlist.sort(),
    rejected: rejected.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function findDisabledCapabilityForSlashInput(
  text: string,
  snapshot: EffectiveProjectCapabilitySnapshot,
): ProjectCapabilityCandidate | null {
  const match = /^\/([^\s]+)(?:\s|$)/.exec(text.trim());
  if (!match) return null;
  const name = match[1]!;
  if (isReservedSlashCommandName(name)) return null;
  return snapshot.candidates.find(item => (
    item.kind === 'command' && !item.enabled && item.canonicalName === name
  )) ?? null;
}

export function isSdkBuiltinCommand(name: string, commands: readonly SdkSlashCommand[]): boolean {
  // Canonical names take precedence over aliases. If several rows share a
  // canonical name, Claude dispatches the builtin row when one exists.
  const named = commands.filter(command => command.name === name);
  if (named.length) return named.some(command => command.builtin === true);
  const aliases = commands.filter(command => command.aliases?.includes(name));
  return aliases.length > 0 && aliases.every(command => command.builtin === true);
}

export function filterSlashCommandsForCapabilities(
  commands: SlashCommand[],
  snapshot: EffectiveProjectCapabilitySnapshot,
): SlashCommand[] {
  const disabledNames = new Set(
    snapshot.candidates
      .filter(item => item.kind === 'command' && !item.enabled)
      .map(item => item.canonicalName),
  );
  return commands.filter(command => (
    isReservedSlashCommandName(command.name) || !disabledNames.has(command.name)
  ));
}

export function buildBuiltinSkillAllowlist(
  snapshot: EffectiveProjectCapabilitySnapshot,
  pluginQualifiedSkillNames: Iterable<string>,
  unavailableSkillNames: Iterable<string> = [],
): string[] {
  const unavailable = new Set(unavailableSkillNames);
  return [...new Set([
    ...snapshot.enabledSkills
      .map(item => item.canonicalName)
      .filter(name => !unavailable.has(name)),
    ...pluginQualifiedSkillNames,
  ])].sort();
}
