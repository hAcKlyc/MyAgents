---
title: Version History
description: |
  MyAgents 版本发布记录。

  作用：记录每个版本的核心功能变化、Bug 修复和技术改进，便于追溯和用户了解更新内容。

  更新时机：版本功能开发完毕、测试通过后，先更新本文档，再执行 git tag。

  更新原则：
  1. 新版本插入到文档顶部（倒序排列）
  2. 每个版本包含：版本号、日期、核心变更分类描述
  3. 变更按类型聚合：功能新增、Bug 修复、技术改进、架构优化等
  4. Tag 提交时使用本文档对应版本的内容作为 tag message
  5. 保持简洁，详细内容参考对应 PRD 文档
  6. 「详见 PRD」链接仅在本文档中保留，tag message 中不包含此行
---

# Version History

---

## v0.1.4
**Date**: 2026-01-29

### 1. 自定义供应商编辑
- 支持编辑自定义供应商的名称、云服务商标签、Base URL、模型列表
- 编辑面板内增加「删除」按钮，附确认弹窗
- 删除供应商时自动切换受影响项目到其他可用供应商
- 模型标签 hover 显示删除按钮（用户添加的模型可删除）

### 2. 预设供应商自定义模型
- 预设供应商支持用户添加自定义模型
- 预设模型显示「预设」标签，不可删除
- 用户添加的模型 hover 显示删除按钮
- 数据解耦：预设数据随 App 更新，用户数据独立保留
- Moonshot 供应商新增 Kimi K2.5 模型

### 3. 历史记录列表优化
- 每条记录显示消息数和 Token 消耗统计
- 新增统计详情弹窗（按模型分组、消息明细）
- 消息存储升级为 JSONL 格式（O(1) 追加，崩溃容错）
- 增量统计计算、行数缓存、文件锁机制

### 4. MCP 工具选项始终显示
- 无 MCP 工具时显示引导文案，链接至设置页面

### 5. 工作区右键菜单「引用」
- 文件/文件夹/多选均支持插入 `@路径` 引用到输入框

### 6. 技能文件夹导入
- 新建技能对话框增加「导入文件夹」选项（桌面端）
- 验证 SKILL.md 存在，从 frontmatter 提取技能名称

### 7. Tab 切换配置同步
- 切换回 Chat Tab 时自动同步供应商、API Key、MCP 配置

### 8. 交互优化
- Slash 命令菜单键盘导航时自动滚动保持选中项可见

### 9. Bug 修复
- 修复消息中断后 Thinking Block 卡在加载状态
- 修复 API Key 模式切换到订阅模式报错（`Invalid signature in thinking block`）
- 修复长文本（如 JSON）在消息气泡中不换行
- 修复历史记录「当前」标签不更新
- 修复历史记录按钮点击无法关闭
- 修复加载历史会话后新消息统计不更新
- 修复 switchToSession 未终止旧 session 导致模型/供应商切换失效
- 修复三方供应商切换到 Anthropic 官方时 thinking block 签名冲突
- 修复第三方供应商模型切换后 UI 卡住（thinking/tool 块加载状态未结束）
- 修复 AI 回复完成后 Loading 指示器和停止按钮卡住（补全 9 种结束场景的 sessionState 重置）
- 修复发送消息后不自动滚动到底部
- 修复系统任务（如 Compact）期间显示停止按钮的误导
- 修复进程泄露问题（SDK/MCP 子进程随应用关闭正确清理）
- 优化文件预览性能（React.lazy + useMemo 缓存）

### 10. 架构优化
- 应用退出支持 Cmd+Q 和 Dock 右键退出的进程清理（RunEvent::ExitRequested）
- 进程清理函数重构，统一 SIGTERM → SIGKILL 两阶段关闭
- 启动时清理扩展至 SDK 和 MCP 子进程

**详见**: [specs/prd/prd_0.1.4.md](./prd/prd_0.1.4.md)

---

## v0.1.3
**Date**: 2026-01-27

### 1. Skills 同步与交互优化
- 支持从 Claude Code 同步 Skills 配置（`~/.claude/skills/` → `~/.myagents/skills/`）
- 技能/指令详情页焦点控制优化
- 描述区域支持多行输入
- 内容区域高度自适应视口

### 2. Task 工具 UI 增强
- ProcessRow 显示任务运行时间
- 展开状态显示实时统计信息（工具调用次数、Token 消耗）
- 新增 Trace 列表查看子代理工具调用记录

### 3. React 稳定性修复
- 修复 Toast/ImagePreview Context 稳定性问题
- 统一 useEffect 依赖数组规范
- 统一定时器初始化模式
- 修复权限弹框重复弹出问题
- 修复 Settings 页面事件监听竞态条件

