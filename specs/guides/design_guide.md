# MyAgents Design Guide

> **Version**: 1.3.0
> **Last Updated**: 2026-01-22
> **Status**: Active
> **Platform**: macOS / Windows Desktop Client

---

## 设计理念

MyAgents 是一款 AI Agent 桌面客户端，采用**温暖纸张质感**的设计风格，营造舒适、专业的使用体验。

### 核心原则

- **易读有质感** - AI 生成大量内容，阅读体验是第一优先级
- **逻辑清晰有重点** - 不同内容块有明确的视觉层级，用户能快速定位关键信息
- **统一有秩序** - 所有页面、所有内容类型遵循相同的设计语言
- **温暖亲和** - 奶油白背景配合暖棕色文字，长时间使用不疲劳

### 产品特性考量

作为 AI Agent 产品，设计需特别关注：
- **长文本阅读** - AI 回复通常较长，需优化行高、段落间距
- **多种内容块** - 普通文本、代码、工具调用、思考过程等需要清晰区分
- **信息密度平衡** - 既要展示完整信息，又不能让用户感到压迫
- **跨平台一致性** - macOS 和 Windows 保持相同的视觉体验

---

## 1. 颜色系统 (Colors)

### 1.1 核心色板

#### Ink (文字色)
| Token | 值 | 用途 |
|-------|------|------|
| `--ink` | `#1c1612` | 主文字、标题 |
| `--ink-secondary` | `#3a3532` | 次级标题、重要内容 |
| `--ink-muted` | `#6f6156` | 辅助文字、描述、placeholder |
| `--ink-subtle` | `#9a8d82` | 弱化文字、时间戳、提示 |

#### Paper (背景色)
| Token | 值 | 用途 |
|-------|------|------|
| `--paper` | `#f6efe5` | 主背景 |
| `--paper-elevated` | `#fdf8f1` | 卡片、弹层背景 |
| `--paper-inset` | `#efe6d9` | 输入框内部、hover 状态 |
| `--paper-subtle` | `#f8f5ef` | 阅读区域背景 |

#### Accent (强调色)
| Token | 值 | 用途 |
|-------|------|------|
| `--accent-warm` | `#c26d3a` | 暖强调色（链接、高亮） |
| `--accent-warm-hover` | `#e18a58` | 暖强调 hover |
| `--accent-cool` | `#2e6f5e` | 冷强调色（文件夹、标签） |
| `--accent-cool-hover` | `#3d8a75` | 冷强调 hover |

#### Border (边框)
| Token | 值 | 用途 |
|-------|------|------|
| `--line` | `rgb(28 22 18 / 0.10)` | 默认边框 |
| `--line-strong` | `rgb(28 22 18 / 0.18)` | 强调边框、hover 边框 |
| `--line-subtle` | `rgb(28 22 18 / 0.06)` | 弱化边框、分割线 |

### 1.2 语义色 (Semantic Colors)

用于状态反馈，需谨慎使用，避免页面过于花哨。

| Token | 值 | 背景色 | 用途 |
|-------|------|-------|------|
| `--success` | `#16a34a` | `#dcfce7` | 成功、已启用、已完成 |
| `--error` | `#dc2626` | `#fee2e2` | 错误、失败、危险操作 |
| `--warning` | `#d97706` | `#fef3c7` | 警告、需注意 |
| `--info` | `#2563eb` | `#dbeafe` | 信息提示、加载中 |

**使用原则**：
- 语义色仅用于状态指示，不作为装饰
- 优先使用图标+文字，颜色作为辅助
- 背景色用于 toast、badge，主色用于图标、文字

### 1.3 按钮专用色

| Token | 值 | 用途 |
|-------|------|------|
| `--button-primary-bg` | `#1c1612` | 主按钮背景 |
| `--button-primary-bg-hover` | `#3a3532` | 主按钮 hover |
| `--button-primary-text` | `#ffffff` | 主按钮文字 |
| `--button-secondary-bg` | `#efe6d9` | 次按钮背景 |
| `--button-secondary-bg-hover` | `#e4ddd0` | 次按钮 hover |
| `--button-secondary-text` | `#1c1612` | 次按钮文字 |

---

## 2. 字体系统 (Typography)

### 2.1 字体族

