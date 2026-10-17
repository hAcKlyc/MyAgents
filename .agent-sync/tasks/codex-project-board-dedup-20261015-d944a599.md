<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/project-board-dedup-20261015 -->
<!-- git-project-sync-task:base=6bb6d7844a016af2ab1278136f4294d05974cbdd -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-BOARD-DEDUP-001

## Objective and scope

修复多个历史Task关联同一Session时，当前Goal/运行状态/TODO/计时被复制到多张执行卡的问题。沿用已有Task与Session authority，只修改renderer看板投影；不删除/归档/合并真实任务、不改变调度或业务会话。后续056范围，不回写冻结055。

## Acceptance criteria / To Do

- [x] 同一Session观察只装饰一个Task卡片；其余历史Task维持各自持久状态和原会话入口。
- [x] 优先具体执行态，其次最近执行/dispatch证据；不受旧任务编辑updatedAt和输入顺序影响。
- [x] 多Session分别归属；缺metadata、重复link、失败/过期观察回归。
- [x] 48项unit/DOM、typecheck。
- [x] lint、production web build、实际React合成页面六条旅程和主Agent视觉/交互验收。
- [ ] PR/CI/main集成及远端核实。
- [ ] 056正式客户端安装后的真实同一Task/Session复验（独立发布门禁）。

## Evidence boundaries

代表卡片只是一份Session观察的展示归属，不是新增Task执行权威，不会把TaskStore的blocked/done改为running。Task executionState仍独立展示，确有多个具体作业时不隐藏其执行。无执行态时用最近执行证据作为确定性展示规则，不声称证明当前Query属于某个Task。

原始截图与本地运行态只读调查已复现共享会话重复装饰；不向Git写入真实业务Task/Session标识或正文。测试只用合成数据。UI owner为当前主Agent；范围为纯状态投影且无布局改动，零子Agent，不宣称独立审阅、原生联调或生产验收。模型用量与节省未知。

## Next step

完成合成React/构建门禁后提交并集成；在既有056发布窗口完成原生真实路径复验。当前日常App仍有会话执行，不操作安装、退出或升级。

## Verification / execution record

当前主Agent单独实现与UI验收，零子Agent，零外部模型；无用量或成本节省测量。48项相关unit/DOM、full typecheck/full lint（既有16 dependency warnings/0 errors）、MoXBots production web build通过。React light/dark1440与540窄窗、列表、共享原会话入口、详情超时/Escape、Goal暂停刷新共六条旅程通过；合成数据和结果见 `dev-docs/project-board-validation/dedup/README.md`。自查覆盖representative选择的稳定性和历史Task状态/入口完整；首轮浏览器fixture selector与snapshot稳定性问题修复后复验通过，无产品验收标准降低。

## Completed

共享Session代表选择与所有观察消费路径已实现；旧Task的状态、历史和会话入口保全。48项unit/DOM、类型/lint/构建与六条React合成旅程通过，证据已提交。PR https://github.com/heavenzhang/MoXBots/pull/66 ，当前等待六项CI/main。

## Blockers and unknowns

源码无未解决失败；PR CI尚在运行。056正式包/签名/安装/真实薪资路径需既有发布窗口，冻结055不重写；当前任务不抢占日常App，不声称已发布或原生验收。展示代表规则不是精确Query归属证明。无独立审阅、未测量模型用量及费用。
