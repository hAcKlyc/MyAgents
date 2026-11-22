import type { ToolCallUpdate } from '@agentclientprotocol/sdk/unstable';
import { createPatch } from 'diff';

const nativeToolNames: ReadonlyMap<string, string> = new Map([
  ['run_command', 'Bash'],
  ['read_file', 'Read'],
  ['find_by_name', 'Glob'],
  ['grep_search', 'Grep'],
  ['write_to_file', 'Write'],
  ['edit_file', 'Edit'],
  ['replace_file_content', 'Edit'],
  ['multi_replace_file_content', 'Edit'],
  ['search_web', 'WebSearch'],
  ['web_search', 'WebSearch'],
  ['read_url_content', 'WebFetch'],
  ['web_fetch', 'WebFetch'],
  ['invoke_subagent', 'CollabAgent'],
]);

function parameters(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function toolNameFor(tool: ToolCallUpdate, args: Record<string, unknown>, nativeName: string | undefined, dialect: 'bash' | 'pwsh' | undefined): string {
  const knownName = nativeName && nativeToolNames.get(nativeName);
  if (knownName === 'Bash' || typeof args.CommandLine === 'string') return dialect === 'pwsh' ? 'PowerShell' : 'Bash';
  if (knownName) return knownName;
  if (nativeName && /^mcp__[\w.-]+__[\w.-]+$/.test(nativeName)) return nativeName;
  if (tool.kind === 'edit' || tool.kind === 'delete' || tool.kind === 'move'
    || tool.content?.some((part) => part.type === 'diff')) return 'Edit';
  if (tool.kind === 'read' || (typeof args.Path === 'string' && 'StartLine' in args)) return 'Read';
  return 'Tool';
}

/** Keep ACP presentation text and opaque arguments separate from the product tool identity. */
export function presentAntigravityTool(tool: ToolCallUpdate): {
  toolName: string;
  input: Record<string, unknown>;
} {
  const args = parameters(tool.rawInput);
  const nativeName = tool.name ?? /^Run ([a-z][a-z0-9_]*)$/.exec(tool.title ?? '')?.[1];
  const shell = string(args.Shell ?? args.shell)?.toLowerCase();
  const dialect = shell === 'pwsh' || shell === 'powershell' ? 'pwsh' : shell === 'bash' ? 'bash' : undefined;
  const toolName = toolNameFor(tool, args, nativeName, dialect);
  const location = tool.locations?.[0];
  const changes = tool.content?.flatMap((part) => {
    if (part.type !== 'diff') return [];
    // FilePatch's shared wire format uses raw file contents for additions and deletions.
    if (part.oldText == null) return [{ path: part.path, kind: 'add', diff: part.newText }];
    if (tool.kind === 'delete') return [{ path: part.path, kind: 'delete', diff: part.oldText }];
    return [{ path: part.path, kind: 'update', diff: createPatch(part.path, part.oldText, part.newText) }];
  }) ?? [];
  const filePath = string(args.Path ?? args.TargetFile ?? args.file_path)
    ?? location?.path ?? changes[0]?.path;
  const cwd = string(args.Cwd ?? args.WorkingDirectory ?? args.cwd);

  switch (toolName) {
    case 'PowerShell':
    case 'Bash':
      return { toolName, input: {
        command: string(args.CommandLine ?? args.command),
        description: string(args.toolSummary ?? args.description),
        cwd,
        dialect,
      } };
    case 'Read': {
      const start = integer(args.StartLine ?? args.offset) ?? location?.line ?? undefined;
      const end = integer(args.EndLine);
      return { toolName, input: {
        file_path: filePath,
        offset: start,
        limit: start !== undefined && end !== undefined && end >= start
          ? end - start + 1 : integer(args.limit),
      } };
    }
    case 'Write':
    case 'Edit':
      return { toolName, input: {
        file_path: filePath,
        cwd,
        ...(changes.length > 0 ? { changes } : {
          old_string: string(args.TargetContent ?? args.old_string),
          new_string: string(args.ReplacementContent ?? args.new_string),
          content: string(args.CodeContent ?? args.content),
        }),
      } };
    case 'Glob':
    case 'Grep':
      return { toolName, input: {
        pattern: string(args.Pattern ?? args.Query ?? args.pattern),
        path: string(args.SearchDirectory ?? args.SearchPath ?? args.Path ?? args.path),
        glob: string(args.Includes ?? args.glob),
      } };
    case 'WebSearch':
      return { toolName, input: { query: string(args.Query ?? args.query), queries: args.Queries ?? args.queries } };
    case 'WebFetch':
      return { toolName, input: { url: string(args.Url ?? args.URL ?? args.url), prompt: string(args.Prompt ?? args.prompt) } };
    case 'CollabAgent':
      return { toolName, input: {
        tool: 'spawnAgent',
        description: string(args.Role ?? args.role),
        prompt: string(args.Prompt ?? args.prompt),
        model: string(args.Model ?? args.model),
        subagent_type: string(args.TypeName ?? args.subagent_type),
      } };
    default:
      return { toolName, input: {
        ...args,
        ...(Object.keys(args).length === 0 && tool.rawInput != null ? { arguments: tool.rawInput } : {}),
        title: tool.title ?? undefined,
        native_name: nativeName,
        locations: tool.locations?.map(({ path, line }) => ({ path, line })),
      } };
  }
}

export function antigravityToolResult(tool: ToolCallUpdate, toolName: string) {
  const raw = parameters(tool.rawOutput);
  const content = tool.content?.flatMap((part) => {
    if (part.type !== 'content') return [];
    const value = part.content;
    if (value.type === 'text') return [value.text];
    if (value.type === 'resource_link') return [`${value.title ?? value.name} — ${value.uri}`];
    if (value.type === 'resource' && 'text' in value.resource) return [value.resource.text];
    return [];
  }).filter(Boolean).join('\n');
  const rawText = string(tool.rawOutput) ?? string(raw.output ?? raw.Output);
  const links = tool.content?.flatMap((part) => part.type === 'content' && part.content.type === 'resource_link'
    ? [{ title: part.content.title ?? part.content.name, url: part.content.uri }]
    : []) ?? [];
  const searchResults = Array.isArray(raw.results) ? raw.results : links.length > 0 ? links : undefined;
  const hasTypedMedia = tool.content?.some((part) => part.type === 'content' && (
    part.content.type === 'image' || part.content.type === 'audio'
    || (part.content.type === 'resource' && 'blob' in part.content.resource)
  ));
  const result = toolName === 'WebSearch' && searchResults
    ? JSON.stringify({ results: searchResults, answer: content || rawText || string(raw.answer) })
    : content || rawText || (tool.rawOutput == null || hasTypedMedia ? '' : JSON.stringify(tool.rawOutput));
  return {
    result,
    metadata: {
      status: tool.status ?? undefined,
      exitCode: integer(raw.exit_code ?? raw.exitCode ?? raw.ExitCode),
      durationMs: integer(raw.duration_ms ?? raw.durationMs ?? raw.DurationMs),
      cwd: string(raw.cwd ?? raw.Cwd),
      processId: string(raw.process_id ?? raw.processId ?? raw.ProcessId),
    },
  };
}
