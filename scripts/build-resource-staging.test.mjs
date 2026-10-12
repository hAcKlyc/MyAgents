import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const buildDev = readFileSync(resolve(repoRoot, 'build_dev.sh'), 'utf8');

test('Cargo build inputs use the invocation checkout rather than cached compilation paths', () => {
  // A cached build-script executable may have been compiled in a removed or
  // still-existing checkout. Neither may supply inputs for the current build.
  for (const file of ['src-tauri/build.rs', 'src-tauri/build_cliproxy.rs']) {
    const source = withoutComments(readFileSync(resolve(repoRoot, file), 'utf8'));
    assert.doesNotMatch(source, /(?:env|option_env)!\s*\(\s*"CARGO_MANIFEST_DIR"/, file);
  }
});

const buildDevWindows = readFileSync(
  resolve(repoRoot, 'build_dev_win.ps1'),
  'utf8',
);
const buildMacos = readFileSync(resolve(repoRoot, 'build_macos.sh'), 'utf8');
const esbuildBundle = readFileSync(
  resolve(repoRoot, 'scripts/esbuild-bundle.mjs'),
  'utf8',
);
const buildLinux = readFileSync(resolve(repoRoot, 'build_linux.sh'), 'utf8');
const buildWindows = readFileSync(
  resolve(repoRoot, 'build_windows.ps1'),
  'utf8',
);
const setupUnix = readFileSync(resolve(repoRoot, 'setup.sh'), 'utf8');
const setupWindows = readFileSync(
  resolve(repoRoot, 'setup_windows.ps1'),
  'utf8',
);
const documentResourceScript = readFileSync(
  resolve(repoRoot, 'scripts/prepare-document-processing.mjs'),
  'utf8',
);
const documentResourceCache = readFileSync(
  resolve(repoRoot, 'scripts/document-processing-resource-cache.mjs'),
  'utf8',
);
const nativeResourceScript = readFileSync(
  resolve(repoRoot, 'scripts/prepare-native-inference.mjs'),
  'utf8',
);
const speechResourceScript = readFileSync(
  resolve(repoRoot, 'scripts/prepare-speech-inference.mjs'),
  'utf8',
);
const syncVersionScript = readFileSync(
  resolve(repoRoot, 'scripts/sync-version.js'),
  'utf8',
);
const documentWorkerSmoke = readFileSync(
  resolve(repoRoot, 'scripts/document-worker-smoke.mjs'),
  'utf8',
);
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
);
const documentResourceLock = JSON.parse(
  readFileSync(
    resolve(repoRoot, 'src-tauri/document-worker/resource-lock.json'),
    'utf8',
  ),
);
const tauriConfig = JSON.parse(
  readFileSync(resolve(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
);
const macInfoPlist = readFileSync(
  resolve(repoRoot, 'src-tauri/Info.plist'),
  'utf8',
);
const macEntitlements = readFileSync(
  resolve(repoRoot, 'src-tauri/Entitlements.plist'),
  'utf8',
);
const macInfoPlistEnglish = readFileSync(
  resolve(repoRoot, 'src-tauri/infoplist/en.lproj/InfoPlist.strings'),
  'utf8',
);
const macInfoPlistChinese = readFileSync(
  resolve(repoRoot, 'src-tauri/infoplist/zh-Hans.lproj/InfoPlist.strings'),
  'utf8',
);

const recordingPrivacyKeys = [
  'NSMicrophoneUsageDescription',
  'NSAudioCaptureUsageDescription',
  'NSScreenCaptureUsageDescription',
];

test('macOS dev checkout initialization precedes dependency work even from another directory', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'myagents dev checkout '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const caller = join(root, 'caller');
  mkdirSync(checkout);
  mkdirSync(caller);
  writeFileSync(join(checkout, 'package.json'), 'checkout dependencies');
  writeFileSync(join(caller, 'package.json'), 'caller dependencies');
  // Execute the actual entrypoint initialization, stopping before tools/env or
  // resource preparation so this regression never mutates a real checkout.
  const initialization = buildDev.slice(0, buildDev.indexOf('CLIPROXY_BUILD_ONLY='));
  const script = join(checkout, 'build_dev.sh');
  writeFileSync(script, `${initialization}\ncat package.json\n`);
  const result = spawnSync('bash', [script], { cwd: caller, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'checkout dependencies');
});

test('Windows dev sets the checkout before its dependency installation', () => {
  const checkoutAt = buildDevWindows.indexOf('Set-Location $PROJECT_DIR');
  const installAt = buildDevWindows.indexOf('& npm install');
  assert.ok(checkoutAt >= 0 && checkoutAt < installAt,
    'absolute-path invocation must install checkout dependencies, not caller dependencies');
});

function withoutComments(source) {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function assertRecordingPrivacyDeclarations(infoPlist, ...localizations) {
  const plist = withoutComments(infoPlist);
  const stringsFiles = localizations.map(withoutComments);
  for (const key of recordingPrivacyKeys) {
    const plistKeys = [...plist.matchAll(new RegExp(`<key>${key}</key>`, 'g'))];
    assert.equal(plistKeys.length, 1, `${key} must occur once in Info.plist`);
    const plistMatches = [
      ...plist.matchAll(
        new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'g'),
      ),
    ];
    assert.equal(plistMatches.length, 1, `${key} must have a string value`);
    assert.ok(plistMatches[0][1].trim(), `${key} must not be empty`);
    for (const stringsFile of stringsFiles) {
      const assignments = [
        ...stringsFile.matchAll(new RegExp(`^\\s*${key}\\s*=`, 'gm')),
      ];
      assert.equal(
        assignments.length,
        1,
        `${key} must occur once in each InfoPlist.strings`,
      );
      const assignment = new RegExp(
        `^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)";\\s*$`,
        'gm',
      );
      const matches = [...stringsFile.matchAll(assignment)];
      assert.equal(
        matches.length,
        1,
        `${key} must have a string value in each InfoPlist.strings`,
      );
      assert.ok(matches[0][1].trim(), `${key} localization must not be empty`);
    }
  }
}

function assertRecordingPrivacyEntitlements(entitlements) {
  const plist = withoutComments(entitlements);
  const audioInputKeys = [
    ...plist.matchAll(/<key>com\.apple\.security\.device\.audio-input<\/key>/g),
  ];
  assert.equal(
    audioInputKeys.length,
    1,
    'macOS recording requires exactly one audio-input entitlement key',
  );
  const audioInput = [
    ...plist.matchAll(
      /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/g,
    ),
  ];
  assert.equal(
    audioInput.length,
    1,
    'macOS recording requires one enabled audio-input entitlement',
  );
}

test('macOS recording privacy declarations survive source and localization staging', () => {
  assertRecordingPrivacyDeclarations(
    macInfoPlist,
    macInfoPlistEnglish,
    macInfoPlistChinese,
  );
});

test('macOS recording entitlement survives signing configuration', () => {
  assertRecordingPrivacyEntitlements(macEntitlements);
  assert.throws(() =>
    assertRecordingPrivacyEntitlements(
      macEntitlements.replace(
        /(<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>)/,
        '<!-- $1 -->',
      ),
    ),
  );
  assert.throws(() =>
    assertRecordingPrivacyEntitlements(
      macEntitlements.replace(
        /(<key>com\.apple\.security\.device\.audio-input<\/key>\s*)<true\s*\/>/,
        '$1<false/>',
      ),
    ),
  );
  assert.throws(() =>
    assertRecordingPrivacyEntitlements(
      macEntitlements.replace(
        '</dict>',
        '  <key>com.apple.security.device.audio-input</key>\n' +
          '  <false/>\n' +
          '</dict>',
      ),
    ),
  );
});

test('macOS recording privacy contract rejects commented or empty declarations', () => {
  const key = 'NSScreenCaptureUsageDescription';
  assert.throws(() =>
    assertRecordingPrivacyDeclarations(
      macInfoPlist.replace(
        new RegExp(`(<key>${key}</key>\\s*<string>[^<]+</string>)`),
        '<!-- $1 -->',
      ),
      macInfoPlistEnglish,
      macInfoPlistChinese,
    ),
  );
  assert.throws(() =>
    assertRecordingPrivacyDeclarations(
      macInfoPlist,
      macInfoPlistEnglish.replace(
        new RegExp(`^(${key}\\s*=\\s*)"[^"]+";`, 'm'),
        '$1"";',
      ),
      macInfoPlistChinese,
    ),
  );
  assert.throws(() =>
    assertRecordingPrivacyDeclarations(
      macInfoPlist,
      `${macInfoPlistEnglish}\n${key} = "";\n`,
      macInfoPlistChinese,
    ),
  );
});

test('bundled workspace templates are committed, clean, and setup-independent', () => {
  const templateRoot = resolve(repoRoot, 'bundled-workspaces', 'mino');
  assert.ok(
    existsSync(resolve(templateRoot, 'CLAUDE.md')),
    'the committed mino template must include its workspace marker',
  );
  assert.equal(
    tauriConfig.bundle.resources['../bundled-workspaces'],
    'bundled-workspaces',
  );
  assert.equal(tauriConfig.bundle.resources['../mino'], undefined);
  assert.equal(existsSync(resolve(repoRoot, 'mino')), false);
  const bundledSkills = readdirSync(
    resolve(templateRoot, '.claude', 'skills'),
    { withFileTypes: true },
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(bundledSkills, [
    'apple-notes',
    'apple-reminders',
    'bird',
    'github',
    'peekaboo',
    'remotion-best-practices',
  ]);

  const pending = [templateRoot];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      assert.notEqual(entry.name, '.DS_Store');
      assert.notEqual(entry.name, '.git');
      assert.equal(
        lstatSync(path).isSymbolicLink(),
        false,
        `bundled templates cannot contain skipped symlinks: ${path}`,
      );
      if (entry.isDirectory()) pending.push(path);
    }
  }

  for (const setup of [setupUnix, setupWindows]) {
    assert.doesNotMatch(setup, /openmino/i);
    assert.doesNotMatch(setup, /git clone[^\n]*mino/i);
  }
  assert.match(buildMacos, /bundled-workspaces\/mino\/CLAUDE\.md/);
});

test('macOS dev build replaces every mutable native resource staging directory', () => {
  for (const resource of ['claude-agent-sdk', 'sharp-runtime', 'tsx-runtime']) {
    const remove = `rm -rf "\${PROJECT_DIR}/src-tauri/resources/${resource}"`;
    const create = `mkdir -p "\${PROJECT_DIR}/src-tauri/resources/${resource}"`;
    const removeAt = buildDev.indexOf(remove);
    const createAt = buildDev.indexOf(create);

    assert.notEqual(
      removeAt,
      -1,
      `${resource} must be removed before dev staging`,
    );
    assert.notEqual(
      createAt,
      -1,
      `${resource} must be recreated for the Tauri resource map`,
    );
    assert.ok(
      removeAt < createAt,
      `${resource} must be replaced, not prepared additively`,
    );
  }
});

test('Windows dev and release stage the validated Claude SDK package before Tauri builds', () => {
  const prepare = readFileSync(resolve(repoRoot, 'scripts/ensure_claude_sdk_package.ps1'), 'utf8');
  assert.match(prepare, /function Stage-SdkPackage\s*\{/);
  assert.match(prepare, /Test-SdkPackage -PackageArch \$archName -SdkVersion \$sdkVersion/);
  assert.match(prepare, /Stage-SdkPackage -PackageArch \$archName/);
  for (const [name, source] of [['build_dev_win.ps1', buildDevWindows], ['build_windows.ps1', buildWindows]]) {
    const stageAt = source.indexOf('ensure_claude_sdk_package.ps1" -Arch x64 -Stage');
    assert.notEqual(stageAt, -1, `${name} must stage the validated SDK binary`);
    assert.ok(stageAt > source.indexOf('npm install'), `${name} must install dependencies first`);
    assert.ok(stageAt < source.indexOf('npm run tauri:build:prepared'), `${name} must stage before Tauri`);
  }
});

test('macOS dev and release verify the installed SDK wrapper before bundling it', () => {
  for (const [name, source] of [['build_dev.sh', buildDev], ['build_macos.sh', buildMacos]]) {
    const verifyAt = source.indexOf('verify-claude-sdk-wrapper.mjs');
    assert.notEqual(verifyAt, -1, `${name} must verify the installed JS wrapper`);
    assert.ok(verifyAt < source.indexOf('npm run build:assets'), `${name} must verify before bundling`);
    const cleanupAt = source.indexOf(name === 'build_dev.sh'
      ? 'rm -rf "${PROJECT_DIR}/src-tauri/resources/claude-agent-sdk"'
      : 'rm -rf "${SDK_DEST}"');
    assert.ok(cleanupAt >= 0 && verifyAt < cleanupAt, `${name} must reject a stale wrapper before removing SDK staging`);
  }
});

test('macOS release prepares and validates Sharp inside each target build', () => {
  const prepareCall = 'prepare_sharp_runtime "$NODE_TARGET_ARCH"';
  const prepareAt = buildMacos.indexOf(prepareCall);
  const targetLoopAt = buildMacos.lastIndexOf(
    'for TARGET in "${BUILD_TARGETS[@]}"; do',
    prepareAt,
  );
  const targetArchReadyAt = buildMacos.indexOf(
    'NODE_TARGET_ARCH="x64"',
    targetLoopAt,
  );
  const tauriBuildAt = buildMacos.indexOf(
    'npm run tauri:build:prepared -- --target "$TARGET"',
    targetLoopAt,
  );

  assert.match(buildMacos, /prepare_sharp_runtime\(\) \{/);
  assert.notEqual(targetLoopAt, -1, 'target build loop must exist');
  assert.notEqual(
    targetArchReadyAt,
    -1,
    'target architecture selection must exist',
  );
  assert.ok(
    prepareAt > targetLoopAt,
    'Sharp staging must be owned by the current target loop',
  );
  assert.ok(
    prepareAt > targetArchReadyAt,
    'Sharp staging must run after the current target architecture is selected',
  );
  assert.ok(
    prepareAt < tauriBuildAt,
    'Sharp must be ready before Tauri snapshots resources',
  );
  assert.equal(
    buildMacos.match(new RegExp(prepareCall.replaceAll('$', '\\$'), 'g'))
      ?.length,
    1,
  );

  const prepareFunctionAt = buildMacos.indexOf('prepare_sharp_runtime() {');
  const nextFunctionAt = buildMacos.indexOf(
    '\nvalidate_claude_sdk_package() {',
    prepareFunctionAt,
  );
  const prepareFunction = buildMacos.slice(prepareFunctionAt, nextFunctionAt);

  assert.match(prepareFunction, /npm run build:sharp-runtime -- darwin "\$ARCH"/);
  assert.match(prepareFunction, /validate_macho_binary/);
  assert.match(
    prepareFunction,
    /codesign --force --options runtime --timestamp/,
  );
  assert.doesNotMatch(
    buildMacos,
    /@img\/sharp-darwin-arm64@[^\n]*@img\/sharp-darwin-x64@/,
    'a thin target must not install both Sharp architectures',
  );
});

test('CLI bundle staging owns its complete mutable resource inventory', () => {
  const cliTargetAt = esbuildBundle.indexOf('cli: {');
  const cleanAt = esbuildBundle.indexOf("if (targetName === 'cli')");
  const buildAt = esbuildBundle.indexOf('await build({');

  assert.notEqual(cliTargetAt, -1, 'CLI esbuild target must exist');
  assert.notEqual(
    cleanAt,
    -1,
    'CLI target must clear stale resource artifacts',
  );
  assert.ok(
    cleanAt < buildAt,
    'stale CLI resources must be removed before esbuild emits the bundle',
  );
  assert.match(esbuildBundle, /entry !== '\.gitkeep'/);
  assert.match(esbuildBundle, /resources\/cli\/myagents\.cjs/);
  assert.doesNotMatch(esbuildBundle, /resources\/cli\/myagents\.js/);
  assert.doesNotMatch(esbuildBundle, /copyFile|src\/cli\/myagents\.cmd/);
});

test('native prerequisite preflight runs before expensive or destructive entry-point work', () => {
  function assertEarlyNativePreflight({
    source,
    invocation,
    toolchain,
    expensiveBoundary,
    label,
  }) {
    const toolchainAt = source.indexOf(toolchain);
    const preflightAt = source.indexOf(invocation);
    const expensiveBoundaryAt = source.indexOf(expensiveBoundary);
    assert.notEqual(toolchainAt, -1, `${label} must prepare pinned Rust`);
    assert.notEqual(preflightAt, -1, `${label} must run native preflight`);
    assert.notEqual(
      expensiveBoundaryAt,
      -1,
      `${label} must retain its expensive-work boundary`,
    );
    assert.ok(
      toolchainAt < preflightAt && preflightAt < expensiveBoundaryAt,
      `${label} must run native preflight after Rust and before expensive work`,
    );
  }

  assertEarlyNativePreflight({
    source: setupUnix,
    invocation:
      'prepare-native-inference.mjs" --check-prerequisites',
    toolchain: '"${PROJECT_DIR}/scripts/ensure_rust_toolchain.sh"',
    expensiveBoundary: 'scripts/download_nodejs.sh',
    label: 'Unix setup',
  });
  assertEarlyNativePreflight({
    source: setupWindows,
    invocation:
      'prepare-native-inference.mjs" "x86_64-pc-windows-msvc" --check-prerequisites',
    toolchain:
      '& "$ProjectDir\\scripts\\ensure_rust_toolchain.ps1" -Targets',
    expensiveBoundary:
      'Write-Host "`nStep 2/7: 下载 Node.js 运行时',
    label: 'Windows setup',
  });
  const windowsSetupMainAt = setupWindows.indexOf('# Main');
  const windowsSetupPreflightAt = setupWindows.indexOf(
    'prepare-native-inference.mjs" "x86_64-pc-windows-msvc" --check-prerequisites',
    windowsSetupMainAt,
  );
  const windowsSetupBeforePreflight = setupWindows.slice(
    windowsSetupMainAt,
    windowsSetupPreflightAt,
  );
  assert.doesNotMatch(
    windowsSetupBeforePreflight,
    /Test-MSVC|winget install --id Microsoft\.VisualStudio\.2022\.BuildTools/,
    'Windows setup must leave cache-aware MSVC decisions to the native owner',
  );
  assertEarlyNativePreflight({
    source: buildDev,
    invocation:
      'prepare-native-inference.mjs" "$DEV_NATIVE_TARGET" --check-prerequisites',
    toolchain: '"${PROJECT_DIR}/scripts/ensure_rust_toolchain.sh"',
    expensiveBoundary: 'LOCK_FILE="$HOME/.myagents/app.lock"',
    label: 'macOS dev build',
  });
  assertEarlyNativePreflight({
    source: buildDevWindows,
    invocation:
      'prepare-native-inference.mjs" "x86_64-pc-windows-msvc" --check-prerequisites',
    toolchain:
      '& "$PROJECT_DIR\\scripts\\ensure_rust_toolchain.ps1" -Targets',
    expensiveBoundary: '$appProcesses = Get-Process',
    label: 'Windows dev build',
  });
  assertEarlyNativePreflight({
    source: buildLinux,
    invocation:
      'prepare-native-inference.mjs" "$TARGET" --check-prerequisites',
    toolchain:
      '"${PROJECT_DIR}/scripts/ensure_rust_toolchain.sh" "$TARGET"',
    expensiveBoundary: 'npm run typecheck',
    label: 'Linux release build',
  });
  assertEarlyNativePreflight({
    source: buildWindows,
    invocation:
      'prepare-native-inference.mjs" "x86_64-pc-windows-msvc" --check-prerequisites',
    toolchain:
      '& "$ProjectDir\\scripts\\ensure_rust_toolchain.ps1" -Targets',
    expensiveBoundary: '& "$ProjectDir\\scripts\\download_nodejs.ps1"',
    label: 'Windows release build',
  });

  const windowsMsvcAt = buildWindows.indexOf(
    'Initialize-MsvcBuildEnvironment',
  );
  const windowsPreflightAt = buildWindows.indexOf(
    'prepare-native-inference.mjs" "x86_64-pc-windows-msvc" --check-prerequisites',
  );
  assert.ok(
    windowsMsvcAt >= 0 && windowsMsvcAt < windowsPreflightAt,
    'Windows release preflight must inherit the initialized MSVC environment',
  );
});

test('every setup, dev, and release entry point delegates native resources to one prepare owner', () => {
  const macPreflight = buildMacos.indexOf(
    'prepare-native-inference.mjs" "$TARGET" --check-prerequisites',
  );
  const macTargetBuildLoop = buildMacos.indexOf(
    'for TARGET in "${BUILD_TARGETS[@]}"; do',
    macPreflight + 1,
  );
  assert.ok(
    macPreflight >= 0 && macPreflight < macTargetBuildLoop,
    'macOS selected targets must run owner preflight before the app build loop',
  );

  const macDevPrepare = buildDev.indexOf(
    'prepare-native-inference.mjs" "$DEV_NATIVE_TARGET"',
  );
  const macDevBuild = buildDev.indexOf('npm run tauri:build:prepared -- --debug');
  assert.ok(macDevPrepare >= 0 && macDevPrepare < macDevBuild);

  const windowsDevPrepare = buildDevWindows.indexOf(
    'prepare-native-inference.mjs" "x86_64-pc-windows-msvc"',
  );
  const windowsDevBuild = buildDevWindows.indexOf(
    'npm run tauri:build:prepared -- --debug',
  );
  assert.ok(windowsDevPrepare >= 0 && windowsDevPrepare < windowsDevBuild);

  const macPrepare = buildMacos.indexOf(
    'prepare-native-inference.mjs" "$TARGET"',
  );
  const macBuild = buildMacos.indexOf(
    'npm run tauri:build:prepared -- --target "$TARGET"',
  );
  assert.ok(macPrepare >= 0 && macPrepare < macBuild);

  const linuxPrepare = buildLinux.indexOf(
    'prepare-native-inference.mjs" "$TARGET"',
  );
  const linuxBuild = buildLinux.indexOf(
    'npm run tauri:build:prepared -- --target "$TARGET"',
  );
  assert.ok(linuxPrepare >= 0 && linuxPrepare < linuxBuild);

  const windowsPrepare = buildWindows.indexOf('prepare-native-inference.mjs');
  const windowsBuild = buildWindows.indexOf(
    'npm run tauri:build:prepared -- --target x86_64-pc-windows-msvc',
  );
  assert.ok(windowsPrepare >= 0 && windowsPrepare < windowsBuild);

  assert.match(
    setupUnix,
    /node "\$\{PROJECT_DIR\}\/scripts\/prepare-native-inference\.mjs"/,
  );
  assert.match(
    setupWindows,
    /node "\$ProjectDir\\scripts\\prepare-native-inference\.mjs" "x86_64-pc-windows-msvc"/,
  );
  assert.equal(
    packageJson.scripts['prepare:document-processing'],
    'npm run prepare:native-inference',
  );
  assert.equal(
    packageJson.scripts['prepare:native-inference'],
    'node scripts/prepare-native-inference.mjs',
  );
  assert.match(
    packageJson.scripts['tauri:dev'],
    /^node scripts\/prepare-cliproxy\.mjs && npm run prepare:native-inference && npm run verify:dsh-runtime && npm run verify:dsh-runtime:fresh && tauri dev$/,
  );
  assert.match(nativeResourceScript, /prepare-document-processing\.mjs/);
  assert.match(nativeResourceScript, /prepare-speech-inference\.mjs/);
});

test('document processing locks all release targets and publishes only verified reusable resources', () => {
  assert.deepEqual(Object.keys(documentResourceLock.targets).sort(), [
    'aarch64-apple-darwin',
    'aarch64-unknown-linux-gnu',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
    'x86_64-unknown-linux-gnu',
  ]);
  assert.equal(
    documentResourceLock.pipelineVersion,
    'anydoc-0.1.9_ppocrv6-small_v1',
  );
  assert.match(
    documentResourceLock.shared.dictionary.url,
    /ppocrv6_dict\.txt$/,
  );
  for (const resource of Object.values(documentResourceLock.shared)) {
    assert.match(resource.sha256, /^[0-9a-f]{64}$/);
    assert.ok(resource.size > 0);
    assert.ok(resource.upstreamRevision);
  }
  for (const target of Object.values(documentResourceLock.targets)) {
    assert.ok(
      target.onnxRuntime.sha256 || target.onnxRuntime.sourceBuild?.commit,
    );
    assert.match(target.pdfium.sha256, /^[0-9a-f]{64}$/);
  }
  for (const macTarget of [
    documentResourceLock.targets['aarch64-apple-darwin'],
    documentResourceLock.targets['x86_64-apple-darwin'],
  ]) {
    assert.equal(macTarget.onnxRuntime.sourceBuild.deploymentTarget, '13.0');
    assert.equal(macTarget.onnxRuntime.sourceBuild.recipeVersion, 2);
    assert.equal(macTarget.onnxRuntime.url, undefined);
  }
  assert.match(
    documentResourceScript,
    /cargo[\s\S]*--locked[\s\S]*--release[\s\S]*--target/,
  );
  assert.match(documentResourceCache, /Locked size\/digest mismatch/);
  assert.match(
    documentResourceScript,
    /writeFileSync\(\s*join\(stageRoot, 'manifest\.json'\)/,
  );
  assert.match(documentResourceScript, /buildFingerprint/);
  assert.match(documentResourceScript, /publishPreparedBundle\(preparedRoot\)/);
  assert.match(
    documentResourceScript,
    /renameSync\(projectionStage, publishRoot\)/,
  );
  assert.match(
    documentResourceScript,
    /renameSync\(projectionBackup, publishRoot\)/,
  );
  assert.match(
    documentResourceScript,
    /const cacheRoot = join\([\s\S]*?'resources',[\s\S]*?'document-processing-cache'/,
  );
  assert.match(documentResourceCache, /mkdirSync\(lockPath\)/);
  assert.match(documentResourceCache, /lockedEntryDigest\(entry\)/);
  assert.doesNotMatch(packageJson.scripts.clean, /document-processing-cache/);
  assert.match(documentResourceScript, /`MyAgents\/\$\{appVersion\}`/);
  assert.match(documentResourceScript, /WINDOWS_SIGNTOOL_PATH/);
  assert.match(documentResourceScript, /WINDOWS_CERTIFICATE_SHA1/);
  assert.match(documentResourceScript, /'authenticode'/);
  assert.match(documentResourceScript, /artifactSource/);
  assert.match(documentResourceScript, /signing/);
  const windowsSignAt = documentResourceScript.search(
    /'sign',\s*'\/fd',\s*'SHA256'/,
  );
  const manifestWriteAt = documentResourceScript.search(
    /writeFileSync\(\s*join\(stageRoot, 'manifest\.json'\)/,
  );
  assert.ok(
    windowsSignAt >= 0 &&
      manifestWriteAt >= 0 &&
      windowsSignAt < manifestWriteAt,
    'Windows native resources must be signed before manifest hashes are committed',
  );
  assert.match(syncVersionScript, /src-tauri\/document-worker\/Cargo\.toml/);
  assert.match(documentWorkerSmoke, /protocolVersion: 3/);
  assert.match(
    documentWorkerSmoke,
    /message\.type === ["']ocr_lease_requested["']/,
  );
  assert.match(documentWorkerSmoke, /resourceManifestPath: manifestPath/);
  assert.match(documentWorkerSmoke, /onnxRuntimePath/);
  assert.match(documentWorkerSmoke, /message\.type === ["']ready["']/);
  assert.match(documentWorkerSmoke, /message\.type === ["']completed["']/);
  assert.equal(
    tauriConfig.bundle.resources['../src-tauri/resources/document-processing'],
    'document-processing',
  );
});

test('speech inference builds a signed exact native inventory around the shared ORT', () => {
  const speech = documentResourceLock.speechInference;
  assert.equal(speech.adapterAbiVersion, 2);
  assert.equal(speech.sherpaOnnxVersion, '1.13.6');
  assert.match(speech.sherpaOnnxCommit, /^[0-9a-f]{40}$/);
  assert.equal(speech.onnxRuntimeVersion, '1.28.0');
  assert.equal(speech.opus2Version, '0.4.0');
  assert.equal(speech.libopusSysVersion, '0.3.3');
  assert.equal(speech.numTraitsVersion, '0.2.19');
  assert.equal(speech.sonoraVersion, '0.2.0');
  assert.equal(speech.rubatoVersion, '0.16.2');
  assert.equal(speech.nativeIncrementHardLimitBytes, 80 * 1024 * 1024);
  assert.match(speech.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    speech.source.archiveRoot,
    `sherpa-onnx-${speech.sherpaOnnxCommit}`,
  );
  assert.deepEqual(speech.dependencies.map(({ id }) => id).sort(), [
    'eigen',
    'hclust-cpp',
    'kaldi-decoder',
    'kaldi-native-fbank',
    'kaldifst',
    'kissfft',
    'nlohmann-json',
    'openfst',
    'simple-sentencepiece',
  ]);
  for (const dependency of speech.dependencies) {
    assert.match(dependency.sha256, /^[0-9a-f]{64}$/);
    assert.ok(dependency.size > 0);
    assert.ok(dependency.license);
    assert.ok(dependency.upstreamRevision);
  }

  assert.match(speechResourceScript, /acquireLockedResource/);
  assert.match(speechResourceScript, /validateDocumentRuntimeDescriptor/);
  assert.match(speechResourceScript, /extractSherpaBuildSource/);
  assert.match(speechResourceScript, /nativeIncrementHardLimitBytes/);
  assert.match(speechResourceScript, /SHERPA_ONNXRUNTIME_LIB_DIR/);
  assert.match(speechResourceScript, /SHERPA_ONNX_BUILD_C_API_EXAMPLES=OFF/);
  assert.match(
    speechResourceScript,
    /CMAKE_CXX_FLAGS_INIT=-DSHERPA_ONNX_DISABLE_COREML=1/,
  );
  assert.doesNotMatch(speechResourceScript, /-DCMAKE_CXX_FLAGS=/);
  assert.match(
    speechResourceScript,
    /if \(targetLock\.platform === 'windows'\) \{\s+patchHclustWindowsFenvPragma\(hclustIncludeRoot\);/,
  );
  assert.ok(
    speechResourceScript.indexOf('patchHclustWindowsFenvPragma(hclustIncludeRoot)') <
      speechResourceScript.indexOf("'--build'"),
  );
  assert.match(speechResourceScript, /--target[\s\S]*sherpa-onnx-c-api/);
  assert.match(speechResourceScript, /signNativeFiles/);
  assert.doesNotMatch(
    speechResourceScript,
    /stageRoot[\s\S]{0,200}onnxruntime\.(?:dll|dylib|so)/i,
  );
  assert.equal(
    tauriConfig.bundle.resources['../src-tauri/resources/speech-inference'],
    'speech-inference',
  );
});

test('Cuse uses the complete Skill bundle while retired MCP sidecar stays absent', () => {
  const tauri = JSON.parse(readFileSync(resolve(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.ok(!(tauri.bundle.externalBin ?? []).some(binary => binary.includes('cuse')));
  for (const source of [setupUnix, setupWindows, buildMacos, buildWindows, buildDev, buildDevWindows]) {
    assert.doesNotMatch(source, /download_cuse|binaries[/\\]cuse|EXTBIN_DIR/);
  }
});


test('all native build entrypoints prepare Cuse for the explicit target', () => {
  for (const source of [buildDev, buildMacos, buildLinux, buildWindows, buildDevWindows]) {
    assert.match(source, /prepare-cuse-bundle\.mjs/);
    assert.ok(source.indexOf('prepare-cuse-bundle.mjs') < source.lastIndexOf('npm run tauri:build'));
  }
  assert.match(buildMacos, /prepare-cuse-bundle\.mjs" "\$TARGET"/);
  assert.match(buildDev, /prepare-cuse-bundle\.mjs" "\$DEV_NATIVE_TARGET"/);
  for (const source of [buildWindows, buildDevWindows]) {
    assert.match(source, /prepare-cuse-bundle\.mjs" "x86_64-pc-windows-msvc"/);
    assert.match(source, /if \(\$LASTEXITCODE -ne 0\) \{ throw "Cuse Skill\+CLI preparation failed" \}/);
  }
  for (const source of [buildMacos, buildDev]) {
    assert.match(source, /codesign --force --options runtime --timestamp --sign "\$APPLE_SIGNING_IDENTITY" "\$\{PROJECT_DIR\}\/bundled-skills\/cuse\/scripts\/cuse"/);
  }
  assert.equal(tauriConfig.bundle.resources['../bundled-skills'], 'bundled-skills');
});


test('setup, local builds and CI share signed CLIProxy preparation without a publication cache', () => {
  for (const name of ['setup.sh', 'setup_windows.ps1', 'build_dev.sh', 'build_dev_win.ps1', 'build_macos.sh', 'build_windows.ps1', '.github/workflows/test.yml']) {
    const text = readFileSync(resolve(repoRoot, name), 'utf8');
    assert.match(text, /scripts[\\/]prepare-cliproxy\.mjs/, name);
    assert.doesNotMatch(text, /package-cliproxy-component\.mjs["']? stage|cliproxy-cache[\\/]distribution/, name);
  }
  assert.match(speechResourceScript, /-DBUILD_TESTING=\$\{speechNativeTestPlan\(target\)\.buildTesting\}/);
  assert.match(speechResourceScript, /runSpeechNativeTests\(\{ target, buildDir: adapterBuild/);
});


test('macOS signs all staged DSH Mach-O resources before bundling', t => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-dsh-signing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const staging = join(root, 'src-tauri/resources/integrated-runtimes/dsh');
  const paths = ['bin/rg', 'prebuilds/spawn-helper', 'native/pty.node', 'lib/with space.dylib'];
  // A real Mach-O header lets file(1) classify binaries without executing them.
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  for (const path of [...paths, 'runtime.js']) {
    const absolute = join(staging, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, path === 'runtime.js' ? 'export {};' : header);
  }
  const tools = join(root, 'tools');
  mkdirSync(tools);
  const signer = join(tools, 'codesign');
  writeFileSync(signer, '#!/bin/bash\n[[ "$1 $2 $3 $4 $5 $6" == "--force --options runtime --timestamp --sign Test Developer ID" ]] || exit 2\nprintf "%s\n" "$7" >> "$SIGN_LOG"\n');
  chmodSync(signer, 0o755);
  const signFunction = buildMacos.match(/^sign_dsh_runtime\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(signFunction);
  const result = spawnSync('bash', ['-c', `${signFunction}\nsign_dsh_runtime`], { encoding: 'utf8', env: {
    ...process.env, PATH: `${tools}:${process.env.PATH}`, PROJECT_DIR: root,
    APPLE_SIGNING_IDENTITY: 'Test Developer ID', SIGN_LOG: join(root, 'signed'),
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(join(root, 'signed'), 'utf8').trim().split('\n').sort(), paths.map(path => join(staging, path)).sort());
  writeFileSync(signer, '#!/bin/bash\nexit 1\n');
  const failed = spawnSync('bash', ['-c', `${signFunction}\nsign_dsh_runtime`], { env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, PROJECT_DIR: root } });
  assert.equal(failed.status, 1, 'a failed native signature must stop the release build');
  const prepareAt = buildMacos.indexOf('--source release --target "darwin-${NODE_TARGET_ARCH}"');
  const signAt = buildMacos.indexOf('    sign_dsh_runtime', prepareAt);
  assert.ok(signAt > prepareAt && signAt < buildMacos.indexOf('tauri:build:prepared', prepareAt));
});

test('macOS restores a coherent host Node, DSH and business bundle after cross-target builds', async t => {
  const restoreStart = buildMacos.lastIndexOf('\nif [[ "$(uname -m)" == "arm64" ]]; then');
  const restoreEnd = buildMacos.indexOf('\n# 检查输出', restoreStart);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
  assert.match(buildMacos, /^set -e$/m);
  const restore = buildMacos.slice(restoreStart, restoreEnd);

  for (const scenario of [
    { host: 'arm64', target: 'darwin-arm64', previous: 'darwin-x64' },
    { host: 'x86_64', target: 'darwin-x64', previous: 'darwin-arm64' },
    { host: 'arm64', target: 'darwin-arm64', previous: 'darwin-x64', failDsh: true },
  ]) {
    await t.test(`${scenario.host}${scenario.failDsh ? ' with failed DSH preparation' : ''}`, t => {
      const root = mkdtempSync(join(tmpdir(), 'myagents-host-staging-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const tools = join(root, 'tools');
      mkdirSync(tools);
      mkdirSync(join(root, 'scripts'));
      const executable = (path, body) => {
        writeFileSync(path, `#!/bin/bash\nset -e\n${body}\n`);
        chmodSync(path, 0o755);
      };
      executable(join(tools, 'uname'), 'printf "%s\\n" "$TEST_HOST_ARCH"');
      executable(join(root, 'scripts/download_nodejs.sh'), `
[[ "$1" == "--target" ]] || exit 2
printf 'darwin-%s' "$2" > "$PROJECT_DIR/node.target"`);
      executable(join(tools, 'node'), `
case "$1" in
  "$PROJECT_DIR/scripts/integrated-runtimes/prepare-dsh-runtime.mjs")
    [[ "$2 $3 $4" == "--source release --target" ]] || exit 2
    [[ "$TEST_FAIL_DSH" != "1" ]] || exit 23
    printf '%s' "$5" > "$PROJECT_DIR/dsh.target"
    ;;
  "$PROJECT_DIR/scripts/prepare-cliproxy.mjs")
    printf '%s' "$2" > "$PROJECT_DIR/cliproxy.target"
    ;;
  *) exit 2 ;;
esac`);
      executable(join(tools, 'npm'), `
[[ "$*" == "run build:assets" ]] || exit 2
[[ "$(cat "$PROJECT_DIR/node.target")" == "$(cat "$PROJECT_DIR/dsh.target")" ]] || exit 3
cp "$PROJECT_DIR/dsh.target" "$PROJECT_DIR/assets.target"`);
      for (const resource of ['node', 'dsh', 'assets', 'cliproxy']) {
        writeFileSync(join(root, `${resource}.target`), scenario.previous);
      }
      const result = spawnSync('bash', ['-c', `set -e\n${restore}`], {
        cwd: root, encoding: 'utf8', env: {
          ...process.env, PATH: `${tools}:${process.env.PATH}`, PROJECT_DIR: root,
          TEST_HOST_ARCH: scenario.host, TEST_FAIL_DSH: scenario.failDsh ? '1' : '0',
        },
      });
      assert.equal(result.status, scenario.failDsh ? 23 : 0, result.stderr);
      for (const resource of ['node', 'dsh', 'assets', 'cliproxy']) {
        const expected = scenario.failDsh && resource !== 'node' ? scenario.previous : scenario.target;
        assert.equal(readFileSync(join(root, `${resource}.target`), 'utf8'), expected, resource);
      }
    });
  }
});
