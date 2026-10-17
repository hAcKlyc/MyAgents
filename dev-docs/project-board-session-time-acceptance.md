# MOXBOTS-PROJECT-BOARD-002 验收

2026-10-15；真实 MoXBots 项目看板增量，用户要求执行时长和直达原会话。主 Agent 实现并负责 UI 回归；零子智能体，改动有限且紧密，无外部模型或真实业务写入。

## 行为与依据

- 当前轮次的开始时间由 SessionEngine adapter 从 product transcript 读取；内置/外部均支持，仅 running turn 暴露。owner 计算 elapsedMs，避免 renderer 与执行机器时钟差。
- 卡片显示“本轮已用 12分30秒”，与“最近更新 00:41”区分；列表与详情一致。时间含等待答复。不存在开始时间/旧侧车只返回状态时显示不可用，不拿更新时间假充执行时长。
- 查询快照有效一分钟；前端每秒推算，无自动网络轮询。过期后显示查询当时“快照已用”并提示刷新，不宣称仍在执行；空闲不计时。
- 独立“进入会话”按钮经现有事件定位准确 workspace/Session；卡片正文和详情入口保留。单关联 Session 直达，多关联从详情选择；没有嵌套按钮。导航不发送模型消息、不创建会话。

## 验证状态

| 层级 | 结果 | 证据 |
| --- | --- | --- |
| 代码/只读协议 | 通过 | 7 文件154项组合 unit，覆盖两类adapter当前/终结turn、owner隔离、无时间、非法/未来开始、等待、过期、旧响应 |
| 静态与构建 | 通过 | Node24 typecheck、完整lint/依赖边界/agent docs、MoXBots profile生产build:web/build:server和8项主题测试 |
| 实际React交互（合成数据） | 通过 | 14组 journeys；单击/键盘定位准确原会话、列表入口、保留筛选草稿、错误恢复、过期冻结/手动恢复、无后台轮询；1440/1024/768/540、深浅主题，无pageerror |
| 原生隔离客户端 | 导航/空闲通过；真实运行计时未覆盖 | 已升级QA 0.5.4/B3，卡片、列表、详情与草稿保持通过；QA禁止模型执行，详见下方原生补验 |
| main/CI | 通过 | 与PR43/main37279ce4组合，head e22b7b7c完整CI38606936447六项通过；PR42合入main58b6720f，远端ref及源码树一致 |

合成截图和结果：`project-board-validation/session-time/`；本地完整输出 `/tmp/moxbots-board-session-time-20261015`。截图仅用于界面回归，不能替代原生实际API或真实模型执行证据。

## 修复与限制

测试补充时发现既有 adapter mock 未导出 isBuiltinWaitingForUser，已补足mock后通过；一次20ms既有超时用例受并行CPU负载影响，单独复跑通过，未延长超时或改产品逻辑。隔离Vite验收补充CJS预优化依赖，避免lowlight/extend导出错误；MoXBots profile复验14组通过。并行原生构建导致一次页面导航超出交互用5秒限制，导航改为独立60秒上限（交互仍5秒），复验通过；未改产品依赖版本。

计时是当前轮次的墙钟时间，包含等待，不是所有历史轮次累计或模型token耗时。未建立新的执行状态authority或持久化owner，未更改云服务或数据。后续统一包须核实renderer/server同源、空闲安装窗口、回滚及原生会话直达路径。

PR42首次CI（38603665188）的JS gate在550个unit文件中仅runtime-boundary两项失败：adapter直接import内部transcript违反既有facade边界。修复为ProductTranscriptContent只读executionStartedAt getter，由agent-session/external-session正式facade暴露；adapter不再越界。未修改/抑制边界测试，153项相关复验通过，终结/中止/错误/打断turn均不再暴露计时起点。CI和main仍以修复后PR head为准。

## 主干交付与剩余原生门禁

PR42已合入远端main；集成锚点58b6720f296484c8ccd3ada08fc38695827df016，源码验收锚点e22b7b7c1c4ad6f4ee1fb56a9f3fc36ceda3ecf4。原始失败run38603665188、修复后run38605229874（因同步并发主干取消）与最终通过run38606936447分开记录；取消不当作失败或通过。组合后154项相关unit、typecheck、MoXBots前后端构建通过；Git树比较确认合并未改变验收源码。

