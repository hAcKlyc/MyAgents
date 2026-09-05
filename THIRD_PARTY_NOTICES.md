# Third-Party Notices / 第三方声明

## English

MyAgents includes, distributes, or integrates with third-party software, SDKs,
runtimes, Skills, plugins, assets, and online services. The adoption of
`AGPL-3.0-only` for MyAgents-owned components does not alter the licenses or
terms applicable to those third-party materials, and a MyAgents commercial
license does not automatically license them.

### Principal separately licensed components

| Component | Applicable license or terms |
|---|---|
| Anthropic Claude Agent SDK and native binaries | Applicable Anthropic legal agreements; see the `LICENSE.md` distributed with the SDK |
| Node.js and npm | Their respective licenses and the licenses of included third-party components |
| OpenClaw Plugin SDK-derived shim | MIT License; Copyright © 2026 OpenClaw Foundation |
| OpenAI Codex runtime | Apache License 2.0 |
| Playwright MCP, Playwright, and optional Chromium downloaded directly from the official Chrome for Testing / Playwright distribution | Apache License 2.0 for Playwright; Chromium and bundled third-party components retain the notices shipped in the official archive |
| sharp | Apache License 2.0 |
| libvips distributed with sharp platform packages | LGPL-3.0-or-later |
| SheetJS `xlsx` | Apache License 2.0 |
| AnyDoc, pdf-inspector, and office-crypto document parsers | MIT License |
| PP-OCRv6 Small ONNX models and PaddleOCR dictionary | Apache License 2.0 |
| ONNX Runtime CPU | MIT License |
| Opus audio codec (bundled through `libopus_sys`) | 3-clause BSD-style license; Copyright 2001-2023 Xiph.Org, Skype Limited, Octasic, and other contributors identified in the bundled `COPYING` file |
| PDFium and its Chromium third-party components | BSD-style and the licenses identified by the accompanying PDFium/Chromium notices |
| Tauri, React, and other npm or Cargo dependencies | Licenses declared by the respective packages |
| User-installed Skills, plugins, MCP servers, and external runtimes | Licenses or service terms specified by their respective publishers |

Any separately distributed `LICENSE`, `LICENSE.txt`, `COPYING`, or `NOTICE`
file remains controlling for the material it accompanies and must be preserved
where required. License and notice files accompanying bundled Node.js, npm,
sharp runtime, SDKs, Skills, Plugin Bridge shims, or other resources must also
be retained in redistributed builds as required by their respective terms.

MyAgents may connect to Anthropic, OpenAI, Google, Lark/Feishu, DingTalk,
Telegram, WeCom, and other third-party platforms. The MyAgents license does not
grant accounts, API rights, model access, data rights, service rights, or
trademark rights in those platforms.

This document identifies principal licensing boundaries; it is not an
exhaustive software bill of materials or a substitute for release-specific
license review. Distributors should review the lockfiles, target-platform
packages, build inputs, and final artifacts for each release and, where
appropriate, generate and retain a software bill of materials (SBOM).

### Language

The Chinese text below is provided for convenience. If the English and Chinese
texts differ, the English text prevails to the extent permitted by applicable
law. The original third-party license or terms prevail in all cases.

## 中文

MyAgents 包含、分发或集成第三方软件、SDK、运行时、Skills、插件、素材和在线服务。MyAgents 自有
组件采用 `AGPL-3.0-only` 不会改变适用于这些第三方材料的许可或条款，MyAgents 商业许可
也不会自动授权这些材料。

### 主要独立授权组件

| 组件 | 适用许可或条款 |
|---|---|
| Anthropic Claude Agent SDK 及原生二进制文件 | Anthropic 适用的法律协议；参见随 SDK 分发的 `LICENSE.md` |
| Node.js 与 npm | 各自的许可及所含第三方组件的许可 |
| 派生自 OpenClaw Plugin SDK 的 shim | MIT License；Copyright © 2026 OpenClaw Foundation |
| OpenAI Codex runtime | Apache License 2.0 |
| Playwright MCP、Playwright，以及从 Chrome for Testing / Playwright 官方分发按需下载的 Chromium | Playwright 使用 Apache License 2.0；Chromium 及其第三方组件保留官方归档随附的许可与声明 |
| sharp | Apache License 2.0 |
| 随 sharp 平台包分发的 libvips | LGPL-3.0-or-later |
| SheetJS `xlsx` | Apache License 2.0 |
| AnyDoc、pdf-inspector 与 office-crypto 文档解析器 | MIT License |
| PP-OCRv6 Small ONNX 模型与 PaddleOCR 字典 | Apache License 2.0 |
| ONNX Runtime CPU | MIT License |
| Opus 音频编解码器（通过 `libopus_sys` 内置） | 三条款 BSD-style 许可；Copyright 2001-2023 Xiph.Org、Skype Limited、Octasic 及内置 `COPYING` 文件列明的其他贡献者 |
| PDFium 及其 Chromium 第三方组件 | BSD-style 及随附 PDFium/Chromium 声明中列明的许可 |
| Tauri、React 及其他 npm 或 Cargo 依赖 | 各软件包声明的许可 |
| 用户安装的 Skills、插件、MCP servers 及外部运行时 | 各发布者声明的许可或服务条款 |

任何单独分发的 `LICENSE`、`LICENSE.txt`、`COPYING` 或 `NOTICE` 文件，对其所附材料具有优先效力，
并应在相关条款要求的范围内予以保留。随内置 Node.js、npm、sharp runtime、SDK、Skills、Plugin Bridge shim
或其他资源提供的许可和声明文件，也必须按其各自条款在再分发构建中保留。

MyAgents 可能连接 Anthropic、OpenAI、Google、飞书/Lark、钉钉、Telegram、企业微信及其他第三方平台。
MyAgents 许可不授予这些平台的账号、API、模型、数据、服务或商标权利。

本文件用于说明主要许可边界，并非穷尽的软件物料清单，也不替代针对具体发行版本的许可审查。
分发者应审查每次发行的 lockfile、目标平台软件包、构建输入和最终产物，并在适当情况下生成和保留
软件物料清单（SBOM）。

### 语言与效力

上述英文文本为主要解释文本，中文仅为阅读便利而提供。如中英文存在不一致，在适用法律允许的
范围内以英文为准。在任何情况下，第三方许可或条款的原文均优先。
