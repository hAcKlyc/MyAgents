# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.7] - 2026-01-31

### Added
- Windows 平台开发工具（`build_dev_win.ps1`）
- 设置页面「关于」新增用户交流群二维码（自动缓存，离线可用）
- 代理配置支持（Settings > About > Developer Mode）
  - 支持 HTTP/HTTPS/SOCKS5 协议
  - 自动应用于 Claude Agent SDK 和应用更新下载

### Changed
- 改进 Windows 安装器升级体验，支持直接覆盖安装（无需先卸载旧版本）
- 优化网络连接池配置（降低资源占用）

### Fixed
- **Windows 平台关键修复**：
  - 修复 Windows 生产包无法启动的问题
  - 修复 Sidecar 连接失败（代理配置冲突）
  - 修复 Windows Tauri IPC 通信错误（CSP 配置不完整）
  - 修复构建脚本导致的配置缓存问题
- 修复二维码加载失败问题（Windows CSP 限制）
- 修复代理环境下 localhost 连接失败
- 修复多项代码质量问题（进程清理竞态、错误处理等）

### Technical
- 统一代理配置模块，消除代码重复
- 完善错误处理和日志记录
- 增强构建脚本健壮性（清理验证、容错处理）
- 新增技术文档：代理配置、构建问题排查、Windows 平台指南

**详见**: [specs/prd/prd_0.1.7.md](./specs/prd/prd_0.1.7.md)

---

## [0.1.6] - 2026-01-30

### Added
- **Windows 客户端支持**
  - NSIS 安装包 (`MyAgents_x.x.x_x64-setup.exe`)
  - 便携版 ZIP (`MyAgents_x.x.x_x86_64-portable.zip`)
  - 自动更新支持（共用 Tauri 签名密钥）
- 新增 Windows 构建脚本
  - `setup_windows.ps1` - 环境初始化
  - `build_windows.ps1` - 构建脚本
  - `publish_windows.ps1` - 发布脚本（含 `latest_win.json` 生成）
- 新增 `src/server/utils/platform.ts` 跨平台工具模块
- **支持 `server_tool_use` 内容块类型**（第三方 API 如智谱 GLM-4.7 的服务端工具调用）
- **设置页面添加用户交流群二维码**
  - 位于「关于」页面，从 R2 动态加载
  - 网络异常时自动隐藏
  - 新增 `upload_qr_code.sh` 上传脚本
- **MCP 表单 UI 改进**
  - 优化服务器配置表单交互体验

### Changed
- `runtime.ts` 支持 Windows 路径检测 (`bun.exe`, `%USERPROFILE%\.bun`, etc.)
- `sidecar.rs` 支持 Windows 进程管理 (`wmic` + `taskkill`)
- 统一跨平台环境变量处理（消除 10+ 处重复代码）
- **全局视觉优化与设计规范更新**
- 工作区右键菜单「快速预览」改为「预览」
- **会话统计 UI 优化**
  - 「缓存读取」改为「输入缓存」（= cache_read + cache_creation）
  - 消息明细新增「输入缓存」列

### Fixed
- 修复 Windows 自定义标题栏按钮无效（缺少 Tauri 权限）
- 修复 UI 卡在 loading 状态（`chat:system-status` 事件未注册 + React 批量更新延迟）
- 修复 `MultiEdit` 工具完成后工作区不刷新
- 修复 MCP 服务器和命令系统的 Windows 跨平台路径问题
- 修复智谱 GLM-4.7 `server_tool_use` 的输入解析（JSON 字符串 → 对象）
- 过滤智谱 API 返回的装饰性工具文本（避免干扰正常内容显示）
- **Token 统计修复**
  - 从 SDK result 消息提取统计数据（更可靠）
  - 支持多模型分别统计（新增 `modelUsage` 字段）
  - 修复智谱/Anthropic 等供应商统计数据为 0 的问题
- 修复流式输出中空白 chunk 过滤（保留有效换行和空格）
- 修复进程终止信号被错误保存为错误消息
- 为未知工具添加兜底图标 (Wrench)

