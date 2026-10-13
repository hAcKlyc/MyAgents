import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { link, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const PROVIDER = "moonshot-coding" as const;
const FILE_NAME = "credentials.enc";
const DOMAIN = "myagents-host-provider-credentials";
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_RECEIPTS = 256;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class HostProviderCredentialError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HostProviderCredentialError";
  }
}

export type ProviderCredentialReceipt = {
  mutationId: string;
  status: "persisted" | "conflict";
  revision: number;
  effect: "new-session" | "none";
};

export type ProviderCredentialInput = {
  providerId: typeof PROVIDER;
  credential: string;
  expectedRevision: number;
  mutationId: string;
};

type ReceiptEntry = { requestMac: string; receipt: ProviderCredentialReceipt };
type StoreState = {
  version: 1;
  revision: number;
  credential: string | null;
  receipts: ReceiptEntry[];
};
type Envelope = {
  version: 1;
  hostId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};
type FileIdentity = { dev: number; ino: number };
type ReadResult = { state: StoreState; identity: FileIdentity | null };

function fail(code: string): never {
  throw new HostProviderCredentialError(code);
}
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, expected: string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const safeRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function validateId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !UUID.test(value) ||
    value !== value.toLowerCase()
  )
    fail("HOST_PROVIDER_CREDENTIAL_REQUEST_INVALID");
  return value;
}

function validateProvider(value: unknown): asserts value is typeof PROVIDER {
  if (value !== PROVIDER) fail("HOST_PROVIDER_CREDENTIAL_PROVIDER_UNSUPPORTED");
}

function validateCredential(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_BYTES ||
    value.trim().length === 0
  ) {
    fail("HOST_PROVIDER_CREDENTIAL_REQUEST_INVALID");
  }
}

function emptyState(): StoreState {
  return { version: 1, revision: 0, credential: null, receipts: [] };
}

function validateState(value: unknown): StoreState {
  if (
    !plain(value) ||
    !exactKeys(value, ["version", "revision", "credential", "receipts"]) ||
    value.version !== 1 ||
    !safeRevision(value.revision) ||
    !(value.credential === null || typeof value.credential === "string") ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > MAX_RECEIPTS
  )
    fail("HOST_PROVIDER_CREDENTIAL_STORE_INVALID");
  if (value.credential !== null) validateCredential(value.credential);
  if ((value.revision === 0) !== (value.credential === null))
    fail("HOST_PROVIDER_CREDENTIAL_STORE_INVALID");
  const ids = new Set<string>();
  const persistedRevisions = new Set<number>();
  for (const entry of value.receipts) {
    if (
      !plain(entry) ||
      !exactKeys(entry, ["requestMac", "receipt"]) ||
      typeof entry.requestMac !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.requestMac) ||
      !plain(entry.receipt) ||
      !exactKeys(entry.receipt, ["mutationId", "status", "revision", "effect"])
    )
      fail("HOST_PROVIDER_CREDENTIAL_STORE_INVALID");
    const receipt = entry.receipt;
    if (
      typeof receipt.mutationId !== "string" ||
      !UUID.test(receipt.mutationId) ||
      receipt.mutationId !== receipt.mutationId.toLowerCase() ||
      ids.has(receipt.mutationId) ||
      !safeRevision(receipt.revision) ||
      (receipt.status !== "persisted" && receipt.status !== "conflict")
    )
      fail("HOST_PROVIDER_CREDENTIAL_STORE_INVALID");
    if (receipt.status === "persisted") {
      if (
        receipt.revision < 1 ||
        receipt.revision > value.revision ||
        receipt.effect !== "new-session" ||
        persistedRevisions.has(receipt.revision)
      )
        fail("HOST_PROVIDER_CREDENTIAL_STORE_INVALID");
      persistedRevisions.add(receipt.revision);
    } else if (receipt.revision > value.revision || receipt.effect !== "none")
      fail("HOST_PROVIDER_CREDENTIAL_STORE_INVALID");
    ids.add(receipt.mutationId);
  }
  if (
    value.revision > MAX_RECEIPTS ||
    persistedRevisions.size !== value.revision
  )
    fail("HOST_PROVIDER_CREDENTIAL_STORE_INVALID");
  return value as unknown as StoreState;
}