跨平台字体策略：macOS 优先使用系统字体，Windows 使用对应的系统字体作为 fallback。

```css
:root {
  /* 英文字体 - macOS: SF Pro, Windows: Segoe UI */
  --font-sans: 'SF Pro Text', 'SF Pro Display', -apple-system,
               'Segoe UI', BlinkMacSystemFont, sans-serif;

  /* 中文字体 - macOS: 苹方, Windows: 微软雅黑 */
  --font-chinese: 'PingFang SC', 'Microsoft YaHei',
                  'Hiragino Sans GB', sans-serif;

  /* 等宽字体 - 跨平台 */
  --font-mono: 'SF Mono', 'Cascadia Code', 'Consolas',
               'Monaco', 'Fira Code', monospace;

  /* 组合使用 - 英文字体在前确保英文使用英文字体 */
  --font-body: var(--font-sans), var(--font-chinese);
  --font-display: var(--font-sans), var(--font-chinese);
}
```

**平台字体映射**：
| 用途 | macOS | Windows |
|------|-------|---------|
| 英文正文 | SF Pro Text | Segoe UI |
| 英文标题 | SF Pro Display | Segoe UI |
| 中文 | PingFang SC (苹方) | Microsoft YaHei (微软雅黑) |
| 等宽/代码 | SF Mono | Cascadia Code / Consolas |

### 2.2 字号层级 (Type Scale)

基于 **16px** 作为 AI 回复正文的基准字号设计，确保长文本阅读的舒适性。

| Token | 大小 | 行高 | 用途 |
|-------|------|------|------|
| `--text-2xs` | 10px | 1.4 | 极小辅助文字（谨慎使用） |
| `--text-xs` | 11px | 1.4 | 时间戳、状态标签、badge |
| `--text-sm` | 13px | 1.5 | **工具栏按钮**、标签、次要内容、工具名 |
| `--text-base` | 14px (text-sm in Tailwind) | 1.5 | 导航按钮、主要按钮文字 |
| `--text-md` | 16px | 1.6 | **正文主体** - AI 回答内容 |
| `--text-lg` | 18px | 1.5 | H3 标题 |
| `--text-xl` | 20px | 1.4 | H2 标题 |
| `--text-2xl` | 22px | 1.3 | H1 标题 |
| `--text-3xl` | 28px | 1.2 | 页面大标题 |
| `--text-brand` | 56px | 1.1 | 品牌名（移动端 48px） |

**字号使用原则**：
- AI 回复的 Markdown 正文使用 16px，确保阅读舒适
- 工具栏按钮（ghost button）使用 13px，配合 h-3.5 w-3.5 图标
- 主按钮/导航按钮使用 14px (text-sm)
- 时间戳、状态等辅助信息使用 11px
- Markdown 标题：H1=22px, H2=20px, H3=18px, H4-H6=16px

### 2.3 字重

| Token | 值 | 用途 |
|-------|------|------|
| `--font-light` | 300 | 品牌大字、slogan |
| `--font-normal` | 400 | 正文 |
| `--font-medium` | 500 | 小标题、标签、按钮 |
| `--font-semibold` | 600 | 标题、重要内容 |
| `--font-bold` | 700 | 强调（谨慎使用） |

### 2.4 字间距

| Token | 值 | 用途 |
|-------|------|------|
| `--tracking-tight` | -0.02em | 大标题 |
| `--tracking-normal` | 0 | 正文 |
| `--tracking-wide` | 0.04em | 小标签、slogan |
| `--tracking-wider` | 0.08em | 大写标签（如 "AGENT UI"） |

---

## 3. 间距系统 (Spacing)

采用 4px 基准网格。

| Token | 值 | 用途示例 |
|-------|------|---------|
| `--space-0.5` | 2px | 图标与文字间距 |
| `--space-1` | 4px | 紧凑元素间距 |
| `--space-1.5` | 6px | 按钮内边距（垂直） |
| `--space-2` | 8px | 小组件间距、列表项间距 |
| `--space-3` | 12px | 组件内边距 |
| `--space-4` | 16px | 卡片内边距、区块间距 |
| `--space-5` | 20px | 区块内边距 |
| `--space-6` | 24px | 大区块间距 |
| `--space-8` | 32px | 页面边距、大分隔 |
| `--space-10` | 40px | 区域分隔 |
| `--space-12` | 48px | 页面区块分隔 |

