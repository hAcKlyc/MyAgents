# 独立 UI 验收记录

任务 AN-SHARE-PROTOTYPE-20261013。当前方向：服务端平台管理员的跨 owner Bots 管理；个人 Bots Net 用户体验是次级入口。独立 reviewer 只读实现，独占本记录与 `evidence/independent-*`。范围为 loopback 本地合成交互，真实认证、API、Host 隔离、后端持久化、生产验收不适用。

请求模型 gpt-6.1-sol / medium（跨 Bot 状态与多角色判断可降低返工）；实际模型变体、effort 与用量未工具确认，未知。最终独立结论：本地原型视觉、交互与响应式验收通过，7项缺陷已关闭。最终HTML SHA256 `8118ea5a0715abcdfa0b3e39fca462a900c1182e5b6a2421524f7f7ada2ec3a3`；证据按固定版本继承，未宣称最终头全套重跑。

## 新版最小验收矩阵

| ID | 检查 | 完成标准 | 状态 |
| --- | --- | --- | --- |
| A01 | 平台管理员默认目录 | ≥5 Bots、≥3 owners、≥2 Hosts；默认平台管理员，无个人身份主入口；搜索与状态/Host筛选、清空恢复 | 通过 · 4959继承 |
| A02 | 跨 Bot 详情和配置隔离 | 列表上下文保留；不同 Bot 成员/资源/额度/审计独立，改一项不串入其他 Bot；刷新保留 | 通过 · 4959继承；8216关联复验 |
| A03 | 邀请与权限管理 | 目标/资源/重复/额度校验；角色与动态摘要一致；既有授权编辑增加版本并失效旧审批 | 通过 · 4959+8216；重复邀请8216 |
| A04 | 资源上限与管理边界 | 不可分享私人目录/原始凭据明确不可选；平台admin不等于共享admin，不能拿共享暂停冒充Host停止 | 通过 · 4959继承 |
| A05 | 跨页完整审批链 | 管理员邀请→目标接受→5k任务→35k待审→管理员审批→用户结果和用量→撤销拒绝；审批元数据完整 | 通过 · 4959；8216审批恢复复验 |
| A06 | 高成本预算和失效审批 | 预占不透支、重复提交和批准不重复结算；授权编辑/撤销/到期/暂停后旧审批不执行 | 通过 · 4959；8216失效/续期复验 |
| A07 | 共享暂停隔离 | 仅目标 Bot 被阻断，其他 Bot 与Host状态独立；本人历史成果保留；恢复共享可重试 | 通过 · 4959；8216暂停写入修复 |
| U01 | Bots Net 用户与私有边界 | 次级入口可返回管理员；guest不枚举私有对象、admin不读私人正文、会话按Bot+发起者隔离 | 通过 · 4959；8216inert/退出复验 |
| U02 | grant驱动的协作者/共享admin | 邀请协作者维护指定资料；共享admin管理低级成员，无自扩权/同级/跨Bot/Host/总预算权 | 通过 · 4959；8216资料恢复复验 |
| U03 | 异常和恢复 | Host离线、额度不足、过期提示可读且可恢复，拒绝不执行 | 通过 · 4959离线；8216过期恢复修复 |
| K01 | 模态与输入 | Tab/Shift+Tab圈定、Escape关闭、恢复触发点焦点；取消不保存，输入转义 | 通过 · 4959邀请焦点；8216外层；8118嵌套 |
| V01 | 视觉 | 1440×900目录与详情、权限预览层级清晰，统一模拟标识和可读边界 | 通过 · 8216修复截图；8118目录截图 |
| R01 | 响应式 | 1440×900、768×1024、390×844无页面横溢，表格局部滚动、抽屉滚动、手机导航折叠，核心控件可用 | 通过 · 4959几何/点击；8216控件/标识修复 |
| Q01 | 控制台 | 无页面异常或外部网络调用，仅本地合成模拟 | 通过 · 4959网络；8216/8118console |

