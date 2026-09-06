import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  extractSherpaBuildSource,
  patchHclustWindowsFenvPragma,
  patchSherpaWindowsOnnxRuntimeImport,
} from './sherpa-source-extraction.mjs';

// A tiny tar.gz with the required build tree plus an unrelated symlink. The
// extractor must never ask the host tar to materialize that symlink on Windows.
const ARCHIVE_BASE64 =
  'H4sIAFoPlGoAA+2a3W7TMBiGC5z1KnIDS/0bJweTKGXSKjq0MQmJw6gzNCxNqiSFimMuhDNuZZfEIV4ZyxrqVGldIyXfcxI1P7Ib633f+LMvw9W5DG9kNshnMluEJx+jVbHMZM8gCCHBubM+en+Oir9HhAhGDuaE8fv7KHEQ9ghiPWdlshM6lnkRZqor32bRbFlz39eZlHHN9c0/5Rju5dGgyJkX0VyeYuH7yPcxZy5lGIkAC9LnwpmMXw3fjc7H78/cVVgUmTtN5264WMTSXWTpF5mEyVSeDq/Gw6s3w9ezi8/jxeBTnwXOtXpo8qHuoWfPey9/vPh+d/fzV/9/v4eusqn6wVHa2KX/+x+b+mcUK/3zo/SmQsf1Xxn/y8c4GF2Et3IS5UXuFqvioDbU+/AYa+D/6gT2wP9tsN3/UeAzwn3w/9ZT0b9B1Zfs0j9CvOL/AjHRc5Ch9mvpuP6zNC1AfN1Fm/+T8ejs7fWZiTYa57+aengU8t8GmvkfJgH3If/bT0X/BlVfsjP//9E/pxhB/tsgjqYyySXor6No8386VzMBM200r/+q/If6rxU0+U8QowLyv/1U9L9WvekqcPP6L6cC6r9W0Pr/w4U0SQ624cb+r9yHQf3XChr/p4T5wgP/bz0V/T9RvbkUaO7/Huce+L8NtP6/TDIZh4W8ObyNPfwfewL83wbb/Z8KNRQMg/+3nor+H1Vvcg6wh/8TIcD/baAd/zIJHkqEJ3GU3O7VRnP/J5xB/ccKGv/3Ah9RCv7ferT6P1j1JY39n6gPQNRziOseZ0HqKR3Xf838z9heQNR4/x8lHgL/t4Gu/iMIYQH4f+up0b+xvYC79K9OV/f/Ukxh/d8GicxV2oP8usrW9b8y+Ys0jaezMErcA/YDNM9/9QEA+W8F3fo/xyRgkP+tZ6v+jai+ZHf+e9X6P+UE8t8G6wEG9QEAAHSO30qJaQkAQgAA';

