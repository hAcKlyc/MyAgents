# 正式客户端下一步建议路由修复与验收

任务MOXBOTS-NEXT-PROMPT-003。代码与原生发行分别追踪，主Agent单独实现/审查；无子Agent、无外部模型调用，精确Token/费用未知。

## 故障与修复

已安装0.5.7包含生成handler，但src/server/sidecar-composition.ts未登记/api/chat/next-prompt。前置composition返回404，renderer hook静默忽略失败，输入框无建议。实际日志与当前实例无效payload探测均复现。修复只把精确路径归给Session，与读取完成对话、使用原Session模型/凭据的owner一致；不开放/api/chat/前缀，不向Global放行。

## 确定性验证

新增9项正式composition/route/service组合测试，先7失败/2通过，修复后全部通过。总7文件189项包括既有输入框Enter采纳、长按不发送、Escape、IME、Session切换及不支持Runtime状态。模型和Session为fixture，不作真实Provider或已安装客户端验收。

```sh
node_modules/.bin/vitest run --project unit \
  src/server/routes/prompt-suggestion-composition.unit.test.ts \
  src/server/routes/prompt-suggestion.unit.test.ts \
  src/server/session-prompt-suggestion.unit.test.ts \
  src/server/sidecar-composition.unit.test.ts \
  src/shared/nextPromptSuggestion.test.ts --project dom \
  src/renderer/hooks/useNextPromptSuggestion.test.tsx \
  src/renderer/components/SimpleChatInput.suggestion.test.tsx
```

## 原生验收门槛（未完成）

由唯一桌面发布owner01a12bc2-907a-7702-b6dd-788225c5dfe4串行安排下一未冻结发行，固定实际main/包hash。先fresh完整活动owner空闲、手动解锁、兼容备份及可执行回退，绝不stop/kill/强退或在任务运行中换包。

1. 核实正式签名客户端版本与包含本修复的冻结源码/包hash对应。
2. 使用获授权的受控本地工作区和既有模型，提出具有后续细化空间的小任务；正常完成，输入框保持空白，无待审批/排队任务。
3. 实际记录生产POST /api/chat/next-prompt返回成功、匹配Session/anchor且建议非空；null表示本次没有建议，不充作成功，也不要求每一轮强行提供下一步。
4. 观察真实灰字，核实textarea值空；按一次Enter，灰字转入可编辑草稿，未发送新消息/未启动任务。长按Enter不发送，Escape忽略另做必要回归。
5. 保留脱敏截图、版本/hash、关键HTTP/Session状态与操作前后消息数/执行状态证据；不保存凭据或业务正文。验收完成前保持原生pending。

## 当前状态

代码回归189项、完整tsc --noEmit、两文件ESLint均通过；PR92六项CI/main、正式签名包/发布及实际用户路径待逐项回填。未修改0.5.7安装包、日常配置或运行任务。
