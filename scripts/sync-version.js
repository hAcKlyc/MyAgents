/**
 * 同步版本号到 Tauri 配置文件
 * 由 npm version 钩子自动调用
 *
 * 数据源: package.json (单一数据源)
 * 同步目标: src-tauri/tauri.conf.json, src-tauri/Cargo.toml
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

// 更新 tauri.conf.json
const tauriConfPath = join(rootDir, 'src-tauri/tauri.conf.json');
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'));
tauriConf.version = version;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf-8');
console.log('  ✓ src-tauri/tauri.conf.json');

// 更新 Cargo.toml
const cargoPath = join(rootDir, 'src-tauri/Cargo.toml');
let cargoContent = readFileSync(cargoPath, 'utf-8');
cargoContent = cargoContent.replace(
    /^version = "[0-9]+\.[0-9]+\.[0-9]+"/m,
    `version = "${version}"`
);
writeFileSync(cargoPath, cargoContent, 'utf-8');
console.log('  ✓ src-tauri/Cargo.toml');

console.log(`\n版本号已同步到 ${version}`);
