import { describe, expect, it } from 'vitest';
import type { Task } from '@/../shared/types/task';
import type { SessionMetadata } from '@/api/sessionClient';
import { boardRowStateKey, filterBoardRows, INACTIVE_AFTER_MS, RECENT_FINISH_MS, projectBoardRows, freshActivity, sessionExecutionTime } from './projection';
const now = 100000;
const task = (fields: Partial<Task> = {}): Task => ({ id: 't1', name: 'Task', executor: 'agent', workspaceId: 'p', workspacePath: '/work/p', executionMode: 'once', sessionIds: ['s1'], status: 'running', tags: [], createdAt: now, updatedAt: now, statusHistory: [], dispatchOrigin: 'direct', ...fields });
const session = (fields: Partial<SessionMetadata> = {}): SessionMetadata => ({ id: 's1', title: 'Conversation', agentDir: '/work/p', createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(), ...fields });
describe('project board authority projection', () => {
  it('decorates shared-session work once while preserving completed and blocked Task records', () => {
    const old = task({id:'check',status:'done',lastExecutedAt:100,updatedAt:now+1000});
    const retry = task({id:'retry',status:'blocked',lastExecutedAt:200,lastExecution:{at:200,durationMs:3600000,sessionId:'s1',success:false,error:'Execution timed out',trigger:'scheduled'}});
    const snapshot = {state:'running' as const,checkedAt:now,execution:{startedAt:new Date(now-1000).toISOString(),elapsedMs:1000},
      progress:{source:'live' as const,todoSource:'tools' as const,todos:[],todoTotal:21,todoCompleted:3,agents:[],agentTotal:0,agentRunning:0},
      goal:{checkedAt:now,value:{status:'active' as const,isExecuting:true}}};
    for(const tasks of [[old,retry],[retry,old]]) {
      const rows=projectBoardRows({path:'/work/p'},tasks,[session()],new Map([['s1',snapshot]]),now);
      expect(rows).toHaveLength(2);
      expect(rows.filter(row=>row.group==='running')).toHaveLength(1);
      expect(rows.find(row=>row.task?.id==='retry')).toMatchObject({activity:snapshot,activitySessionId:'s1'});
      expect(rows.find(row=>row.task?.id==='check')).toMatchObject({group:'done',activity:undefined,activitySessionId:undefined,sessions:[{id:'s1'}]});
      expect(old.status).toBe('done'); expect(retry.status).toBe('blocked');
    }
  });
  it('prefers a current concrete execution over a newer historical or future Task', () => {
    const rows=projectBoardRows({path:'/work/p'},[
      task({id:'active',executionState:'running',lastExecutedAt:100}),
      task({id:'later',status:'done',lastExecutedAt:200}),
      task({id:'future',status:'todo',createdAt:now+1000}),
    ],[session()],new Map([['s1',{state:'waiting_user_action',checkedAt:now}]]),now);
    expect(rows.find(row=>row.task?.id==='active')).toMatchObject({group:'needs',confirmationReason:'waiting',activitySessionId:'s1'});
    expect(rows.filter(row=>row.activity)).toHaveLength(1);
    expect(rows.find(row=>row.task?.id==='later')?.group).toBe('done');
    expect(rows.find(row=>row.task?.id==='future')?.group).toBe('todo');
  });
  it('keeps shared-session failure and stale observations on one row without changing other task states', () => {
    for(const snapshot of [{checkedAt:now,error:'failed',errorCode:'execution_failed' as const}, {state:'running' as const,checkedAt:now-61000}]) {
      const rows=projectBoardRows({path:'/work/p'},[task({id:'old',status:'archived',lastExecutedAt:100}),task({id:'new',status:'blocked',lastExecutedAt:200})],
        [session()],new Map([['s1',snapshot]]),now);
      expect(rows.find(row=>row.task?.id==='old')).toMatchObject({group:'archived',activity:undefined});
      expect(rows.find(row=>row.task?.id==='new')?.group).toBe('needs');
      expect(rows.filter(row=>row.activity)).toHaveLength(1);
    }
  });
  it('assigns each shared Session independently and handles missing metadata and duplicate links', () => {
    const observations=new Map([['s1',{state:'running' as const,checkedAt:now}],['s2',{state:'waiting_user_action' as const,checkedAt:now}]]);
    const rows=projectBoardRows({path:'/work/p'},[task({id:'old',status:'done',sessionIds:['s1','s2'],lastExecutedAt:100}),
      task({id:'new',sessionIds:['s1','s1'],lastExecutedAt:200})],[],observations,now);
    expect(rows.find(row=>row.task?.id==='old')).toMatchObject({confirmationReason:'waiting',activitySessionId:'s2'});
    expect(rows.find(row=>row.task?.id==='new')).toMatchObject({group:'running',activitySessionId:'s1'});
  });

  it('preserves trusted Task execution when the independent Goal read fails or is paused',()=>{
    for(const goal of [{checkedAt:now,error:'unavailable'},{checkedAt:now,value:{status:'paused' as const,isExecuting:false}}]){
      const row=projectBoardRows({path:'/work/p'},[task({status:'done',executionState:'running'})],[session()],new Map([['s1',{state:'idle',checkedAt:now,goal}]]),now)[0];
      expect(row.group).toBe('running');
    }
  });
  it('keeps a missing-metadata Session waiting for approval even while its Goal is active',()=>{
    const row=projectBoardRows({path:'/work/p'},[task({status:'done'})],[],new Map([['s1',{state:'waiting_user_action',checkedAt:now,goal:{checkedAt:now,value:{status:'active',isExecuting:true}}}]]),now)[0];
    expect(row).toMatchObject({group:'needs',confirmationReason:'waiting',activitySessionId:'s1'});
  });
  it('keeps active Goals running across idle turns, stale done labels and absent Session metadata',()=>{
    for(const status of ['done','archived'] as const) for(const isExecuting of [true,false]) for(const metadata of [[],[session()]]) {
      const observation={state:'idle' as const,checkedAt:now,goal:{checkedAt:now,value:{status:'active' as const,isExecuting}}};
      const rows=projectBoardRows({path:'/work/p'},[task({status})],metadata,new Map([['s1',observation]]),now);
      expect(rows[0].group).toBe('running');
      expect(rows[0].task?.status).toBe(status);
    }
  });
  it('uses Goal lifecycle for unlinked Sessions without inferring completion from idle',()=>{
    for(const [status,group,reason] of [['active','running',undefined],['paused','needs','paused'],['blocked','needs','blocked'],['canceled','needs','stopped'],['complete','done',undefined]] as const){
      const snapshot={state:'idle' as const,checkedAt:now,goal:{checkedAt:now,value:{status,isExecuting:false}}};
      const row=projectBoardRows({path:'/work/p'},[],[session()],new Map([['s1',snapshot]]),now)[0];
      expect(row).toMatchObject({group,confirmationReason:reason});
    }
  });
  it('does not let a failed or expired Goal lookup report an idle done Task as completed',()=>{
    for(const goal of [{checkedAt:now,error:'unavailable'},{checkedAt:now-61000,value:{status:'active' as const,isExecuting:false}}]){
      const row=projectBoardRows({path:'/work/p'},[task({status:'done'})],[session()],new Map([['s1',{state:'idle',checkedAt:now,goal}]]),now)[0];
      expect(row).toMatchObject({group:'needs',confirmationReason:'unknown'});
    }
  });
  it('preserves required human action and executing turns even after a Goal terminal commit',()=>{
    for(const [state,group] of [['waiting_user_action','needs'],['running','running']] as const){
      const row=projectBoardRows({path:'/work/p'},[task({status:'done'})],[session()],new Map([['s1',{state,checkedAt:now,goal:{checkedAt:now,value:{status:'complete',isExecuting:false}}}]]),now)[0];
      expect(row.group).toBe(group);
    }
  });

  it('attributes idle progress to the latest linked Session without completing its Task', () => {
    const progress={source:'history' as const,todoSource:'tools' as const,todos:[],todoTotal:3,todoCompleted:3,agents:[],agentTotal:0,agentRunning:0};
    const latest={state:'idle' as const,checkedAt:now,progress};
    const older={state:'idle' as const,checkedAt:now};
    const rows=projectBoardRows({path:'/work/p'},[task({status:'verifying',sessionIds:['s1','s2']})],
      [session({id:'s2',lastActiveAt:new Date(now+100).toISOString()}),session()],new Map([['s1',older],['s2',latest]]),now);
    expect(rows[0]).toMatchObject({group:'done',reviewReady:true,confirmationReason:'verification',activitySessionId:'s2',activity:latest});
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
    expect(rows[0]).toMatchObject({group:'done',reviewReady:true});
    expect(boardRowStateKey(rows[0],now)).toBe('projectBoard.reviewReady');
    const snapshot={state:'running' as const,checkedAt:now-10000,error:'read failed',execution:{startedAt:'2026-10-14T12:00:00.000Z',elapsedMs:15000}};
    expect(freshActivity(snapshot,now)).toBeUndefined();
    expect(sessionExecutionTime(snapshot,now)).toMatchObject({elapsedMs:15000,stale:true});
  });
  it('merges verification, blocked, stopped and unknown into confirmation with distinct reasons', () => {
    const rows=projectBoardRows({path:'/work/p'}, ['verifying','blocked','stopped','running'].map(status=>task({id:status,status:status as Task['status'],sessionIds:[]})),[],new Map(),now);
    expect(Object.fromEntries(rows.map(r=>[r.task?.id,r.group]))).toEqual({verifying:'done',blocked:'needs',stopped:'needs',running:'needs'});
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
  it('puts just-finished conversations in done for review, then idle, then inactive by last activity', () => {
    const later = now + INACTIVE_AFTER_MS + 1;
    const fresh = new Date(later - 1000).toISOString(), recent = new Date(later - 2 * RECENT_FINISH_MS).toISOString(), old = new Date(now).toISOString();
    const rows = projectBoardRows({path:'/work/p'},[],[session({id:'fresh',lastActiveAt:fresh}),session({id:'recent',lastActiveAt:recent}),session({id:'old',lastActiveAt:old}),session({id:'unseen',lastActiveAt:old})],
      new Map([['fresh',{state:'idle' as const,checkedAt:later}],['recent',{state:'idle' as const,checkedAt:later}],['old',{state:'idle' as const,checkedAt:later}]]),later);
    expect(Object.fromEntries(rows.map(r=>[r.id,r.group]))).toEqual({'session:fresh':'done','session:recent':'idle','session:old':'inactive','session:unseen':'inactive'});
    expect(rows.find(r=>r.id==='session:fresh')?.reviewReady).toBe(true);
    expect(rows.find(r=>r.id==='session:recent')?.reviewReady).toBeUndefined();
    expect(boardRowStateKey(rows.find(r=>r.id==='session:old')!,later)).toBe('projectBoard.inactive');
    const failed = projectBoardRows({path:'/work/p'},[],[session({lastActiveAt:old})],new Map([['s1',{checkedAt:later,error:'unavailable'}]]),later);
    expect(failed[0]).toMatchObject({group:'needs',confirmationReason:'unknown'});
  });
  it('moves a finished agent run to done for review only when its Session is observed idle', () => {
    const run = (activity: Map<string, any>) => projectBoardRows({path:'/work/p'},[task()],[session()],activity,now)[0];
    expect(run(new Map([['s1',{state:'idle',checkedAt:now}]]))).toMatchObject({group:'done',reviewReady:true});
    expect(run(new Map([['s1',{state:'running',checkedAt:now}]])).group).toBe('running');
    expect(run(new Map([['s1',{state:'waiting_user_action',checkedAt:now}]])).group).toBe('needs');
    expect(run(new Map([['s1',{state:'idle',checkedAt:now-61000}]]))).toMatchObject({group:'needs',confirmationReason:'unknown'});
    expect(run(new Map())).toMatchObject({group:'needs',confirmationReason:'unknown'});
  });
  it('keeps detector checks with waiting automations instead of running work', () => {
    const rows = projectBoardRows({path:'/work/p'},[task({id:'probe',executionMode:'recurring',executionState:'checking',sessionIds:[]}),task({id:'once',executionState:'checking',sessionIds:[]})],[],new Map(),now);
    expect(Object.fromEntries(rows.map(r=>[r.task?.id,r.group]))).toEqual({probe:'scheduled',once:'running'});
    expect(boardRowStateKey(rows.find(r=>r.task?.id==='probe')!,now)).toBe('projectBoard.checkingTrigger');
  });
});
