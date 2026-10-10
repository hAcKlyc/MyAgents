import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const HANDOFF_MANIFEST = "batch-3-integration-handoff-v1.json";
export const RUNTIME_MANIFEST = "runtime-artifact/runtime-artifact-v1.json";
export const COMPATIBILITY_MANIFEST =
  "contracts/myagents-dsh-compatibility-v1.json";
export const PROTOCOL_META = "contracts/protocol-meta.json";
export const PROTOCOL_SCHEMA = "contracts/protocol.schema.json";

export const CONTRACT_PATHS = Object.freeze([
  "contracts/accepted-patched-dsh-artifact-v1.json",
  "contracts/batch-1-candidate-profile-v1.json",
  "contracts/canonical-tool-contracts-v1.json",
  "contracts/catalog-fixtures-v1.json",
  "contracts/host-client.generated.ts",
  "contracts/public-contract.generated.ts",
  "contracts/myagents-dsh-compatibility-v1.json",
  "contracts/official-product-profile-v1.json",
  "contracts/protocol-6.1.0-evidence.json",
  "contracts/protocol-fixtures.json",
  "contracts/protocol-meta.json",
  "contracts/protocol.schema.json",
]);

const REQUIRED_CONTROL_METHODS = Object.freeze([
  "plan/apply",
  "permission/rules/list",
  "permission/rules/add",
  "permission/rules/revoke",
]);

function fail(message) {
  throw new Error(`[dsh-handoff] ${message}`);
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${path}: ${error.message}`);
  }
}

export function resolveExplicitDirectory(path, label) {
  if (!path || !isAbsolute(path)) {
    fail(`${label} must be an explicit absolute directory`);
  }
  if (!existsSync(path) || !lstatSync(path).isDirectory()) {
    fail(`${label} is not a directory: ${path}`);
  }
  if (lstatSync(path).isSymbolicLink()) {
    fail(`${label} cannot itself be a symbolic link: ${path}`);
  }
  const canonical = realpathSync(path);
  if (canonical !== resolve(path)) {
    fail(`${label} must use its canonical path: ${path}`);
  }
  return canonical;
}

export function assertPathInside(root, path, label) {
  const pathFromRoot = relative(root, path);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot)
  ) {
    fail(`${label} must be a child of ${root}: ${path}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} mismatch: expected ${expected}, received ${actual}`);
  }
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} mismatch`);
  }
}

// Node resource preparation belongs to the downloader; DSH only binds the
// product's pinned Node version to the handoff requirement, without executing it.
export function assertBundledNodeRequirement(repoRoot, lock) {
  const distribution = readJson(resolve(repoRoot, "scripts/node-runtime.json"));
  assertEqual(distribution.node, lock.runtime.requiredNodeVersion, "bundled distribution Node");
}