旧个人方向矩阵与脚本未执行、不计 pass。旧脚本保留为 `evidence/independent-personal-v0-unexecuted.mjs`，只作方向对照，不能用于本版本验收。

新版正式执行将使用独立 headless context，通过可见 DOM 与产品控件建状态，不改 localStorage 造 passing state；开始/结束核对固定 SHA256。视觉、交互、响应式各自评定，截图不替代点击验收。

## 首轮固定版本结果

固定 HTML SHA256：`4959f53811d1da4bef51d394e2459ac3f72693a8ebab902f910c08703a3933eb`；开始/结束一致。2026-10-13 12:16:47–12:17:05（Asia/Shanghai），主自动化实际运行约18秒，补充视觉/键盘/共享暂停检查另行执行。浏览器为现有 Chromium headless shell 1243，通过已安装 Playwright 调用；默认依赖要求的1212缓存缺失导致两次环境launch失败，随后指定已有缓存完成，不安装框架，不使用用户Chrome。

主脚本19项结果：18通过、1失败；其中16项为业务/交互/三视口场景（15通过、1失败），其余为console、网络、固定hash检查。补充检查另发现下列缺陷。不能把首轮宣布全部通过。

- **视觉：需修复。** 平台管理员主方向、目录/详情层次和边界正确；品牌旧命名、手机窄按钮逐字换行、移动端缺少统一模拟标识仍待修复。
- **交互：需修复。** 完整邀请接受→5k任务→35k审批→结果40k→撤销与保留成果通过；跨Bot隔离、grant驱动角色、预留、防重复、授权变更失效、离线拒绝通过。过期反馈、暂停下资料写入与用户模拟键盘焦点待修复。
- **响应式：几何与核心点击通过，视觉待修复。** 三视口页面无横向溢出，邀请/接受/普通任务可操作；1440目录确有可操作局部横滚（wheel后scrollLeft 0→116，client724/scroll840），可访问末列，不判为不可访问截断。

### 待修复缺陷

| ID | 级别与复现 | 期望 / 实际 | 定位与证据 |
| --- | --- | --- | --- |
| IR-01 | P1：管理员暂停客户研究Bot→体验陈序→打开Bot→填写授权资料→保存 | 暂停共享后受保护写入应拒绝且不改变资源；实际提示保存成功，管理员资源页已持久改变 | `saveUserResource`（index第59行）；`independent-admin-paused-resource-write.png`、supplement.json |
| IR-02 | P2：邀请林沐并接受→35k待审→编辑授权有效期为过去日期→返回林沐列表 | 明确已过期、恢复方式，管理员不标有效；实际Bot静默消失，未提示过期，管理员成员状态仍按active显示有效；旧审批未执行这一点正确 | `members`/`userView`（28/44行）；`independent-admin-failure-U03-expiry.png`、results.json |
| IR-03 | P2：1440默认页面观察品牌旁 | 当前主入口按用户修正命名“管理控制台”；实际仍“AgentNets 服务端” | `header`（21行）；`independent-admin-directory-1440.png` |
| IR-04 | P2：390打开客户研究Bot详情 | 暂停/返回等关键控件应可读；实际按钮约52px宽100px高，中文字逐字换行；成员角色也形成竖列 | CSS/cardhead布局；`independent-admin-detail-390.png`、`independent-admin-mobile-controls.png` |
| IR-05 | P2：390查看主界面 | 统一显示交互原型与合成数据标识；实际 `.demo` 隐藏（页面说明仍提合成数据，故未误判真实服务，但未满足统一标识要求） | 移动CSS；supplement.json |
| IR-06 | P2：点击“体验用户视角”后按Tab | 焦点进入可见用户视图，后台管理控件不可被Tab选中，退出恢复入口；实际焦点落到被遮挡后台open-user按钮，可继续访问后台 | `userOverlay`/`open-user`；`independent-admin-focus.json` |

