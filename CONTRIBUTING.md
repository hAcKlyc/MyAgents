# Contributing to MyAgents

[English](#english) | [中文](#中文)

---

<a name="english"></a>

## English

Thank you for your interest in contributing to MyAgents! This document provides guidelines and instructions for contributing.

### Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

### How to Contribute

#### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/hAcKlyc/MyAgents/issues)
2. If not, create a new issue with:
   - Clear, descriptive title
   - Steps to reproduce
   - Expected vs actual behavior
   - System information (macOS version, chip type)
   - Screenshots if applicable

#### Suggesting Features

1. Check existing [Issues](https://github.com/hAcKlyc/MyAgents/issues) for similar suggestions
2. Create a new issue with the "Feature Request" label
3. Describe the feature and its use case clearly

#### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes
4. Run checks before committing:
   ```bash
   npm run typecheck
   npm run lint
   ```
5. Commit with conventional commit messages:
   - `feat:` New feature
   - `fix:` Bug fix
   - `docs:` Documentation changes
   - `refactor:` Code refactoring
   - `test:` Adding tests
   - `chore:` Maintenance tasks
6. Push and create a Pull Request

### Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/MyAgents.git
cd MyAgents

# Install dependencies
./setup.sh

# Start development
./start_dev.sh
```

### Project Structure

```
MyAgents/
├── src/
│   ├── renderer/     # React frontend
│   ├── server/       # Bun backend (Sidecar)
│   └── shared/       # Shared types
├── src-tauri/        # Tauri Rust code
└── specs/            # Design documents
```

### Code Style

- Use TypeScript for frontend code
- Follow existing code patterns
- Run `npm run lint` before committing
- Keep components small and focused

### Questions?

Feel free to open an issue or reach out at myagents.io@gmail.com

---

<a name="中文"></a>

## 中文

感谢您有兴趣为 MyAgents 做出贡献！本文档提供贡献指南和说明。

### 行为准则

请阅读并遵守我们的[行为准则](CODE_OF_CONDUCT.md)。

### 如何贡献

#### 报告 Bug

1. 先在 [Issues](https://github.com/hAcKlyc/MyAgents/issues) 中检查是否已有相同报告
2. 如果没有，创建新 issue 并包含：
   - 清晰的标题
   - 复现步骤
   - 预期行为 vs 实际行为
   - 系统信息（macOS 版本、芯片类型）
   - 相关截图

#### 功能建议

1. 先检查 [Issues](https://github.com/hAcKlyc/MyAgents/issues) 中是否有类似建议
2. 使用 "Feature Request" 标签创建新 issue
3. 清晰描述功能及其使用场景

#### Pull Request

1. Fork 仓库
2. 创建功能分支：`git checkout -b feature/your-feature-name`
3. 进行修改
4. 提交前运行检查：
   ```bash
   npm run typecheck
   npm run lint
   ```
5. 使用规范的 commit 信息：
   - `feat:` 新功能
   - `fix:` Bug 修复
   - `docs:` 文档更新
   - `refactor:` 代码重构
   - `test:` 添加测试
   - `chore:` 维护任务
6. 推送并创建 Pull Request

### 开发环境设置

```bash
# 克隆你的 fork
git clone https://github.com/YOUR_USERNAME/MyAgents.git
cd MyAgents

# 安装依赖
./setup.sh

# 启动开发
./start_dev.sh
```

### 项目结构

```
MyAgents/
├── src/
│   ├── renderer/     # React 前端
│   ├── server/       # Bun 后端 (Sidecar)
│   └── shared/       # 共享类型
├── src-tauri/        # Tauri Rust 代码
└── specs/            # 设计文档
```

### 代码风格

- 前端使用 TypeScript
- 遵循现有代码模式
- 提交前运行 `npm run lint`
- 保持组件小而专注

### 有问题？

欢迎创建 issue 或发送邮件至 myagents.io@gmail.com
