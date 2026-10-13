import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import fs, {
  linkSync,
  lstatSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createHostProviderCredentialOwner,
  HostProviderCredentialError,
} from "../host/provider-credentials";

const HOST_ID = "00000000-0000-4000-8000-000000000101";
const SECRET = "test-only-provider-key-never-use-for-network";
const KEY = Buffer.from("01234567890123456789012345678901");
let scratch: string | undefined;
let store: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (scratch)
    await (
      await import("node:fs/promises")
    ).rm(scratch, { recursive: true, force: true });
  scratch = undefined;
  store = undefined;
});

async function setup(options: { initialize?: boolean } = {}) {
  const uid = process.getuid?.();
  expect(uid).toBeGreaterThan(0);
  scratch = await (
    await import("node:fs/promises")
  ).mkdtemp(join(homedir(), `.mah-provider-credentials-${process.pid}-`));
  await (await import("node:fs/promises")).chmod(scratch, 0o700);
  store = join(scratch, "provider-store");
  await (await import("node:fs/promises")).mkdir(store, { mode: 0o700 });
  await (await import("node:fs/promises")).chmod(store, 0o700);
  const owner = createHostProviderCredentialOwner({
    hostId: HOST_ID,
    storePath: store,
    loadMasterKey: () => Buffer.from(KEY),
  });
  if (options.initialize !== false) await owner.initialize();
  return { owner, store };
}

function writeInput(
  mutationId: string,
  expectedRevision = 0,
  credential = SECRET,
) {
  return {
    providerId: "moonshot-coding" as const,
    credential,
    expectedRevision,
    mutationId,
  };
}

function expectCode(promise: Promise<unknown> | (() => unknown), code: string) {
  const result =
    typeof promise === "function" ? Promise.resolve().then(promise) : promise;
  return expect(result).rejects.toMatchObject({ code });
}

it("requires explicit initialization and never recreates a deleted encrypted store", async () => {
  const uninitialized = await setup({ initialize: false });
  expect(() => uninitialized.owner.inspect()).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_STORE_MISSING",
  );
  await expectCode(
    uninitialized.owner.write(writeInput("00000000-0000-4000-8000-000000000109")),
    "HOST_PROVIDER_CREDENTIAL_STORE_MISSING",
  );
  expect(() =>
    uninitialized.owner.receipt("00000000-0000-4000-8000-000000000109"),
  ).toThrowError("HOST_PROVIDER_CREDENTIAL_STORE_MISSING");
  expect(() => uninitialized.owner.readForExecution("moonshot-coding")).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_STORE_MISSING",
  );
  expect(await uninitialized.owner.initialize()).toEqual({
    providerId: "moonshot-coding",
    configured: false,
    revision: 0,
  });
  expect(await uninitialized.owner.initialize()).toEqual({
    providerId: "moonshot-coding",
    configured: false,
    revision: 0,
  });

  const { owner, store } = await setup();
  const mutationId = "00000000-0000-4000-8000-000000000110";
  await owner.write(writeInput(mutationId));
  unlinkSync(join(store, "credentials.enc"));
  expect(() => owner.inspect()).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_STORE_MISSING",
  );
  await expectCode(
    owner.write(writeInput(mutationId, 0, `${SECRET}-different`)),
    "HOST_PROVIDER_CREDENTIAL_STORE_MISSING",
  );
  expect(() => owner.receipt(mutationId)).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_STORE_MISSING",
  );
  expect(() => owner.readForExecution("moonshot-coding")).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_STORE_MISSING",
  );
  expect(() => owner.inspect()).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_STORE_MISSING",
  );
  expect(() => owner.receipt(mutationId)).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_STORE_MISSING",
  );
  expect(() => owner.readForExecution("moonshot-coding")).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_STORE_MISSING",
  );
  await expectCode(
    owner.write(writeInput(mutationId)),
    "HOST_PROVIDER_CREDENTIAL_STORE_MISSING",
  );
});

it("AES-GCM encrypts credentials, survives owner recreation, and only exposes the execution projection", async () => {
  const { owner, store } = await setup();
  expect(owner.inspect()).toEqual({
    providerId: "moonshot-coding",
    configured: false,
    revision: 0,
  });
  const mutationId = "00000000-0000-4000-8000-000000000111";
  const receipt = await owner.write(writeInput(mutationId));
  expect(receipt).toEqual({
    mutationId,
    status: "persisted",
    revision: 1,
    effect: "new-session",
  });
  expect(owner.inspect()).toEqual({
    providerId: "moonshot-coding",
    configured: true,
    revision: 1,
  });
  expect(owner.readForExecution("moonshot-coding")).toBe(SECRET);
  const bytes = await (
    await import("node:fs/promises")
  ).readFile(join(store, "credentials.enc"));
  expect(bytes.includes(Buffer.from(SECRET))).toBe(false);
  const restarted = createHostProviderCredentialOwner({
    hostId: HOST_ID,
    storePath: store,
    loadMasterKey: () => Buffer.from(KEY),
  });
  expect(restarted.inspect()).toEqual({
    providerId: "moonshot-coding",
    configured: true,
    revision: 1,
  });
  expect(restarted.receipt(mutationId)).toEqual(receipt);
  expect(restarted.readForExecution("moonshot-coding")).toBe(SECRET);
  expect(await restarted.initialize()).toEqual({
    providerId: "moonshot-coding",
    configured: true,
    revision: 1,
  });
  const stat = lstatSync(join(store, "credentials.enc"));
  expect(stat.uid).toBe(process.getuid?.());
  expect(stat.nlink).toBe(1);
  expect(stat.mode & 0o7777).toBe(0o600);
});

