import { APP_CLI_NAME, APP_DATA_DIR_NAME } from '../shared/appProfile';
/**
 * Unified system prompt assembly for MyAgents.
 *
 * Three-layer prompt architecture:
 *   L1 — Base identity (always included)
 *   L2 — Interaction channel (desktop vs IM, mutually exclusive)
 *   L3 — Scenario instructions (cron-task / heartbeat, stacked as needed)
 *
 * Template content is inlined below (not loaded from filesystem) because
 * bun build hardcodes __dirname at compile time, breaking production builds.
 */

import type { RuntimeType } from '../shared/types/runtime';
import type { OfficialToolId } from '../shared/official-tools';
import type { HostInteractionCapability } from '../shared/types/hostInteraction';
import { buildCliToolsAppend, buildWidgetSection, buildSessionInboxSection } from './system-prompt-cli-tools';

// ===== Scenario types =====

export type InteractionScenario =
  | { type: 'desktop'; surface?: 'chat' | 'floating-ball' }
  | { type: 'im'; platform: 'telegram' | 'feishu'; sourceType: 'private' | 'group'; botName?: string; hostInteraction?: HostInteractionCapability }
  | { type: 'agent-channel'; platform: string; sourceType: 'private' | 'group'; botName?: string; agentName?: string; hostInteraction?: HostInteractionCapability }
  | { type: 'cron'; taskId: string; intervalMinutes: number; aiCanExit: boolean }
  | {
      type: 'registeredAgent';
      platform: 'space';
      spaceId: string;
      registeredAgentId: string;
      sourceType?: 'issue-delivery';
    };

// ===== Runtime display name =====
// Maps internal runtime ids to human-readable names injected into the L1 base identity
// so the AI can correctly answer "what runtime am I running on?" questions regardless
// of which CLI is driving it.
function getRuntimeDisplayName(runtime: RuntimeType | undefined): string {
  switch (runtime) {
    case 'dsh':         return 'MyAgents integrated DeepSeek Harness';
    case 'claude-code': return 'Anthropic Claude Code CLI';
    case 'codex':       return 'OpenAI Codex CLI';
    case 'builtin':
    default:
      return 'MyAgents 内置 Claude Agent SDK';
  }
}

// ===== Inline templates =====

const TMPL_BASE_IDENTITY = `<myagents-identity>
你正运行在 MyAgents —— 一款通用的桌面端 AI Agent 应用中。用户通过 MyAgents 调用你,
MyAgents 负责会话管理、工具权限、定时任务、IM Bot 集成、工作区文件访问等能力,
你则负责理解和执行用户的请求。

当前执行 Runtime: {{runtimeName}}

用户全局配置目录: ~/${APP_DATA_DIR_NAME}
当对话涉及日期、时间或星期时,先用 Bash 执行 \`date\` 获取准确的当前时间再作判断——系统信息中的日期可能已过期。
</myagents-identity>`;

const TMPL_CHANNEL_DESKTOP = `<myagents-interaction-channel>
用户正通过 MyAgents 桌面客户端与你对话。
</myagents-interaction-channel>`;

const TMPL_CHANNEL_IM = `<myagents-interaction-channel>
你正通过 {{platformLabel}} 作为 IM 聊天机器人与用户对话，{{sourceTypeLabel}}。{{#if botName}}你的昵称为「{{botName}}」。{{/if}}
</myagents-interaction-channel>`;

const TMPL_CRON_TASK = `<myagents-cron-task-instructions>
你正处于心跳循环任务模式 (Task ID: {{taskId}})。每隔 {{intervalText}} 系统触发唤醒你一次。{{#if aiCanExit}}

如果任务目标已完全达成、或继续执行无意义/有害，请按下方 \`<myagents-cli-task-exit>\` 段落给出的 \`${APP_CLI_NAME} task exit\` 命令结束任务。{{/if}}
</myagents-cron-task-instructions>`;

const TMPL_HEARTBEAT = `<myagents-heartbeat-instructions>
You will periodically receive heartbeat messages (a user message wrapped in tags like \`<HEARTBEAT>\\nThis is a heartbeat from the system.\\n……\\n</HEARTBEAT>\`).
When you receive one, follow its instructions.
</myagents-heartbeat-instructions>`;

