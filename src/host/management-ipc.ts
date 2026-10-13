import { isHostProviderId, isHostModelId, isHostProviderProfile, isHostRelativePath, isHostWorkspaceSelection } from '../shared/hostProviderConfig';
import { createConnection, type Socket } from "node:net";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { HostConfigError, HostManagementUpgradeRequired } from "./management";
import { HostProviderCredentialError } from "./provider-credentials";

const MAX_FRAME = 64 * 1024;
const MAX_RECEIVE = 256 * 1024;
const MAX_QUEUED_REQUESTS = 16;
const MAX_OUTBOUND_BUFFER = 1024 * 1024;
const WRITE_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 2_000;
const STARTUP_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METHODS = new Set([
  "host.snapshot",
  "config.set",
  "resources.create",
  "credential.set",
  "receipt.get",
  "host.capabilities", "host.inspect", "config.provider.set", "credential.provider.set", "receipt.provider.get", "resources.directory.list", "resources.register",
]);
type Request = {
  kind: "request";
  requestId: string;
  method: string;
  params: Record<string, unknown>;
};
type Dispatcher = (
  method: Request["method"],
  params: Record<string, unknown>,
) => Promise<unknown>;

class IpcError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}

function exactKeys(value: Record<string, unknown>, fields: string[]): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function validParams(method: string, params: Record<string, unknown>): boolean {
  if (method === 'host.capabilities' || method === 'host.inspect') return exactKeys(params, []);
  if (method === 'config.provider.set') return exactKeys(params,['provider','model','workspace','executionAuthorized','expectedRevision','mutationId']) && isHostProviderProfile(params.provider) && isHostModelId(params.model) && isHostWorkspaceSelection(params.workspace) && typeof params.executionAuthorized === 'boolean' && Number.isSafeInteger(params.expectedRevision) && Number(params.expectedRevision) >= 0 && typeof params.mutationId === 'string' && UUID.test(params.mutationId);
  if (method === 'receipt.provider.get') return exactKeys(params,['owner','providerId','mutationId']) && ['config','credentials'].includes(params.owner as string) && isHostProviderId(params.providerId) && typeof params.mutationId === 'string' && UUID.test(params.mutationId);
  if (method === 'resources.directory.list') return exactKeys(params,['rootId','relativePath',...(params.cursor === undefined ? [] : ['cursor'])]) && isHostWorkspaceSelection({rootId:params.rootId,relativePath:params.relativePath}) && (params.cursor === undefined || (typeof params.cursor === 'string' && params.cursor.length <= 1024));
  if (method === 'resources.register') return exactKeys(params,['rootId','relativePath','expectedRevision','mutationId']) && isHostWorkspaceSelection({rootId:params.rootId,relativePath:params.relativePath}) && isHostRelativePath(params.relativePath,false) && Number.isSafeInteger(params.expectedRevision) && Number(params.expectedRevision) >= 0 && typeof params.mutationId === 'string' && UUID.test(params.mutationId);
  if (method === "host.snapshot") return exactKeys(params, []);
  if (method === "credential.set" || method === "credential.provider.set") return (
    exactKeys(params, ['expectedRevision', 'providerId', 'credential', 'mutationId'])
    && Number.isSafeInteger(params.expectedRevision) && Number(params.expectedRevision) >= 0
    && (method === 'credential.set' ? params.providerId === 'moonshot-coding' : isHostProviderId(params.providerId))
    && typeof params.credential === 'string' && params.credential.trim().length > 0
    && Buffer.byteLength(params.credential, 'utf8') <= 16 * 1024 && !/[\r\n\0]/.test(params.credential)
    && typeof params.mutationId === 'string' && UUID.test(params.mutationId)
  );
  if (method === "config.set") {
    const fields = [
      "expectedRevision",
      "providerId",
      "model",
      "executionAuthorized",
      "mutationId",
    ];
    if (Object.hasOwn(params, "workspace")) fields.push("workspace");
    return (
      exactKeys(params, fields) &&
      Number.isSafeInteger(params.expectedRevision) &&
      Number(params.expectedRevision) >= 0 &&
      params.providerId === "moonshot-coding" &&
      typeof params.model === "string" &&
      /^[A-Za-z0-9._-]{1,128}$/.test(params.model) &&
      (params.workspace === undefined ||
        (typeof params.workspace === "string" &&
          params.workspace.length <= 4096 &&
          isAbsolute(params.workspace) &&
          resolve(params.workspace) === params.workspace)) &&
      typeof params.executionAuthorized === "boolean" &&
      typeof params.mutationId === "string" &&
      UUID.test(params.mutationId)
    );
  }
  if (method === "resources.create")
    return (
      exactKeys(params, [
        "rootId",
        "relativePath",
        "expectedRevision",
        "mutationId",
        "operation",
      ]) &&
      typeof params.rootId === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(params.rootId) &&
      typeof params.relativePath === "string" &&
      params.relativePath.length <= 1024 &&
      params.relativePath
        .split("/")
        .every(
          (piece) =>
            /^[A-Za-z0-9_.-]{1,128}$/.test(piece) &&
            piece !== "." &&
            piece !== "..",
        ) &&
      Number.isSafeInteger(params.expectedRevision) &&
      Number(params.expectedRevision) >= 0 &&
      typeof params.mutationId === "string" &&
      UUID.test(params.mutationId) &&
      (params.operation === "register" || params.operation === "create")
    );
  if (method === "receipt.get")
    return (
      exactKeys(params, ["mutationId", "owner"]) &&
      typeof params.mutationId === "string" &&
      UUID.test(params.mutationId) &&
      (params.owner === "config" || params.owner === "resources" || params.owner === "credentials")
    );
  return false;
}

