import { describe, expect, it, vi } from 'vitest';
import { readBoardSessionActivity } from './activity';
const { post } = vi.hoisted(() => ({post:vi.fn()}));
vi.mock('@/api/apiFetch',()=>({apiPostJson:post}));
describe('project board session observations',()=>{
  it('reads existing owner without creating or executing a session',async()=>{
    post.mockResolvedValue({success:true,session:{sessionId:'s',state:'running'}});
    expect((await readBoardSessionActivity('s')).state).toBe('running');
    expect(post).toHaveBeenCalledWith('/api/admin/session/state',{sessionId:'s'});
  });
  it.each([{success:false,error:'unavailable'},{success:true,session:{sessionId:'wrong',state:'running'}},{success:true,session:{sessionId:'s',state:'done'}}])('rejects unavailable, wrong owner or fabricated states',async response=>{
    post.mockResolvedValue(response);
    await expect(readBoardSessionActivity('s')).rejects.toThrow();
  });
});