---

## 4. 圆角系统 (Border Radius)

| Token | 值 | 用途 |
|-------|------|------|
| `--radius-sm` | 6px | 小按钮、输入框、标签 |
| `--radius-md` | 10px | 按钮、下拉菜单 |
| `--radius-lg` | 14px | 卡片、弹层 |
| `--radius-xl` | 20px | 大卡片、面板 |
| `--radius-2xl` | 24px | 模态框、全屏面板 |
| `--radius-full` | 9999px | 胶囊按钮、头像 |

---

## 5. 阴影系统 (Shadows)

| Token | 值 | 用途 |
|-------|------|------|
| `--shadow-xs` | `0 1px 2px rgb(28 22 18 / 0.05)` | 微弱提升感 |
| `--shadow-sm` | `0 2px 8px rgb(28 22 18 / 0.08)` | 按钮、小卡片 |
| `--shadow-md` | `0 8px 24px rgb(28 22 18 / 0.12)` | 下拉菜单、弹层 |
| `--shadow-lg` | `0 16px 40px rgb(28 22 18 / 0.16)` | 模态框、浮层 |
| `--shadow-xl` | `0 24px 48px rgb(28 22 18 / 0.20)` | 全屏面板 |

---

## 6. 组件规范

### 6.1 按钮 (Buttons)

#### 按钮尺寸规范

| 类型 | 字号 | 内边距 | 图标尺寸 | 圆角 | 场景 |
|------|------|--------|---------|------|------|
| 大按钮 | 14px | py-2.5 px-5 | h-4 w-4 | radius-full | 主要 CTA |
| 中按钮 | 14px | py-2 px-4 | h-3.5 w-3.5 | radius-lg | 表单提交、弹窗操作 |
| 小按钮 | 13px | py-1.5 px-3 | h-3.5 w-3.5 | radius-md | 卡片内操作 |
| 工具栏按钮 | 13px | py-1.5 px-2.5 | h-3.5 w-3.5 | radius-lg | 页头工具栏、输入框工具栏 |

#### 主按钮 (Primary)
```
背景: var(--button-primary-bg)
文字: var(--button-primary-text)
圆角: var(--radius-md) 或 var(--radius-full)
内边距: py-2 px-4 (中) | py-2.5 px-5 (大)
字号: 14px (text-sm) font-medium
图标: h-3.5 w-3.5
```

#### 次按钮 (Secondary)
```
背景: var(--button-secondary-bg)
文字: var(--button-secondary-text)
边框: 1px solid var(--line)
圆角: 同主按钮
内边距: 同主按钮
```

#### Ghost/工具栏按钮
```
背景: transparent
文字: var(--ink-muted)
圆角: var(--radius-lg)
内边距: py-1.5 px-2.5
字号: 13px font-medium
图标: h-3.5 w-3.5
Hover 背景: var(--paper-inset)
Hover 文字: var(--ink)
```

**工具栏按钮示例** (Chat 页面顶部、SimpleChatInput 底部):
```jsx
<button className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5
  text-[13px] font-medium text-[var(--ink-muted)]
  hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]">
  <Plus className="h-3.5 w-3.5" />
  新对话
</button>
```

#### 危险按钮 (Danger)
```
背景: var(--error)
文字: white
用于: 删除、不可恢复操作
```

### 6.2 卡片 (Cards)

#### 默认卡片
```
背景: var(--paper-elevated)
边框: 1px solid var(--line)
圆角: var(--radius-lg)
内边距: var(--space-4)
Hover: border-color 加深至 var(--line-strong)
```

#### 可交互卡片
```
同默认卡片 +
Hover: 添加 var(--shadow-sm)
Active: 轻微缩放 scale(0.99)
```

### 6.3 输入框 (Inputs)

```
背景: var(--paper) 或 transparent
边框: 1px solid var(--line)
圆角: var(--radius-sm)
内边距: 10px 12px
字号: var(--text-base)
Placeholder: var(--ink-muted)
Focus: border-color 变为 var(--ink)
```

### 6.4 标签 (Badges/Tags)

```
背景: var(--paper-inset)
文字: var(--ink-muted)
圆角: var(--radius-sm) 或 var(--radius-full)
内边距: 2px 8px
字号: var(--text-xs) font-medium
```