function retryableFilesystemError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      ["ENOENT", "ENOTDIR"].includes(error.code),
  );
}

async function verifySocketPath(
  socketPath: string,
  uid: number,
  gid: number,
): Promise<void> {
  if (
    !isAbsolute(socketPath) ||
    resolve(socketPath) !== socketPath ||
    socketPath.includes("\0")
  ) {
    throw new IpcError("MANAGEMENT_IPC_UNSAFE_PATH");
  }
  let current = "/";
  for (const part of socketPath.split("/").filter(Boolean).slice(0, -1)) {
    current = current === "/" ? `/${part}` : `${current}/${part}`;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (retryableFilesystemError(error))
        throw new IpcError("MANAGEMENT_IPC_NOT_READY", true);
      throw new IpcError("MANAGEMENT_IPC_UNSAFE_PATH");
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o022) !== 0 ||
      (info.uid !== 0 && info.uid !== uid)
    )
      throw new IpcError("MANAGEMENT_IPC_UNSAFE_PATH");
    try {
      if ((await realpath(current)) !== current)
        throw new IpcError("MANAGEMENT_IPC_UNSAFE_PATH");
    } catch (error) {
      if (error instanceof IpcError) throw error;
      throw new IpcError("MANAGEMENT_IPC_UNSAFE_PATH");
    }
  }
  let parent;
  let target;
  try {
    parent = await lstat(dirname(socketPath));
  } catch (error) {
    if (retryableFilesystemError(error))
      throw new IpcError("MANAGEMENT_IPC_NOT_READY", true);
    throw new IpcError("MANAGEMENT_IPC_UNSAFE_PATH");
  }
  if (
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    parent.uid !== uid ||
    parent.gid !== gid ||
    (parent.mode & 0o777) !== 0o750
  ) {
    throw new IpcError("MANAGEMENT_IPC_UNSAFE_PATH");
  }
  try {
    target = await lstat(socketPath);
  } catch (error) {
    if (retryableFilesystemError(error))
      throw new IpcError("MANAGEMENT_IPC_NOT_READY", true);
    throw new IpcError("MANAGEMENT_IPC_UNSAFE_PATH");
  }
  if (
    !target.isSocket() ||
    target.isSymbolicLink() ||
    target.uid !== uid ||
    target.gid !== gid ||
    (target.mode & 0o777) !== 0o660
  )
    throw new IpcError("MANAGEMENT_IPC_UNSAFE_PATH");
}

