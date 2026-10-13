import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {i18n} from '@/i18n';
import {ThemeRuntimeProvider} from '@/theme/ThemeRuntime';
import '@/index.css';
import GlobalSidebar from '@/components/global-sidebar/GlobalSidebar';
await i18n.changeLanguage('zh-CN');
const noop=()=>{};
function Fixture(){const [active,setActive]=useState({id:'launcher',view:'launcher',title:'合成验收'});const [path,setPath]=useState(null);
const open=async(s,p)=>{window.auditEvents.push({kind:'openSession',session:s.id,project:p.id,path:p.path});setActive({id:s.id,view:'chat',title:s.title,sessionId:s.id,workspacePath:p.path});setPath(p.path);return true};
return <main style={{height:'100vh',display:'flex'}}><GlobalSidebar tabs={[active]} activeTab={active} activeWorkspacePath={path} teamSpaceAvailable onNewTab={noop} onOpenTaskCenter={noop} onCreateTask={noop} onOpenSpace={noop} onOpenCapabilities={noop} onOpenSettings={noop} onOpenBugReport={noop} onOpenWorkspace={async(p)=>{window.auditEvents.push({kind:'openWorkspace',project:p.id});return true}} onOpenSession={open} onRenameSession={async()=>null} newAgentPanelOpen={false} onNewAgentPanelOpenChange={noop}/><article style={{padding:24}}>正式 GlobalSidebar 合成验收；无模型、无真实后台。</article></main>}
window.auditEvents=[];
createRoot(document.getElementById('root')).render(<ThemeRuntimeProvider selection={null}><Fixture/></ThemeRuntimeProvider>);
