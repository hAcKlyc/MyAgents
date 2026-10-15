import { describe, expect, it, vi } from 'vitest';
import { readBoardSessionActivity } from './activity';
const { post } = vi.hoisted(() => ({post:vi.fn()}));
vi.mock('@/api/apiFetch',()=>({apiPostJson:post}));
describe('project board session observations',()=>{
  it('preserves an explicit execution failure without inventing idle',async()=>{
    post.mockResolvedValue({success:false,code:'SESSION_EXECUTION_FAILED',error:'Execution failed'});
    await expect(readBoardSessionActivity('s')).rejects.toMatchObject({code:'SESSION_EXECUTION_FAILED'});
  });
  it('reads existing owner without creating or executing a session',async()=>{
    post.mockResolvedValue({success:true,session:{sessionId:'s',state:'running'}});
    expect((await readBoardSessionActivity('s')).state).toBe('running');
    expect(post).toHaveBeenCalledWith('/api/admin/session/state',{sessionId:'s'});
  });
  it('preserves owner duration while accepting older state-only responses',async()=>{
    const execution={startedAt:'2026-10-14T12:00:00.000Z',elapsedMs:750000};
    post.mockResolvedValue({success:true,session:{sessionId:'s',state:'waiting_user_action',execution}});
    expect((await readBoardSessionActivity('s')).execution).toEqual(execution);
    for(const bad of [{...execution,elapsedMs:-1},{...execution,startedAt:'bad'}]) {
      post.mockResolvedValue({success:true,session:{sessionId:'s',state:'running',execution:bad}});
      expect((await readBoardSessionActivity('s')).execution).toBeUndefined();
    }
  });
  it.each([{success:false,error:'unavailable'},{success:true,session:{sessionId:'wrong',state:'running'}},{success:true,session:{sessionId:'s',state:'done'}}])('rejects unavailable, wrong owner or fabricated states',async response=>{
    post.mockResolvedValue(response);
    await expect(readBoardSessionActivity('s')).rejects.toThrow();
  });
});
