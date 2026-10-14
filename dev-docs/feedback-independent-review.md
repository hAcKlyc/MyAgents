# FEEDBACK-001 独立 UI 验收

Reviewer：feedback_ui_review；只写本报告与 feedback-validation/，没有修改产品源码、生产或用户Chrome。模型请求 gpt-6.1-sol / medium；实际运行变体、token与费用不可确认。候选为 codex/feedback-center-20261015 工作区，base HEAD `ff957fdf078d8e96e732c5b22c89ee2f41337fe9`；实际源码sha256见 feedback-validation/source-hashes.json。

## 最终结果

- [x] 桌面真实React渲染，moxbot profile，1280×800 / 900×800，5项通过。
- [x] 云端实际HTML/CSS/JS的显式模拟auth/API浏览器检查，1280×800 / 390×844，18项通过。
- [x] 最终编译内嵌assets、本地真实AuthStore/FeedbackStore/Admin HTTP，6项通过；只有上游OIDC身份选择器为合成测试实现，第6项另有一次401响应故障注入。
- [x] 视觉、交互、响应式在上述本地范围通过；查看了实际截图并执行关键按钮行为。总计29项通过，无未关闭产品缺陷。
- [ ] 生产OIDC、真实账号及已安装原生客户端验收由主Agent负责，此报告不证明其通过。

## 桌面入口

Fixture真实使用GlobalSidebar、OwnedAccountEntry、JoinNetworkDialog与产品样式；mock网络/store/API，无原生登录或模型。实际确认账户在设置下方，小助理触发原onOpenBugReport回调，反馈打开所属issuer `/feedback`；未登录仍使用既有JoinNetworkDialog。900窄轨账户与铃铛分开，账户可聚焦、Escape关闭；铃铛实际打开原通知flyout，未出现小助理。证据 sidebar-results.json、sidebar-login-1280.png、sidebar-rail-900.png、sidebar-menu-900.png、sidebar-notification-900.png。

## 模拟故障与安全检查

使用原始feedback-web、admin-web feedback.js与样式，显式mock auth poll/反馈API和admin request。覆盖：PKCE回调context删除、Bearer不持久化、required验证、确定失败保留可编辑输入、401清理与再认证解锁、断网及真实15秒AbortController超时原请求不变、重试完成、详情/回复恶意HTML仅文本、原生dialog Escape、390无横向溢出、退出捕获旧Bearer撤销与清空DOM、reload需重新登录。

草稿回调真实重新加载页面：同principal恢复有界title/description/category/version，不自动POST，随后清除待登录context；异principal清空。已不确定原请求的同主体草稿恢复后输入冻结、显示“重试原反馈”，POST mutation_id与整个body逐字段等于原pending；异主体不恢复pending或输入。

管理员覆盖：状态/回复CAS冲突保留输入、结果未确认锁原请求、原编号原内容重试、重试确定性冲突恢复编辑、成功刷新。证据 web-results.json、web-detail-1280.png、web-390.png、admin-uncertain-390.png、admin-1280.png。

## 最终真实本地联调

环境 `http://127.0.0.1:5197`，后端ignored feedback_browser_fixture。真实AuthStore会话、FeedbackStore私有文件存储、反馈HTTP与管理员权限；OIDC由本地合成身份选择器代替。served-hashes.json确认最终 `/feedback/app.js`、`/admin/feedback.js` 与磁盘源码sha256完全相同，不使用旧编译内嵌assets宣告最终通过。

6项旅程：普通用户实际点击登录/PKCE并提交列表；管理员实际登录进入完整后台用户反馈页回复并更新已解决；原用户刷新详情看到状态与回复；另一主体列表为空看不到原反馈；原用户退出并重登仍看到既有反馈；单次401响应故障注入后实际登录导航、同主体真实poll回调恢复草稿且可编辑。最终管理员390无横向溢出，截图可读无遮挡。

证据 integration-results.json、real-user-1280.png、real-admin-1280.png、real-admin-390.png、real-user-detail-1280.png、real-other-390.png、real-reauth-draft-1280.png。账号均为本地合成AuthStore主体；脚本不输出或保存Bearer。跨退出重登持久化已验证，未在此UI脚本测试服务重启恢复；存储重启/权限/幂等单元验证由后端owner提供。

## 缺陷与修复

FB-UI-01（独立review发现）：管理员提交结果不确定后重试遇到确定性REVISION_CONFLICT，原runPending清除pending/隐藏retry却未解锁原form，回复可见但无法继续编辑。主Agent修复后独立浏览器回归通过，保留回复并恢复textarea/select/save。1轮产品修复。

FB-UI-02（主Agent发现）：提交401后forgetSession原表单保持锁住。主Agent修复后独立回归通过。进一步按主体绑定有界草稿，只主动登录时写入本Tab待登录context，回调同主体恢复、不自动提交、异主体reset；已不确定请求在再认证后沿用原mutation。相关模拟与最终真实导航回归通过。草稿机制不持久化Bearer，主动logout清理表单和context。

验收脚本曾出现inline脚本截断、格式化空白断言和Playwright单次route解绑错误，均为fixture问题；已修复重跑，未计为产品缺陷。

## 复现

仓库根执行；使用现有Playwright缓存Chromium与loopback，未安装框架或使用用户Chrome：

```
/opt/homebrew/opt/node@24/bin/node dev-docs/feedback-validation/sidebar-run.mjs
/opt/homebrew/opt/node@24/bin/node dev-docs/feedback-validation/web-run.mjs
cargo test --manifest-path services/agentnet/Cargo.toml --locked --lib feedback_browser_fixture -- --ignored --nocapture
/opt/homebrew/opt/node@24/bin/node dev-docs/feedback-validation/integration-run.mjs
```

本地/模拟通过不替代生产OIDC、真实账号、原生安装和发布验收。主Agent仍负责整体集成、主干交付与最终验收。复盘：结果未确认再认证需保留原mutation这一跨页面状态，是本轮关键风险；以后将其前置为固定恢复旅程可减少重复编译验收。
