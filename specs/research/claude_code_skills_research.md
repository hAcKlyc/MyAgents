# Claude Code Skills 研究报告

## 概述

Claude Code Skills 是 Anthropic 推出的一项功能，允许用户通过定义结构化的技能文件来扩展 Claude 的能力。Skills 本质上是**可复用的工作流程和专业知识包**，可以教会 Claude 如何以一致、高效的方式完成特定任务。

---

## 一、Skills 是什么？

### 1.1 核心概念

Skills 是一种**文件系统级别的配置机制**，由以下部分组成：

```
my-skill/
├── SKILL.md           # 主指令文件（必需）
├── references/        # 参考文档（可选）
├── scripts/           # 可执行脚本（可选）
└── assets/            # 资源文件（可选）
```

### 1.2 SKILL.md 文件格式

每个 Skill 的核心是 `SKILL.md` 文件，采用 **YAML Frontmatter + Markdown** 格式：

```markdown
---
name: explain-code
description: Explains code with visual diagrams and analogies. Use when explaining how code works.
---

When explaining code, always include:
1. **Start with an analogy**: Compare the code to something from everyday life
2. **Draw a diagram**: Use ASCII art to show the flow
3. **Walk through the code**: Explain step-by-step
4. **Highlight a gotcha**: What's a common mistake?
```

### 1.3 Frontmatter 字段说明

| 字段 | 必需 | 描述 |
|------|------|------|
| `name` | ✅ | 技能名称，1-64字符，小写字母+连字符，同时作为 slash command 名称 |
| `description` | ✅ | 技能描述，1-1024字符，用于 Claude 自动判断何时使用 |
| `disable-model-invocation` | ❌ | 设为 `true` 时仅用户可调用，Claude 不会自动使用 |
| `user-invocable` | ❌ | 设为 `false` 时仅 Claude 自动调用，用户不可手动调用 |
| `allowed-tools` | ❌ | 限制该 Skill 可使用的工具，如 `Read, Grep, Glob` |
| `context` | ❌ | 设为 `fork` 时在独立子代理中运行 |
| `agent` | ❌ | 指定执行该 Skill 的代理类型：`Explore`, `Plan`, `general-purpose` |
| `argument-hint` | ❌ | 参数提示，如 `[issue-number]` |

### 1.4 Skills 存放位置

| 位置 | 作用域 |
|------|--------|
| `~/.claude/skills/<skill-name>/SKILL.md` | 用户级（所有项目共享）|
| `.claude/skills/<skill-name>/SKILL.md` | 项目级（仓库内共享）|
| `<plugin>/skills/<skill-name>/SKILL.md` | 插件级 |

---

## 二、Agent Skills 开放标准

Skills 遵循 **Agent Skills Open Standard**，这是一个开放规范，允许跨平台兼容。

### 2.1 官方资源

