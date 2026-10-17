import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/../shared/types/task';
import type { SessionMetadata } from '@/api/sessionClient';
import type { useProjectBoardData } from '@/features/project-board/useProjectBoardData';
import ProjectBoard from './ProjectBoard';
const mocks = vi.hoisted(()=>({data:null as unknown as ReturnType<typeof useProjectBoardData>,archive:vi.fn(),status:vi.fn(),get:vi.fn(),update:vi.fn(),observe:vi.fn(),apply:vi.fn(),create:vi.fn(),append:vi.fn()}));
vi.mock('@/hooks/useConfig',()=>({useConfig:()=>({projects:[{id:'p',name:'Project',path:'/work'}]})}));
vi.mock('@/features/project-board/useProjectBoardData',()=>({useProjectBoardData:()=>mocks.data}));
vi.mock('@/features/project-board/useBoardOverlay',()=>({useBoardOverlay:()=>false}));
vi.mock('@/api/taskCenter',()=>({taskArchive:mocks.archive,taskUpdateStatus:mocks.status,taskGet:mocks.get,taskRun:vi.fn(),taskRerun:vi.fn(),taskCreateDirect:mocks.create,taskAppendSession:mocks.append}));
vi.mock('@/api/sessionClient',()=>({updateSession:mocks.update}));
vi.mock('@/features/project-board/activity',()=>({readBoardSessionActivity:mocks.observe}));
vi.mock('@/hooks/taskCenterStore',()=>({actions:{beginSessionMetadataMutation:()=>1,applySessionMetadata:mocks.apply}}));
vi.mock('@/components/task-center/TaskDocBlock',()=>({TaskDocBlock:()=>null}));
vi.mock('@/hooks/useCloseLayer',()=>({useCloseLayer:()=>{}}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
const task=(id:string,status:Task['status']):Task=>({id,name:id,executor:'agent',workspaceId:'p',workspacePath:'/work',executionMode:'once',sessionIds:[],status,tags:[],createdAt:100000,updatedAt:100000,statusHistory:[],dispatchOrigin:'direct'});
const session=(id:string,archived=false):SessionMetadata=>({id,title:id,agentDir:'/work',createdAt:'2026-10-15T01:00:00Z',lastActiveAt:'2026-10-15T01:00:00Z',archived});
beforeEach(()=>{
 vi.clearAllMocks();
 mocks.data={tasks:[task('todo','todo'),task('review','verifying'),task('done','done'),task('archived','archived')],sessions:[session('live'),session('old',true)],activity:new Map([['live',{state:'running',checkedAt:100000}]]),now:100000,tasksLoading:false,taskError:null,sessionsLoading:false,sessionError:null,checking:false,checkedAt:100000,unobservedCount:0,refresh:vi.fn()};
 mocks.observe.mockResolvedValue({state:'idle',checkedAt:100000});
 mocks.get.mockImplementation(async(id:string)=>mocks.data.tasks.find(t=>t.id===id));
 mocks.archive.mockImplementation(async(id:string)=>{mocks.data={...mocks.data,tasks:mocks.data.tasks.map(t=>t.id===id?{...t,status:'archived'}:t)};});
 mocks.status.mockImplementation(async({id,status}:{id:string,status:Task['status']})=>{mocks.data={...mocks.data,tasks:mocks.data.tasks.map(t=>t.id===id?{...t,status}:t)};});
});
describe('project board stages and archive history',()=>{
 it('moves a done Task into running for an active Goal and back only after the Goal completes',()=>{
  mocks.data.tasks=[{...task('goal-task','done'),sessionIds:['goal-session']}];
  mocks.data.sessions=[session('goal-session')];
  const goal={checkedAt:100000,value:{status:'active' as const,isExecuting:false}};
  mocks.data.activity=new Map([['goal-session',{state:'idle',checkedAt:100000,goal}]]);
  const {container,rerender}=render(<ProjectBoard workspacePath='/work'/>);
  expect(container.querySelector('[data-group="running"] [data-board-row="task:goal-task"]')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'projectBoard.archive'})).toBeNull();
  mocks.data.activity=new Map([['goal-session',{state:'idle',checkedAt:100000,goal:{...goal,value:{status:'complete',isExecuting:false}}}]]);
  rerender(<ProjectBoard workspacePath='/work'/>);
  expect(container.querySelector('[data-group="done"] [data-board-row="task:goal-task"]')).toBeTruthy();
 });
 it('rejects archive when an idle Session has an active Goal',async()=>{
  mocks.data.tasks=[{...task('done','done'),sessionIds:['s']}];
  mocks.observe.mockResolvedValue({state:'idle',checkedAt:Date.now(),goal:{checkedAt:Date.now(),value:{status:'active',isExecuting:false}}});
  const {container}=render(<ProjectBoard workspacePath='/work'/>);
  fireEvent.click(within(container.querySelector('[data-board-row="task:done"]')!.closest('article')!).getByRole('button',{name:'projectBoard.archive'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('projectBoard.archiveBusy');
  expect(mocks.archive).not.toHaveBeenCalled();
  expect(mocks.observe).toHaveBeenCalledWith('s','/work');
 });

 it('shows ordered stages and keeps completion on the board while history contains archives only',()=>{
  const {container}=render(<ProjectBoard workspacePath='/work'/>);
  expect([...container.querySelectorAll('.pb-columns>[data-group]')].map(e=>e.getAttribute('data-group'))).toEqual(['todo','running','needs','done']);
  expect(container.querySelector('[data-group="done"] [data-board-row="task:done"]')).toBeTruthy();
  expect(container.querySelector('[data-board-row="task:archived"]')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:/projectBoard.scopes.history/}));
  expect(container.querySelector('[data-board-row="task:archived"]')).toBeTruthy();
  expect(container.querySelector('[data-board-row="session:old"]')).toBeTruthy();
  expect(container.querySelector('[data-board-row="task:done"]')).toBeNull();
  expect(screen.getByText('projectBoard.historyOverview')).toBeTruthy();
  expect(screen.queryByText('projectBoard.overview')).toBeNull();
 });
 it('archives a completed task then restores it to completed without dispatching a run',async()=>{
  const {container}=render(<ProjectBoard workspacePath='/work'/>);
  const done=container.querySelector('[data-board-row="task:done"]')!.closest('article')!;
  fireEvent.click(within(done).getByRole('button',{name:'projectBoard.archive'}));
  await waitFor(()=>expect(mocks.archive).toHaveBeenCalledWith('done'));
  await waitFor(()=>expect(screen.getByRole('button',{name:/projectBoard.scopes.history/})).toHaveTextContent('3'));
  fireEvent.click(screen.getByRole('button',{name:/projectBoard.scopes.history/}));
  const archived=container.querySelector('[data-board-row="task:done"]')!.closest('article')!;
  fireEvent.click(within(archived).getByRole('button',{name:'projectBoard.restore'}));
  await waitFor(()=>expect(mocks.status).toHaveBeenCalledWith({id:'done',status:'done'}));
  fireEvent.click(screen.getByRole('button',{name:/projectBoard.scopes.work/}));
  expect(container.querySelector('[data-group="done"] [data-board-row="task:done"]')).toBeTruthy();
 });
 it('rejects archive if a linked session becomes active after the displayed snapshot',async()=>{
  mocks.data.tasks=mocks.data.tasks.map(t=>t.id==='done'?{...t,sessionIds:['done-session']}:t);
  // This linked identity is deliberately absent from metadata.
  // The Task's canonical sessionIds must still be checked.
  mocks.data.activity=new Map([...mocks.data.activity,['done-session',{state:'idle',checkedAt:100000}]]);
  mocks.observe.mockResolvedValue({state:'running',checkedAt:100001});
  const {container}=render(<ProjectBoard workspacePath='/work'/>);
  const done=container.querySelector('[data-board-row="task:done"]')!.closest('article')!;
  fireEvent.click(within(done).getByRole('button',{name:'projectBoard.archive'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('projectBoard.archiveBusy');expect(mocks.archive).not.toHaveBeenCalled();
 });
 it('can confirm actual results but exposes no completion action for a blocked task',async()=>{
  mocks.data.tasks.push(task('blocked','blocked'));
  const {container}=render(<ProjectBoard workspacePath='/work'/>);
  fireEvent.click(container.querySelector('[data-board-row="task:blocked"]')!);
  await act(async()=>{});expect(screen.queryByRole('button',{name:'projectBoard.accept'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'projectBoard.close'}));
  fireEvent.click(container.querySelector('[data-board-row="task:review"]')!);
  await waitFor(()=>expect(screen.getByRole('button',{name:'projectBoard.inspect'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'projectBoard.inspect'}));
  fireEvent.click(screen.getByRole('button',{name:'projectBoard.accept'}));
  await waitFor(()=>expect(mocks.status).toHaveBeenCalledWith({id:'review',status:'done',message:undefined}));
 });
 it('orders waiting, continue and inactive pools and lets inactive conversations be archived',async()=>{
  const old=new Date(100000-8*24*3600*1000).toISOString();
  mocks.data.tasks=[{...task('cron','running'),executionMode:'recurring'}];
  mocks.data.sessions=[session('fresh'),{...session('stale'),lastActiveAt:old}];
  mocks.data.activity=new Map([['fresh',{state:'idle',checkedAt:100000}],['stale',{state:'idle',checkedAt:100000}]]);
  mocks.update.mockResolvedValue({...session('stale',true)});
  const {container}=render(<ProjectBoard workspacePath='/work'/>);
  expect([...container.querySelectorAll('details.pb-other>summary')].map(e=>e.textContent)).toEqual(['projectBoard.groups.scheduled · 1','projectBoard.groups.idle · 1','projectBoard.groups.inactive · 1']);
  expect(container.querySelector('details.pb-other[open] [data-board-row="session:fresh"]')).toBeTruthy();
  fireEvent.click(within(container.querySelector('[data-board-row="session:stale"]')!.closest('article')!).getByRole('button',{name:'projectBoard.archive'}));
  await waitFor(()=>expect(mocks.update).toHaveBeenCalledWith('stale',{archived:true}));
 });

 it('converts an idle conversation into a Task bound to the same Session',async()=>{
  mocks.data.sessions=[session('talk')];
  mocks.data.activity=new Map([['talk',{state:'idle',checkedAt:100000}]]);
  mocks.create.mockResolvedValue({...task('new','todo'),sessionIds:['talk']});
  mocks.append.mockResolvedValue(task('new','todo'));
  const {container}=render(<ProjectBoard workspacePath='/work'/>);
  const card=container.querySelector('[data-board-row="session:talk"]')!.closest('article')!;
  fireEvent.click(within(card).getByRole('button',{name:'projectBoard.convert'}));
  await waitFor(()=>expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({name:'talk',workspaceId:'p',workspacePath:'/work',executionMode:'once',runMode:'single-session',preselectedSessionId:'talk'})));
  expect(mocks.append).toHaveBeenCalledWith('new','talk');
 });
 it('refuses to convert a conversation that is no longer idle',async()=>{
  mocks.data.sessions=[session('talk')];
  mocks.data.activity=new Map([['talk',{state:'idle',checkedAt:100000}]]);
  mocks.observe.mockResolvedValue({state:'running',checkedAt:100001});
  const {container}=render(<ProjectBoard workspacePath='/work'/>);
  const card=container.querySelector('[data-board-row="session:talk"]')!.closest('article')!;
  fireEvent.click(within(card).getByRole('button',{name:'projectBoard.convert'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('projectBoard.convertBusy');
  expect(mocks.create).not.toHaveBeenCalled();
 });
});
