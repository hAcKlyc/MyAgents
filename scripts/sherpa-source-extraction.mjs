import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SHERPA_BUILD_MEMBERS = Object.freeze([
  'CMakeLists.txt',
  'LICENSE',
  'cmake',
  'sherpa-onnx',
]);

const WINDOWS_ORT_IMPORT_BROKEN = `    elseif(WIN32)
      if(SHERPA_ONNX_ENABLE_GPU)
        set(location_onnxruntime_lib $ENV{SHERPA_ONNXRUNTIME_LIB_DIR}/onnxruntime.dll)
        set(location_onnxruntime_lib2 $ENV{SHERPA_ONNXRUNTIME_LIB_DIR}/onnxruntime.lib)
      else()
        set(location_onnxruntime_lib $ENV{SHERPA_ONNXRUNTIME_LIB_DIR}/onnxruntime.lib)
        if(SHERPA_ONNX_ENABLE_DIRECTML)
          include(onnxruntime-win-x64-directml)
        endif()
      endif()
`;

const WINDOWS_ORT_IMPORT_FIXED = `    elseif(WIN32)
      set(location_onnxruntime_lib $ENV{SHERPA_ONNXRUNTIME_LIB_DIR}/onnxruntime.dll)
      set(location_onnxruntime_lib2 $ENV{SHERPA_ONNXRUNTIME_LIB_DIR}/onnxruntime.lib)
      if(SHERPA_ONNX_ENABLE_DIRECTML)
        include(onnxruntime-win-x64-directml)
      endif()
`;

function requireEntry(path, kind) {
  const metadata = lstatSync(path);
  const valid =
    !metadata.isSymbolicLink() &&
    (kind === 'file' ? metadata.isFile() : metadata.isDirectory());
  if (!valid) {
    throw new Error(`Sherpa build source ${kind} is unavailable: ${path}`);
  }
}

export function patchSherpaWindowsOnnxRuntimeImport(sourceRoot) {
  const cmakePath = join(sourceRoot, 'cmake', 'onnxruntime.cmake');
  requireEntry(cmakePath, 'file');
  const source = readFileSync(cmakePath, 'utf8');
  if (source.includes(WINDOWS_ORT_IMPORT_FIXED)) {
    return false;
  }
  const firstMatch = source.indexOf(WINDOWS_ORT_IMPORT_BROKEN);
  if (
    firstMatch < 0 ||
    source.indexOf(WINDOWS_ORT_IMPORT_BROKEN, firstMatch + 1) >= 0
  ) {
    throw new Error(
      'Locked Sherpa ONNX Runtime CMake no longer matches the expected Windows CPU import block',
    );
  }
  writeFileSync(
    cmakePath,
    source.replace(WINDOWS_ORT_IMPORT_BROKEN, WINDOWS_ORT_IMPORT_FIXED),
    'utf8',
  );
  return true;
}

export function patchHclustWindowsFenvPragma(sourceRoot) {
  const sourcePath = join(sourceRoot, 'fastcluster_dm.cpp');
  requireEntry(sourcePath, 'file');
  const source = readFileSync(sourcePath, 'utf8');
  const original = '#pragma STDC FENV_ACCESS on';
  // The locked upstream explicitly allows ignoring this pragma. MSVC already
  // ignores it with C4068; omit only the unsupported directive, keeping fenv
  // includes/checks and the directive for other compilers intact.
  const patched = `#ifndef _MSC_VER\n${original}\n#endif`;
  if (source.includes(patched)) {
    return false;
  }
  const firstMatch = source.indexOf(original);
  if (firstMatch < 0 || source.indexOf(original, firstMatch + 1) >= 0) {
    throw new Error(
      'Locked hclust source no longer matches the expected FENV_ACCESS pragma',
    );
  }
  writeFileSync(sourcePath, source.replace(original, patched), 'utf8');
  return true;
}

export function extractSherpaBuildSource({
  archive,
  destination,
  archiveRoot,
  runTar = execFileSync,
}) {
  if (!/^[A-Za-z0-9._-]+$/.test(archiveRoot ?? '')) {
    throw new Error('Sherpa source lock has an invalid archive root');
  }
  requireEntry(archive, 'file');
  mkdirSync(destination, { recursive: true });
  runTar(
    'tar',
    [
      '-xf',
      archive,
      '-C',
      destination,
      ...SHERPA_BUILD_MEMBERS.map((member) => `${archiveRoot}/${member}`),
    ],
    { stdio: 'inherit' },
  );

  const sourceRoot = join(destination, archiveRoot);
  requireEntry(join(sourceRoot, 'CMakeLists.txt'), 'file');
  requireEntry(join(sourceRoot, 'LICENSE'), 'file');
  requireEntry(join(sourceRoot, 'cmake'), 'directory');
  requireEntry(join(sourceRoot, 'sherpa-onnx'), 'directory');
  requireEntry(join(sourceRoot, 'sherpa-onnx', 'CMakeLists.txt'), 'file');
  return sourceRoot;
}