export function runPublicVerifier(root, expectedManifestSha256) {
  // The official structural API checks the handoff without executing target
  // binaries. The public CLI also performs a native Runtime self-check, which
  // belongs to DSH's platform validation rather than cross-target packaging.
  const script = `
    import { resolve } from "node:path";
    import { pathToFileURL } from "node:url";
    const root = process.argv[1];
    const verifier = resolve(root, "runtime-artifact/node_modules/@myagents-dsh/artifact-verifier/src/integration-handoff.js");
    const { verifyBatch3IntegrationHandoffReport } = await import(pathToFileURL(verifier).href);
    const { manifest } = verifyBatch3IntegrationHandoffReport(root, process.argv[2]);
    process.stdout.write(JSON.stringify({ kind: manifest.kind, files: manifest.files.length }));
  `;
  try {
    return execFileSync(process.execPath, ["--input-type=module", "-e", script, root, expectedManifestSha256], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    fail(`public verifier rejected ${root}: ${detail}`);
  }
}

export function verifyHandoffFacts(root, lock) {
  const outerPath = resolve(root, HANDOFF_MANIFEST);
  const runtimePath = resolve(root, RUNTIME_MANIFEST);
  const compatibilityPath = resolve(root, COMPATIBILITY_MANIFEST);
  const protocolMetaPath = resolve(root, PROTOCOL_META);
  const protocolSchemaPath = resolve(root, PROTOCOL_SCHEMA);

  assertEqual(
    sha256File(outerPath),
    lock.handoff.manifestSha256,
    "handoff manifest digest",
  );

  const outer = readJson(outerPath);
  const runtime = readJson(runtimePath);
  const compatibility = readJson(compatibilityPath);
  const protocolMeta = readJson(protocolMetaPath);

  assertEqual(outer.schemaVersion, 1, "handoff schema version");
  assertEqual(
    outer.kind,
    "myagents-dsh-batch-3-integration-handoff",
    "handoff kind",
  );
  assertEqual(
    outer.runtime.manifestSha256,
    lock.handoff.runtimeManifestSha256,
    "outer Runtime manifest digest",
  );
  assertEqual(
    sha256File(runtimePath),
    lock.handoff.runtimeManifestSha256,
    "Runtime manifest digest",
  );
  assertEqual(
    outer.compatibility.sha256,
    lock.handoff.compatibilitySha256,
    "outer compatibility digest",
  );
  assertEqual(
    sha256File(compatibilityPath),
    lock.handoff.compatibilitySha256,
    "compatibility digest",
  );
  assertEqual(
    outer.generatedClient.sha256,
    lock.handoff.generatedClientSha256,
    "generated client digest",
  );
  assertEqual(
    sha256File(resolve(root, outer.generatedClient.path)),
    lock.handoff.generatedClientSha256,
    "generated client file digest",
  );
  assertEqual(
    outer.notices.sha256,
    lock.handoff.noticesSha256,
    "notice digest",
  );
  assertEqual(
    sha256File(resolve(root, outer.notices.path)),
    lock.handoff.noticesSha256,
    "notice file digest",
  );

  assertEqual(
    runtime.build.repositoryHead,
    lock.handoff.sourceCommit,
    "Runtime source commit",
  );
  assertEqual(runtime.runtimeVersion, lock.runtime.version, "Runtime version");
  assertEqual(
    runtime.entrypoint,
    lock.runtime.entrypoint,
    "Runtime entrypoint",
  );
  assertEqual(
    runtime.build.toolchain.node,
    lock.runtime.requiredNodeVersion,
    "required Node version",
  );
  assertEqual(
    runtime.protocol.version,
    lock.protocol.version,
    "protocol version",
  );
  assertEqual(
    runtime.protocol.schemaSha256,
    lock.protocol.schemaSha256,
    "Runtime protocol schema digest",
  );
  assertEqual(runtime.profile.id, lock.profile.id, "profile id");
  assertEqual(runtime.profile.digest, lock.profile.digest, "profile digest");
  assertEqual(runtime.dsh.artifactVersion, lock.dsh.version, "DSH version");
  assertEqual(
    runtime.dsh.sourceCommit,
    lock.dsh.sourceCommit,
    "DSH source commit",
  );
  assertEqual(
    runtime.dsh.artifactManifestSha256,
    lock.dsh.artifactManifestSha256,
    "DSH artifact digest",
  );
  assertEqual(
    runtime.dsh.patchSeriesSha256,
    lock.dsh.patchSeriesSha256,
    "DSH patch-series digest",
  );

  assertEqual(
    compatibility.runtime.sessionFormat,
    lock.runtime.sessionFormat,
    "session format",
  );
  assertEqual(
    compatibility.runtime.artifactSha256,
    lock.handoff.runtimeManifestSha256,
    "compatibility Runtime digest",
  );
  assertEqual(
    compatibility.protocol.generatedClientSha256,
    lock.handoff.generatedClientSha256,
    "compatibility generated-client digest",
  );
  assertEqual(
    sha256File(protocolSchemaPath),
    lock.protocol.schemaSha256,
    "protocol schema file digest",
  );
  assertEqual(
    protocolMeta.hostMethods.length,
    lock.protocol.hostMethodCount,
    "Host method count",
  );
  assertEqual(
    protocolMeta.reverseMethods.length,
    lock.protocol.reverseMethodCount,
    "reverse method count",
  );
  assertEqual(
    protocolMeta.notifications.length,
    lock.protocol.notificationCount,
    "notification count",
  );
  for (const method of REQUIRED_CONTROL_METHODS) {
    if (!protocolMeta.hostMethods.includes(method)) {
      fail(`formal protocol is missing required method ${method}`);
    }
  }

  assertJsonEqual(outer.platforms, lock.platforms, "outer platform claims");
  assertJsonEqual(
    compatibility.platforms,
    lock.platforms,
    "compatibility platform claims",
  );
  for (const platform of lock.platforms) {
    if (
      platform.claim !== "implementation-complete_pending-native-validation"
      && platform.claim !== "verified"
    ) {
      fail(
        `unaccepted platform claim for ${platform.target}: ${platform.claim}`,
      );
    }
  }

  return {
    handoffManifestSha256: lock.handoff.manifestSha256,
    runtimeManifestSha256: lock.handoff.runtimeManifestSha256,
    compatibilitySha256: lock.handoff.compatibilitySha256,
    protocolVersion: lock.protocol.version,
    sourceCommit: lock.handoff.sourceCommit,
  };
}

export function compareOrAcceptContracts(
  handoffRoot,
  contractsRoot,
  acceptContracts,
  excluded = [],
) {
  const targetRoot = resolve(contractsRoot, "myagents-dsh");
  // Preflight the entire new inventory before replacing any accepted contract.
  for (const contractPath of CONTRACT_PATHS) {
    if (excluded.includes(contractPath)) continue;
    const source = resolve(handoffRoot, contractPath);
    if (!existsSync(source) || !lstatSync(source).isFile()) {
      fail(`handoff contract is missing or not a regular file: ${contractPath}`);
    }
  }
  if (acceptContracts) mkdirSync(targetRoot, { recursive: true });

  for (const contractPath of CONTRACT_PATHS) {
    if (excluded.includes(contractPath)) continue;
    const source = resolve(handoffRoot, contractPath);
    const target = resolve(targetRoot, contractPath.slice("contracts/".length));
    if (acceptContracts) {
      mkdirSync(resolve(target, ".."), { recursive: true });
      cpSync(source, target, { force: true });
      continue;
    }
    if (!existsSync(target)) {
      fail(`generated contract is missing: ${target}`);
    }
    assertEqual(
      sha256File(target),
      sha256File(source),
      `generated contract ${contractPath}`,
    );
  }
  if (acceptContracts) {
    // Evidence belongs to the accepted generated projection.
    for (const version of ["5.0.0", "6.0.0"]) {
      rmSync(resolve(targetRoot, `protocol-${version}-evidence.json`), { force: true });
    }
  }
}

export function stageCompleteHandoff(sourceRoot, outputRoot, verify, afterPublish = () => {}) {
  const outputParent = resolve(outputRoot, "..");
  assertPathInside(outputParent, outputRoot, "staged Runtime path");
  mkdirSync(outputParent, { recursive: true });

  const suffix = `${process.pid}-${randomUUID()}`;
  const temporaryRoot = `${outputRoot}.tmp-${suffix}`;
  const backupRoot = `${outputRoot}.backup-${suffix}`;
  let movedExisting = false;
  let published = false;

  try {
    cpSync(sourceRoot, temporaryRoot, {
      recursive: true,
      dereference: false,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    prepareResourcePermissions(temporaryRoot);
    verify(temporaryRoot);

    if (existsSync(outputRoot)) {
      renameSync(outputRoot, backupRoot);
      movedExisting = true;
    }
    renameSync(temporaryRoot, outputRoot);
    published = true;
    afterPublish();
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (published) rmSync(outputRoot, { recursive: true, force: true });
    if (movedExisting && existsSync(backupRoot)) {
      renameSync(backupRoot, outputRoot);
    }
    throw error;
  }
  if (movedExisting) rmSync(backupRoot, { recursive: true, force: true });
}

function prepareResourcePermissions(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) {
      prepareResourcePermissions(resolve(path, name));
    }
  } else if (stat.isFile()) {
    // The immutable source may seal evidence as 0400. Build resources must be
    // readable by app users and writable by the builder for macOS xattr/signing.
    // Normalize only the private copy; preserve executable intent and verify
    // the complete handoff again before publishing it to resources.
    chmodSync(path, stat.mode & 0o111 ? 0o755 : 0o644);
  } else {
    fail(`staged handoff must be link-free regular files/directories: ${path}`);
  }
}

export function parseNamedArgs(argv, definitions) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const definition = definitions[name];
    if (!definition) fail(`unknown argument: ${name}`);
    if (definition === "boolean") {
      parsed[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${name}`);
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}
