// Run: node --import tsx/esm dev-docs/project-context-validation/measure-tokens.mjs > /tmp/context-samples.json
// All contents are synthetic; tokenize the returned text with the chosen model's tokenizer.
import { projectSessionContextSources, renderProjectContext } from '../../src/shared/projectContext.ts';
import { composeQueryReminder } from '../../src/shared/agentMentions.ts';
const fixture = (n, long = false) => ({ projectId: 'synthetic-project', scannedSessions: n, totalSessions: n, unavailableSessions: 0,
 sources: Array.from({ length: n }, (_, i) => projectSessionContextSources(`session-${i}`, [
  { id: `user-${i}`, role: 'user', content: '确定采用方案B，发布交给统一发布会话。\n仅本次原型有效，正式生产继续使用方案A。' + (long ? '\n' + '详细方案说明。'.repeat(150) + '\n上述范围不扩大。' : ''), timestamp: '2026-10-16T01:00:00Z' },
  { id: `assistant-${i}`, role: 'assistant', content: '实现已完成，相关测试通过，尚未发布。\n下一步由统一发布会话在隔离身份中执行原生验收。' + (long ? '\n' + '这是合成的测试说明和边界。'.repeat(150) : ''), timestamp: '2026-10-16T01:01:00Z' }
 ])).flat() });
console.log(JSON.stringify([['one-session', fixture(1)], ['three-sessions', fixture(3)], ['budget-pressure-24-sessions', fixture(24, true)]].map(([name, snapshot]) => {
 const text = composeQueryReminder({ visibleText: '', projectContext: snapshot });
 return { name, contextBodyUtf8Bytes: Buffer.byteLength(renderProjectContext(snapshot)), addedUtf8Bytes: Buffer.byteLength(text), text };
})));