function validateEnvelope(value: unknown, hostId: string): Envelope {
  if (
    !plain(value) ||
    !exactKeys(value, ["version", "hostId", "nonce", "ciphertext", "tag"]) ||
    value.version !== 1 ||
    value.hostId !== hostId ||
    typeof value.nonce !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.tag !== "string" ||
    !BASE64.test(value.nonce) ||
    !BASE64.test(value.ciphertext) ||
    !BASE64.test(value.tag)
  )
    fail("HOST_PROVIDER_CREDENTIAL_STORE_INVALID");
  const nonce = Buffer.from(value.nonce, "base64");
  const ciphertext = Buffer.from(value.ciphertext, "base64");
  const tag = Buffer.from(value.tag, "base64");
  if (
    nonce.length !== 12 ||
    ciphertext.length === 0 ||
    ciphertext.length > MAX_FILE_BYTES ||
    tag.length !== 16 ||
    nonce.toString("base64") !== value.nonce ||
    ciphertext.toString("base64") !== value.ciphertext ||
    tag.toString("base64") !== value.tag
  )
    fail("HOST_PROVIDER_CREDENTIAL_STORE_INVALID");
  return value as unknown as Envelope;
}

function aad(hostId: string): Buffer {
  return Buffer.from(`${DOMAIN}\0v1\0${hostId}\0${PROVIDER}`, "utf8");
}

function encryptState(state: StoreState, hostId: string, key: Buffer): Buffer {
  const plaintext = Buffer.from(JSON.stringify(state), "utf8");
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(hostId));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      version: 1,
      hostId,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    const encoded = Buffer.from(JSON.stringify(envelope), "utf8");
    if (encoded.length > MAX_FILE_BYTES)
      fail("HOST_PROVIDER_CREDENTIAL_STORE_FULL");
    return encoded;
  } finally {
    plaintext.fill(0);
    nonce.fill(0);
  }
}

function decryptState(bytes: Buffer, hostId: string, key: Buffer): StoreState {
  let plaintext: Buffer | undefined;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const envelope = validateEnvelope(JSON.parse(decoded), hostId);
    const nonce = Buffer.from(envelope.nonce, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad(hostId));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const state = validateState(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
    );
    nonce.fill(0);
    ciphertext.fill(0);
    tag.fill(0);
    return state;
  } catch (error) {
    if (error instanceof HostProviderCredentialError) throw error;
    return fail("HOST_PROVIDER_CREDENTIAL_STORE_INVALID");
  } finally {
    plaintext?.fill(0);
  }
}

function requestMac(
  input: ProviderCredentialInput,
  hostId: string,
  key: Buffer,
): string {
  return createHmac("sha256", key)
    .update(
      `${DOMAIN}\0request-v1\0${hostId}\0${input.providerId}\0${input.expectedRevision}\0${input.mutationId}\0`,
      "utf8",
    )
    .update(input.credential, "utf8")
    .digest("hex");
}