### Technical
- Windows 数据目录：`%APPDATA%\MyAgents\`
- 添加 `buildCrossPlatformEnv()` 统一子进程环境变量构建
- 使用 `flushSync` 强制同步关键 UI 状态更新
- 装饰性文本过滤使用多条件匹配，避免误伤正常内容
- 新增 `ModelUsageEntry` 类型支持按模型分组存储 token 统计

**详见**: [specs/prd/prd_0.1.6.md](./specs/prd/prd_0.1.6.md)

---

## [0.1.5] - 2026-01-29

### Added
- 添加网络代理设置功能（开发者模式）
  - 支持 HTTP/SOCKS5 协议
  - 设置入口：设置 → 关于 → 点击 Logo 5次 → 开发者区域
  - Sidecar 启动时自动注入 HTTP_PROXY/HTTPS_PROXY 环境变量

### Changed
- 升级 Claude Agent SDK 从 0.2.7 到 0.2.23
- 建立 E2E 测试基础设施（Anthropic/Moonshot 双供应商测试）
- 统一 `/api/commands` 端点的命令解析逻辑
  - 使用 `parseFullCommandContent()` 替代 `parseYamlFrontmatter()`
  - 优先使用 frontmatter.name，回退到文件名
  - 提取 `scanCommandsDir()` 消除代码重复
- 统一版本记录到 CHANGELOG.md（移除 specs/version.md）

### Fixed
- 修复全局用户指令在对话 `/` 菜单中不显示的问题
  - `/api/commands` 端点新增扫描 `~/.myagents/commands/` 目录

### Technical
- 代理设置提取 `PROXY_DEFAULTS` 常量，消除魔数
- 添加 `isValidProxyHost()` 验证函数
- Rust 侧同步添加默认值常量

---

## [0.1.4] - 2026-01-29

### Added
- 支持编辑自定义供应商的名称、云服务商标签、Base URL、模型列表
- 编辑面板内增加「删除」按钮，附确认弹窗
- 删除供应商时自动切换受影响项目到其他可用供应商
- 模型标签 hover 显示删除按钮（用户添加的模型可删除）
- 预设供应商支持用户添加自定义模型
- 预设模型显示「预设」标签，不可删除
- 历史记录显示消息数和 Token 消耗统计
- 新增统计详情弹窗（按模型分组、消息明细）
- 无 MCP 工具时显示引导文案，链接至设置页面
- 工作区右键菜单「引用」（文件/文件夹/多选均支持插入 `@路径`）
- 新建技能对话框增加「导入文件夹」选项（桌面端）
- Moonshot 供应商新增 Kimi K2.5 模型

### Changed
- 消息存储升级为 JSONL 格式（O(1) 追加，崩溃容错）
- 增量统计计算、行数缓存、文件锁机制
- Tab 切换时自动同步供应商、API Key、MCP 配置
- Slash 命令菜单键盘导航时自动滚动保持选中项可见

### Fixed
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

### Technical
- 应用退出支持 Cmd+Q 和 Dock 右键退出的进程清理（RunEvent::ExitRequested）
- 进程清理函数重构，统一 SIGTERM → SIGKILL 两阶段关闭
- 启动时清理扩展至 SDK 和 MCP 子进程

**详见**: [specs/prd/prd_0.1.4.md](./specs/prd/prd_0.1.4.md)

---

## [0.1.3] - 2026-01-27

### Added
- 支持从 Claude Code 同步 Skills 配置（`~/.claude/skills/` → `~/.myagents/skills/`）
- ProcessRow 显示任务运行时间
- 展开状态显示实时统计信息（工具调用次数、Token 消耗）
- 新增 Trace 列表查看子代理工具调用记录
- Settings 页面增加 Rust 日志监听

### Changed
- 技能/指令详情页焦点控制优化
- 描述区域支持多行输入
- 内容区域高度自适应视口

### Fixed
- 修复 Toast/ImagePreview Context 稳定性问题
- 统一 useEffect 依赖数组规范
- 统一定时器初始化模式
- 修复权限弹框重复弹出问题
- 修复 Settings 页面事件监听竞态条件
- 修复 tauri-plugin-updater 架构目标识别问题
- 移除非标准 platform 字段，符合 Tauri v2 官方 schema
- 修复事件发射错误处理
- 修复更新按钮样式（emerald 配色 + rounded-full）

### Technical
- 增加文件描述符限制至 65536，防止 Bun 启动失败
- 添加 `--myagents-sidecar` 标记精确识别进程
- 实现两阶段清理机制（SIGTERM → SIGKILL）
- 明确 Tab Sidecar 与 Global Sidecar 使用边界
- Settings/Launcher 不再包裹 TabProvider
- Release 构建启用 INFO 级别日志支持诊断
- 调试日志包装 `isDebugMode()` 避免生产环境刷屏

**详见**: [specs/prd/prd_0.1.3.md](./specs/prd/prd_0.1.3.md)

---

## [0.1.2] - 2026-01-25

### Added
- 实现自定义服务商完整的 CRUD 功能
- 服务商配置持久化到 `~/.myagents/providers/`

### Fixed
- 修复 MCP 开关状态与实际请求不一致问题
- 初始化时始终同步 MCP 配置（包括空数组）
- MCP 变化时正确重启 SDK 会话
- 切换配置时保持对话上下文（通过 resume session_id）
- 修复 AI "失忆" 问题
- 实现用户级 Skill 按需复制到项目目录
- `/` 菜单去重（项目级优先）
- 修复详情页交互问题（保存后自动关闭、名称字段、路径重命名）
- 修复 `/cost` 和 `/context` 命令输出不显示问题
- 正确处理 `<local-command-stdout>` 包裹的字符串内容

### Changed
- 设置页版本号动态读取
- 日志规范化（生产环境不输出调试日志）

**详见**: [specs/prd/prd_0.1.2.md](./specs/prd/prd_0.1.2.md)

---

## [0.1.1] - 2026-01-26

### Added
- 添加订阅凭证真实验证功能
- 设置页显示验证状态（验证中/已验证/验证失败）
- 支持拖拽文件到工作区文件夹
- 支持 Cmd+V 粘贴文件到工作区
- 支持拖拽/粘贴文件到对话输入框（自动复制到 `myagents_files/`）
- AskUserQuestion 工具向导式问答 UI
- 单选自动跳转 / 多选手动确认
- 自定义输入框支持
- 进度指示器和回退修改
- Agent 日志懒加载创建
- 日志存储到 `~/.myagents/logs/`
- React/Bun/Rust 日志统一到 UnifiedLogs 面板

### Fixed
- 修复 Anthropic 订阅检测逻辑（`~/.claude.json` 中的 `oauthAccount`）

### Changed
- 文件名冲突自动重命名
- Cmd+Z 撤销支持
- 30 天日志自动清理

**详见**: [specs/prd/prd_0.1.1.md](./specs/prd/prd_0.1.1.md)

---

## [0.1.0] - 2026-01-24

### Added
- Initial open source release
- Native macOS desktop application with Tauri v2
- Multi-tab support with independent Sidecar processes
- Multi-project management
- Claude Agent SDK integration
- Support for multiple AI providers:
  - Anthropic (Claude Sonnet/Haiku/Opus 4.5)
  - DeepSeek
  - Moonshot (Kimi)
  - Zhipu AI
  - MiniMax
  - Volcengine
  - OpenRouter
- Slash Commands (built-in and custom)
- MCP integration (STDIO/HTTP/SSE)
- Tool permission management (Act/Plan/Auto modes)
- Visual configuration editor for CLAUDE.md, Skills, and Commands
- Keyboard shortcuts (Cmd+T, Cmd+W)
- Local data storage in `~/.myagents/`

### Technical
- React 19 + TypeScript frontend
- Bun runtime bundled in app
- Rust HTTP/SSE proxy layer
- Chrome-style frameless window
- 零外部依赖（内置 Bun 运行时）

**详见**: [specs/prd/prd_0.1.0/](./specs/prd/prd_0.1.0/) (21 个迭代 PRD)

---
