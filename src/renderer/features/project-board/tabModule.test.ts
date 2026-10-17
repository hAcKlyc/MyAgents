import { describe, expect, it } from 'vitest';
import { projectBoardTabModule as module } from './tabModule';
describe('workspace board tab identity', () => {
  it('reuses a workspace board and keeps another project independent', () => {
    const tab=module.open.create({title:'P',workspacePath:'/work/p'},{id:'board'});
    expect(module.open.findExisting([tab],{title:'Renamed',workspacePath:'/work/p/'})).toBe(tab);
    expect(module.open.findExisting([tab],{title:'Q',workspacePath:'/work/q'})).toBeUndefined();
    expect(module.open.reopen(tab,{title:'Renamed',workspacePath:'/work/p'})).toEqual({...tab,title:'Renamed'});
  });
});
