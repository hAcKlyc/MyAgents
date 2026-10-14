# MOXBOTS-BRAND-COMMUNITY-001 独立 UI / 状态审查

Reviewer：community_review。基线 `c7bab28594a03dfba7167200a90ae73ad0a6b5aa`，工作分支 `codex/brand-community-20261015`。仅编辑本报告和 `brand-community-validation/`，没有编辑产品、提交、推送、操作生产或用户 Chrome；使用现有 Playwright 缓存 Chromium 的独立 headless 会话。请求模型 gpt-6.1-sol / medium，实际运行变体、token 与费用未知。

## 结果与证据边界

本地限定范围 **39/39 项通过，无未关闭产品缺陷**。这不是生产、原生安装或真实上游 OIDC 验收。主 Agent 负责最终集成、主干、发布及生产账号路径。精确候选文件 SHA256 见 `brand-community-validation/source-hashes.json`。

| 层次 | 检查 | 结果文件 | 边界 |
| --- | --- | --- | --- |
| 桌面入口 | 4/4 | desktop-results.json | 真 GlobalSidebar / 产品样式 / openOwnedCloudPage；registry、外部 opener 及配置 hooks 为显式 mock，App callback 按实际源码接线，非完整 App 或原生壳 |
| 关于页面 | 4/4 | about-results.json | 从当前 SettingsPage 原样抽取 About JSX 并以真实 React/i18n/theme 渲染；Settings owner 状态及 ExternalLink wrapper 为 stub，非完整 SettingsPage |
| 用户社区 | 15/15 | web-results.json | 实际 community HTML/CSS/JS，显式模拟认证/API与故障 |
| 管理操作故障 | 6/6 | admin-results.json | 当前 app.js 原样抽取 CommunityAdmin，实际 CSS，显式模拟外层 session/request owner；完整后台另有真实本地联调 |
| 真实本地联调 | 10/10 | integration-results.json | 最终编译 assets + 真 AuthStore / CommunityStore / HTTP / admin；仅 OIDC 上游身份选择器为合成，最后恢复案例额外注入响应丢失和 401 |

模拟与真实浏览器均无 pageerror。独立 harness 目录 ESLint `--max-warnings=0` 通过。没有安装新框架。截图全部为本地合成身份、数据与 loopback，不包含生产凭据；保留代表性截图，重复/debug/失败截图未纳入交付。

## 已执行行为

桌面 1440×900、768×1024、390×844：实际“更多→协作社区”打开配置所属 issuer `/community`；Escape 返回触发按钮焦点。配置缺失显示错误，不打开 upstream 或任意 peer。关于页面显示中文 MoXBots 自有说明、官网/仓库/社区/反馈链接，不显示 upstream 群二维码或邮箱；法律原作者及第三方声明仍保留。390 的长仓库链接已修复换行并重新查看截图。完整 App 的旧 Space route 被产品分支导向 owned community、旧 Space tab gate 被关闭，属于源码审查证据，未冒充完整 App runtime 验证。

用户社区在三个尺寸实际检查列表、详情、长文本与恶意 HTML 仅文本、分类/搜索、required、Escape、可见焦点；400/403/409 后保留可编辑草稿，断网和真实 15 秒超时锁住原 mutation/body，原请求重试后成功。401 再认证通过真实页面导航和同主体 callback 恢复不确定原请求；异主体不恢复草稿/请求，退出清空并撤销旧会话。回复不确定时阻止切换到新话题提交，返回原讨论重试相同 body。

管理员在三个尺寸检查可读布局、无横向文档溢出、长内容/XSS、403 保留选择、未知结果锁定修改与跨页保留原请求、CAS409 后要求重新加载最新话题、成功携带 `expected_revision`。完整后台实测的 390 导航为局部横向滚动条，社区项可通过该导航进入；正文与操作表单保持单列。

已实际查看代表性截图：desktop-more-1440/390、about-1440/390、web-1440、web-768（运行时已查看、交付去重）、web-detail-1440/390（保留390）、real-admin-1440/768/390、real-recovery-1440。长正文在详情 dialog 内纵向滚动，关闭按钮清晰可达；移动端管理表单正常换行。

## 最终真实本地链路

服务 `http://127.0.0.1:5198`，后端 ignored `community_browser_fixture`。`served-hashes.json` 逐项确认 `/community/app.js`、`/community/styles.css`、`/admin/app.js`、`/admin/styles.css` 与磁盘源码完全一致，再运行验收。

1. 普通用户实际 PKCE 导航、发帖并持久化。
2. 另一主体看到共享话题、发表持久回复；恶意 HTML 不执行。
3. 管理员实际登录完整 `/admin`，进入社区，看到该话题和回复；三个尺寸复核。
4. 管理员置顶/锁定，普通用户刷新看到锁定且无法回复。
5. 管理员隐藏后另一主体列表不可见，管理员仍可核对。
6. 管理员恢复公开/解锁，已存回复保留，普通用户恢复回复入口。
7. 普通用户尝试完整后台，被权限检查拒绝，console 未展示。
8. 原用户退出重登仍看到既有话题、回复。
9. 真实 POST 已提交后故意丢响应，原请求重试注入401；实际同主体登录导航后按原 mutation/body 重试，最终仅一条新增话题。

