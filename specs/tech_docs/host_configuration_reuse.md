# Host configuration reuse — MOXBOTS-HOST-CONFIG-20261013

Current Agent implements the user's desktop-main-Agent configuration reuse and remote directory picker. The existing Settings model-management interaction is the UI baseline. This document freezes implementation interfaces; it does not claim deployment or acceptance.

## Owners and compatibility

- Existing desktop ConfigProvider/config services own source Provider/Agent settings. Source means the Agent attached to `config.defaultWorkspacePath`, with its explicit provider/model taking precedence over general defaults. An explicit missing/unsupported source is an error, never a silently substituted model.
- Host config, resource and encrypted-provider-credential owners remain authoritative. The existing encrypted management channel and private Unix IPC carry bounded typed operations. No arbitrary remote file read, command, environment or new public listener.
- Keep the original v1 five methods and DTOs unchanged. Add closed extension methods/results. A fully handshaken read-only `host.capabilities` probe uses its own management subchannel. An unsupported probe must retire its subchannel and leave the main AgentNet connection/epoch intact before a fresh legacy snapshot. Do not generalize this recovery to writes, identity failures or other protocol errors.
- New Host continues serving old controllers while its configuration is representable by v1. For an API profile that cannot be represented, legacy snapshot/config receipt returns the existing legal error `HOST_MANAGEMENT_UPGRADE_REQUIRED`; do not fake an empty configuration.
- API-key Providers using Anthropic/OpenAI protocols are portable. OAuth subscriptions, SDK-native/runtime-managed credentials, local desktop proxies and arbitrary ProviderEnv are not copied. Credentials are write-only, encrypted by the existing Host credential owner and excluded from snapshot, UI receipts, logs and task records.
- Applying source configuration preserves the Host's existing execution authorization; it does not enable execution or expose Agents. Existing Session birth settings remain unchanged. Config and credential persistence are separate, and partial application is reported accurately.

## Closed extension contract

All operations retain existing locator/target-scope fences. Mutation IDs, CAS and original-receipt recovery are required. Envelope budget remains 64 KiB.

| Method | Params | Result |
| --- | --- | --- |
| `host.capabilities` | `{}` | `{kind:"capabilities",version:1,methods:[closed method names],providerKinds:["anthropic","openai"],limits:{directoryEntries:128,pathBytes:4096}}` |
| `host.inspect` | `{}` | Existing snapshot fields with `kind:"extended-snapshot"`, plus generic settings/credential provider IDs and required non-secret `provider: PortableApiProvider|null`; version stays 1 for this result shape. |
| `config.provider.set` | `{provider,model,workspace:{rootId,relativePath},executionAuthorized,expectedRevision,mutationId}` | `{kind:"provider-config-receipt",status,mutationId,revision,effect,settings?}` |
| `credential.provider.set` | `{providerId,credential,expectedRevision,mutationId}` | `{kind:"provider-credential-receipt",status,mutationId,revision?,effect}` |
| `receipt.provider.get` | `{owner:"config"|"credentials",providerId,mutationId}` | Corresponding provider receipt, or existing receipt-not-found result. |
| `resources.directory.list` | `{rootId,relativePath,cursor?}` | `{kind:"directory-list",rootId,relativePath,entries:[{name,relativePath}],nextCursor:null|string}` |
| `resources.register` | `{rootId,relativePath,expectedRevision,mutationId}` | Existing resource-receipt; registers an existing directory as a disabled Agent without creating it. |

`provider` is non-secret: `{id,sourceProviderId?,name,apiProtocol:"anthropic"|"openai",baseUrl,authType:"auth_token"|"api_key"|"both"|"auth_token_clear_api_key",upstreamFormat?:"chat_completions"|"responses",maxOutputTokens?:number,maxOutputTokensParamName?:"max_tokens"|"max_completion_tokens"|"max_output_tokens",modelAliases?:{fable?,sonnet?,opus?,haiku?}}`. IDs use 1–128 safe ASCII characters. Model IDs/aliases are nonempty, up to 160 characters, with no controls. Names are at most 256 characters. Endpoint is HTTPS with no userinfo/query/fragment; desktop loopback endpoints cannot be inherited as remote endpoints. No arbitrary headers/env/runtime config.

Generic wire settings are `{revision,providerId,model,workspace:{rootId,relativePath},executionAuthorized}`. The existing Host internal `hostSettings.workspace` remains an absolute owner-validated path, with the selection stored separately in `hostProviderWorkspace`; old wire settings remain unchanged. Extended snapshot credentials describe only the currently selected provider `{providerId,configured,revision,writeAvailable}`. Original Kimi credentials/receipts must remain recoverable. Generic credential storage supports a bounded number of registered providers using the existing owner/encryption and provider-bound references; no raw keys in config or Session snapshots.

Directory paths are relative to Host-declared roots; empty string denotes root for browsing/config selection. Registration needs a nonempty child path. UTF-8 spaces/Chinese names are supported, with bounded lengths, no `.`/`..`, NUL, absolute path or symlink traversal. Reuse fd anchoring and no-follow semantics; filter symlinks. Pagination is bounded and location-bound, detects directory changes and offers refresh. Never load an unbounded directory into memory.

## Immutable profile identities

Every desktop generic application derives a SHA-256 profile version ID from the portable non-secret definition and chosen model, with complete fable/sonnet/opus/haiku aliases frozen. Optional sourceProviderId preserves the original source identity when reading a versioned profile back, so unchanged re-application yields the same ID. Host rejects changing metadata under an existing ID. Changing endpoint/protocol/aliases/model uses a new profile identity, preserving prior concrete Session route endpoint, model, aliases and provider-bound key references. Capped profile capacity is explicit. No plaintext ProviderEnv snapshot or second birth authority is introduced.

## UI flow and gates

1. Read capabilities and actual owner snapshot. Old Host retains its existing Kimi form with a clear upgrade explanation for new features.
2. Reuse Settings model-management/preset selection, connection and key-input controls. Draft editing in Host never changes the desktop source registry implicitly. Source config is re-read before one-click application; no stale captured key is persisted in presentation state.
3. Show source Agent/provider/model/local path and target Host/directory. Local path is a source hint, not a remote path. Remote current directory or a same-name suggestion must be verified by Host; missing mappings open the picker, not auto-create.
4. Select root, navigate directories, select an existing directory, optionally create a named child through the existing create operation. Existing-directory Agent registration is explicit and remains disabled.
5. Apply source model/profile and credential through their respective owners, query uncertain receipts rather than resending, re-read actual state and distinguish full success from partial application.

Acceptance: old Host/new client leaves main socket/epoch online after unsupported probe; old client/new Host retains original five methods; generic configuration returns legal upgrade-required to old DTO callers; modern model/key/path persist and receipt lookup survives restart; directory root/Unicode/symlink/race/pagination fences; representative UI at 1280×800 and 900×800, keyboard/Escape/focus, empty/error/offline/stale-target states. Local fixtures are not real Host or native installation acceptance. Original Host task owns unified installation and credential recovery.
