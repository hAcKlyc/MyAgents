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

const registry={ownedServiceUrl:'https://owned.example.test',selected:null,connections:[]};
export const useAgentNetworkRegistry=()=>registry;
export const networkConnections=async()=>registry;
export const acceptNetworkRegistry=noop;
export const selectNetworkConnection=async()=>registry;
export const removeNetworkConnection=async()=>registry;
export const startOwnedNetworkLogin=async()=>({attemptId:'fixture',authorizationUrl:'https://owned.example.test/auth',expiresAt:Date.now()/1000+300});
export const openOwnedNetworkAuthorization=async()=>{};
export const pollOwnedNetworkLogin=async()=>({status:'pending'});
export const cancelOwnedNetworkLogin=async()=>{};
export const openExternal=async(url)=>{window.auditEvents.push({kind:'external',url})};
