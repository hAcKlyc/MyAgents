/**
 * 同步版本号到 Tauri 配置文件
 * 由 npm version 钩子自动调用
 *
 * 数据源: package.json (单一数据源)
 * 同步目标: 两份 Tauri 配置、App Cargo.toml、Document Worker Cargo.toml
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// 读取 package.json 的版本号
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
const version = packageJson.version;

// 校验版本号格式 (semver: x.y.z)
if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`错误: 版本号格式无效 "${version}"，应为 x.y.z`);
    process.exit(1);
}

console.log(`同步版本号: ${version}`);

// Both configs are used for real builds: the MoxBots product build overrides
// the generic MyAgents Tauri config with tauri.moxbot.conf.json.
for (const relativePath of ['src-tauri/tauri.conf.json', 'src-tauri/tauri.moxbot.conf.json']) {
    const configPath = join(rootDir, relativePath);
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.version = version;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log(`  ✓ ${relativePath}`);
}

// 更新 Cargo.toml
const cargoPath = join(rootDir, 'src-tauri/Cargo.toml');
let cargoContent = readFileSync(cargoPath, 'utf-8');
cargoContent = cargoContent.replace(
    /^version = "[0-9]+\.[0-9]+\.[0-9]+"/m,
    `version = "${version}"`
);
writeFileSync(cargoPath, cargoContent, 'utf-8');
console.log('  ✓ src-tauri/Cargo.toml');

// 独立 Document Worker 随 App 同版本发布，也必须跟随唯一版本源。
const workerCargoPath = join(rootDir, 'src-tauri/document-worker/Cargo.toml');
let workerCargoContent = readFileSync(workerCargoPath, 'utf-8');
workerCargoContent = workerCargoContent.replace(
    /^version = "[0-9]+\.[0-9]+\.[0-9]+"/m,
    `version = "${version}"`
);
writeFileSync(workerCargoPath, workerCargoContent, 'utf-8');
console.log('  ✓ src-tauri/document-worker/Cargo.toml');

console.log(`\n版本号已同步到 ${version}`);
