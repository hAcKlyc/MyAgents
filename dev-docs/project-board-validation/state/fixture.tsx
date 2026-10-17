import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {i18n} from '@/i18n';
import {ThemeRuntimeProvider} from '@/theme/ThemeRuntime';
import '@/index.css';
import ProjectBoard from '@/pages/ProjectBoard';
import {CUSTOM_EVENTS} from '@/../shared/constants';
await i18n.changeLanguage('zh-CN');
window.boardCalls=[];
window.boardTimedSession=true;
const originalSessions=(await import('../mock')).sessions;
originalSessions.find(s=>s.id==='alpha-2').title='HRM 状态同步（合成会话）';
function Fixture(){
 const [active,setActive]=useState('board');
 useEffect(()=>{const open=e=>{window.boardCalls.push({kind:'openSession',...e.detail});setActive('chat')};window.addEventListener(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB,open);return()=>window.removeEventListener(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB,open)},[]);
 return <main style={{height:'100vh',display:'flex',flexDirection:'column'}}><nav style={{display:'flex',gap:20,padding:'12px 24px',borderBottom:'1px solid var(--line)',fontSize:14}}><button onClick={()=>setActive('board')}>项目看板</button><button onClick={()=>setActive('chat')}>原会话</button><span style={{fontSize:12,color:'var(--ink-muted)'}}>实际 React 组件 · 隔离合成数据 · 无真实执行</span></nav><div style={{flex:1,minHeight:0,display:active==='board'?'block':'none'}}><ProjectBoard workspacePath='/synthetic/alpha' isActive={active==='board'}/></div>{active==='chat'&&<div style={{padding:24}}>原会话导航模拟；返回项目看板后保留筛选、选择和草稿。</div>}</main>
}
createRoot(document.getElementById('root')).render(<ThemeRuntimeProvider selection={{themeId:'myagents-light',appearanceMode:window.location.search.includes('dark')?'dark':'light'}}><Fixture/></ThemeRuntimeProvider>);