function responseFrame(message: Record<string, unknown>): Buffer {
  let body: Buffer;
  try {
    body = Buffer.from(JSON.stringify(message));
  } catch {
    throw new IpcError("MANAGEMENT_IPC_RESPONSE_INVALID");
  }
  if (body.length === 0 || body.length > MAX_FRAME)
    throw new IpcError("MANAGEMENT_IPC_RESPONSE_SIZE");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

type ConnectionSession = {
  socket: Socket;
  connected: boolean;
  buffer: Buffer;
  receiveBytes: number;
};

async function connectOnce(
  socketPath: string,
  expectedUid: number,
  expectedGid: number,
): Promise<Socket> {
  await verifySocketPath(socketPath, expectedUid, expectedGid);
  const socket = createConnection({ path: socketPath });
  try {
    await new Promise<void>((resolveConnect, reject) => {
      const timer = setTimeout(
        () => finish(new IpcError("MANAGEMENT_IPC_NOT_READY", true)),
        CONNECT_TIMEOUT_MS,
      );
      const onError = (error: NodeJS.ErrnoException) =>
        finish(
          new IpcError(
            error.code &&
            ["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code)
              ? "MANAGEMENT_IPC_NOT_READY"
              : "MANAGEMENT_IPC_CONNECT_FAILED",
            Boolean(
              error.code &&
                ["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code),
            ),
          ),
        );
      const onConnect = () => finish();
      const finish = (error?: Error) => {
        clearTimeout(timer);
        socket.off("error", onError);
        socket.off("connect", onConnect);
        if (error) reject(error);
        else resolveConnect();
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
    await verifySocketPath(socketPath, expectedUid, expectedGid);
    return socket;
  } catch (error) {
    socket.destroy();
    if (error instanceof IpcError) throw error;
    if (retryableFilesystemError(error))
      throw new IpcError("MANAGEMENT_IPC_NOT_READY", true);
    throw new IpcError("MANAGEMENT_IPC_UNSAFE_PATH");
  }
}

export async function connectHostManagementIpc(options: {
  socketPath: string;
  expectedUid: number;
  expectedGid: number;
  dispatch: Dispatcher;
  isShuttingDown: () => boolean;
  onFailure?: (code: string) => void;
}): Promise<{ close(): Promise<void> }> {
  if (
    !Number.isSafeInteger(options.expectedUid) ||
    options.expectedUid <= 0 ||
    !Number.isSafeInteger(options.expectedGid) ||
    options.expectedGid <= 0
  )
    throw new IpcError("MANAGEMENT_IPC_INVALID_IDENTITY");

  let stopped = false;
  let current: ConnectionSession | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let retryWake: (() => void) | undefined;
  let reconnectTask: Promise<void> | undefined;
  let failures = 0;
  let connectedOnce = false;
  let terminal = false;
  let pendingRequests = 0;
  let dispatchTail: Promise<void> = Promise.resolve();
  const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;
  let settleInitial!: (error?: Error) => void;
  const initialConnection = new Promise<void>(
    (resolveInitial, rejectInitial) => {
      settleInitial = (error) =>
        error ? rejectInitial(error) : resolveInitial();
    },
  );
  const waitRetry = (delay: number) =>
    new Promise<void>((resolveWait) => {
      retryWake = resolveWait;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        retryWake = undefined;
        resolveWait();
      }, delay);
    });
  const closeSession = (session: ConnectionSession, reason?: Error) => {
    if (!session.connected) return;
    session.connected = false;
    session.buffer = Buffer.alloc(0);
    session.socket.destroy(reason);
    if (current === session) current = undefined;
    if (!stopped && !options.isShuttingDown()) scheduleReconnect();
  };
  const safeFailure = (code: string) => {
    try {
      options.onFailure?.(code);
    } catch {
      /* safe diagnostic only */
    }
  };
  const scheduleReconnect = () => {
    if (reconnectTask || stopped || terminal || options.isShuttingDown())
      return;
    reconnectTask = (async () => {
      while (!stopped && !options.isShuttingDown() && !current) {
        try {
          const socket = await connectOnce(
            options.socketPath,
            options.expectedUid,
            options.expectedGid,
          );
          if (stopped || options.isShuttingDown()) {
            socket.destroy();
            break;
          }
          const session: ConnectionSession = {
            socket,
            connected: true,
            buffer: Buffer.alloc(0),
            receiveBytes: 0,
          };
          current = session;
          failures = 0;
          connectedOnce = true;
          settleInitial();
          attachSession(session);
          return;
        } catch (error) {
          if (!(error instanceof IpcError) || !error.retryable) {
            terminal = true;
            safeFailure(
              error instanceof IpcError
                ? error.code
                : "MANAGEMENT_IPC_CONNECT_FAILED",
            );
            if (current) closeSession(current);
            if (!connectedOnce)
              settleInitial(
                error instanceof Error
                  ? error
                  : new IpcError("MANAGEMENT_IPC_CONNECT_FAILED"),
              );
            break;
          }
          failures++;
          if (!connectedOnce && Date.now() >= startupDeadline) {
            terminal = true;
            safeFailure("MANAGEMENT_IPC_START_TIMEOUT");
            settleInitial(new IpcError("MANAGEMENT_IPC_START_TIMEOUT"));
            break;
          }
          await waitRetry(
            Math.min(1000, failures <= 1 ? 100 : failures <= 3 ? 250 : 500),
          );
        }
      }
    })().finally(() => {
      reconnectTask = undefined;
      if (!current && !terminal && !stopped && !options.isShuttingDown())
        scheduleReconnect();
    });
  };
  const attachSession = (session: ConnectionSession) => {
    const send = async (message: Record<string, unknown>) => {
      if (!session.connected || session.socket.destroyed) return;
      const frame = responseFrame(message);
      if (session.socket.writableLength + frame.length > MAX_OUTBOUND_BUFFER) {
        closeSession(
          session,
          new IpcError("MANAGEMENT_IPC_WRITE_BUFFER_LIMIT"),
        );
        return;
      }
      if (session.socket.write(frame)) return;
      await new Promise<void>((resolveWrite, rejectWrite) => {
        const timer = setTimeout(
          () => finish(new IpcError("MANAGEMENT_IPC_WRITE_TIMEOUT")),
          WRITE_TIMEOUT_MS,
        );
        const onDrain = () => finish();
        const onClose = () =>
          finish(new IpcError("MANAGEMENT_IPC_DISCONNECTED"));
        const onError = () =>
          finish(new IpcError("MANAGEMENT_IPC_WRITE_FAILED"));
        const finish = (error?: Error) => {
          clearTimeout(timer);
          session.socket.off("drain", onDrain);
          session.socket.off("close", onClose);
          session.socket.off("error", onError);
          if (error) rejectWrite(error);
          else resolveWrite();
        };
        session.socket.once("drain", onDrain);
        session.socket.once("close", onClose);
        session.socket.once("error", onError);
      }).catch((error) =>
        closeSession(session, error instanceof Error ? error : undefined),
      );
    };
    const enqueue = (message: unknown) => {
      if (pendingRequests >= MAX_QUEUED_REQUESTS) {
        closeSession(session, new IpcError("MANAGEMENT_IPC_QUEUE_LIMIT"));
        return;
      }
      pendingRequests++;
      const task = dispatchTail
        .then(async () => {
          try {
            if (!session.connected || stopped || options.isShuttingDown())
              return;
            if (
              !plain(message) ||
              typeof message.requestId !== "string" ||
              !UUID.test(message.requestId)
            ) {
              closeSession(
                session,
                new IpcError("MANAGEMENT_IPC_INVALID_FRAME"),
              );
              return;
            }
            if (
              !exactKeys(message, ["kind", "requestId", "method", "params"]) ||
              message.kind !== "request" ||
              typeof message.method !== "string" ||
              !METHODS.has(message.method) ||
              !plain(message.params) ||
              !validParams(message.method, message.params)
            ) {
              await send({
                kind: "response",
                requestId: message.requestId,
                result: { kind: "error", code: "INVALID_REQUEST" },
              });
              return;
            }
            try {
              const result = await options.dispatch(
                message.method,
                message.params,
              );
              if (
                session.connected &&
                current === session &&
                !stopped &&
                !options.isShuttingDown()
              ) {
                await send({
                  kind: "response",
                  requestId: message.requestId,
                  result,
                });
              }
            } catch (error) {
              const code =
                error instanceof HostConfigError || error instanceof HostManagementUpgradeRequired || error instanceof HostProviderCredentialError
                  ? error.code
                  : "OWNER_OPERATION_FAILED";
              if (
                session.connected &&
                current === session &&
                !stopped &&
                !options.isShuttingDown()
              ) {
                await send({
                  kind: "response",
                  requestId: message.requestId,
                  result: { kind: "error", code },
                });
              }
            }
          } finally {
            pendingRequests--;
          }
        })
        .catch(() =>
          closeSession(session, new IpcError("MANAGEMENT_IPC_DISPATCH_FAILED")),
        );
      dispatchTail = task.then(
        () => undefined,
        () => undefined,
      );
    };
    session.socket.on("close", () => closeSession(session));
    session.socket.on("error", () => closeSession(session));
    session.socket.on("data", (chunk) => {
      if (!session.connected) return;
      session.receiveBytes += chunk.length;
      if (session.receiveBytes > MAX_RECEIVE) {
        closeSession(session, new IpcError("MANAGEMENT_IPC_RECEIVE_LIMIT"));
        return;
      }
      session.buffer = Buffer.concat([session.buffer, chunk]);
      while (session.buffer.length >= 4) {
        if (!session.connected) return;
        const length = session.buffer.readUInt32BE(0);
        if (length === 0 || length > MAX_FRAME) {
          closeSession(session, new IpcError("MANAGEMENT_IPC_INVALID_FRAME"));
          return;
        }
        if (session.buffer.length < length + 4) break;
        const body = session.buffer.subarray(4, 4 + length);
        session.buffer = session.buffer.subarray(4 + length);
        session.receiveBytes = session.buffer.length;
        let message: unknown;
        try {
          message = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          );
        } catch {
          closeSession(session, new IpcError("MANAGEMENT_IPC_INVALID_FRAME"));
          return;
        }
        enqueue(message);
      }
    });
  };

  scheduleReconnect();
  let startupTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      initialConnection,
      new Promise<void>((_resolve, reject) => {
        startupTimer = setTimeout(
          () => reject(new IpcError("MANAGEMENT_IPC_START_TIMEOUT")),
          STARTUP_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    stopped = true;
    if (startupTimer) clearTimeout(startupTimer);
    if (retryTimer) clearTimeout(retryTimer);
    retryWake?.();
    await reconnectTask;
    if (error instanceof IpcError) throw error;
    throw new IpcError("MANAGEMENT_IPC_START_FAILED");
  }
  if (startupTimer) clearTimeout(startupTimer);
  return {
    close: async () => {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      retryWake?.();
      retryWake = undefined;
      const session = current;
      if (session) closeSession(session);
      await dispatchTail;
      await reconnectTask;
    },
  };
}
