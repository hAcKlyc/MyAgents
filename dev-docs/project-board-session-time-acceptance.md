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
| 原生安装/真实执行 | 待统一更新 | 当前已装0.5.3/5949b7f1不含本次功能；统一owner工作树仍有其他修改，未并发构建/换包/退出运行中客户端 |
| main/CI | 通过 | 与PR43/main37279ce4组合，head e22b7b7c完整CI38606936447六项通过；PR42合入main58b6720f，远端ref及源码树一致 |

合成截图和结果：`project-board-validation/session-time/`；本地完整输出 `/tmp/moxbots-board-session-time-20261015`。截图仅用于界面回归，不能替代原生实际API或真实模型执行证据。

## 修复与限制

测试补充时发现既有 adapter mock 未导出 isBuiltinWaitingForUser，已补足mock后通过；一次20ms既有超时用例受并行CPU负载影响，单独复跑通过，未延长超时或改产品逻辑。隔离Vite验收补充CJS预优化依赖，避免lowlight/extend导出错误；MoXBots profile复验14组通过。并行原生构建导致一次页面导航超出交互用5秒限制，导航改为独立60秒上限（交互仍5秒），复验通过；未改产品依赖版本。

计时是当前轮次的墙钟时间，包含等待，不是所有历史轮次累计或模型token耗时。未建立新的执行状态authority或持久化owner，未更改云服务或数据。后续统一包须核实renderer/server同源、空闲安装窗口、回滚及原生会话直达路径。

PR42首次CI（38603665188）的JS gate在550个unit文件中仅runtime-boundary两项失败：adapter直接import内部transcript违反既有facade边界。修复为ProductTranscriptContent只读executionStartedAt getter，由agent-session/external-session正式facade暴露；adapter不再越界。未修改/抑制边界测试，153项相关复验通过，终结/中止/错误/打断turn均不再暴露计时起点。CI和main仍以修复后PR head为准。

## 主干交付与剩余原生门禁

PR42已合入远端main；集成锚点58b6720f296484c8ccd3ada08fc38695827df016，源码验收锚点e22b7b7c1c4ad6f4ee1fb56a9f3fc36ceda3ecf4。原始失败run38603665188、修复后run38605229874（因同步并发主干取消）与最终通过run38606936447分开记录；取消不当作失败或通过。组合后154项相关unit、typecheck、MoXBots前后端构建通过；Git树比较确认合并未改变验收源码。

只读查看统一更新owner的当前状态：升级器不能确认会话owner活动状态，A→B原生升级仍阻断，门禁保留。另已请求追加联系实际owner任务的明确授权；收到授权并获得窗口前，不发新跨任务消息、不并发构建或替换其客户端。本次主干和合成UI交付完成；安装、原生真实计时/会话直达、官网包更新仍未完成。