主Agent已收到集中缺陷并将召回同一实现者；reviewer不修改实现。修复轮次：正式首轮发现，尚未复验固定修复版。请求模型/实际模型证据边界不变；token用量未知，未记为0。

### 首轮原始证据

- `evidence/independent-admin-review.mjs`：产品DOM驱动验收，不写localStorage。
- `evidence/independent-admin-results.json`：逐项结果、时间、hash、请求及console。
- `evidence/independent-admin-supplement.mjs` / `.json`：横滚、暂停写入与移动控件。
- `evidence/independent-admin-focus.mjs` / `.json`：用户视图后台焦点复现。
- `evidence/independent-admin-*.png`：全部为合成数据；截图辅助定位，不替代点击。

真实服务认证、多用户鉴权、Host隔离、后端持久化与生产发布均未测试，仍不在本任务范围。

## 修复版目标复验（8216b8）

固定 SHA256 `8216b84172b2c6b707cef283954dcd43569281449fcc76f49cf0310964234f57`；复验开始/结束一致。12:34:48–12:34:53，目标脚本约5秒，9项全通过。IR-01至IR-06均通过：暂停写入和任务禁用，恢复资料可保存；离线任务禁用；过期Bot与续期明确可见、已得成果保留、旧审失效、续期后协作者保存与35k审批结果正确；名称、390/768关键按钮及模拟标识可读；用户视角后台inert、Tab限定、Escape/按钮退出恢复入口焦点。

复验脚本首次使用未经需求指定的70px控件宽度阈值误报68×37的可读“返回目录”，同时第二尺寸未先返回目录导致隐藏列表点击超时。视觉检查确认控件已单行可读，脚本改为核对非逐字换行及实际产品返回路径后通过；这些是检查脚本适配，不是产品修复轮次，未更改实现。最终使用 `independent-recheck-*.png`，不把首轮失败图当当前展示。

IR-01离线资料写入边界：现有离线Bot无可维护资料fixture，未造状态直接调用handler。实际验证离线任务控件禁用；源码审阅确认资料保存和共享管理员撤销复用 `canSharedWrite` 检查授权到期、Bot暂停/共享和Host在线。暂停资料路径则已实际点击建立状态并验证禁用、未持久改变及恢复保存。

### 新发现受影响缺陷 IR-07（P2）

复现：体验用户视角→许知→打开客户研究Bot→“管理此Bot的低级成员”→Tab到模态按钮→Escape。期望只关闭低级成员dialog、保留用户视角并恢复按钮焦点；实际dialog保持打开。源码 `document keydown` 在 `s.usersim` 且 `#modal [role=dialog]` 存在时直接return，未处理Escape。主Agent已收到；等待最小固定修复版后仅复验此项和退出路径。

证据：`independent-admin-recheck-results.json`（9项通过）；`independent-admin-recheck.mjs`；`independent-admin-invitation-focus-related.mjs`（相关重复邀请通过，嵌套Escape断言失败，未写pass结果）。最终视觉/交互结论暂待IR-07关闭，其他既有通过证据沿用。

## 最终接受结论与证据继承

最终固定HTML SHA256：`8118ea5a0715abcdfa0b3e39fca462a900c1182e5b6a2421524f7f7ada2ec3a3`。IR-07复验 12:37:22–12:37:25（约2.5秒）：nested Tab/Shift+Tab圈定、Escape仅关闭内层、内层焦点恢复、外层保持inert、再次Escape退出外层且恢复入口、console及hash，5项均通过。开始/结束hash一致；所有IR-01至IR-07关闭。正式修复轮次2轮：六项集中修复 + 嵌套Escape最小修复；检查脚本调整不计产品修复。