当时只读查看统一更新owner的状态：升级器不能确认会话owner活动状态，A→B原生升级仍阻断，门禁保留。另已请求追加联系实际owner任务的明确授权；收到授权并获得窗口前，不发新跨任务消息、不并发构建或替换其客户端。本次主干和合成UI交付完成；安装、原生真实计时/会话直达、官网包更新仍未完成。

## 用户追加协调授权

用户已明确授权联系实际统一更新负责人并协调更新；原收件方限制已解除，不再作为阻断。已向01a12bc2-907a-7702-b6dd-788225c5dfe4发送main/CI及独占UI交接要求。负责人确认冻结源码e5a05f76974a4962beb0b7de259690daaef08fd5包含PR42；本Agent独立核对10个关键文件与0c7b8e72已验收源码哈希一致。源证据为私有WPS项目work/updater-20261014/unified-054-source-receipt.json与E-source-freeze-e5a05f76.json，本地复核/tmp/moxbots-board-native-source-preflight-20261015.json。此证据只证明源码包含，不证明包内资源、签名、安装或UI路径。

该时点窗口仍由A3→B3更新验收独占，负责人会在接续记录明确释放；本Agent未碰此原生窗口。QA禁止模型执行，因此能验收原生导航/空态，不能将其称作真实Provider计时通过；没有现成合法执行样本时继续记录该覆盖缺口，不注入虚假running或发收费请求。

## 2026-10-15 原生 B3 补验与窗口交回

收到统一更新owner明确释放窗口后，仅操作隔离的 `com.moxbot.updaterqa` 0.5.4，实际运行PID 34881。应用在A3安装路径内完成B3升级，不能仅用目录名判断版本；Info.plist版本和主二进制SHA256独立核对，结果与B3 stage一致。源码e5a05f76974a4962beb0b7de259690daaef08fd5含PR42，10个关键看板文件与已验收0c7b8e72源码一致。应用不等于用户日常客户端，本次未退出、替换或更新日常0.5.3。

| 实际原生路径 | 结果与可复现观察 |
| --- | --- |
| Mino侧栏打开项目看板，展开其他会话 | 原Session New Chat显示当前空闲，最近更新独立标注；不显示虚假执行耗时 |
| 卡片“进入会话” | 打开已有mino标签，4个原标签保持；原三行QA草稿和文件引用逐字保留，没有新增会话/消息 |
| 返回看板 | New Chat搜索和展开状态保留 |
| 空闲查询超过一分钟、手动刷新 | 实际时钟下变为执行状态未知，刷新恢复当前空闲；没有将空闲认作完成 |
| 列表“进入会话”及回看 | 进入相同原会话，草稿保持；返回列表仍选中，搜索保持，重新激活读取空闲快照 |
| 列表详情与Escape | 原会话详情可见；Escape关闭详情，列表恢复；未发送模型请求 |

原始截图及AX文本留在本机 `/tmp/moxbots-board-native-e5-20261015`；精选原生截图及SHA256为 `project-board-validation/session-time-native/evidence.json`。这些图是**真实Tauri窗口 + 隔离合成QA数据**，不是合成网页，也不是已登录生产账号/真实Provider执行证据。两个入口均用CUA观察点击后实际页面和草稿，不能仅用click返回成功代替导航验收。

04:12已向两个获授权的负责人明确释放所有QA界面操作，窗口停在原mino草稿，未发送、未配置供应商。A3→B3升级、签名公证及正式包由更新owner负责；官网发布由Bots任务负责。官网负责人报告0.5.4下载页面已发布，其发布元数据PR47及公网包验证由对应owner继续处理，本记录不把对方进度陈述当作本Agent独立下载验签完成。

真实运行计时仍未覆盖：QA明确禁止模型执行，没有现成合法running样本。本次不注入假的执行状态，不自动发送收费请求；owner/unit和实际React合成运行计时已通过，但不能替代原生真实执行计时。合入PR46/main0c85b571后，5文件147项相关unit复验通过（activity/projection/owner/runtime boundary/SessionEngine）；仅追加验收文档和合成QA截图，没有产品源码修改。下一次合法现成执行需记录起点、等待状态、前端推进与过期冻结，再与owner快照核对。
