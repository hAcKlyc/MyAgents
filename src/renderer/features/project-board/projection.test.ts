import { describe, expect, it } from 'vitest';
import type { Task } from '@/../shared/types/task';
import type { SessionMetadata } from '@/api/sessionClient';
import { filterBoardRows, projectBoardRows, freshActivity } from './projection';
const now = 100000;
const task = (fields: Partial<Task> = {}): Task => ({ id: 't1', name: 'Task', executor: 'agent', workspaceId: 'p', workspacePath: '/work/p', executionMode: 'once', sessionIds: ['s1'], status: 'running', tags: [], createdAt: now, updatedAt: now, statusHistory: [], dispatchOrigin: 'direct', ...fields });
const session = (fields: Partial<SessionMetadata> = {}): SessionMetadata => ({ id: 's1', title: 'Conversation', agentDir: '/work/p', createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(), ...fields });
describe('project board authority projection', () => {
  it('deduplicates linked sessions, retains archived original links and isolates projects', () => {
    const rows = projectBoardRows({id:'p',path:'/work/p'}, [task(),task({id:'foreign',workspacePath:'/work/else'})], [session({archived:true}),session({id:'s2'}),session({id:'other',agentDir:'/else'})], new Map(), now);
    expect(rows.map(r => r.id)).toEqual(['session:s2','task:t1']);
    expect(rows.find(r => r.task)?.sessions[0].id).toBe('s1');
  });
  it('never treats idle, unavailable or expired activity as completed', () => {
    for (const snapshot of [{state:'idle' as const, checkedAt:now},{state:'running' as const,checkedAt:now-61000},{checkedAt:now,error:'unavailable'}]) {
      const rows=projectBoardRows({path:'/work/p'},[],[session()],new Map([['s1',snapshot]]),now);
      expect(rows[0].group).toBe('other');
    }
    expect(freshActivity({state:'running',checkedAt:now-61000},now)).toBeUndefined();
  });
  it('distinguishes enabled schedules, live turns and stop failures', () => {
    const rows=projectBoardRows({path:'/work/p'},[task({id:'schedule',executionMode:'recurring'}),task({id:'turn',executionMode:'recurring',executionState:'running'}),task({id:'failure',status:'done',executionState:'stop_failed'})],[],new Map(),now);
    expect(Object.fromEntries(rows.map(r=>[r.task?.id,r.group]))).toEqual({schedule:'other',turn:'running',failure:'needs'});
  });
  it('prioritizes owner-addressed waits and searches task tags', () => {
    const rows=projectBoardRows({path:'/work/p'},[task({tags:['crm']})],[session()],new Map([['s1',{state:'waiting_user_action',checkedAt:now}]]),now);
    expect(rows[0].group).toBe('needs');
    expect(filterBoardRows(rows,'needs','CRM')).toHaveLength(1);
  });
});
