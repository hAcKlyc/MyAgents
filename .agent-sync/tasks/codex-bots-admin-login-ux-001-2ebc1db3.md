<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/bots-admin-login-ux-001 -->
<!-- git-project-sync-task:base=d86f7505f641ecbe6d136142c11422ef063ea0e5 -->
<!-- git-project-sync-task:status=complete -->


# Task: BOTS-ADMIN-LOGIN-UX-001 同页中文管理员登录

## Objective

修复云后台弹窗登录造成的双窗口割裂：当前标签页登录、固定同源返回、中文统一品牌。仅现有认证链路 UI/跳转，不新增账号、权限或认证 owner。

## Acceptance criteria

- [x] 当前标签页跳转登录并返回 /admin，成功加载既有管理员目录；不创建弹窗。
- [x] 错误、取消、浏览器返回、刷新及过期可恢复，普通账号依旧 403。
- [x] PKCE/device/state 绑定及单次消费保持，临时事务仅 tab-scoped；bearer 不落盘、不入URL。
- [x] 中文登录页面 390/768/1440 布局、键盘与交互检查通过。
- [x] 聚焦测试、独立只读审阅、CI、main 合入及远端核查。
- [x] 云端备份/回滚、源码对应、真实管理员登录/退出复验。

## Completed

- 基线与 origin/main d86f7505 已核实；隔离工作树 start gate PASS。
- 主 Agent 实现/集成/发布；login_ux_review 只读审阅，requested gpt-6-luna/medium，实际模型及用量未知。

## Verification

- 代码：已交付 main 1ece497d（PR33）；模拟：Rust90通过/2手动fixture忽略、Python5、clippy/fmt、真实AuthStore loopback同页登录/取消/过期/退出撤销/普通用户403通过，弹窗0；独立真实Dex隔离UI三视口与键盘/401错误恢复通过；CI七项通过；云端已发布并完成真实管理员中文登录、确认、干净/admin返回、Bots目录、退出204和失效callback400中文恢复。

## Blockers and unknowns

- 当前没有新增授权需求；使用既有受控测试账号，禁止模型调用及 Bot/账号业务写入。

## Next step

- 当前UI任务无需继续实现；后续账号管理和Bots共享依既有规划另行推进。云端维护窗口已释放，101 Host 未改动。

## 最终发布与真实验收

- PR33源码 main `1ece497d9b93974667c17c25d41350325479ef5e`，包含 reviewed head `7c30a58c96339b9a3eae86c7e68a728da10b3edf`；源tree与CI工件源 `c1a257a206c7a262a70ca698cfc39b7a6e0e0d9e` 完全相同（e8767f85）。主干已远端核实，后续文档收口不改源。
- Test `38499003136` 六项、Owned `38499003166` 一项全通过；工件 `11865367468`。归档SHA256 `c698d3ac714070ab9c22e40fe8e4613fddee50a9ee29bc072bde4e9f968ca1c2`；运行二进制SHA256 `04e4a960b46078870b5c2d83bb07906e0da1d1369a4830631ecaad9cd6917de9`。
- 仅现有auth/network服务升级，停止后备份完整私有状态及unit，SQLite integrity通过；备份标记 `moxbots-login-ux-backup-20261014T101958`。runtime PID与目标二进制路径核实，HTTP三个admin资产与源码SHA精确一致，服务phase authentication。Dex资源逐文件manifest通过；原身份/凭据/client id及redirectURI/approval策略/service.json/nginx不变，仅新增frontend主题及展示名。
- 回滚恢复备份network unit及dex.json，daemon-reload，启动原auth再network；不覆盖业务状态。
- Codex IAB同一tab真实受控管理员：/admin→中文邮箱密码页→中文身份确认→干净/admin→Bots管理目录；退出请求204，登录页恢复。无效callback为400中文恢复页，可点击返回；真实取消返回清除待登录请求。没有Bot写入、Host写入、模型调用或账号/权限扩大。
- 实际账号仅既有管理员；普通用户403与390×844/768×900/1440×1000使用隔离合成身份及真实Dex fixture，不能称作生产多用户验收。
- 主Agent + 1只读独立worker，requested gpt-6-luna/medium，实际model/token/费用未知。纯内置模式未调用外部模型。独立审阅发现源码溯源需独立工件/资源证明，主Agent已以CI归档、Git tree、资源manifest及运行SHA补齐。
- 详细凭据、浏览器证据、回执、脚本及备份的安全访问沿用本聊天私有证据目录；普通Git不保存密钥、cookie、bearer或访问URL。