#### 状态标签
- 成功: `bg: var(--success-bg), text: var(--success)`
- 错误: `bg: var(--error-bg), text: var(--error)`
- 警告: `bg: var(--warning-bg), text: var(--warning)`

### 6.5 下拉菜单 (Dropdowns)

```
背景: var(--paper-elevated)
边框: 1px solid var(--line)
圆角: var(--radius-md)
阴影: var(--shadow-md)
Item 高度: 36px (紧凑) | 40px (标准)
Item Hover: 背景 var(--paper-inset)
Item 选中: 文字 var(--accent-warm)
```

### 6.6 开关 (Toggle/Switch)

```
宽度: 44px
高度: 24px
圆角: var(--radius-full)
关闭背景: var(--paper-inset)
开启背景: var(--success)
滑块: 20px 白色圆形
```

---

## 7. 布局规范

### 7.1 断点

| Token | 值 | 说明 |
|-------|------|------|
| `--breakpoint-mobile` | 768px | 移动端/桌面端分界 |

### 7.2 容器宽度

| 用途 | 最大宽度 |
|------|---------|
| 消息列表 | 768px (max-w-3xl) |
| 设置表单 | 576px (max-w-xl) |
| 技能面板 | 全宽 |

### 7.3 侧边栏

| 属性 | 值 |
|------|------|
| 最小宽度 | 320px |
| 设置页侧边栏 | 208px (w-52) |

### 7.4 Header 高度

```
固定高度: 48px (h-12)
内边距: 0 16px
```

---

## 8. 动效规范

### 8.1 Transition Duration

| Token | 值 | 用途 |
|-------|------|------|
| `--duration-fast` | 150ms | 按钮、开关 |
| `--duration-normal` | 200ms | 菜单、展开 |
| `--duration-slow` | 300ms | 页面切换、模态框 |

### 8.2 Easing

| Token | 值 | 用途 |
|-------|------|------|
| `--ease-default` | `ease` | 大多数过渡 |
| `--ease-out` | `ease-out` | 弹出动画 |
| `--ease-in-out` | `ease-in-out` | 双向过渡 |

### 8.3 常用动效

```css
/* 按钮 hover */
transition: background var(--duration-fast),
            border-color var(--duration-fast),
            transform var(--duration-fast);

/* 下拉菜单出现 */
transition: opacity var(--duration-normal),
            transform var(--duration-normal);
transform-origin: top;

/* 模态框 */
transition: opacity var(--duration-slow),
            transform var(--duration-slow);
```

---

## 9. 图标规范

### 9.1 尺寸

| 场景 | 尺寸 | Tailwind |
|------|------|----------|
| 极小辅助 | 10px | h-2.5 w-2.5 |
| 内联文字 | 12px | h-3 w-3 |
| 工具栏按钮 | 14px | h-3.5 w-3.5 |
| 主/次按钮 | 14px | h-3.5 w-3.5 |
| 导航菜单 | 16px | h-4 w-4 |
| 列表项 | 16px | h-4 w-4 |
| 卡片图标 | 16px | h-4 w-4 |
| 空状态 | 24px | h-6 w-6 |

**图标与按钮配合**：
- 13px 字号按钮 → h-3.5 w-3.5 图标
- 14px 字号按钮 → h-3.5 ~ h-4 图标
- 图标与文字间距: gap-1.5

### 9.2 颜色

- 默认: `var(--ink-muted)`
- Hover: `var(--ink)`
- 文件夹: `var(--accent-cool)`
- 文件: `var(--accent-warm)`
- 成功: `var(--success)`
- 错误: `var(--error)`

---

## 10. AI 内容规范

作为 AI Agent 产品的核心，对话内容的展示需要特别规范。

### 10.1 内容层级体系

从高到低的视觉重要性：

| 层级 | 内容类型 | 视觉特征 |
|------|---------|---------|
| **L1** | AI 最终回复 | 清晰、大字号、高对比度 |
| **L2** | 用户输入 | 次要背景色区分，同等字号 |
| **L3** | 工具调用结果 | 边框卡片，可折叠 |
| **L4** | 工具调用过程 | 弱化样式，默认折叠 |
| **L5** | 思考过程 | 最弱化，斜体或更小字号 |

