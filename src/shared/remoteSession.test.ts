import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {remoteSessionRequestSchema,remoteSessionResultSchema} from './remoteSession';
it('matches the Rust shared fixture and refuses caller paths or identity overrides',()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../src-tauri/host-management-protocol/tests/fixtures/remote-session-v1.json',import.meta.url),'utf8'));
  for(const request of fixture.requests)expect(remoteSessionRequestSchema.safeParse(request).success).toBe(true);
  for(const result of fixture.results)expect(remoteSessionResultSchema.safeParse(result).success).toBe(true);
  expect(remoteSessionRequestSchema.safeParse({kind:'start',agentId:'agent',operationId:'00000000-0000-4000-8000-000000000003',text:'hi',workspacePath:'/etc',caller:'forged'}).success).toBe(false);
});