以上合计10项（含最初的源码/服务字节一致性）。真实服务重启恢复、>200 最新回复窗口、存储目录权限、并发压力由后端 owner 的测试另证；本 UI 报告不独立声称覆盖这些边界。

## 缺陷与复核

- **COM-UI-01**：已不确定的用户发帖重试遇401后无条件丢弃 pending，重登录生成新 mutation。独立 browser 复现后 web owner 添加 unconfirmed 状态；模拟与真实已提交/丢响应/401/导航/幂等恢复均独立复测通过。1轮修复。
- **COM-UI-02**：侧栏 community/cloudUnavailable 翻译键被加进错误 namespace，实际显示 `globalSidebar.community`。主 Agent 将键移回 globalSidebar，并补相邻中文标签；实际 sidebar 四项复测通过。1轮修复。
- **窄宽视觉修正**：About 390 源码链接溢出卡片；主 Agent 加换行后独立截图复核通过。1轮视觉修正，不扩大为移动原生支持承诺。

Harness 初轮出现多个“更多”选择器歧义、合法作者署名/品牌图被误当 upstream 残留、内联 script 截断、重复 heading 选择器及旧并行进程结果覆盖，均已修正并最终完整重跑；不计为产品缺陷。独立 review 发现2项产品缺陷，2轮功能修复，另1轮窄宽视觉修正。

## 状态与风险审查

服务在同一 AuthStore 会话锁内检查 network 与实时管理员 allowlist 再操作 store；客户端不声称自己具有管理权限。用户 pending 绑定原主体，Bearer 只在内存；原请求在不确定状态保持原 body/ID。用户列表/detail 与管理员 render/session epoch 阻止旧请求写回新页面或新账号。主动退出清理草稿与 pending；管理员退出或失效会话也清理内存 pending，再登录须重新加载当前修订，未实现跨登录保留管理员处理操作的产品承诺。

附加源码审查：AgentNetwork setup 卡片仅 moxbot 分支使用 Bots Net 文案/自有官网；中英文 infoIntro/Relay/Local 覆盖仅作用于 moxbot，原 profile 分支保留。未渲染完整 AgentNetwork setup gate。Launcher hero/theme 的并发修改不在本 UI review 的渲染验收范围内。

## 复现

仓库根目录，先由后端 owner 启动最终编译 fixture（避免与其 cargo 作业争锁）：

```sh
/opt/homebrew/opt/node@24/bin/node dev-docs/brand-community-validation/sidebar-run.mjs
/opt/homebrew/opt/node@24/bin/node dev-docs/brand-community-validation/about-run.mjs
/opt/homebrew/opt/node@24/bin/node dev-docs/brand-community-validation/web-run.mjs
/opt/homebrew/opt/node@24/bin/node dev-docs/brand-community-validation/admin-run.mjs
cargo test --manifest-path services/agentnet/Cargo.toml --locked --lib community_browser_fixture -- --ignored --nocapture
/opt/homebrew/opt/node@24/bin/node dev-docs/brand-community-validation/integration-run.mjs
```

about-run 会生成可重复抽取的 about-extracted.tsx；它是临时 harness 输入，不是产品组件。模拟、真实本地与生产分别记录，39项本地通过不替代主 Agent 最终验收。

## 发布前相邻入口复核（追加）

主 Agent 随后发现旧资源市场入口在 MoXBots 下显示 upstream 市场宣传，却因 Space gate 关闭而跳到社区；已修复。独立复核候选 HEAD `bae5dceeb85b3f834fbd4d336c479f4237c6b3a5` 上未提交的最终入口修正：

- 实际运行 DOM `ToolMarketEntry.profile.test.tsx`，**2/2通过**：动态切换 moxbot / myagents profile 并重载产品模块；moxbot 不渲染按钮/宣传图、不会触发回调，myagents 原按钮点击调用 onOpen 一次。
- `scripts/check-test-classification.mjs` 通过；文件有 `@vitest-environment jsdom`，由 dom 项目的 `src/**/*.test.tsx` 收集，不进入 unit 池。
- 源码确认 App 的 `handleOpenToolMarket` 在 moxbot 分支仅显示本地化不可用说明；合法 `space.home` 仍打开 owned community，其他旧 Space route 只提示并返回已处理，`task.comment` 在此前独立处理，未被误拦截。中英文 `globalSidebar.legacySpaceUnavailable` 位于正确 namespace。

没有新增缺陷。上述为2项真实 React DOM 检查及有界源码审查，未启动完整 App/原生 deep link，不改变此前39项浏览器验收的证据边界。没有服务/社区 assets 变更，未无谓重跑已通过的服务验收。最终相关文件哈希已更新进 source-hashes.json。
