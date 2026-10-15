import { describe, expect, it } from 'vitest';
import type { Task } from '@/../shared/types/task';
import type { SessionMetadata } from '@/api/sessionClient';
import { filterBoardRows, projectBoardRows, freshActivity, sessionExecutionTime } from './projection';
const now = 100000;
const task = (fields: Partial<Task> = {}): Task => ({ id: 't1', name: 'Task', executor: 'agent', workspaceId: 'p', workspacePath: '/work/p', executionMode: 'once', sessionIds: ['s1'], status: 'running', tags: [], createdAt: now, updatedAt: now, statusHistory: [], dispatchOrigin: 'direct', ...fields });
const session = (fields: Partial<SessionMetadata> = {}): SessionMetadata => ({ id: 's1', title: 'Conversation', agentDir: '/work/p', createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(), ...fields });
describe('project board authority projection', () => {
  it('attributes idle progress to the latest linked Session without completing its Task', () => {
    const progress={source:'history' as const,todoSource:'tools' as const,todos:[],todoTotal:3,todoCompleted:3,agents:[],agentTotal:0,agentRunning:0};
    const latest={state:'idle' as const,checkedAt:now,progress};
    const older={state:'idle' as const,checkedAt:now};
    const rows=projectBoardRows({path:'/work/p'},[task({status:'verifying',sessionIds:['s1','s2']})],
      [session({id:'s2',lastActiveAt:new Date(now+100).toISOString()}),session()],new Map([['s1',older],['s2',latest]]),now);
    expect(rows[0]).toMatchObject({group:'needs',confirmationReason:'verification',activitySessionId:'s2',activity:latest});
    expect(rows[0].task?.status).toBe('verifying');
    expect(rows).toHaveLength(1);
  });
  it('keeps failed executions visible for confirmation even with stale archived metadata', () => {
    const activity = new Map([['s1', {checkedAt:now,error:'Execution failed',errorCode:'execution_failed' as const}]]);
    for (const tasks of [[],[task({status:'archived'})],[task({executionState:'running'})]]) {
      const rows=projectBoardRows({path:'/work/p'},tasks,[session({archived:true})],activity,now);
      expect(rows[0]).toMatchObject({group:'needs',confirmationReason:'blocked'});
    }
  });
  it('uses the persistent status as the authority for manual tasks without runtime owners', () => {
    const rows=projectBoardRows({path:'/work/p'},[task({executor:'user',sessionIds:[]})],[],new Map(),now);
    expect(rows[0].group).toBe('running');expect(rows[0].confirmationReason).toBeUndefined();
  });
  it('keeps an archived live record visible when the next owner observation fails or expires', () => {
    for (const archivedTask of [false,true]) {
      for(const observation of [{state:'running' as const,checkedAt:now-61000},{state:'waiting_user_action' as const,checkedAt:now,error:'unavailable'}]) {
        const rows=projectBoardRows({path:'/work/p'},archivedTask?[task({status:'archived'})]:[],[session({archived:true})],new Map([['s1',observation]]),now);
        expect(rows[0].group).toBe('needs');expect(rows[0].confirmationReason).toBe('unknown');
      }
    }
  });
  it('keeps done work on the board and only archived records in history', () => {
    const rows=projectBoardRows({path:'/work/p'},[task({id:'done',status:'done',sessionIds:[]}),task({id:'archive',status:'archived',sessionIds:[]})],[session({archived:true})],new Map(),now);
    expect(Object.fromEntries(rows.map(r=>[r.id,r.group]))).toEqual({'task:done':'done','task:archive':'archived','session:s1':'archived'});
  });
  it('preserves a live execution despite a stale done/archive task label', () => {
    for (const status of ['done','archived'] as const) {
      const rows=projectBoardRows({path:'/work/p'},[task({status})],[session({archived:true})],new Map([['s1',{state:'running',checkedAt:now}]]),now);
      expect(rows).toHaveLength(1);
      expect(rows[0].group).toBe('running');
      expect(rows[0].activity?.state).toBe('running');
    }
  });
  it('separates idle from unknown and preserves observed duration after a failed refresh', () => {
    const rows=projectBoardRows({path:'/work/p'},[],[session()],new Map([['s1',{state:'idle',checkedAt:now}]]),now);
    expect(rows[0].group).toBe('idle');
    const snapshot={state:'running' as const,checkedAt:now-10000,error:'read failed',execution:{startedAt:'2026-10-14T12:00:00.000Z',elapsedMs:15000}};
    expect(freshActivity(snapshot,now)).toBeUndefined();
    expect(sessionExecutionTime(snapshot,now)).toMatchObject({elapsedMs:15000,stale:true});
  });
  it('merges verification, blocked, stopped and unknown into confirmation with distinct reasons', () => {
    const rows=projectBoardRows({path:'/work/p'}, ['verifying','blocked','stopped','running'].map(status=>task({id:status,status:status as Task['status'],sessionIds:[]})),[],new Map(),now);
    expect(rows.every(r=>r.group==='needs')).toBe(true);
    expect(rows.map(r=>r.confirmationReason).sort()).toEqual(['blocked','stopped','unknown','verification']);
  });
  it('advances fresh elapsed time locally, freezes stale snapshots, and never fabricates missing timing', () => {
    const execution = {startedAt:'2026-10-14T12:00:00.000Z',elapsedMs:750000};
    const snapshot = {state:'running' as const,checkedAt:now,execution};
    expect(sessionExecutionTime(snapshot,now+1000)).toMatchObject({elapsedMs:751000,stale:false});
    expect(sessionExecutionTime(snapshot,now+61000)).toMatchObject({elapsedMs:750000,stale:true});
    expect(sessionExecutionTime({...snapshot,checkedAt:now+1000},now)?.elapsedMs).toBe(750000);
    for (const invalid of [{...snapshot,state:'idle' as const},{...snapshot,execution:undefined},{...snapshot,execution:{...execution,elapsedMs:-1}},{...snapshot,execution:{...execution,startedAt:'invalid'}}]) {
      expect(sessionExecutionTime(invalid,now)).toBeUndefined();
    }
  });
  it('deduplicates linked sessions, retains archived original links and isolates projects', () => {
    const rows = projectBoardRows({id:'p',path:'/work/p'}, [task(),task({id:'foreign',workspacePath:'/work/else'})], [session({archived:true}),session({id:'s2'}),session({id:'other',agentDir:'/else'})], new Map(), now);
    expect(rows.map(r => r.id)).toEqual(['session:s2','task:t1']);
    expect(rows.find(r => r.task)?.sessions[0].id).toBe('s1');
  });
  it('never treats idle, unavailable or expired activity as completed', () => {
    for (const snapshot of [{state:'running' as const,checkedAt:now-61000},{checkedAt:now,error:'unavailable'}]) {
      const rows=projectBoardRows({path:'/work/p'},[],[session()],new Map([['s1',snapshot]]),now);
      expect(rows[0].group).toBe('needs');
      expect(rows[0].confirmationReason).toBe('unknown');
    }
    expect(freshActivity({state:'running',checkedAt:now-61000},now)).toBeUndefined();
  });
  it('distinguishes enabled schedules, live turns and stop failures', () => {
    const rows=projectBoardRows({path:'/work/p'},[task({id:'schedule',executionMode:'recurring'}),task({id:'turn',executionMode:'recurring',executionState:'running'}),task({id:'failure',status:'done',executionState:'stop_failed'})],[],new Map(),now);
    expect(Object.fromEntries(rows.map(r=>[r.task?.id,r.group]))).toEqual({schedule:'scheduled',turn:'running',failure:'needs'});
  });
  it('prioritizes owner-addressed waits and searches task tags', () => {
    const rows=projectBoardRows({path:'/work/p'},[task({tags:['crm']})],[session()],new Map([['s1',{state:'waiting_user_action',checkedAt:now}]]),now);
    expect(rows[0].group).toBe('needs');
    expect(filterBoardRows(rows,'needs','CRM')).toHaveLength(1);
  });
});