### 4. 自动更新机制完善
- 修复 tauri-plugin-updater 架构目标识别问题（显式设置 `.target()` 确保完整架构标识）
- 移除非标准 platform 字段，符合 Tauri v2 官方 schema
- Release 构建启用 INFO 级别日志支持诊断
- Settings 页面增加 Rust 日志监听
- 修复事件发射错误处理

### 5. 进程管理最佳实践
- 增加文件描述符限制至 65536，防止 Bun 启动失败
- 添加 `--myagents-sidecar` 标记精确识别进程
- 实现两阶段清理机制（SIGTERM → SIGKILL）

### 6. 架构优化
- 明确 Tab Sidecar 与 Global Sidecar 使用边界
- Settings/Launcher 不再包裹 TabProvider

### 7. UI 修复
- 修复更新按钮样式（emerald 配色 + rounded-full）
- 调试日志包装 `isDebugMode()` 避免生产环境刷屏

**详见**: [specs/prd/prd_0.1.3.md](./prd/prd_0.1.3.md)

---

## v0.1.2
**Date**: 2026-01-25

### 1. 自定义服务商功能修复
- 实现自定义服务商完整的 CRUD 功能
- 服务商配置持久化到 `~/.myagents/providers/`
- 加载时验证 JSON 数据完整性
- Chat 页面模型选择器正确显示自定义服务商

### 2. MCP 开关状态修复
- 修复 MCP 开关状态与实际请求不一致问题
- 初始化时始终同步 MCP 配置（包括空数组）
- MCP 变化时正确重启 SDK 会话

### 3. Provider/MCP 切换上下文保持
- 切换配置时保持对话上下文（通过 resume session_id）
- 只有用户点击「新对话」才创建新 session
- 修复 AI "失忆" 问题

### 4. Skills 功能修复
- 实现用户级 Skill 按需复制到项目目录
- `/` 菜单去重（项目级优先）
- 修复详情页交互问题（保存后自动关闭、名称字段、路径重命名）
- Skill 复制使用 folderName 确保 SDK 能找到

### 5. 系统命令输出修复
- 修复 `/cost` 和 `/context` 命令输出不显示问题
- 正确处理 `<local-command-stdout>` 包裹的字符串内容

### 6. 其他改进
- 设置页版本号动态读取
- 日志规范化（生产环境不输出调试日志）

**详见**: [specs/prd/prd_0.1.2.md](./prd/prd_0.1.2.md)

---

## v0.1.1
**Date**: 2026-01-26

### 1. 订阅验证修复
- 修复 Anthropic 订阅检测逻辑（`~/.claude.json` 中的 `oauthAccount`）
- 添加订阅凭证真实验证功能
- 设置页显示验证状态（验证中/已验证/验证失败）

### 2. 文件管理增强
- 支持拖拽文件到工作区文件夹
- 支持 Cmd+V 粘贴文件到工作区
- 支持拖拽/粘贴文件到对话输入框（自动复制到 `myagents_files/`）
- 文件名冲突自动重命名
- Cmd+Z 撤销支持

### 3. AskUserQuestion 工具交互
- 向导式问答 UI 展示
- 单选自动跳转 / 多选手动确认
- 自定义输入框支持
- 进度指示器和回退修改

### 4. 统一日志系统
- Agent 日志懒加载创建
- 日志存储到 `~/.myagents/logs/`
- React/Bun/Rust 日志统一到 UnifiedLogs 面板
- 30 天自动清理

**详见**: [specs/prd/prd_0.1.1.md](./prd/prd_0.1.1.md)

---

## v0.1.0
**Date**: 2026-01-24

### 首个公开版本

MyAgents 桌面端 Claude Agent 客户端首个完整版本发布。

### 1. 核心架构
- 多 Tab 多 Session 架构（每个 Tab 独立 Sidecar 进程）
- Tauri v2 + React 19 + Bun 技术栈
- Rust HTTP/SSE Proxy 通信层
- 零外部依赖（内置 Bun 运行时）

### 2. 对话体验
- 流式输出与 Markdown 渲染
- 对话上下文恢复
- Slash Commands 支持
- 权限模式管理

### 3. 多 Provider 支持
- Anthropic 订阅模式
- API Key 模式
- 自定义服务商配置

### 4. MCP 工具集成
- MCP 服务器配置管理
- 工具权限控制
- 内置 bun 安装 MCP（无需 Node.js）

### 5. Skills & Commands
- Skills 能力集成
- CLAUDE.md 配置管理
- 用户级/项目级配置分离

### 6. 工作区管理
- 文件树浏览
- 文件预览器
- 系统级链接打开

### 7. 其他特性
- 启动页体验优化
- WebSearch 工具展示优化
- 开发者模式
- 自动更新系统

**详见**: [specs/prd/prd_0.1.0/](./prd/prd_0.1.0/) (21 个迭代 PRD)

---