function validateDirectory(storePath: string, uid: number) {
  if (
    !isAbsolute(storePath) ||
    resolve(storePath) !== storePath ||
    storePath.includes("\0") ||
    storePath === "/"
  )
    fail("HOST_PROVIDER_CREDENTIAL_PATH_UNSAFE");
  const parts = storePath.split("/").filter(Boolean);
  let current = "/";
  let finalInfo;
  for (let index = 0; index < parts.length; index++) {
    current =
      current === "/" ? `/${parts[index]}` : `${current}/${parts[index]}`;
    let info;
    try {
      info = lstatSync(current);
    } catch {
      fail("HOST_PROVIDER_CREDENTIAL_PATH_UNSAFE");
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      realpathSync(current) !== current ||
      (info.uid !== 0 && info.uid !== uid) ||
      (info.mode & 0o022) !== 0 ||
      (info.mode & 0o7000) !== 0
    )
      fail("HOST_PROVIDER_CREDENTIAL_PATH_UNSAFE");
    if (
      index === parts.length - 1 &&
      (info.uid !== uid || (info.mode & 0o7777) !== 0o700)
    )
      fail("HOST_PROVIDER_CREDENTIAL_PATH_UNSAFE");
    finalInfo = info;
  }
  let fd: number;
  try {
    fd = openSync(
      storePath,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
    );
  } catch {
    fail("HOST_PROVIDER_CREDENTIAL_PATH_UNSAFE");
  }
  const pinned = fstatSync(fd);
  if (
    !finalInfo ||
    pinned.dev !== finalInfo.dev ||
    pinned.ino !== finalInfo.ino ||
    pinned.uid !== uid ||
    (pinned.mode & 0o7777) !== 0o700
  ) {
    closeSync(fd);
    fail("HOST_PROVIDER_CREDENTIAL_PATH_UNSAFE");
  }
  return {
    fd,
    identity: { dev: pinned.dev, ino: pinned.ino },
    path: process.platform === "linux" ? `/proc/self/fd/${fd}` : storePath,
  };
}

function verifyDirectory(
  storePath: string,
  uid: number,
  directory: ReturnType<typeof validateDirectory>,
): void {
  try {
    const current = lstatSync(storePath);
    const pinned = fstatSync(directory.fd);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      realpathSync(storePath) !== storePath ||
      current.uid !== uid ||
      (current.mode & 0o7777) !== 0o700 ||
      current.dev !== directory.identity.dev ||
      current.ino !== directory.identity.ino ||
      pinned.dev !== directory.identity.dev ||
      pinned.ino !== directory.identity.ino
    )
      fail("HOST_PROVIDER_CREDENTIAL_PATH_CHANGED");
  } catch (error) {
    if (error instanceof HostProviderCredentialError) throw error;
    fail("HOST_PROVIDER_CREDENTIAL_PATH_CHANGED");
  }
}

function readFileStateOptional(
  storePath: string,
  hostId: string,
  uid: number,
  key: Buffer,
): ReadResult | undefined {
  const directory = validateDirectory(storePath, uid);
  try {
    const path = join(directory.path, FILE_NAME);
    let before;
    try {
      before = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return undefined;
      fail("HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE");
    }
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.uid !== uid ||
      (before.mode & 0o7777) !== 0o600 ||
      before.nlink !== 1 ||
      before.size < 2 ||
      before.size > MAX_FILE_BYTES
    )
      fail("HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE");
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      fail("HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE");
    }
    try {
      const pinned = fstatSync(fd);
      const current = lstatSync(path);
      if (
        !pinned.isFile() ||
        pinned.uid !== uid ||
        (pinned.mode & 0o7777) !== 0o600 ||
        pinned.nlink !== 1 ||
        pinned.size < 2 ||
        pinned.size > MAX_FILE_BYTES ||
        current.isSymbolicLink() ||
        current.dev !== pinned.dev ||
        current.ino !== pinned.ino
      )
        fail("HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE");
      const bytes = Buffer.alloc(pinned.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, null);
        if (count === 0) break;
        offset += count;
      }
      if (offset !== pinned.size) fail("HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE");
      verifyDirectory(storePath, uid, directory);
      return {
        state: decryptState(bytes.subarray(0, offset), hostId, key),
        identity: { dev: pinned.dev, ino: pinned.ino },
      };
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(directory.fd);
  }
}