it("enforces CAS, idempotent receipt recovery, mutation binding, and conflict receipts", async () => {
  const { owner } = await setup();
  const firstId = "00000000-0000-4000-8000-000000000121";
  const first = await owner.write(writeInput(firstId));
  expect(await owner.write(writeInput(firstId))).toEqual(first);
  await expectCode(
    owner.write(writeInput(firstId, 0, `${SECRET}-different`)),
    "HOST_PROVIDER_CREDENTIAL_MUTATION_MISMATCH",
  );
  const conflictId = "00000000-0000-4000-8000-000000000122";
  const conflict = await owner.write(writeInput(conflictId));
  expect(conflict).toEqual({
    mutationId: conflictId,
    status: "conflict",
    revision: 1,
    effect: "none",
  });
  expect(owner.receipt(conflictId)).toEqual(conflict);
  expect(await owner.write(writeInput(conflictId))).toEqual(conflict);
  expect(owner.inspect().revision).toBe(1);
});

it("fails closed for wrong master key, host binding, corrupt envelope, and unsafe directory or file", async () => {
  const { owner, store } = await setup();
  await owner.write(writeInput("00000000-0000-4000-8000-000000000131"));
  const wrongKey = createHostProviderCredentialOwner({
    hostId: HOST_ID,
    storePath: store,
    loadMasterKey: () => Buffer.alloc(32, 0x58),
  });
  expect(() => wrongKey.inspect()).toThrowError(HostProviderCredentialError);
  expect(() => wrongKey.inspect()).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_STORE_INVALID",
  );
  const wrongHost = createHostProviderCredentialOwner({
    hostId: "00000000-0000-4000-8000-000000000102",
    storePath: store,
    loadMasterKey: () => Buffer.from(KEY),
  });
  expect(() => wrongHost.inspect()).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_STORE_INVALID",
  );

  const file = join(store, "credentials.enc");
  const original = await (await import("node:fs/promises")).readFile(file);
  writeFileSync(file, '{"broken":true}', { mode: 0o600 });
  expect(() => owner.inspect()).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_STORE_INVALID",
  );
  writeFileSync(file, original, { mode: 0o600 });
  chmodSync(file, 0o640);
  expect(() => owner.inspect()).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE",
  );
  chmodSync(file, 0o600);

  const hardlink = join(store, "extra-link");
  linkSync(file, hardlink);
  expect(() => owner.inspect()).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE",
  );
  unlinkSync(hardlink);

  chmodSync(store, 0o750);
  expect(() => owner.inspect()).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_PATH_UNSAFE",
  );
  chmodSync(store, 0o700);
  const alias = join(scratch!, "store-alias");
  symlinkSync(store, alias);
  expect(() =>
    createHostProviderCredentialOwner({
      hostId: HOST_ID,
      storePath: alias,
      loadMasterKey: () => Buffer.from(KEY),
    }),
  ).toThrowError("HOST_PROVIDER_CREDENTIAL_PATH_UNSAFE");

  const backup = join(store, "saved.enc");
  renameSync(file, backup);
  symlinkSync(backup, file);
  expect(() => owner.inspect()).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE",
  );
  unlinkSync(file);
  renameSync(backup, file);

  unlinkSync(file);
  execFileSync("mkfifo", [file]);
  expect(() => owner.inspect()).toThrowError(
    "HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE",
  );
});

it("returns an unknown result after commit-time directory fsync failure and allows original receipt lookup", async () => {
  const { owner } = await setup();
  const id = "00000000-0000-4000-8000-000000000141";
  const originalSync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = (fd: number) => {
    if (fs.fstatSync(fd).isDirectory()) {
      injected = true;
      throw new Error("private injected fsync detail");
    }
    return originalSync(fd);
  };
  syncBuiltinESMExports();
  let caught: unknown;
  try {
    await owner.write(writeInput(id));
  } catch (error) {
    caught = error;
  } finally {
    fs.fsyncSync = originalSync;
    syncBuiltinESMExports();
  }
  expect(injected).toBe(true);
  expect(caught).toBeInstanceOf(HostProviderCredentialError);
  expect((caught as HostProviderCredentialError).code).toBe(
    "HOST_MANAGEMENT_UNCONFIRMED",
  );
  expect((caught as Error).message).toBe("HOST_MANAGEMENT_UNCONFIRMED");
  expect(owner.receipt(id)).toEqual({
    mutationId: id,
    status: "persisted",
    revision: 1,
    effect: "new-session",
  });
  expect(owner.readForExecution("moonshot-coding")).toBe(SECRET);
});

