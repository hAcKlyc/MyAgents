import {describe,it,expect} from 'vitest';
import {isHostProviderProfile,isHostRelativePath,isHostModelId,portableProfileToProvider} from './hostProviderConfig';
const profile={id:'portable-1',name:'Portable',apiProtocol:'openai' as const,baseUrl:'https://api.example.test/v1',authType:'api_key' as const};
describe('portable Host closed metadata',()=> {
  it('keeps model slashes and Unicode paths while rejecting traversal, controls, local endpoints and arbitrary environment',()=> {
    expect(isHostModelId('vendor/model:2026')).toBe(true);expect(isHostRelativePath('客户 文件夹/项目 A')).toBe(true);
    for(const path of ['../child','a/./b','/absolute','a//b','a\\b','a\0b','\ud800']) expect(isHostRelativePath(path)).toBe(false);
    expect(isHostProviderProfile(profile)).toBe(true);
    expect(isHostProviderProfile({...profile,sourceProviderId:'original-provider'})).toBe(true);
    expect(isHostProviderProfile({...profile,sourceProviderId:'bad/provider'})).toBe(false);
    expect(portableProfileToProvider({...profile,sourceProviderId:'original-provider'},['model'])).not.toHaveProperty('sourceProviderId');
    for(const id of ['anthropic-sub','codex-sub','xai-sub','antigravity-sub']) expect(isHostProviderProfile({...profile,id})).toBe(false);
    for(const baseUrl of ['http://api.example.test','https://127.0.0.1','https://[::1]','https://localhost/v1','https://user:pass@example.test','https://example.test?v=1','https://example.test/#key','https://example.test/?','https://example.test/#','https://[::ffff:127.0.0.1]']) expect(isHostProviderProfile({...profile,baseUrl})).toBe(false);
    expect(isHostProviderProfile({...profile,env:{SECRET:'no'}})).toBe(false);
    for(const authType of ['auth_token','api_key','both','auth_token_clear_api_key'])expect(isHostProviderProfile({...profile,authType})).toBe(true);
    expect(isHostProviderProfile({...profile,authType:'both',modelAliases:{fable:'vendor/fable',sonnet:'vendor/sonnet',opus:'vendor/opus',haiku:'vendor/haiku'}})).toBe(true);
    expect(portableProfileToProvider(profile,['vendor/model'])).toMatchObject({type:'api',config:{baseUrl:profile.baseUrl},models:[{model:'vendor/model'}]});
  });
});
