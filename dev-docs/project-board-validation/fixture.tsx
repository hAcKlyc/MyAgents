import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {i18n} from '@/i18n';
import {ThemeRuntimeProvider} from '@/theme/ThemeRuntime';
import '@/index.css';
import GlobalSidebar from '@/components/global-sidebar/GlobalSidebar';
import ProjectBoard from '@/pages/ProjectBoard';
import {CUSTOM_EVENTS} from '@/../shared/constants';
await i18n.changeLanguage('zh-CN');
window.boardCalls=[];
window.boardFailAction=false;
window.boardFailRead=false;
const noop=()=>{};
function Fixture(){
 const [active,setActive]=useState('board');
 const board={id:'board',view:'projectboard',title:'研发 Agent Alpha · 看板',workspacePath:'/synthetic/alpha'};
 const chat={id:'chat',view:'chat',title:'原会话',agentDir:'/synthetic/alpha',sessionId:'alpha-1'};
 useEffect(()=>{const open=e=>{window.boardCalls.push({kind:'openSession',...e.detail});setActive('chat')};window.addEventListener(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB,open);return()=>window.removeEventListener(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB,open)},[]);
 return <main style={{height:'100vh',display:'flex'}}><GlobalSidebar tabs={[board,chat]} activeTab={active==='board'?board:chat} activeWorkspacePath='/synthetic/alpha' teamSpaceAvailable onNewTab={noop} onOpenTaskCenter={noop} onCreateTask={noop} onOpenSpace={noop} onOpenCapabilities={noop} onOpenSettings={noop} onOpenBugReport={noop} onOpenWorkspace={async()=>true} onOpenProjectBoard={()=>setActive('board')} onOpenSession={async()=>{setActive('chat');return true}} onRenameSession={async()=>null} newAgentPanelOpen={false} onNewAgentPanelOpenChange={noop}/>
 <article style={{flex:1,minWidth:0,display:'flex',flexDirection:'column'}}><nav style={{display:'flex',gap:16,padding:12,borderBottom:'1px solid var(--line)'}}><button onClick={()=>setActive('board')}>项目看板</button><button onClick={()=>setActive('chat')}>原会话</button><span style={{fontSize:12,color:'var(--ink-muted)'}}>实际 React 组件 · 隔离合成数据</span></nav><div style={{flex:1,minHeight:0,display:active==='board'?'block':'none'}}><ProjectBoard workspacePath='/synthetic/alpha' isActive={active==='board'}/></div>{active==='chat'&&<div style={{padding:24}}>原会话验收占位：返回看板保留筛选、选择和验收说明。</div>}</article></main>
}
createRoot(document.getElementById('root')).render(<ThemeRuntimeProvider selection={{themeId:'myagents-light',appearanceMode:window.location.search.includes('light')?'light':'dark'}}><Fixture/></ThemeRuntimeProvider>);
