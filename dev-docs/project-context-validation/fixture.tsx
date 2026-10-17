import { createRoot } from 'react-dom/client';
import { i18n } from '@/i18n';
import { ThemeRuntimeProvider } from '@/theme/ThemeRuntime';
import '@/index.css';
import ProjectContextSection from '@/components/AgentSettings/sections/ProjectContextSection';
import { useConfig, qa } from './mock';
await i18n.changeLanguage('zh-CN');
Object.assign(window, { contextQa: qa });
function Fixture() {
 const { projects } = useConfig();
 return <main style={{minHeight:'100vh',padding:'32px 16px',background:'var(--paper)',color:'var(--ink)'}}>
  <div style={{maxWidth:672,margin:'0 auto'}}><h1 style={{fontSize:24,marginBottom:12}}>项目通用设置</h1>
   <p style={{fontSize:13,marginBottom:24,color:'var(--ink-muted)'}}>实际 React 组件 · 合成项目 · 不读取真实配置</p>
   <section className='rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5'><ProjectContextSection project={projects[0]} /></section>
   <button style={{marginTop:20,fontSize:12}} onClick={() => { qa.failNext = true; }}>模拟下次保存失败</button>
   <p id='feedback' role='status' style={{marginTop:16}} />
  </div>
 </main>;
}
createRoot(document.getElementById('root')!).render(<ThemeRuntimeProvider selection={{themeId:'myagents-light',appearanceMode:location.search.includes('dark')?'dark':'light'}}><Fixture /></ThemeRuntimeProvider>);
