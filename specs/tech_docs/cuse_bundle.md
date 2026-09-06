# Cuse 内置 Skill+CLI

Cuse 的独立仓库负责桌面操作、CLI/help/Skill 内容及版本发布；MyAgents 消费完整 Skill 包。它是全局 **可关闭的 system-owned Skill**：首次默认启用，内容由客户端更新覆盖，关闭状态由现有 `skills-config.json.disabled` 保留。它不在 `REQUIRED_SYSTEM_SKILLS` 中，也不注册内置 MCP。

## 构建 owner 与交付结构

Mac 和 Windows 的正式/开发构建脚本调用 `scripts/prepare-cuse-bundle.mjs RUST_TARGET_TRIPLE`，按目标选择平台，不能按执行脚本的主机猜测：

| 构建目标 | Cuse 包 |
| --- | --- |
| aarch64 / x86_64-apple-darwin | macos-universal Skill ZIP |
| x86_64-pc-windows-msvc | windows-x64 Skill ZIP |
| Linux | 不携带 Cuse；清理该构建树残留的其它平台 Cuse staging |

准备过程每次读取 `https://download.myagents.io/cuse/bundles/latest.json`，校验其指向的版本 manifest 的 SHA256/长度，选择 `packages.skill`。已安装的本地 staging 必须满足 metadata 的版本、source commit、平台、入口、完整文件清单、逐文件哈希与 Mac 执行权限；缺失或不匹配才下载 ZIP。ZIP 校验通过、所有成员为安全普通文件、解包完整性通过后才替换 `bundled-skills/cuse/`。网络或校验失败终止构建，保留已有包，不以旧包冒充最新包。

`bundled-skills/cuse/` 是 ignored 的构建输入，由既有 Tauri `bundled-skills` resources 映射携带。不要手工提交二进制、从 MCP 包拼装 Skill 或修改上游 SKILL.md。整个目录包含 `SKILL.md`、`package.json`、`LICENSE`、`references/` 和 `scripts/cuse[.exe]`、Python 辅助脚本。Python 只用于可选编排，CLI 本身不依赖 Python/Node。

低层直接使用 `tauri build/dev` 时，先运行 `npm run prepare:cuse -- <target>`；平台 build 脚本已包含这一步。此机制没有版本 pin、独立锁文件、运行时下载器或客户端自动升级 Cuse 的后台任务。每次准备输出实际版本、平台和 ZIP SHA256，便于追踪构建输入。

## Mac 签名与启动同步

Cuse 上游包采用 ad-hoc 签名。MyAgents Mac 发布构建在下载验证后，用 `APPLE_SIGNING_IDENTITY` 对资源中的 Cuse CLI 执行 Developer ID / hardened runtime / timestamp 签名，再由 Tauri 封装 App。开发构建配置同一身份时也签名。Tauri 不自动签任意 Resources 下的可执行文件，这个显式步骤与 Node/Claude 的现有签名路径一致。

`package.json` 保留上游交付 metadata；签名改变 CLI 字节，所以上游二进制哈希只用于**签名前构建下载验证**。下次构建会将签名后的 staging 判为需要恢复，再从上游重新准备。启动时以**当前 App bundle 中实际文件**为权威比较、复制，不能拿上游 hash 拒绝正确签名的 App。

Rust `cmd_sync_system_skills` 在原有同步锁内管理安装到 `~/.myagents/skills/cuse/`。Cuse 除系统 Skill 版本戳外还比较 App source 与已安装目录的完整 metadata/文件字节，并检查必需文件、普通路径与 Mac 可执行位。因此仅 Cuse 版本改变、不手工 bump 系统 Skill 版本也能更新；文件缺失、内容损坏或执行权限丢失会重新同步。源不完整时先保留旧副本，不先删除。Linux 跳过 Cuse 同步，不因此阻断其它系统 Skills。

同步只写 Skill 目录；不写 `skills-config.json`。用户在「全局 Skills」关闭 Cuse 后，App 更新仍会覆盖内容，但不会重新启用。UI 复用既有 `systemOwned: true, required: false` 语义：内容只读、可启停；项目自己维护的同名 Skill 仍遵守原有 project winner 规则。

## Runtime 使用与平台体验

所有 Runtime 继续走现有全局 inventory 和 capability selection。Builtin / Claude Code 工作区链接以及 Codex 的临时 Skill roots 链接整个目录，保留相对 `scripts/` 与 `references/`。Agent 从实际加载的 Skill 根目录读取 `package.json.entrypoint` 并解析成绝对路径，再按需使用 `--help` 和 `readme`，不依赖系统 PATH。更新由下次启动同步、既有 Runtime admission/idle replacement 生效。

Mac 提供 Cuse 的后台窗口定向输入；前台输入仍共享用户鼠标/焦点。Windows 支持前台操作，后台计划返回 unsupported；Linux 不提供这份 Skill。权限和操作契约由随包 Skill 与 CLI help/readme 渐进披露，MyAgents 不在全局提示词镜像这些细节。首次实际操作可能仍需系统辅助功能/屏幕录制权限。

关闭 Skill 控制能力发现与后续投影；它不是撤销操作系统权限、禁止已知绝对路径执行或强行取消当前 Agent 操作的安全开关。

## 验证与故障定位

- `node --test scripts/prepare-cuse-bundle.test.mjs scripts/build-resource-staging.test.mjs`：构建目标、完整性、补全、故障保留与接线。
- Rust `cuse_skill::tests` / `system_skills_tests`：完整 payload、签名后的实际字节、同步、缺文件/权限、关闭配置不变。
- `project-user-config-sync.unit.test.ts` 与 `codex-app-server-protocol.unit.test.ts`：全局关闭/重新启用与相对资源投影。
- 对真实 staging CLI 执行 `--version`、`--help`、`readme`；Windows ZIP 可在 Mac 校验，但 Windows 原生执行需要 Windows。

构建报下载错误时修复网络后重跑原平台脚本。用户端文件不完整时由下次启动从 App bundle 补全；若 App 自身缺包则需修复客户端构建，不能让 Agent 自行下载另一份 CLI。

可选原生验收：准备并签名 Cuse 后，将 `MYAGENTS_CUSE_SMOKE_SOURCE` 指向完整 `cuse/` 目录，显式运行 ignored Rust 测试 `cuse_prepared_bundle_native_smoke`。它通过真实系统 Skill 同步 helper 安装到临时目录，再执行同包 CLI 的 version/help/readme，不触碰用户 Skill 或桌面输入。
