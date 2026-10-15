# MOXBOTS-PROJECT-BOARD-TODO-001 验收

2026-10-15；用户要求把原会话TODO和SUBAGENTS执行情况体现到看板具体任务。基于main8f7ebc21已有四阶段看板增量实现，不替代TaskStore状态。

## 完成行为

- 卡片与列表：只读TODO完成数/进度条、当前步骤、子Agent运行数；无清单不编造百分比。空闲历史in_progress显示待续步骤，不能宣称当前执行。
- 详情：完整三态TODO（最多100项，真实总数单独保留并提示其余去原会话）、子Agent状态/后台标记/耗时（最多20项）、准确来源Session；原会话入口保留，返回选中状态保留。
- Chat和看板共用 `shared/sessionWorkProgress.ts` 与搬移的纯Task/TodoWrite reducers；Task工具成功/拒绝、删除、TaskList权威空集、未成形TaskList/TaskGet、runtime plan空集清空均有区别。全部TODO完成不写Task状态，不代表业务验收成功。
- 现有activity HTTP/Rust owner链路附加progress；local检查准确Session，adapter只经正式facade获取。Builtin后台仅当前Query的active registry；读取不drain/stop，终态/换Query不能复活。External native plan由原SSE事件保存当前Session只读快照，换Session/reset清除；冷历史没有nativeplan时明确未提供。
- 历史工具TODO可恢复，历史loading不构成live运行；过期/错误保留的看板快照标明上次观测，运行子Agent计时停止外推。继续沿既有可见看板30秒、50Session/4并发观察，不增加独立轮询或启动Session/模型。

## 验证及证据边界

| 层级 | 状态 | 证据 |
| --- | --- | --- |
| 相关unit/DOM | 通过 | 11文件251项；包括原面板兼容、共享TODO、exact Query、owner/外部plan reset、formal facade、activity与Task projection |
| 类型/lint/构建 | 通过 | Node24类型、完整lint（16已有orphan warning/0errors），MoXBots profile web/server生产构建 |
| 实际React合成UI | 通过 | 6组journeys，1440深浅、540窄窗、17TODO/3子Agent、回原会话/返回、全部勾完Task仍等待、失败观察保留旧进度和stale子Agent；0pageerror |
| 独立审阅 | 通过 | todo_review只读代码/视觉审阅；准确Session/Query、nativeplan reset、冷历史/完成权威通过。未亲自操作原生GUI，不冒称独立原生验收 |
| main/CI | 待提交核实 | 以PR真实head与远端main为准 |
| 原生安装/Provider/发布 | 未执行 | 当前日常客户端不包含新增feature；统一包owner串行纳入，不退出、重启或发送现有业务会话 |

精选合成截图、原始journey输出、图像hash和可复现脚本在 `project-board-validation/todo/`。临时完整命令输出 `/tmp/board-todo-*.log`。全部截图使用隔离合成数据，不是生产账号或真实模型执行证据。

首次UI预优化缺debug默认导出，补夹具CJS预优化后通过，未改变产品依赖。首次540截图在侧栏过渡动画中取图，独立审阅指出证据不足；夹具改为等待rail与有限CSS动画稳定后重跑并独立复看通过。首次完整SessionEngine测试因既有mock未包含新增export而在对象初始化失败；adapter采用与现有其他方法一致的惰性facade调用，并追加两类facade测试，120项通过；未放宽边界或忽略失败。

执行：主Agent实现/集成/关键交互；一个只读reviewer gpt-6-luna/medium负责数据与UI审阅，请求值已知、运行型号与用量未知；未调用外部模型。不调用外部原因：沿用ai-yaoren-local纯内置模式。审阅发现一处夹具证据问题并修复，下一次响应式取证先等状态和动画稳定。
