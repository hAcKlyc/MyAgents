import { describe, expect, it } from 'vitest';
import { deriveSessionTodos, deriveSessionWorkProgress } from './sessionWorkProgress';
const todo = { content: '部署生产', activeForm: '正在部署生产', status: 'in_progress' as const };
const msg = (name: string, properties: Record<string,unknown> = {}, id = 'm') => ({ id, role: 'assistant', content: [{ type:'tool_use', tool:{ id: id+'-tool', name, ...properties } }] });
describe('shared chat/board progress truth', () => {
  it('uses result before input and survives stored JSON wire content', () => {
    const message = msg('TodoWrite', { parsedInput:{todos:[todo]}, result:JSON.stringify({newTodos:[{...todo,status:'completed'}]}) });
    expect(deriveSessionTodos([message]).todos[0].status).toBe('completed');
    expect(deriveSessionTodos([{...message,content:JSON.stringify(message.content)}])).toEqual(deriveSessionTodos([message]));
    expect(deriveSessionTodos([msg('TodoWrite',{parsedInput:{}}), message]).todos).toHaveLength(1);
  });
  it('uses Task identity and never applies a rejected update', () => {
    const list = [msg('TaskCreate',{parsedInput:{subject:'测试'},result:'{"task":{"id":"1"}}'}),msg('TaskUpdate',{parsedInput:{taskId:'1',status:'completed'},result:'{"success":false}'})];
    expect(deriveSessionTodos(list).todos[0]).toMatchObject({key:'1',status:'pending'});
    list.push(msg('TaskUpdate',{parsedInput:{taskId:'1',status:'completed'},result:'{"success":true}'}));
    expect(deriveSessionTodos(list).todos[0].status).toBe('completed');
  });
  it('keeps prior tools while native plan is absent but respects explicit clears', () => {
    const messages = [msg('TodoWrite',{parsedInput:{todos:[todo]}})];
    expect(deriveSessionTodos(messages,null).todos).toHaveLength(1);
    expect(deriveSessionTodos(messages,[])).toEqual({todos:[],source:'runtime'});
    expect(deriveSessionTodos([...messages,msg('TaskList',{result:'{"tasks":[]}'})])).toEqual({todos:[],source:'tools'});
    expect(deriveSessionTodos([...messages,msg('TaskGet',{result:'{}'})]).todos).toHaveLength(1);
  });
  it('rejects malformed todos without invalidating state and does not scan user text', () => {
    expect(deriveSessionTodos([msg('TodoWrite',{parsedInput:{todos:[null,{bad:true},todo]}})]).todos).toHaveLength(1);
    expect(deriveSessionTodos([{...msg('TodoWrite',{parsedInput:{todos:[todo]}}),role:'user'}]).todos).toHaveLength(0);
  });
  it('only projects background work owned by the exact live Query', () => {
    const messages = [msg('Agent',{parsedInput:{description:'后台审查'},isLoading:true})];
    expect(deriveSessionWorkProgress(messages,{live:true}).agentRunning).toBe(0);
    const options = {live:true,activeBackground:[{id:'task',toolUseId:'m-tool',startedAt:1000}]};
    expect(deriveSessionWorkProgress(messages,options)).toMatchObject({agentRunning:1,agents:[{id:'m-tool',status:'running'}]});
    expect(deriveSessionWorkProgress(messages,{...options,live:false}).agentRunning).toBe(0);
    expect(deriveSessionWorkProgress(messages,{live:true,activeBackground:[]} ).agentRunning).toBe(0);
  });
  it('does not revive historical lifecycle cards or replace a failed child with success', () => {
    const messages=[msg('CollabAgent',{subagentLifecycle:{status:'running',startedAt:1,agentType:'Reviewer'}})];
    expect(deriveSessionWorkProgress(messages,{live:false})).toMatchObject({agentRunning:0,agents:[{status:'unknown'}]});
    const terminal = msg('CollabAgent',{subagentLifecycle:{status:'failed',startedAt:1,finishedAt:2}},'new');
    expect(deriveSessionWorkProgress([...messages,terminal],{live:true})).toMatchObject({agentRunning:0,agents:[{status:'failed'}]});
  });
  it('caps display items after computing actual totals', () => {
    const messages=[msg('TodoWrite',{parsedInput:{todos:Array.from({length:130},()=>({...todo,status:'completed'}))}})];
    const result=deriveSessionWorkProgress(messages,{live:true,activeBackground:Array.from({length:23},(_,i)=>({id:String(i)}))});
    expect(result).toMatchObject({todoTotal:130,todoCompleted:130,agentTotal:23,agentRunning:23});
    expect(result.todos).toHaveLength(100); expect(result.agents).toHaveLength(20);
    expect(result).not.toHaveProperty('taskStatus');
  });
});
