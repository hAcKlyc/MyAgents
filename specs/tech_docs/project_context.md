# 同项目新会话背景

任务：MOXBOTS-PROJECT-CONTEXT-001。范围是普通项目的新桌面会话，不包含群聊、浮球、自动化或远程委派自动扩散。

## 行为和 authority

首次实际发送（包括提前 pre-warm 的空 Session）通过 SessionEngine 的 `prepareDesktopQuery` 读取当前项目其他可见桌面会话的来源摘录。builtin、DSH、Claude Code、Codex 共用此入口。首条消息重试在原 Runtime mutation owner 内重新准备，使用最新来源；后续已有 user 行的普通会话不重复添加。

现有 SessionStore 对话是唯一持久事实来源，不新增摘要数据库、后台模型调用、writer 或周期任务。关闭主动 Agent/Heartbeat 不关闭此功能。Project 的 `projectContextEnabled` 缺省为 true，设置页通用区域可关闭；关闭仅影响未来注入，不删除已发送的模型上下文。

源候选按工作区规范路径匹配且要求唯一有效 Project；不按仓库 URL、目录名称或用户文案猜项目。不同 worktree/路径不自动合并。排除归档、隐藏维护、Host 私有委派、channel 与非桌面 origin。索引只作候选发现，读取来源后再次检查活跃 metadata，防止索引滞后造成泄漏。不可读/损坏历史不回退成 raw JSON，也不使用旧摘要缓存。

## 内容与边界

每个源 Session 保留最多三条用户决策候选、最近用户请求、最新非 streaming 助手进展。它们是带 sessionId/messageId/timestamp 的**原文摘录**，不是模型确认的事实。用户请求/建议不自动升级为已采纳决策；助手自报完成不能证明测试、合入或发布。当前用户授权和 Runtime policy 始终有效；历史一次性授权不得继承。

在额度内保留连续文本，不能按关键词删掉范围、否定或验收限定。超长内容保留开头与结尾、明确标记 truncated；代码/凭据省略也有标记，常见凭据尽力遮蔽。不能据被截断的来源断定完整决策范围；必要时通过现有 `session list/get` 核对原文。工具、thinking 和隐藏维护结果不进入摘录。带有旧 PROJECT_CONTEXT 的来源 user 行只读取可见正文，避免递归复制其他会话背景。

最多扫描最近24个候选，会话/消息内容还受序列化预算约束；这是有限近期上下文，不保证囊括全部项目历史或所有早期决策。没有摘要生成延迟；只能看到读取时已有的来源，之后产生的更新不会自动改写本次已注入快照。既有会话不实时刷新，模型长期压缩后的重召回仍通过已有查询能力。

## Prompt 和成本

`src/shared/projectContext.ts` 负责纯文本投影与预算；`src/server/session-engine/project-context.ts` 负责读作用域；`agentMentions.composeQueryReminder` 在既有单个 leading system-reminder 中组合动态项目背景、Goal/Task context 与 mention。它不进入固定 system prompt，不需要为 pre-warm 重启 Runtime。

背景 body 最多6000 UTF-8 bytes；无其他 reminder 时外层 envelope 额外38 bytes。6000 bytes 不是所有供应商统一的 Token 上限。内容完整存于原 user 消息及 typed desktopQuery annotation，普通 UI、搜索、标题继续只展示原 visibleText。没有新增模型调用/输出 Token；已注入背景仍可能在后续请求中计入输入 Token，取决于供应商缓存、会话长度与压缩。不能把“不重复注入”解释为后续零费用。

合成包分词实测、脚本及解释见 `dev-docs/project-context-validation/`；只测实际新增 envelope，不包含用户原始问题或固定 system prompt，不冒充账单或所有模型统一计量。第一期不新增付费摘要服务、向量库或外网端点。

## 验收和发布

实际文件持久化测试覆盖 V1/V2、单轮决定、prepared target、发送前更新、后续去重、并发读取、重启恢复、项目/归档/群聊/委派隔离、关闭/身份歧义和损坏来源。实际 adapter mock边界测试覆盖4 Runtime首发与重试；不代替真实 Provider/native acceptance。设置页真实组件有DOM与隔离浏览器交互检查。

发布只由统一发布会话 01a12bc2-907a-7702-b6dd-788225c5dfe4 进行；接续记录和待验收事项在任务记录。不能将源码合入称为已安装或已生产验收。