function readFileState(
  storePath: string,
  hostId: string,
  uid: number,
  key: Buffer,
): ReadResult {
  const result = readFileStateOptional(storePath, hostId, uid, key);
  if (!result) fail("HOST_PROVIDER_CREDENTIAL_STORE_MISSING");
  return result;
}

async function persistState(
  storePath: string,
  hostId: string,
  uid: number,
  state: StoreState,
  expectedIdentity: FileIdentity | null,
  key: Buffer,
  exclusiveCreate = false,
): Promise<void> {
  const directory = validateDirectory(storePath, uid);
  const tempName = `.credentials.${randomBytes(16).toString("hex")}.tmp`;
  const tempPath = join(directory.path, tempName);
  const destPath = join(directory.path, FILE_NAME);
  let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
  let tempIdentity: FileIdentity | undefined;
  let published = false;
  let payload: Buffer | undefined;
  try {
    verifyDirectory(storePath, uid, directory);
    let currentIdentity: FileIdentity | null = null;
    try {
      const current = lstatSync(destPath);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.uid !== uid ||
        (current.mode & 0o7777) !== 0o600 ||
        current.nlink !== 1 ||
        current.size < 2 ||
        current.size > MAX_FILE_BYTES
      )
        fail("HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE");
      currentIdentity = { dev: current.dev, ino: current.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      (expectedIdentity === null) !== (currentIdentity === null) ||
      (expectedIdentity &&
        currentIdentity &&
        (expectedIdentity.dev !== currentIdentity.dev ||
          expectedIdentity.ino !== currentIdentity.ino))
    ) {
      fail("HOST_PROVIDER_CREDENTIAL_STORE_CHANGED");
    }
    if (exclusiveCreate && expectedIdentity !== null)
      fail("HOST_PROVIDER_CREDENTIAL_STORE_CHANGED");
    payload = encryptState(state, hostId, key);
    tempHandle = await open(
      tempPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    const tempStat = await tempHandle.stat();
    if (
      !tempStat.isFile() ||
      tempStat.uid !== uid ||
      (tempStat.mode & 0o777) !== 0o600 ||
      tempStat.nlink !== 1
    )
      fail("HOST_PROVIDER_CREDENTIAL_TEMP_UNSAFE");
    tempIdentity = { dev: tempStat.dev, ino: tempStat.ino };
    await tempHandle.writeFile(payload);
    await tempHandle.sync();
    const afterWrite = await tempHandle.stat();
    if (
      afterWrite.dev !== tempIdentity.dev ||
      afterWrite.ino !== tempIdentity.ino ||
      afterWrite.size !== payload.length ||
      afterWrite.size > MAX_FILE_BYTES ||
      afterWrite.nlink !== 1
    )
      fail("HOST_PROVIDER_CREDENTIAL_TEMP_UNSAFE");
    verifyDirectory(storePath, uid, directory);
    let latest: FileIdentity | null = null;
    try {
      const info = lstatSync(destPath);
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        info.uid !== uid ||
        (info.mode & 0o7777) !== 0o600 ||
        info.nlink !== 1 ||
        info.size < 2 ||
        info.size > MAX_FILE_BYTES
      )
        fail("HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE");
      latest = { dev: info.dev, ino: info.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      (expectedIdentity === null) !== (latest === null) ||
      (expectedIdentity &&
        latest &&
        (expectedIdentity.dev !== latest.dev ||
          expectedIdentity.ino !== latest.ino))
    )
      fail("HOST_PROVIDER_CREDENTIAL_STORE_CHANGED");
    await tempHandle.close();
    tempHandle = undefined;
    if (exclusiveCreate) {
      await link(tempPath, destPath);
      published = true;
      await unlink(tempPath);
    } else {
      await rename(tempPath, destPath);
      published = true;
    }
    const installed = lstatSync(destPath);
    if (
      installed.isSymbolicLink() ||
      !installed.isFile() ||
      installed.uid !== uid ||
      (installed.mode & 0o7777) !== 0o600 ||
      installed.nlink !== 1 ||
      installed.size !== payload.length ||
      installed.size > MAX_FILE_BYTES ||
      (tempIdentity &&
        (installed.dev !== tempIdentity.dev ||
          installed.ino !== tempIdentity.ino))
    )
      fail("HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE");
    verifyDirectory(storePath, uid, directory);
    const check = await open(
      destPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const checked = await check.stat();
      if (
        checked.dev !== installed.dev ||
        checked.ino !== installed.ino ||
        checked.size !== payload.length
      )
        fail("HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE");
      const bytes = await check.readFile();
      if (!bytes.equals(payload)) fail("HOST_PROVIDER_CREDENTIAL_FILE_UNSAFE");
    } finally {
      await check.close();
    }
    // Sync the pinned directory itself. On Linux directory.path is the
    // /proc/self/fd projection, whose final symlink cannot be reopened with
    // O_NOFOLLOW; reopening also adds an unnecessary authority transition.
    const dirStat = fstatSync(directory.fd);
    if (
      !dirStat.isDirectory() ||
      dirStat.dev !== directory.identity.dev ||
      dirStat.ino !== directory.identity.ino ||
      dirStat.uid !== uid ||
      (dirStat.mode & 0o7777) !== 0o700
    )
      fail("HOST_PROVIDER_CREDENTIAL_PATH_CHANGED");
    fsyncSync(directory.fd);
  } catch (error) {
    if (tempHandle) await tempHandle.close().catch(() => {});
    try {
      const info = lstatSync(tempPath);
      if (
        !info.isSymbolicLink() &&
        info.isFile() &&
        info.uid === uid &&
        (!tempIdentity ||
          (info.dev === tempIdentity.dev && info.ino === tempIdentity.ino))
      )
        await unlink(tempPath);
    } catch {
      /* fixed-code cleanup only */
    }
    if (error instanceof HostProviderCredentialError && !published) throw error;
    fail("HOST_MANAGEMENT_UNCONFIRMED");
  } finally {
    payload?.fill(0);
    closeSync(directory.fd);
  }
}

function loadKey(loader: () => Buffer): Buffer {
  let key: Buffer | undefined;
  try {
    key = loader();
  } catch {
    fail("HOST_PROVIDER_CREDENTIAL_KEY_UNAVAILABLE");
  }
  if (!Buffer.isBuffer(key)) fail("HOST_PROVIDER_CREDENTIAL_KEY_INVALID");
  if (key.length !== 32) {
    key.fill(0);
    fail("HOST_PROVIDER_CREDENTIAL_KEY_INVALID");
  }
  return key;
}

export function createHostProviderCredentialOwner(input: {
  hostId: string;
  storePath: string;
  loadMasterKey: () => Buffer;
}) {
  const hostId = validateId(input.hostId);
  const storePath = input.storePath;
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid <= 0) fail("HOST_PROVIDER_CREDENTIAL_OWNER_UNSUPPORTED");
  const directory = validateDirectory(storePath, uid);
  closeSync(directory.fd); // Validate before retaining configuration; no store directory is created implicitly.
  const readWithKey = (key: Buffer) =>
    readFileState(storePath, hostId, uid, key);
  const readOptionalWithKey = (key: Buffer) =>
    readFileStateOptional(storePath, hostId, uid, key);
  // The Host must call write under its existing exclusive mutation lock; this
  // owner intentionally does not claim to provide cross-process locking.
  const withKey = <T>(operation: (key: Buffer) => T): T => {
    const key = loadKey(input.loadMasterKey);
    try {
      return operation(key);
    } finally {
      key.fill(0);
    }
  };

  return {
    async initialize(): Promise<{
      providerId: typeof PROVIDER;
      configured: boolean;
      revision: number;
    }> {
      const key = loadKey(input.loadMasterKey);
      try {
        const current = readOptionalWithKey(key);
        if (!current) {
          try {
            await persistState(
              storePath,
              hostId,
              uid,
              emptyState(),
              null,
              key,
              true,
            );
          } catch {
            fail("HOST_MANAGEMENT_UNCONFIRMED");
          }
        }
        const state = current?.state ?? emptyState();
        return {
          providerId: PROVIDER,
          configured: state.credential !== null,
          revision: state.revision,
        };
      } finally {
        key.fill(0);
      }
    },
    inspect(): {
      providerId: typeof PROVIDER;
      configured: boolean;
      revision: number;
    } {
      return withKey((key) => {
        const state = readWithKey(key).state;
        return {
          providerId: PROVIDER,
          configured: state.credential !== null,
          revision: state.revision,
        };
      });
    },
    async write(
      raw: ProviderCredentialInput,
    ): Promise<ProviderCredentialReceipt> {
      if (
        !plain(raw) ||
        !exactKeys(raw, [
          "providerId",
          "credential",
          "expectedRevision",
          "mutationId",
        ])
      )
        fail("HOST_PROVIDER_CREDENTIAL_REQUEST_INVALID");
      validateProvider(raw.providerId);
      validateCredential(raw.credential);
      if (
        !safeRevision(raw.expectedRevision) ||
        raw.expectedRevision === Number.MAX_SAFE_INTEGER
      )
        fail("HOST_PROVIDER_CREDENTIAL_REQUEST_INVALID");
      const mutationId = validateId(raw.mutationId);
      const request = {
        providerId: PROVIDER,
        credential: raw.credential,
        expectedRevision: raw.expectedRevision,
        mutationId,
      };
      const key = loadKey(input.loadMasterKey);
      try {
        const current = readWithKey(key);
        const mac = requestMac(request, hostId, key);
        const prior = current.state.receipts.find(
          (entry) => entry.receipt.mutationId === mutationId,
        );
        if (prior) {
          const same = timingSafeEqual(
            Buffer.from(prior.requestMac, "hex"),
            Buffer.from(mac, "hex"),
          );
          if (!same) fail("HOST_PROVIDER_CREDENTIAL_MUTATION_MISMATCH");
          return structuredClone(prior.receipt);
        }
        if (current.state.receipts.length >= MAX_RECEIPTS)
          fail("HOST_PROVIDER_CREDENTIAL_RECEIPTS_FULL");
        let state: StoreState;
        let receipt: ProviderCredentialReceipt;
        if (raw.expectedRevision !== current.state.revision) {
          receipt = {
            mutationId,
            status: "conflict",
            revision: current.state.revision,
            effect: "none",
          };
          state = {
            ...current.state,
            receipts: [...current.state.receipts, { requestMac: mac, receipt }],
          };
        } else {
          const revision = current.state.revision + 1;
          receipt = {
            mutationId,
            status: "persisted",
            revision,
            effect: "new-session",
          };
          state = {
            version: 1,
            revision,
            credential: raw.credential,
            receipts: [...current.state.receipts, { requestMac: mac, receipt }],
          };
        }
        await persistState(
          storePath,
          hostId,
          uid,
          state,
          current.identity,
          key,
        );
        return structuredClone(receipt);
      } finally {
        key.fill(0);
      }
    },
    receipt(
      mutation: string,
    ): ProviderCredentialReceipt | { mutationId: string; status: "not-found" } {
      const mutationId = validateId(mutation);
      return withKey((key) => {
        const state = readWithKey(key).state;
        const found = state.receipts.find(
          (entry) => entry.receipt.mutationId === mutationId,
        )?.receipt;
        return found
          ? structuredClone(found)
          : { mutationId, status: "not-found" as const };
      });
    },
    readForExecution(provider: typeof PROVIDER): string | undefined {
      validateProvider(provider);
      return withKey((key) => readWithKey(key).state.credential ?? undefined);
    },
  };
}
