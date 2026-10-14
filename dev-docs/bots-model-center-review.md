# BOTS-MODEL-CENTER-001 独立审查记录

审查对象：`/Users/zhangshaohua/Documents/Codex/2026-10-14/moxbots-model-center`，分支 `codex/bots-model-center-001`，审查时 HEAD `3ee8aab5c185b87d607d4692482d987830c63536`。工作区存在实施中的改动；本审查未修改实现、测试或生产，也未运行部署操作。

## 发现

### 已修复：模型分配在响应丢失后无法用原 mutation 查询或重放

`POST /api/admin/bots/{id}/model` 在调用存储层 mutation 前，先要求当前 Bot revision 等于请求的 `expected_revision`（`services/agentnet/src/model_center_http.rs:401-404`）。成功写入会增加 revision；如果写入已提交但响应丢失，原请求重试会在这项前置比较处以 409 结束，尚未到共享 `admin.store.mutate` 的 actor/action/body 幂等回放（同文件 `:413-421`）。

前端将该写入标为模型 mutation 并查询 `/api/admin/model-mutations/{mutation_id}`（`admin-web/app.js:562-566, 909-915`），而该查询只查 `ModelCenterStore::mutation`（`model_center_http.rs:260-273`）。分配实际将操作收进 AdminStore 的 `configure` mutation，并未写入 ModelCenterStore 的 mutations 表。因此响应丢失时查询得不到原结果，重试也因旧 revision 被拒绝，用户只能通过刷新间接判断当前期望值，无法确认原 operation 的确切结果。

当前版本已在可变 Bot/provider 检查和 revision CAS 之前用 actor、action 与稳定的 `(bot_id, model_ref, mutation_id, expected_revision)` 请求投影检查 AdminStore 原回执；相同请求转入存储层精确 replay。真实 loopback UI 创建并保存 assignment 后，Playwright 以同 mutation、同请求体重放得到 HTTP 200 和相同 revision/model_ref，`GET /api/admin/mutations/{id}` 也返回相同回执。不同 operation 的 stale revision 负例尚待补跑。

### 已修复：usage 为空时前端 render 抛异常，调用监控页面不可用

真实 Rust fixture 的 Playwright 首次打开“模型中心 → 调用监控”，此时没有调用记录。`renderModelUsage` 的空态分支（`services/agentnet/admin-web/app.js:423`）写成 `panel.append(node(...)).lastChild.append(...)`；DOM `Element.append()` 的返回值是 `undefined`，于是报 `Cannot read properties of undefined (reading 'lastChild')`。当前结果是仅剩两个模型中心 tab，查询按钮、过滤器、空态解释和摘要均未渲染。此路径尚未发出 `/api/admin/model-usage` 请求，浏览器无法查看后端的真实空列表。

当前实现先 append 空态 node，再向该 node 添加标题/说明。最终 fixture 中真实 HTTP 返回 0 行时，空态说明与零请求摘要正常显示；无控制台异常。

### 已修复：usage 记录列表在 390px 视口产生页面级横向溢出

最终 fixture 含三条真实写入 ModelCenterStore 的合成 `reserve`/`settle` 计量记录。首次检查发现 390px 页面级溢出，现已由实现方改为移动卡片布局，并针对长内容换行及表格宽度约束修复。最新 Chromium 复测 390px 的 viewport、documentElement 与 body 宽度均为 390px；记录以卡片完整显示。768px 宽度均为 768px，表格留在内部可横向滚动容器（client 522px、scroll 900px）。1440px 宽度均为 1440px，表格完整显示。过滤到无记录时空态和汇总显示正常。最新截图已逐张检查，三种视口没有页面级横向溢出或遮挡。

## 已核对的安全与状态边界

