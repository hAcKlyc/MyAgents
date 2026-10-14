import { expect,it,vi } from 'vitest';
vi.mock('../SessionStore',()=>({getSessionMetadata:vi.fn(),getSessionData:vi.fn(),isHistoryVisibleSession:vi.fn()}));
vi.mock('../session-engine',()=>({getSessionEngine:vi.fn()}));
vi.mock('../session-text-projection',async()=>{const original=await vi.importActual<typeof import('../session-text-projection')>('../session-text-projection');return original});
import {projectRemoteInteractions,projectRemoteMessage} from './projection';
it('projects actual pending approvals only and disables incomplete or secret reviews',()=>{
  const items=[{type:'permission:request',data:{requestId:'r',toolName:'Bash',input:'x'.repeat(500)}},{type:'ask-user-question:request',data:{requestId:'q',questions:[{id:'native-q',question:'Password',isSecret:true,options:[]}]}}];
  expect(projectRemoteInteractions(items,null,'turn')).toEqual([]);
  const projected=projectRemoteInteractions(items,'gen','turn');
  expect(projected).toHaveLength(2);expect(projected.every(p=>!p.actionable)).toBe(true);
  expect(projected[1].questions[0].answerKey).toBe('native-q');
  expect(projectRemoteInteractions([{type:'enter-plan-mode:request',data:{requestId:'legacy'}}],'gen','turn')).toEqual([]);
  expect(projectRemoteInteractions([{type:'permission:request',data:{requestId:'external',toolName:'apply_patch',input:'',review:{file:'/target'}}}],'gen','turn')[0].actionable).toBe(false);
});
it('does not mistake plain JSON for tool frames or leak hidden thinking and tool input',()=>{
  const base={id:'m',role:'assistant' as const,timestamp:'2026-10-15T00:00:00Z'};
  expect(projectRemoteMessage({...base,content:'[1,2]'})).toMatchObject({content:'[1,2]',tools:[]});
  const message=projectRemoteMessage({...base,content:JSON.stringify([{type:'thinking',thinking:'private reasoning'},{type:'text',text:'reply'},{type:'tool_use',id:'t',name:'Bash',input:{password:'secret',command:'private'}}])});
  expect(message).toMatchObject({content:'reply',tools:[{name:'Bash'}]});
  expect(JSON.stringify(message)).not.toMatch(/private reasoning|secret|private"/);
});