it("zeroes each supplied master-key buffer and refuses a preplanted temporary symlink", async () => {
  const { store } = await setup();
  const supplied: Buffer[] = [];
  const owner = createHostProviderCredentialOwner({
    hostId: HOST_ID,
    storePath: store,
    loadMasterKey: () => {
      const key = Buffer.from(KEY);
      supplied.push(key);
      return key;
    },
  });
  owner.inspect();
  expect(supplied[0]?.every((byte) => byte === 0)).toBe(true);

  const target = join(scratch!, "must-not-change");
  writeFileSync(target, "sentinel");
  const predictedTemp = join(
    store,
    `.credentials.${Buffer.alloc(16, 2).toString("hex")}.tmp`,
  );
  symlinkSync(target, predictedTemp);
  const originalRandomBytes = crypto.randomBytes;
  crypto.randomBytes = ((size: number) =>
    Buffer.alloc(size, size === 12 ? 1 : 2)) as typeof crypto.randomBytes;
  syncBuiltinESMExports();
  const id = "00000000-0000-4000-8000-000000000151";
  try {
    await expectCode(
      owner.write(writeInput(id)),
      "HOST_MANAGEMENT_UNCONFIRMED",
    );
  } finally {
    crypto.randomBytes = originalRandomBytes;
    syncBuiltinESMExports();
    unlinkSync(predictedTemp);
  }
  expect(
    await (await import("node:fs/promises")).readFile(target, "utf8"),
  ).toBe("sentinel");
  expect(owner.inspect()).toEqual({
    providerId: "moonshot-coding",
    configured: false,
    revision: 0,
  });
  expect(owner.receipt(id)).toEqual({ mutationId: id, status: "not-found" });
  expect(supplied.every((key) => key.every((byte) => byte === 0))).toBe(true);
});

it('encrypts provider-bound independent credentials and preserves original Kimi receipts across owner restart', async () => {
  const {owner,store}=await setup();
  const kimi=await owner.write(writeInput('00000000-0000-4000-8000-000000000111'));
  const input={...writeInput('00000000-0000-4000-8000-000000000112'),providerId:'portable/provider'.replace('/','-'),credential:'portable-test-key'};
  const portable=await owner.write(input);
  expect(owner.inspect(input.providerId)).toEqual({providerId:input.providerId,configured:true,revision:1});
  expect(owner.readForExecution('moonshot-coding')).toBe(SECRET);expect(owner.readForExecution(input.providerId)).toBe(input.credential);
  expect(owner.inspect('constructor')).toEqual({providerId:'constructor',configured:false,revision:0});
  expect(owner.inspect('unconfigured')).toEqual({providerId:'unconfigured',configured:false,revision:0});
  expect(owner.receipt(input.mutationId,'other')).toMatchObject({status:'not-found'});
  const disk=fs.readFileSync(join(store,'credentials.enc'),'utf8');expect(disk).not.toContain(input.credential);expect(disk).not.toContain(SECRET);
  const restarted=createHostProviderCredentialOwner({hostId:HOST_ID,storePath:store,loadMasterKey:()=>Buffer.from(KEY)});
  expect(restarted.receipt(kimi.mutationId)).toEqual(kimi);expect(restarted.receipt(input.mutationId,input.providerId)).toEqual(portable);
  expect(await restarted.write(input)).toEqual(portable);
  await expect(restarted.write({...input,credential:'different'})).rejects.toMatchObject({code:'HOST_PROVIDER_CREDENTIAL_MUTATION_MISMATCH'});
  const conflict=await restarted.write({...input,mutationId:'00000000-0000-4000-8000-000000000113'});expect(conflict.status).toBe('conflict');
  expect(restarted.readForExecution(input.providerId)).toBe(input.credential);
  await restarted.write(writeInput('00000000-0000-4000-8000-000000000114',1,'new-kimi-test-key'));
  expect(restarted.readForExecution(input.providerId)).toBe(input.credential);
  vi.stubEnv('MYAGENTS_HOST_MODE','1');
  const {installHostSessionCredential}=await import('./utils/host-credentials');
  const {materializeProviderRouteEnv}=await import('./utils/admin-config');
  const {createConcreteProviderRoute}=await import('../shared/providerRoute');
  installHostSessionCredential(restarted.readForExecution(input.providerId),input.providerId);
  const profile={id:input.providerId,name:'Portable fixture',apiProtocol:'openai',baseUrl:'https://api.example.test/v1',authType:'auth_token_clear_api_key'};
  const config={hostProviderProfiles:{[input.providerId]:profile},hostSettings:{providerId:input.providerId,model:'vendor/model'},providerApiKeys:{[input.providerId]:`host-provider-credential:${input.providerId}`}};
  expect(materializeProviderRouteEnv(createConcreteProviderRoute(input.providerId,'vendor/model'),config)).toMatchObject({providerId:input.providerId,baseUrl:profile.baseUrl,apiProtocol:'openai',apiKey:input.credential,authType:'auth_token_clear_api_key'});
});