- Model access grant 绑定 Bot、Host、owner、具体 model UUID、额度和到期；签发要求 Bot owner 的真实登录会话及当前 Host connection，并再次通过 `with_model_host` 校验 live session。普通用户被 admin allowlist 拦截。新建模型会核验 owner principal 已注册。
- 新 session 受 grant 的模型集合约束，并要求当前 Host/Bot 校验返回相同资源身份。调用前和流式期间重新核验 session 与 live Bot；模型/Provider 禁用或 Provider revision 改变会阻断旧 session。撤销按 Bot 一次性撤销其 grant/session 凭据。
- Provider URL 限 HTTPS、默认 443、域名非字面 IP；解析后要求所有地址为公网地址并将连接绑定解析结果，关闭代理、redirect 和 reqwest retry。上游响应体、SSE frame、超时和输入均有上限。未确认用量保留全额预留，不释放为已知成功；请求 ID 重放会被拒绝。
- UI 明确区分后台期望模型与 Host 有效模型；运行中 session 固定在其启动时 capture 的模型，不因 assignment 静默切换。该次审查未发现把 desired assignment 直接显示为 Host 已生效的代码路径。

## loopback 浏览器验收

通过独立 Playwright Chromium（Node 24）访问真实 Rust loopback `127.0.0.1:5199`。fixture 使用真实 `AuthStore`/AdminStore/ModelCenterStore、合成 OIDC 身份和合成 Host；测试 API 地址使用 `.example.test`，fake key 仅为合成字符串，没有供应商调用、Host 进程或付费推理。未访问用户 Chrome 或生产服务。

- 登录合成管理员成功；创建启用 Provider 与已启用模型，授权范围选中已注册 Bot owner。UI 配置 USD/百万 tokens 输入 `1.250000` 与 `4.500000` 后，bootstrap 返回 `1,250,000` / `4,500,000` micro-USD，Provider 状态为 enabled 且 `has_key=true`；截图未捕获密钥字段。
- Bot 模型 assignment HTTP 200；bootstrap 回读的 `model_ref` 与所选模型 UUID 相同。原请求体、mutation ID 原样重放 HTTP 200，revision 与 model_ref 不变；AdminStore mutation 查询 HTTP 200 返回相同结果。独立 stale revision 写入返回 409 `REVISION_CONFLICT`。
- AuthStore 退出后，使用退出前会话访问 bootstrap 得到 401；登录合成普通用户后，bootstrap 得到 403，UI 返回登录屏并显示无管理权限。
- usage 表格展示三条合成记录：成功且已知用量 `3+2` tokens、上游错误且用量未知、成功但价格未知。实际费用显示 `$0.000007` 或“未知”；汇总 tokens/费用保持未知而非伪造为 0，失败率 33.3%。筛选到无记录的模型后空态与 `0` 请求摘要正确显示。计量记录由真实 store 流程生成，但没有调用供应商或付费模型。
- populated usage 和过滤后空态已在 390/768/1440 独立 Chromium 最终复测。各视口 document/body 宽度与 viewport 精确相等（390、768、1440）；768px 表格只在内部容器滚动。浏览器页面没有 JS 异常。此前对话框 Escape 和初始焦点检查通过。

最终移动布局复测对应 served app.js SHA-256 `095750852ae818cf91d63ff59dfc321e1a44ef89769fd3c4fcf0c94053dacf53`，styles.css SHA-256 `e31a21044b2ada865ec5364ec16cd45997ff3e892a78faf217c9deca24b3b997`；served app.js 与源文件哈希一致。最终截图：`final-fixed-populated-390.png`、`final-fixed-populated-768.png`、`final-fixed-populated-1440.png`、`final-fixed-empty-390.png`；机器可读视口结果：`final-fixed-mobile-results.json`，均位于上述私有证据目录。

证据截图与无 bearer 的合成结果摘要位于 `/Users/zhangshaohua/Documents/Codex/2026-10-14/moxbots-model-center-private/`。

## 尚未完成的验收

代码/测试工作区尚未合并；本记录只覆盖独立审查及 loopback UI 验收。assignment stale CAS、usage 空态与 populated 响应式布局、登录权限路径均已通过本地合成 fixture。没有运行生产、真实供应商 API、真实 API key 或付费调用；不能据此认定生产发布或真实供应商联调完成。
