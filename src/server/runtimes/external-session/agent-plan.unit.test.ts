import {describe,it,expect} from 'vitest';
import {setExternalAgentPlan,getExternalAgentPlan,resetExternalLifecycleState,bindExternalSessionContext} from './lifecycle';
describe('native plan owner scope',()=>{
 it('clears on reset and Session change, preserves on same Session rebind, accepts empty clear',()=>{
  resetExternalLifecycleState();expect(getExternalAgentPlan()).toBeNull();
  const bind=(sessionId:string)=>bindExternalSessionContext({sessionId,workspacePath:'/safe',scenario:{type:'desktop'}});
  bind('one');setExternalAgentPlan([{key:'1',content:'step',activeForm:'working',status:'in_progress'}]);
  bind('one');expect(getExternalAgentPlan()).toHaveLength(1);
  bind('two');expect(getExternalAgentPlan()).toBeNull();
  setExternalAgentPlan([]);expect(getExternalAgentPlan()).toEqual([]);
  resetExternalLifecycleState();expect(getExternalAgentPlan()).toBeNull();
 });
});
