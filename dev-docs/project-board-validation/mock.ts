import {useSyncExternalStore} from 'react';
const noop=()=>{};let version=0;const listeners=new Set<()=>void>();function emit(){version++;listeners.forEach(f=>f())}const hook=()=>useSyncExternalStore(f=>{listeners.add(f);return()=>listeners.delete(f)},()=>version);
export const projects=['alpha','beta','gamma'].map((id,i)=>({id,name:['研发 Agent Alpha','产品 Agent Beta 极长名称用于验证侧边栏截断与提示不遮盖菜单','运营 Agent Gamma'][i],path:'/synthetic/'+id,isAgent:true,agentId:'agent-'+id,lastOpenedAt:'2026-10-13T01:00:00Z'}));
export const sessions=projects.flatMap((p)=>[1,2].map(n=>({id:p.id+'-'+n,title:(n===1?'任务一：':'任务二：')+p.name,workspacePath:p.path,agentDir:p.path,lastActiveAt:`2026-10-13T0${n}:00:00Z`,createdAt:'2026-10-13T00:00:00Z',agentId:p.agentId,status:'idle',favorite:false})));
const config={defaultWorkspacePath:projects[0].path,agents:projects.map(p=>({id:p.agentId,enabled:true})),spaceEnvironment:'production'};
export function useConfig(){hook();return{config,projects,isLoading:false,error:null,removeProject:noop,patchProject:noop,touchProject:async()=>{},refreshConfig:async()=>{},addProject:noop}}
export function useGlobalSidebarTaskCenterData(){hook();return{sessions,isSessionsLoading:false,error:null,sessionTagsMap:new Map(),workspaceSessionStates:new Map(),deleteProtectedSessionIds:new Set(),refresh:noop,actions:{deleteSession:async()=>({deleted:true}),setSessionFavorite:async(id,value)=>{Object.assign(sessions.find(s=>s.id===id),{favorite:value});emit();return true},beginSessionMetadataMutation:()=>1,applySessionMetadata:(session)=>{Object.assign(sessions.find(s=>s.id===session.id),session);emit();return true},refreshSessions:noop}}}
export const ensureWorkspaceSessions=noop;
export const useWorkspaceFileService=()=>({openPathExternal:async()=>{}});
export const useSessionDeletion=()=>async()=>({deleted:true});
export const useToast=()=>({error:console.error,warning:console.warn,success:noop,info:noop});
export const useNotificationCenter=()=>({snapshot:{loadState:'ready',authState:'signed_out',items:[],hasUnread:false,hasMore:false,isLoadingMore:false,feedCutoff:null,lastSyncedAt:null,errorCode:null},refresh:noop,loadMore:async()=>{},markAllRead:async()=>{}});
export const track=noop;
export const updateSession=async(id,patch)=>({...sessions.find(s=>s.id===id),...patch});
export const getAgentById=async(id)=>config.agents.find(a=>a.id===id);
export const setAgentEnabledForLifecycle=async()=>{};
export const stopAgentChannelsForLifecycle=async()=>{};
export const archiveProject=async(id)=>({...projects.find(p=>p.id===id),archivedAt:new Date().toISOString()});
export const unarchiveProject=async(id)=>({...projects.find(p=>p.id===id),archivedAt:undefined});
export const useMyAgentsAccount=()=>({scope:'production',enabled:false,generation:0,loadState:'ready',view:null,error:null,avatarPresets:{people:[],agents:[],lastFetchedAt:0,isLoading:false,error:null}});
export const isTauriEnvironment=()=>false;
export const isBrowserDevMode=()=>false;
export const pickFolderForDialog=async()=>null;
export default function Empty(){return null}

export const NewAgentPanel=Empty;
export const getSessionDetails=async()=>({});
export const useToastOptional=useToast;
export const getSessions=async()=>sessions;
export const getSessionUserTags=async()=>[];
export const mutateGlobalSessionUserTag=async()=>{};
export const mutateSessionUserTagAssignment=async()=>{};
export class SessionUserTagApiError extends Error {}
const stamp=Date.now();
export const tasks=['running','blocked','verifying','done','todo'].map((status,i)=>({id:'task-'+status,name:['目标方案调整：费用包预算校验','员工绩效回显异常','项目管理任务错误修复','费用包审批查询支持','销售目标拆分'][i],executor:'agent',workspaceId:'alpha',workspacePath:'/synthetic/alpha',executionMode:'once',sessionIds:status==='blocked'?['alpha-1']:[],status,tags:['销售'],createdAt:stamp,updatedAt:stamp-i*1000,statusHistory:[{from:'todo',to:status,at:stamp,actor:'agent',message:'本地验收合成数据'}],description:'这条记录只用于隔离的界面验收，不代表真实业务执行或发布。',dispatchOrigin:'direct',docs:{dir:'/synthetic/docs',taskMd:'/synthetic/docs/task.md'}}));
tasks.push({...tasks[0],id:'schedule',name:'定时任务等待触发',executionMode:'recurring',sessionIds:[]});
const snapshot={sessions,workspaceSessionStates:new Map(),isSessionsLoading:false,sessionsError:null};
export const getSnapshot=()=>snapshot;
export const subscribePassive=()=>noop;
export const registerPassiveWorkspaceSessionDemand=()=>noop;
export const listenWithCleanup=async()=>noop;
export const taskList=async()=>{if(window.boardFailRead)throw new Error('读取失败（验收）');return [...tasks]};
export const taskGet=async(id)=>tasks.find(t=>t.id===id)??null;
export const taskReadDoc=async()=> '# 交付要求\n\n请检查真实代码、测试、发布和业务路径。\n\n本页面为合成验收。';
export const taskOpenDocsDir=async()=>{};
export const taskUpdateStatus=async(input)=>{window.boardCalls.push({kind:'status',...input});if(window.boardFailAction)throw new Error('验收提交失败（模拟）');const task=tasks.find(t=>t.id===input.id);Object.assign(task,{status:input.status,updatedAt:Date.now()});return task};
export const taskRun=async(id)=>{window.boardCalls.push({kind:'run',id});if(window.boardFailAction)throw new Error('执行失败（模拟）');const task=tasks.find(t=>t.id===id);Object.assign(task,{status:'running',executionState:'running'});return {task,attemptOrdinal:1}};
export const taskRerun=async(id)=>{window.boardCalls.push({kind:'rerun',id});if(window.boardFailAction)throw new Error('重新执行失败（模拟）');const task=tasks.find(t=>t.id===id);Object.assign(task,{status:'running',executionState:'running'});return {task,attemptOrdinal:1}};
export const apiPostJson=async(path,body)=>{window.boardCalls.push({kind:'observe',path,id:body.sessionId});return {success:true,session:{sessionId:body.sessionId,state:body.sessionId==='alpha-1'?'waiting_user_action':'idle'}}};