const TMPL_REGISTERED_AGENT = `<myagents-registered-agent-instructions space-id="{{spaceId}}" registered-agent-id="{{registeredAgentId}}">
你正作为绑定到当前 Session 的 MyAgents Registered Agent 处理 Space Issue 事件。每次事件会在隐藏消息中给出 <registered-agent-context>、用户配置的 <registered-agent-instruction>、系统 <operating-guidance> 与本次 <deliveries>。

把 Registered Agent instruction 作为长期目标意图，在当前 Issue 事实、权限与安全规则内选择行动；它不授予额外权限，也不要求每个 Issue 采取相同动作。可用结果包括不再行动、只评论或更新、claim 责任、继续已有工作，以及在真正完成后 complete。Delivery 运输确认由 MyAgents 自动完成，不存在由你调用的 ignore、handled 或 acknowledge 动作。

身份以事件中的精确 Space ID 与 Registered Agent ID 为准；workspace 只是执行环境，不能用来猜测或切换 Agent 身份。行动前通过 myagents CLI 读取当前 Issue；本次 Delivery 元数据只解释唤醒原因，不是当前状态的第二真相源。
</myagents-registered-agent-instructions>`;

const TMPL_FLOATING_BALL = `<myagents-floating-ball-instructions>
You are talking with the user through the MyAgents desktop floating window.

This is a lightweight, immediate, desktop-adjacent entry point. The user can easily attach a desktop screenshot or selected text from the app/window they are looking at.

Keep responses concise and directly useful for this small-window interaction.
</myagents-floating-ball-instructions>`;

// ===== Variable replacement =====
// Supports {{varName}} simple substitution + {{#if varName}}...{{else}}...{{/if}} conditional blocks

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  // Conditional blocks: {{#if key}}...{{else}}...{{/if}} or {{#if key}}...{{/if}}
  result = result.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
    (_, key, ifBlock, elseBlock) => vars[key] ? ifBlock : (elseBlock ?? '')
  );
  // Simple variable substitution
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
  return result;
}

// ===== Main entry =====

export interface SystemPromptOptions {
  /**
   * Current runtime driving this session, used to render a runtime-accurate
   * identity line in L1. Defaults to 'builtin' (Claude Agent SDK) if omitted.
   */
  runtime?: RuntimeType;
  /**
   * Append the `myagents` CLI capability hints (cron / IM media) to the
   * prompt. Set by ALL runtime paths in v0.2.11+ — builtin and external —
   * because the corresponding in-process MCP servers (`cron-tools` /
   * `im-cron` / `im-media`) were retired in favour of the CLI surface, so
   * builtin sessions need the same prompt guidance to discover those
   * capabilities. Single CLI source of truth across builtin / Codex /
   * Claude Code and Codex runtimes. See prd_0.1.67 for the original (then
   * external-only) introduction; current state described here.
   *
   * Note: generative-UI widget guidance is universal across runtimes (no MCP
   * equivalent — the CLI is the only path) and is emitted unconditionally for
   * desktop scenarios via `buildWidgetSection()`.
   */
  cliToolsEnabled?: boolean;
  /**
   * Include user-registered CLI tools from ~/.myagents/tools/registry.json in
   * the prompt. Separate from `cliToolsEnabled` because Task / Record / IM
   * media are stable product CLI capabilities, while the user tool registry is
   * an experimental feature gate.
   */
  userCliToolsEnabled?: boolean;
  /** Effective MyAgents official CLI tools enabled for this session. */
  enabledOfficialToolIds?: readonly OfficialToolId[];
}

export interface DshHostPromptSection {
  id: string;
  order: number;
  scope: 'global' | 'root';
  text: string;
}

export interface DshHostPromptContext {
  id: string;
  order: number;
  scope: 'global' | 'root';
  text: string;
}

export interface DshSystemContextSnapshot {
  sections: DshHostPromptSection[];
  contexts?: DshHostPromptContext[];
}

const DSH_PRODUCT_IDENTITY = 'You are the active agent in MyAgents, a general-purpose desktop AI agent application. MyAgents owns the session UI, workspace binding, permissions, automations, channels, and product integrations. Use only capabilities that are actually present in this session. When current date or time matters, obtain it with an available tool rather than relying on prompt metadata.';

const DSH_CAPABILITY_ROUTING = 'MyAgents capabilities are progressively disclosed. Use the available tool schemas and capability context to select a Skill, tool, or CLI entry point. Load detailed help only when needed. Mentioning a capability does not grant permission to execute it.';

