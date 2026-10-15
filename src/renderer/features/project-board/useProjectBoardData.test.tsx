import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOARD_REFRESH_MS, useProjectBoardData } from './useProjectBoardData';
const mocks = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn(), ensure: vi.fn(), snapshot: {
  sessions: [{id:'s',title:'Session',agentDir:'/work',lastActiveAt:'2026-10-15T01:00:00Z'}],
  workspaceSessionStates: new Map(), isSessionsLoading: false, sessionsError: null,
} }));
vi.mock('@/api/taskCenter', () => ({taskList:mocks.list}));
vi.mock('./activity', () => ({readBoardSessionActivity:mocks.read}));
vi.mock('@/hooks/taskCenterStore', () => ({ getSnapshot:()=>mocks.snapshot, subscribePassive:()=>()=>{}, registerPassiveWorkspaceSessionDemand:()=>()=>{}, ensureWorkspaceSessions:mocks.ensure }));
vi.mock('@/utils/tauriListen', () => ({listenWithCleanup:async()=>()=>{}}));
const flush = async () => { await act(async()=>{await Promise.resolve(); await Promise.resolve();}); };
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(100_000);vi.clearAllMocks();
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 mocks.snapshot.sessions=[{id:'s',title:'Session',agentDir:'/work',lastActiveAt:'2026-10-15T01:00:00Z'}];
 mocks.list.mockResolvedValue([]);mocks.read.mockImplementation(async()=>({state:'idle',checkedAt:Date.now()}));
});
afterEach(()=>{vi.useRealTimers();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});});
describe('visible workspace execution observations',()=>{
 it('reads Goal owners linked to workspace Tasks even when Session metadata is missing',async()=>{
  mocks.snapshot.sessions=[];
  mocks.list.mockResolvedValue([{id:'task',workspacePath:'/work',sessionIds:['linked']}]);
  const {unmount}=renderHook(()=>useProjectBoardData('/work',true));await flush();
  expect(mocks.read).toHaveBeenCalledWith('linked','/work');unmount();
 });
 it('publishes new Goal lifecycle even if a later turn observation fails',async()=>{
  mocks.read.mockResolvedValueOnce({state:'idle',checkedAt:100000,goal:{checkedAt:100000,value:null}})
    .mockResolvedValue({checkedAt:130000,error:'unavailable',goal:{checkedAt:130000,value:{status:'active',isExecuting:false}}});
  const {result,unmount}=renderHook(()=>useProjectBoardData('/work',true));await flush();
  await act(async()=>{vi.advanceTimersByTime(BOARD_REFRESH_MS);});await flush();
  expect(result.current.activity.get('s')).toMatchObject({error:'unavailable',goal:{checkedAt:130000,value:{status:'active'}}});unmount();
 });

 it('distinguishes execution failures from unreadable owners and clears them after recovery',async()=>{
  mocks.read.mockRejectedValueOnce(Object.assign(new Error('Execution failed'),{code:'SESSION_EXECUTION_FAILED'}))
    .mockResolvedValue({state:'idle',checkedAt:130000});
  const {result,unmount}=renderHook(()=>useProjectBoardData('/work',true));await flush();
  expect(result.current.activity.get('s')).toMatchObject({errorCode:'execution_failed'});
  await act(async()=>{vi.advanceTimersByTime(BOARD_REFRESH_MS);});await flush();
  expect(result.current.activity.get('s')).toEqual({state:'idle',checkedAt:130000});unmount();
 });
 it('finishes a slow 50-session sweep without restart starvation or exceeding four reads',async()=>{
  mocks.snapshot.sessions=Array.from({length:50},(_,i)=>({id:'s'+i,title:'Session',agentDir:'/work',lastActiveAt:'2026-10-15T01:00:00Z'}));
  let active=0,maxActive=0;
  mocks.read.mockImplementation(async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,10000));active--;return {state:'running',checkedAt:Date.now()};});
  const {result,unmount}=renderHook(()=>useProjectBoardData('/work',true));await flush();
  for(let i=0;i<13;i++){await act(async()=>{vi.advanceTimersByTime(10000);});await flush();}
  expect(mocks.read).toHaveBeenCalledTimes(50);expect(maxActive).toBe(4);expect(result.current.activity.size).toBe(50);unmount();
 });
 it('updates a previously idle session after a new run and stops reads when inactive',async()=>{
  const {result,rerender,unmount}=renderHook(({active})=>useProjectBoardData('/work',active),{initialProps:{active:true}});
  await flush();expect(result.current.activity.get('s')?.state).toBe('idle');
  mocks.read.mockImplementation(async()=>({state:'running',checkedAt:Date.now()}));
  await act(async()=>{vi.advanceTimersByTime(BOARD_REFRESH_MS);});await flush();
  expect(result.current.activity.get('s')?.state).toBe('running');expect(mocks.read).toHaveBeenCalledTimes(2);
  rerender({active:false});await act(async()=>{vi.advanceTimersByTime(BOARD_REFRESH_MS*3);});
  expect(mocks.read).toHaveBeenCalledTimes(2);unmount();
 });
 it('pauses hidden windows and immediately rechecks on visibility return',async()=>{
  const {unmount}=renderHook(()=>useProjectBoardData('/work',true));await flush();
  await act(async()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  await act(async()=>{vi.advanceTimersByTime(BOARD_REFRESH_MS*3);});expect(mocks.read).toHaveBeenCalledTimes(1);
  await act(async()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});await flush();
  expect(mocks.read).toHaveBeenCalledTimes(2);unmount();
 });
 it('rejects late old idle results after an explicit refresh observes running',async()=>{
  let resolveOld!: (value:unknown)=>void;
  mocks.read.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockResolvedValue({state:'running',checkedAt:100001});
  const {result,unmount}=renderHook(()=>useProjectBoardData('/work',true));await flush();
  await act(async()=>{result.current.refresh();});await flush();expect(mocks.read).toHaveBeenCalledTimes(1);
  await act(async()=>{resolveOld({state:'idle',checkedAt:100000});});await flush();
  expect(result.current.activity.get('s')?.state).toBe('running');unmount();
 });
 it('keeps the last observation and duration when a later owner read fails',async()=>{
  const execution={startedAt:'2026-10-15T01:00:00Z',elapsedMs:12000};
  mocks.read.mockResolvedValueOnce({state:'running',checkedAt:100000,execution}).mockRejectedValue(new Error('unavailable'));
  const {result,unmount}=renderHook(()=>useProjectBoardData('/work',true));await flush();
  await act(async()=>{vi.advanceTimersByTime(BOARD_REFRESH_MS);});await flush();
  expect(result.current.activity.get('s')).toEqual({state:'running',checkedAt:100000,execution,error:'Error: unavailable'});unmount();
 });
});