### 10.2 消息气泡 (Message Blocks)

#### AI 消息 (Assistant Message)
```
背景: transparent (与页面融合)
文字: var(--ink)
字号: var(--text-base) / 16px
行高: 1.6 (阅读优化)
段落间距: var(--space-4)
最大宽度: 768px (居中)
```

#### 用户消息 (User Message)
```
背景: var(--paper-inset)
文字: var(--ink)
圆角: var(--radius-lg)
内边距: var(--space-3) var(--space-4)
字号: var(--text-base)
对齐: 右侧（或左侧皆可，但需与 AI 区分）
```

### 10.3 工具调用块 (Tool Call Blocks)

工具调用是 AI Agent 的核心交互，需要清晰但不喧宾夺主。

#### 工具调用卡片
```
背景: var(--paper-elevated)
边框: 1px solid var(--line)
圆角: var(--radius-md)
内边距: var(--space-3)

标题区:
  - 图标: 16px, var(--ink-muted)
  - 工具名: var(--text-sm), font-medium, var(--ink)
  - 状态标签: 右侧对齐

内容区:
  - 字号: var(--text-sm)
  - 字体: var(--font-mono)
  - 颜色: var(--ink-muted)
  - 可折叠，默认折叠长内容
```

#### 工具状态指示
| 状态 | 图标 | 颜色 |
|------|------|------|
| 执行中 | Loader (旋转) | var(--info) |
| 成功 | Check | var(--success) |
| 失败 | X | var(--error) |
| 等待确认 | AlertCircle | var(--warning) |

### 10.4 代码块 (Code Blocks)

#### 行内代码
```
背景: var(--paper-inset)
文字: var(--ink)
字体: var(--font-mono)
字号: 0.9em (相对父元素)
圆角: var(--radius-sm)
内边距: 2px 6px
```

#### 多行代码块
```
背景: #1e1e1e (深色) 或 var(--paper-inset) (浅色)
文字: 根据语法高亮
字体: var(--font-mono)
字号: 13px
行高: 1.5
圆角: var(--radius-md)
内边距: var(--space-4)

头部 (可选):
  - 语言标签: 左上角
  - 复制按钮: 右上角
```

### 10.5 思考块 (Thinking Blocks)

AI 的思考过程，用户可选择查看。

```
默认状态: 折叠，仅显示 "思考中..." 或 "查看思考过程"
展开样式:
  - 背景: transparent
  - 左边框: 2px solid var(--line)
  - 内边距: var(--space-3) 0 var(--space-3) var(--space-4)
  - 文字: var(--ink-muted)
  - 字号: var(--text-sm)
  - 字体: 正常（非斜体，保持可读性）
```

### 10.6 权限请求块 (Permission Prompt)

当 AI 需要用户授权时显示。

```
背景: var(--warning-bg)
边框: 1px solid var(--warning) / 0.3
圆角: var(--radius-lg)
内边距: var(--space-4)

标题: font-medium, var(--ink)
描述: var(--text-sm), var(--ink-muted)
操作区:
  - 拒绝按钮: Ghost 样式
  - 允许按钮: Primary 样式
```

### 10.7 长文本阅读优化

#### 行高与段落
```css
/* AI 回复正文 */
.ai-message-content {
  font-size: var(--text-base);  /* 16px */
  line-height: 1.6;              /* 25.6px - 适合长文本阅读 */
  letter-spacing: 0.01em;        /* 略微增加字间距 */
}

/* 段落间距 */
.ai-message-content p + p {
  margin-top: var(--space-2);    /* 8px */
}

/* 列表项间距 */
.ai-message-content li + li {
  margin-top: var(--space-1.5);  /* 6px */
}
```

#### 内容宽度
- 最大宽度限制 768px，避免单行过长影响阅读
- 居中显示，两侧留白形成阅读聚焦

#### 标题层级
在 AI 生成的 Markdown 内容中：
| Markdown | 样式 |
|----------|------|
| `# H1` | 22px, bold, margin-top: 24px, margin-bottom: 16px |
| `## H2` | 20px, semibold, margin-top: 20px, margin-bottom: 12px |
| `### H3` | 18px, semibold, margin-top: 16px, margin-bottom: 8px |
| `#### H4` | 16px, semibold, margin-top: 12px, margin-bottom: 8px |
| `##### H5` | 16px, medium, margin-top: 12px, margin-bottom: 8px |
| `###### H6` | 16px, medium, margin-top: 12px, margin-bottom: 8px |