| HTML版本 | 实际执行与继承范围 | 证据 |
| --- | --- | --- |
| 4959f5 | 首轮平台目录/筛选、跨Bot隔离、资源上限、完整主链、guest私有边界、动态角色、预算防重复、授权变更/暂停失效、三视口实际点击、console/network；未受后续最小修复影响的通过结果继承 | independent-admin-results.json、首轮截图（历史证据，不用作当前展示） |
| 8216b8 | 六项集中修复后的9项目标复验通过：暂停/恢复资料、离线任务、过期可见/续期/成果/审批恢复、品牌、390/768按钮标识、外层focus与退出、console/hash；另实际验证重复邀请被拒绝 | independent-admin-recheck-results.json、independent-recheck-*.png |
| 8118ea | 仅复验改动相关嵌套modal Tab/ShiftTab/Escape/焦点、外层Escape退出、console/hash；其他通过结果按上述版本继承，未全套重跑 | independent-ir07-recheck-results.json、independent-final-nested-dialog.png、independent-final-directory-1440.png |

视觉、交互、响应式分别接受，限合成原型。1440目录末列通过局部横向滚动实际可访问；建议后续增加滚动提示，768成员角色列仍偏窄，可进一步优化列宽，属可用性建议而非本次功能阻断。当前展示优先使用 `independent-final-*`（8118）及 `independent-recheck-*`（8216；后续仅keydown小修复未改布局），不能用旧失败图代表当前状态。

### 复现方式与运行依赖

脚本支持 `PLAYWRIGHT_MODULE`、`CHROMIUM_EXECUTABLE`、`PROTOTYPE_URL` 环境变量，未设置时回退到本次已有本机路径和loopback URL。回退路径仅为本机便利，不是通用安装要求；其他电脑应设置已有Playwright模块与兼容浏览器路径。默认不安装依赖，不使用个人Chrome。此环境变量改动只做语法核对，没有重新计pass。

例如在本地静态服务已启动后执行：

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
CHROMIUM_EXECUTABLE=/absolute/path/to/headless-chromium \
PROTOTYPE_URL=http://127.0.0.1:5197/ \
node evidence/independent-ir07-recheck.mjs 8118ea5a0715abcdfa0b3e39fca462a900c1182e5b6a2421524f7f7ada2ec3a3
```

工作目录为本原型目录。完整首轮脚本只接受其指定固定版本，旧版本脚本不能不加说明宣称为最终头全套结果；若需在未来改动后全套重验，应先核对新需求和选择器、冻结新hash并生成单独证据。

独立reviewer没有修改实现、Git提交/推送或部署，没有真实账号/接口/模型/生产调用。实际token用量、精确模型变体与effort未知；主自动化运行时长为实测，准备/等待总时长未单独计量。真实多用户授权、Host隔离与业务后端验收不在本任务范围。

## CI脚本格式迁移复核

CI的 `npm lint` 因验收脚本CommonJS `require` 触发 `no-require-imports`，属于新增证据脚本格式问题，HTML与产品行为没有变化。实际目录7个脚本（含旧个人版未执行脚本）全部迁移为ESM `.mjs`，使用 `node:fs` / `node:path` / `node:crypto` / `node:url` imports、动态导入Playwright `index.mjs`、`fileURLToPath(import.meta.url)` 定位。保留三个环境变量、现有路径回退和原检查逻辑；未禁用规则或改全局配置。

7个脚本 `node --check` 均通过。最终nested脚本以ESM实际执行于12:46:01–12:46:03，动态Playwright依赖导入成功，原5项检查通过，HTML hash前后保持8118ea。此为格式迁移复核，证据单独保存 `evidence/independent-esm-migration-recheck-results.json`；原12:37产品验收结果文件保留，不计为新产品修复轮次，也不宣称全套重跑。完整lint由主Agent负责核验。

`PLAYWRIGHT_MODULE` 应为Playwright模块目录（脚本追加 `index.mjs`）或该ESM入口绝对路径；其他电脑按本机已有安装设置。正文复现命令与脚本引用已同步为 `.mjs`。