- 规范文档：[https://agentskills.io/specification](https://agentskills.io/specification)
- 集成指南：[https://agentskills.io/integrate-skills](https://agentskills.io/integrate-skills)
- GitHub：[https://github.com/agentskills/agentskills](https://github.com/agentskills/agentskills)
- 示例技能：[https://github.com/anthropics/skills](https://github.com/anthropics/skills)

### 2.2 跨平台兼容性

Agent Skills 标准已被多个 AI 工具采用：
- **Claude Code** (Anthropic)
- **Cursor** (IDE)
- **GitHub Copilot** (部分兼容)
- **Gemini CLI** (Google)

---

## 三、Claude Agent SDK 集成方案

### 3.1 SDK 安装

```bash
npm install @anthropic-ai/claude-agent-sdk
```

### 3.2 核心 API

#### `query()` 函数

主要入口函数，用于与 Claude Agent 交互：

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const result = await query({
  prompt: "Analyze this codebase",
  options: {
    allowedTools: ['Read', 'Grep', 'Glob', 'Skill'],
    settingSources: ['project'],  // 启用项目级 Skills
    cwd: '/path/to/project',
    model: 'claude-sonnet-4-20250514'
  }
});

// 流式处理消息
for await (const message of result) {
  console.log(message);
}
```

### 3.3 启用 Skills 的关键配置

```typescript
const options = {
  // 1. 启用 Skill 工具
  allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Skill'],
  
  // 2. 从项目目录加载 Skills
  settingSources: ['project'],  // 加载 .claude/skills/
  
  // 3. 可选：自定义 MCP 服务器
  mcpServers: {
    'my-server': {
      command: 'node',
      args: ['./mcp-server.js']
    }
  }
};
```

### 3.4 Headless 模式（命令行）

```bash
# 基本用法
claude -p "Find and fix the bug in auth.py" --allowedTools "Read,Edit,Bash,Skill"

# 结构化输出
claude -p "Summarize this project" --output-format json

# 流式 JSON 输出
claude -p "Review code" --output-format stream-json

# 自定义系统提示
claude -p "Review PR" --append-system-prompt "You are a security engineer."
```

### 3.5 Skills 发现与上下文注入

SDK 的集成流程：

```
1. 启动时发现 Skills
   ↓
2. 解析 SKILL.md 的 frontmatter（name, description）
   ↓
3. 将 Skills 元数据注入到系统提示
   ↓
4. Claude 根据 description 自动判断何时使用
   ↓
5. 用户也可通过 /skill-name 手动调用
```

注入到 Claude 上下文的 XML 格式：

```xml
<available_skills>
  <skill>
    <name>pdf-processing</name>
    <description>Extracts text and tables from PDF files.</description>
    <location>/path/to/skills/pdf-processing/SKILL.md</location>
  </skill>
  <skill>
    <name>data-analysis</name>
    <description>Analyzes datasets and generates reports.</description>
    <location>/path/to/skills/data-analysis/SKILL.md</location>
  </skill>
</available_skills>
```

---

## 四、高级特性

### 4.1 动态上下文注入

使用 `!` 前缀执行命令并将结果注入：

```markdown
---
name: pr-summary
description: Summarize changes in a pull request
context: fork
agent: Explore
allowed-tools: Bash(gh:*)
---

## Pull request context
- PR diff: !`gh pr diff`
- PR comments: !`gh pr view --comments`

## Your task
Summarize this pull request...
```

### 4.2 子代理执行

使用 `context: fork` 在隔离环境中运行：

```markdown
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly:
1. Find relevant files using Glob and Grep
2. Read and analyze the code
3. Summarize findings
```

### 4.3 参数传递

使用 `$ARGUMENTS` 接收用户输入：

```markdown
---
name: fix-issue
description: Fix a GitHub issue
disable-model-invocation: true
---

Fix GitHub issue $ARGUMENTS following our coding standards.
```

调用：`/fix-issue 123`

---

## 五、前端交互方案

### 5.1 Slash Command 模式（推荐）

这是最常见的交互模式，类似 Slack/Discord：

```
用户输入: /explain-code src/auth/login.ts
         └── 自动补全提示可用命令
```

**实现要点：**
- 检测 `/` 开头的输入
- 显示可用 Skills 的下拉列表
- 支持模糊搜索和自动补全
- 显示每个 Skill 的 description

### 5.2 UI 组件设计

```tsx
// 示例：Slash Command 自动补全组件
interface SkillSuggestion {
  name: string;
  description: string;
  argumentHint?: string;
}

function SlashCommandAutocomplete({ 
  skills, 
  onSelect 
}: {
  skills: SkillSuggestion[];
  onSelect: (skill: SkillSuggestion) => void;
}) {
  return (
    <div className="skill-autocomplete">
      {skills.map(skill => (
        <div 
          key={skill.name}
          className="skill-item"
          onClick={() => onSelect(skill)}
        >
          <span className="skill-name">/{skill.name}</span>
          {skill.argumentHint && (
            <span className="skill-hint">{skill.argumentHint}</span>
          )}
          <span className="skill-desc">{skill.description}</span>
        </div>
      ))}
    </div>
  );
}
```

### 5.3 交互流程设计

```
┌─────────────────────────────────────────────┐
│  Chat Input                                 │
│  ┌─────────────────────────────────────┐   │
│  │ /ex_                                 │   │
│  └─────────────────────────────────────┘   │
│  ┌─────────────────────────────────────┐   │
│  │ 📝 /explain-code                    │   │
│  │    Explains code with diagrams      │   │
│  │ ───────────────────────────────────│   │
│  │ 🔍 /explore-codebase               │   │
│  │    Deep dive into project structure │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

### 5.4 自动触发 vs 手动触发

| 模式 | 触发方式 | 适用场景 |
|------|----------|----------|
| 自动 | Claude 根据 description 判断 | 通用辅助功能 |
| 手动 | 用户输入 `/skill-name` | 部署、提交等敏感操作 |
| 禁用 | `disable-model-invocation: true` | 仅限用户手动调用 |

---

## 六、安全考虑

### 6.1 SDK 层面

- **沙箱执行**：使用 `sandbox` 选项隔离脚本执行
- **工具限制**：通过 `allowedTools` 限制可用工具
- **权限模式**：`permissionMode` 控制执行权限

### 6.2 Skill 层面

- **工具白名单**：`allowed-tools: Read, Grep` 限制该 Skill 只能读取
- **禁用自动调用**：敏感操作使用 `disable-model-invocation: true`
- **审计日志**：记录所有脚本执行

### 6.3 最佳实践

1. ✅ 仅安装来自可信来源的 Skills
2. ✅ 将 Skills 纳入版本控制
3. ✅ 敏感操作（部署、删除）使用手动触发
4. ✅ 为 Skills 设置最小权限的工具集

---

## 七、产品集成建议

### 7.1 最小可行方案

1. **Skills 管理**
   - 在 `.claude/skills/` 目录存放 Skills
   - 提供 UI 列表展示可用 Skills

2. **前端交互**
   - 检测 `/` 输入，显示 Skills 自动补全
   - 显示 Skill 名称 + 描述 + 参数提示

3. **后端集成**
   ```typescript
   import { query } from '@anthropic-ai/claude-agent-sdk';
   
   const result = await query({
     prompt: userInput,
     options: {
       allowedTools: ['Read', 'Write', 'Skill'],
       settingSources: ['project'],
     }
   });
   ```

### 7.2 进阶方案

1. **Skills 市场**
   - 从 [skills.mp](https://skillsmp.com/) 或自建仓库安装
   - 支持 Skills 分享和发布

2. **可视化编辑器**
   - 提供 SKILL.md 可视化编辑界面
   - 验证 frontmatter 格式

3. **自定义代理**
   - 使用 `agents` 选项定义自定义执行环境
   - 支持不同模型和工具集

---

## 八、参考资源

### 官方文档
- [Claude Code Skills 文档](https://docs.anthropic.com/en/docs/claude-code/skills)
- [Agent SDK TypeScript 参考](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Headless 模式](https://docs.anthropic.com/en/docs/claude-code/headless)

### 开放标准
- [Agent Skills 规范](https://agentskills.io/specification)
- [集成指南](https://agentskills.io/integrate-skills)

### NPM 包
- [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

---

## 总结

| 维度 | 要点 |
|------|------|
| **是什么** | SKILL.md 文件定义的可复用工作流程包 |
| **SDK 集成** | `@anthropic-ai/claude-agent-sdk` + `settingSources: ['project']` |
| **前端交互** | Slash command + 自动补全下拉 |
| **安全性** | 工具白名单 + 手动触发敏感操作 |
