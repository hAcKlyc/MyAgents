# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-01-23

### Added

- Initial open source release
- Native macOS desktop application with Tauri v2
- Multi-tab support with independent Sidecar processes
- Multi-project management
- Claude Agent SDK integration
- Support for multiple AI providers:
  - Anthropic (Claude Sonnet/Haiku/Opus 4.5)
  - DeepSeek
  - Moonshot (Kimi)
  - Zhipu AI
  - MiniMax
  - Volcengine
  - OpenRouter
- Slash Commands (built-in and custom)
- MCP integration (STDIO/HTTP/SSE)
- Tool permission management (Act/Plan/Auto modes)
- Visual configuration editor for CLAUDE.md, Skills, and Commands
- Keyboard shortcuts (Cmd+T, Cmd+W)
- Local data storage in `~/.myagents/`

### Technical

- React 19 + TypeScript frontend
- Bun runtime bundled in app
- Rust HTTP/SSE proxy layer
- Chrome-style frameless window
