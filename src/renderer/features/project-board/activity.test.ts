import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readBoardSessionActivity } from './activity';
const { post, goal, desktop } = vi.hoisted(() => ({post:vi.fn(),goal:vi.fn(),desktop:vi.fn()}));
vi.mock('@/api/sessionGoalClient',()=>({getSessionGoal:goal}));
vi.mock('@/utils/browserMock',()=>({isTauriEnvironment:desktop}));
beforeEach(()=>{goal.mockReset();desktop.mockReturnValue(true);});
vi.mock('@/api/apiFetch',()=>({apiPostJson:post}));
describe('project board session observations',()=>{
  it('reads the durable Goal even when the Session turn is idle or unavailable',async()=>{
    goal.mockResolvedValue({sessionId:'s',workspacePath:'/work',status:'active',isExecuting:false});
    post.mockResolvedValue({success:true,session:{sessionId:'s',state:'idle'}});
    expect(await readBoardSessionActivity('s','/work')).toMatchObject({state:'idle',goal:{value:{status:'active',isExecuting:false}}});
    expect(goal).toHaveBeenCalledWith('s','/work',true);
    post.mockRejectedValue(new Error('Sidecar unavailable'));
    expect(await readBoardSessionActivity('s','/work')).toMatchObject({error:expect.any(String),goal:{value:{status:'active'}}});
  });
  it('distinguishes absent, unreadable and wrong-owner Goals',async()=>{
    post.mockResolvedValue({success:true,session:{sessionId:'s',state:'idle'}});
    goal.mockResolvedValue(null);
    expect((await readBoardSessionActivity('s','/work')).goal).toMatchObject({value:null});
    goal.mockRejectedValue(new Error('Goal unavailable'));
    expect((await readBoardSessionActivity('s','/work')).goal).toMatchObject({error:expect.any(String)});
    goal.mockResolvedValue({sessionId:'other',workspacePath:'/work',status:'active'});
    expect((await readBoardSessionActivity('s','/work')).goal).toMatchObject({error:'Goal owner mismatch'});
  });
  it('keeps web-only observation compatible without invoking a desktop command',async()=>{
    desktop.mockReturnValue(false);
    post.mockResolvedValue({success:true,session:{sessionId:'s',state:'idle'}});
    expect((await readBoardSessionActivity('s','/work')).state).toBe('idle');
    expect(goal).not.toHaveBeenCalled();
  });

  it('accepts optional validated work progress without trusting malformed counts',async()=>{
    const progress={source:'live',todoSource:'tools',todos:[],todoTotal:0,todoCompleted:0,agents:[],agentTotal:0,agentRunning:0};
    post.mockResolvedValue({success:true,session:{sessionId:'s',state:'running',progress}});
    expect((await readBoardSessionActivity('s')).progress).toEqual(progress);
    post.mockResolvedValue({success:true,session:{sessionId:'s',state:'running',progress:{...progress,todoTotal:-1}}});
    expect((await readBoardSessionActivity('s')).progress).toBeUndefined();
  });
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