### 10.8 内容块间距

不同内容块之间的间距规范：

| 场景 | 间距 |
|------|------|
| 消息之间 | var(--space-4) / 16px |
| 消息内段落 | var(--space-4) / 16px |
| 工具块与文本 | var(--space-3) / 12px |
| 代码块与文本 | var(--space-3) / 12px |
| 列表项之间 | var(--space-2) / 8px |

### 10.9 加载与过渡状态

#### AI 生成中
```
显示: 光标闪烁 或 "..." 动画
位置: 消息末尾
动画: shimmer 呼吸效果
```

#### 工具执行中
```
图标: Loader2 旋转动画
文字: "执行中..." var(--ink-muted)
进度: 可选的进度条
```

#### 内容流式输出
```
新内容: 逐字/逐块出现
滚动: 自动滚动到底部（用户手动滚动时暂停）
```

---

## 11. CSS 变量完整定义

```css
:root {
  /* ========== Colors: Ink ========== */
  --ink: #1c1612;
  --ink-secondary: #3a3532;
  --ink-muted: #6f6156;
  --ink-subtle: #9a8d82;

  /* ========== Colors: Paper ========== */
  --paper: #f6efe5;
  --paper-elevated: #fdf8f1;
  --paper-inset: #efe6d9;
  --paper-subtle: #f8f5ef;

  /* ========== Colors: Accent ========== */
  --accent-warm: #c26d3a;
  --accent-warm-hover: #e18a58;
  --accent-cool: #2e6f5e;
  --accent-cool-hover: #3d8a75;

  /* ========== Colors: Semantic ========== */
  --success: #16a34a;
  --success-bg: #dcfce7;
  --error: #dc2626;
  --error-bg: #fee2e2;
  --warning: #d97706;
  --warning-bg: #fef3c7;
  --info: #2563eb;
  --info-bg: #dbeafe;

  /* ========== Colors: Button ========== */
  --button-primary-bg: #1c1612;
  --button-primary-bg-hover: #3a3532;
  --button-primary-text: #ffffff;
  --button-secondary-bg: #efe6d9;
  --button-secondary-bg-hover: #e4ddd0;
  --button-secondary-text: #1c1612;

  /* ========== Colors: Border ========== */
  --line: rgb(28 22 18 / 0.10);
  --line-strong: rgb(28 22 18 / 0.18);
  --line-subtle: rgb(28 22 18 / 0.06);

  /* ========== Typography: Font Family (Cross-platform) ========== */
  /* 英文: macOS SF Pro → Windows Segoe UI */
  --font-sans: 'SF Pro Text', 'SF Pro Display', -apple-system,
               'Segoe UI', BlinkMacSystemFont, sans-serif;
  /* 中文: macOS 苹方 → Windows 微软雅黑 */
  --font-chinese: 'PingFang SC', 'Microsoft YaHei',
                  'Hiragino Sans GB', sans-serif;
  /* 等宽: 跨平台 */
  --font-mono: 'SF Mono', 'Cascadia Code', 'Consolas',
               'Monaco', 'Fira Code', monospace;
  --font-body: var(--font-sans), var(--font-chinese);
  --font-display: var(--font-sans), var(--font-chinese);

  /* ========== Typography: Size ========== */
  /* 基于 16px 正文的字号体系 */
  --text-2xs: 10px;   /* 极小辅助文字（谨慎使用） */
  --text-xs: 11px;    /* 时间戳、状态标签、badge */
  --text-sm: 13px;    /* 工具栏按钮、标签、次要内容 */
  --text-base: 14px;  /* 导航按钮、主要按钮文字 */
  --text-md: 16px;    /* 正文主体 - AI 回答内容 */
  --text-lg: 18px;    /* H3 标题 */
  --text-xl: 20px;    /* H2 标题 */
  --text-2xl: 22px;   /* H1 标题 */
  --text-3xl: 28px;   /* 页面大标题 */
  --text-brand: 56px; /* 品牌展示 */

  /* ========== Spacing ========== */
  --space-0: 0;
  --space-0.5: 2px;
  --space-1: 4px;
  --space-1.5: 6px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;

  /* ========== Border Radius ========== */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 20px;
  --radius-2xl: 24px;
  --radius-full: 9999px;

  /* ========== Shadows ========== */
  --shadow-xs: 0 1px 2px rgb(28 22 18 / 0.05);
  --shadow-sm: 0 2px 8px rgb(28 22 18 / 0.08);
  --shadow-md: 0 8px 24px rgb(28 22 18 / 0.12);
  --shadow-lg: 0 16px 40px rgb(28 22 18 / 0.16);
  --shadow-xl: 0 24px 48px rgb(28 22 18 / 0.20);

  /* ========== Animation ========== */
  --duration-fast: 150ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;

  /* ========== Layout ========== */
  --breakpoint-mobile: 768px;
  --sidebar-min-width: 320px;
  --header-height: 48px;
}
```