function buildProductSessionPrompt(scenario: InteractionScenario, options?: SystemPromptOptions): string {
  const parts: string[] = [];

  // L2: Interaction channel (mutually exclusive)
  if (scenario.type === 'im' || scenario.type === 'agent-channel') {
    const platformMap: Record<string, string> = { feishu: '飞书', telegram: 'Telegram', dingtalk: '钉钉' };
    const platformLabel = platformMap[scenario.platform] ?? scenario.platform;
    const sourceTypeLabel = scenario.sourceType === 'private' ? '私聊模式' : '群聊模式';
    parts.push(renderTemplate(TMPL_CHANNEL_IM, {
      botName: scenario.botName ?? '',
      platformLabel,
      sourceTypeLabel,
    }));
  } else {
    // desktop, cron, and registered-agent events all use desktop-style shell I/O.
    parts.push(TMPL_CHANNEL_DESKTOP);
  }

  // L3: Scenario instructions (stacked as needed)
  if (scenario.type === 'cron') {
    const intervalText = scenario.intervalMinutes >= 60
      ? `${Math.floor(scenario.intervalMinutes / 60)} 小时${scenario.intervalMinutes % 60 > 0 ? ` ${scenario.intervalMinutes % 60} 分钟` : ''}`
      : `${scenario.intervalMinutes} 分钟`;
    parts.push(renderTemplate(TMPL_CRON_TASK, {
      taskId: scenario.taskId,
      intervalText,
      aiCanExit: scenario.aiCanExit ? 'true' : '',  // non-empty = truthy for {{#if}}
    }));
  }

  if (scenario.type === 'registeredAgent') {
    parts.push(renderTemplate(TMPL_REGISTERED_AGENT, {
      spaceId: scenario.spaceId,
      registeredAgentId: scenario.registeredAgentId,
    }));
  }

  if (scenario.type === 'im' || scenario.type === 'agent-channel') {
    parts.push(TMPL_HEARTBEAT);
  }

  if (scenario.type === 'desktop' && scenario.surface === 'floating-ball') {
    parts.push(TMPL_FLOATING_BALL);
  }

  // L3: Generative UI widget guidance — universal across runtimes for desktop
  // scenarios. Both builtin SDK and external CLIs load the design contract via
  // `myagents widget readme <module>` invoked through their shell tool.
  const widgetSection = buildWidgetSection(scenario);
  if (widgetSection) parts.push(widgetSection);

  // L3: Session Inbox guidance (PRD 0.2.18 §4.1) — universal across runtimes
  // and scenarios. Emitted next to widget guidance for the same reason: it's
  // a capability the AI should notice without needing to load the skill doc.
  const sessionInboxSection = buildSessionInboxSection(scenario);
  if (sessionInboxSection) parts.push(sessionInboxSection);

  // L4: CLI-backed capability hints — universal across runtimes since v0.2.11
  // (both agent-session.ts and external-session.ts pass cliToolsEnabled: true;
  // see SystemPromptOptions.cliToolsEnabled doc above). Carries the static
  // capability sections (Task / IM media / Record) plus the dynamic
  // user-registered CLI tools section (PRD 0.2.36).
  if (options?.cliToolsEnabled) {
    const cliTools = buildCliToolsAppend(scenario, {
      includeUserTools: options.userCliToolsEnabled === true,
      enabledOfficialToolIds: options.enabledOfficialToolIds,
    });
    if (cliTools) parts.push(cliTools);
  }

  return parts.join('\n\n');
}

export function buildSystemPromptAppend(scenario: InteractionScenario, options?: SystemPromptOptions): string {
  const identity = renderTemplate(TMPL_BASE_IDENTITY, {
    runtimeName: getRuntimeDisplayName(options?.runtime),
  });
  return [identity, buildProductSessionPrompt(scenario, options)].filter(Boolean).join('\n\n');
}

/** DSH-specific declarative projection; Runtime owns the generic operating contract. */
export function buildDshSystemContext(
  scenario: InteractionScenario,
  options?: SystemPromptOptions,
  workspaceSupplement = '',
): DshSystemContextSnapshot {
  const session = buildProductSessionPrompt(scenario, { ...options, runtime: 'dsh' });
  return {
    sections: [
      { id: 'myagents:identity', order: -80, scope: 'global', text: DSH_PRODUCT_IDENTITY },
      {
        id: 'myagents:capability-routing',
        order: -70,
        scope: 'global',
        text: DSH_CAPABILITY_ROUTING,
      },
      { id: 'myagents:session', order: 10, scope: 'root', text: session },
    ],
    contexts: workspaceSupplement
      ? [{
          id: 'workspace-supplement',
          order: 100,
          scope: 'global',
          text: workspaceSupplement,
        }]
      : [],
  };
}