test('selectively extracts the Sherpa build tree without unrelated symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-sherpa-extract-'));
  try {
    const archive = join(root, 'sherpa-fixture.tar.gz');
    const destination = join(root, 'source');
    writeFileSync(archive, Buffer.from(ARCHIVE_BASE64, 'base64'));

    const sourceRoot = extractSherpaBuildSource({
      archive,
      destination,
      archiveRoot: 'sherpa-fixture',
    });

    assert.equal(
      readFileSync(join(sourceRoot, 'CMakeLists.txt'), 'utf8'),
      'root\n',
    );
    assert.equal(
      readFileSync(join(sourceRoot, 'sherpa-onnx', 'CMakeLists.txt'), 'utf8'),
      'nested\n',
    );
    assert.equal(existsSync(join(sourceRoot, 'unrelated')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an archive root that could escape the extraction destination', () => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-sherpa-lock-'));
  try {
    const archive = join(root, 'source.tar.gz');
    writeFileSync(archive, Buffer.from(ARCHIVE_BASE64, 'base64'));
    assert.throws(
      () =>
        extractSherpaBuildSource({
          archive,
          destination: join(root, 'source'),
          archiveRoot: '../outside',
        }),
      /invalid archive root/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('patches the locked Sherpa Windows CPU import to use the DLL and import library pair', () => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-sherpa-ort-import-'));
  const cmakeRoot = join(root, 'cmake');
  const cmakePath = join(cmakeRoot, 'onnxruntime.cmake');
  mkdirSync(cmakeRoot, { recursive: true });
  writeFileSync(
    cmakePath,
    `before\n    elseif(WIN32)
      if(SHERPA_ONNX_ENABLE_GPU)
        set(location_onnxruntime_lib $ENV{SHERPA_ONNXRUNTIME_LIB_DIR}/onnxruntime.dll)
        set(location_onnxruntime_lib2 $ENV{SHERPA_ONNXRUNTIME_LIB_DIR}/onnxruntime.lib)
      else()
        set(location_onnxruntime_lib $ENV{SHERPA_ONNXRUNTIME_LIB_DIR}/onnxruntime.lib)
        if(SHERPA_ONNX_ENABLE_DIRECTML)
          include(onnxruntime-win-x64-directml)
        endif()
      endif()
after\n`,
  );

  try {
    assert.equal(patchSherpaWindowsOnnxRuntimeImport(root), true);
    const patched = readFileSync(cmakePath, 'utf8');
    assert.match(
      patched,
      /set\(location_onnxruntime_lib \$ENV\{SHERPA_ONNXRUNTIME_LIB_DIR\}\/onnxruntime\.dll\)/,
    );
    assert.match(
      patched,
      /set\(location_onnxruntime_lib2 \$ENV\{SHERPA_ONNXRUNTIME_LIB_DIR\}\/onnxruntime\.lib\)/,
    );
    assert.doesNotMatch(patched, /if\(SHERPA_ONNX_ENABLE_GPU\)/);
    assert.equal(patchSherpaWindowsOnnxRuntimeImport(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects Sherpa CMake drift instead of applying an ambiguous patch', () => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-sherpa-ort-drift-'));
  const cmakeRoot = join(root, 'cmake');
  const cmakePath = join(cmakeRoot, 'onnxruntime.cmake');
  mkdirSync(cmakeRoot, { recursive: true });
  writeFileSync(cmakePath, 'unexpected upstream content\n');

  try {
    assert.throws(
      () => patchSherpaWindowsOnnxRuntimeImport(root),
      /no longer matches the expected Windows CPU import block/,
    );
    assert.equal(
      readFileSync(cmakePath, 'utf8'),
      'unexpected upstream content\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('guards only the unsupported hclust pragma on MSVC and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-hclust-pragma-'));
  const sourcePath = join(root, 'fastcluster_dm.cpp');
  const source = 'before\n#pragma STDC FENV_ACCESS on\n#include <fenv.h>\nafter\n';
  writeFileSync(sourcePath, source);
  try {
    assert.equal(patchHclustWindowsFenvPragma(root), true);
    const expected =
      'before\n#ifndef _MSC_VER\n#pragma STDC FENV_ACCESS on\n#endif\n#include <fenv.h>\nafter\n';
    assert.equal(readFileSync(sourcePath, 'utf8'), expected);
    assert.equal(patchHclustWindowsFenvPragma(root), false);
    assert.equal(readFileSync(sourcePath, 'utf8'), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects missing or ambiguous hclust pragmas without changing the source', () => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-hclust-drift-'));
  const sourcePath = join(root, 'fastcluster_dm.cpp');
  try {
    for (const source of [
      'unexpected upstream content\n',
      '#pragma STDC FENV_ACCESS on\n#pragma STDC FENV_ACCESS on\n',
    ]) {
      writeFileSync(sourcePath, source);
      assert.throws(
        () => patchHclustWindowsFenvPragma(root),
        /no longer matches the expected FENV_ACCESS pragma/,
      );
      assert.equal(readFileSync(sourcePath, 'utf8'), source);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