---

## 12. 跨平台规范

### 12.1 macOS vs Windows 差异处理

| 特性 | macOS | Windows | 处理方式 |
|------|-------|---------|---------|
| 字体渲染 | 更平滑 | 更锐利 | 使用系统字体，信任系统渲染 |
| 窗口控制 | 左上角红绿灯 | 右上角三按钮 | Tauri 自动处理 |
| 滚动条 | 自动隐藏 | 常显示 | CSS `scrollbar-width: thin` |
| 圆角 | 系统级大圆角 | 小圆角/直角 | 使用自定义圆角，两端一致 |

### 12.2 字体渲染优化

```css
body {
  /* 跨平台字体渲染优化 */
  -webkit-font-smoothing: antialiased;  /* macOS */
  -moz-osx-font-smoothing: grayscale;   /* macOS Firefox */
  text-rendering: optimizeLegibility;    /* 通用 */
}
```

### 12.3 滚动条样式

```css
/* 跨平台细滚动条 */
* {
  scrollbar-width: thin;  /* Firefox */
  scrollbar-color: var(--ink-subtle) transparent;
}

/* Webkit (Chrome/Safari/Edge) */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-thumb {
  background: var(--ink-subtle);
  border-radius: 3px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
```

---

## 13. 兼容性说明

### 旧变量映射

为保持向后兼容，保留以下旧变量名（建议逐步迁移）：

| 旧变量 | 新变量 |
|-------|-------|
| `--ink-strong` | `--ink-secondary` |
| `--paper-strong` | `--paper-elevated` |
| `--paper-contrast` | `--paper-inset` |
| `--accent` | `--accent-warm` |
| `--accent-strong` | `--accent-warm-hover` |

---

## 14. 使用示例

### Tailwind 类名映射参考

```jsx
// 主按钮 (14px)
<button className="flex items-center gap-1.5 bg-[var(--button-primary-bg)]
  text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]
  rounded-full px-4 py-2 text-[13px] font-medium transition-colors">
  <Plus className="h-3.5 w-3.5" />
  启动
</button>

// 工具栏按钮 (13px) - Ghost 样式
<button className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5
  text-[13px] font-medium text-[var(--ink-muted)] transition-colors
  hover:bg-[var(--paper-contrast)] hover:text-[var(--ink)]">
  <Plus className="h-3.5 w-3.5" />
  新对话
</button>

// 卡片
<div className="bg-[var(--paper-elevated)] border border-[var(--line)]
  rounded-[var(--radius-lg)] p-4 hover:border-[var(--line-strong)]
  transition-colors">
  卡片内容
</div>

// 输入框
<input className="bg-transparent border border-[var(--line)]
  rounded-[var(--radius-sm)] px-3 py-2.5 text-sm
  placeholder:text-[var(--ink-muted)] focus:border-[var(--ink)]
  focus:outline-none transition-colors" />
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.3.0 | 2026-01-22 | 按钮尺寸规范：工具栏按钮 13px + h-3.5 图标，主按钮 14px |
| 1.2.0 | 2026-01-22 | 字号体系重构：以 16px 为正文基准，H1-H6 标题 22/20/18/16px |
| 1.1.0 | 2026-01-22 | 新增 AI 内容规范、跨平台规范、字体 fallback |
| 1.0.0 | 2026-01-22 | 初始版本，基于设计审计创建 |
