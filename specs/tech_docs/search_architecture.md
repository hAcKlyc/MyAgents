# 全文搜索架构

## 概述

MyAgents 的全文搜索由一个 Rust 层单例 `SearchEngine` 提供，构建在 [Tantivy](https://github.com/quickwit-oss/tantivy)（Rust 原生全文搜索引擎，BM25 评分）+ [tantivy-jieba](https://github.com/jiegec/tantivy-jieba)（中文分词，~37 万词词典）之上。对外暴露三类能力：

1. **Session 搜索** — 跨所有工作区检索会话标题与消息内容
2. **Record 搜索** — 检索 text/audio Record 的 title、tags、content、transcript 与 speaker projection
3. **工作区文件搜索** — 检索单个工作区内的文件名与文件内容

**仅 Tauri 可用**：搜索直接走 Tauri IPC（`invoke('cmd_search_*')`）到 Rust 层，不经 Node.js Sidecar。浏览器开发模式（`start_dev.sh`）没有 fallback — UI 入口在非 Tauri 环境下不出现。

`SearchEngine` 与 `SidecarManager`、`TaskStore` 处于同层，作为 Tauri managed state 注入到命令处理器。

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                     React Frontend                              │
│  ┌────────────────────────┐   ┌──────────────────────────────┐ │
│  │ HistorySearchOverlay   │   │ DirectoryPanel               │ │
│  │  (Session / Record)     │   │  (工作区文件搜索)              │ │
│  └──────────┬─────────────┘   └────────────┬─────────────────┘ │
│             │                               │                   │
│             ▼                               ▼                   │
│        searchClient.ts (Tauri invoke wrapper)                   │
└─────────────┬───────────────────────────────────────────────────┘
              │ invoke('cmd_search_*')
              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Rust SearchEngine                          │
│                                                                 │
│   ┌──────────────────┐       ┌─────────────────────────────┐  │
│   │ SessionIndex     │       │ RecordIndex / FileIndexManager│ │
│   │  (单例, 全局)     │       │  全局 Record + workspace slots│ │
│   │  Arc, 无外锁      │       │  懒加载 + 磁盘 manifest       │  │
│   │  StdMutex<Writer>│       │                             │  │
│   └────────┬─────────┘       └──────────────┬──────────────┘  │
│            │                                 │                 │
│            ▼                                 ▼                 │
│   ┌──────────────────┐       ┌─────────────────────────────┐  │
│   │ session_indexer  │       │ file_indexer                │  │
│   │ + watcher        │       │ (SWR + mtime/size diff)     │  │
│   └────────┬─────────┘       └──────────────┬──────────────┘  │
│            │                                 │                 │
│            └─────────────┬───────────────────┘                 │
│                          ▼                                     │
│            schema / tokenizer(jieba) / util                    │
└─────────────┬───────────────────────────────────────────────────┘
              ▼
    ~/.myagents/search_index/
        ├── sessions/        (单一全局索引)
        ├── records/         (单一全局派生索引)
        └── workspaces/
            ├── <fnv-hash-1>/     (.schema_version + .file_index_manifest.json)
            └── <fnv-hash-2>/
```

## 模块布局 (`src-tauri/src/search/`)

| 文件 | 职责 |
|------|------|
| `mod.rs` | `SearchEngine` 单例 + Tauri IPC facade 与后台索引启动 |
| `schema.rs` | Tantivy Schema 定义 + `SCHEMA_VERSION` 版本号 |
| `tokenizer.rs` | 中英混合分词器：jieba + `LowerCaser` + `RemoveLongFilter(40)` |
| `session_indexer.rs` | Session 索引构建、reindex、delete、查询 |
| `record_indexer.rs` | Record baseline rebuild、增量 upsert/delete、按 record_id 去重查询 |
| `file_indexer.rs` | 工作区文件索引：懒加载 + 磁盘 manifest + 增量刷新 |
| `watcher.rs` | `notify-debouncer-full` 文件系统观察者（5s 滑动去抖） |
| `searcher.rs` | Session/Record/File 搜索的序列化结果类型 |
| `util.rs` | UTF-8 ↔ UTF-16 offset 转换 + char boundary 安全夹紧 |

## Tauri IPC 命令 (`src-tauri/src/lib.rs`)

| 命令 | 返回 | 说明 |
|------|------|------|
| `cmd_search_sessions(query, limit?, tag?)` | `SessionSearchResult` | 全局会话搜索（标题 + 内容），可用一个用户 Tag 精确限定候选 Session |
| `cmd_search_records(query, limit?)` | `RecordSearchResult` | 全局 Record 搜索；每个 Record 至多一个 hit |
| `cmd_search_workspace_files(query, workspace, limit?, maxMatchesPerFile?)` | `FileSearchResult` | 工作区文件搜索 |
| `cmd_search_index_status()` | `IndexStatus` | 索引文档数 + 存储目录（调试用） |
| `cmd_invalidate_workspace_index(workspace)` | `()` | 硬失效一个工作区索引（下次从零重建） |
| `cmd_refresh_workspace_index(workspace)` | `(total, changed)` | 增量刷新当前工作区索引 |

前端 wrapper: `src/renderer/api/searchClient.ts`。

## Schema 与分词

### Session Schema (`schema::session_schema`)

存储字段（`STORED` 回取）：`session_id`、`message_id`、`agent_dir`、`role`、`timestamp`、`last_active_at`、`source`、`message_count`。
索引字段（用于全文匹配，走 `"chinese"` 分词器）：`title`、`content`。

Session `content` 只索引用户可见文本：leading `<system-reminder>...</system-reminder>` 的 hidden payload 属于模型上下文，不进入搜索；有 visible tail 时只索引 tail，纯 hidden reminder 索引为空。这个语义变化也必须 bump `SCHEMA_VERSION`，让旧索引重建。

用户 Session Tag 不进入 Tantivy schema，也不参与标题/正文分词和高亮。带 `tag` 的查询在 blocking worker 上 fresh 读取 `sessions.json`，用与 metadata 投影一致的容错规则规范化 `userTags`，先构造 history-visible `session_id` 精确候选集合，再用 `TermSetQuery` 与全文 query 组合为两个 `Must` 条件，最后才应用 `TopDocs` limit。这样 Tag mutation 无需等待 5s 内容索引 watcher，且不能退化成对前 50 条结果做 Renderer 后过滤。权威 metadata 读取或解析失败必须让命令失败并由 UI 显示可恢复错误，不能伪装成零结果。

### File Schema (`schema::file_schema`)

存储：`path`、`ext`。索引：`name`、`content`。

### Record Schema (`schema::record_schema`)

存储 `record_id`、kind、时间与用于导航/摘要的字段；索引 `title`、`tags`、`content`。`RecordStore::all_search_documents/search_documents` 负责把 text content 或 audio transcript/speaker projection 展平成派生文档。多 segment 可以形成多个 Tantivy document，但 query 必须按 `record_id` 去重后再应用产品 limit，避免一个长 transcript 把结果页占满。

### Schema 版本门控

`SCHEMA_VERSION` 常量 + `.schema_version` 磁盘 marker。版本不一致时自动删除目录重建，防止 Tantivy 因 schema 不匹配 panic。**修改任意 schema 字段、分词器、indexing option 时 MUST bump 版本号**。

### 中文分词

`tokenizer::TOKENIZER_NAME = "chinese"`。构建链：`JiebaTokenizer → RemoveLongFilter(40) → LowerCaser`。

**致命陷阱**：schema 字段 MUST 显式引用该分词器名（通过 `chinese_text_options()`），**禁止**使用 Tantivy 裸 `TEXT`。裸 `TEXT` 走默认英文分词器，把中文按单字切分后又因长度过滤丢失，最终零命中。

**注册时机**：`index.tokenizers().register(...)` MUST 在 `IndexWriter` 创建之前，Tantivy 会在 writer 创建时快照 tokenizer manager。

## Session 索引策略

### 初始化时序（MUST 严格遵守）

```
Tauri setup()
  └─> SearchEngine::new(data_dir)          // 打开/创建 tantivy index
  └─> start_background_indexing()
        └─> tauri::async_runtime::spawn    // ← 不能用 tokio::spawn
              └─> index_all_sessions()     // 全量扫描 sessions.json + JSONL
                    (tokio::task::spawn_blocking, CPU/IO 重)
              └─> spawn_session_watcher()  // ← MUST 在 index 完成后才启动
```

- **`tauri::async_runtime::spawn` 不是 `tokio::spawn`**：`.setup()` 回调在 macOS 上经 ObjC 调用，panic 无法跨 FFI 栈展开会 abort 进程。
- **Watcher MUST 在 `index_all_sessions` 后启动**：watcher 的基线 snapshot（来自 `sessions.json`）必须与已构建的 index 状态一致，否则第一次 tick 会把所有已索引的 session 当"新增"再全量 reindex 一遍。

### 读写并发模型

`SessionIndex` 作为 `Arc<SessionIndex>` 持有（**不是** `Arc<Mutex<SessionIndex>>`）：

- 正常读写共享当前 Tantivy state 的 `RwLock` 读锁；写路径另由 `StdMutex<IndexWriter>` 序列化
- 只有确认 Tantivy 派生文件损坏时才获取写锁，丢弃整个 session index 并从 `sessions.json` + JSONL 重建
- 后果：正常后台索引不阻塞搜索；恢复期间用一个 owner 完成一次有界替换

### Writer Lock 与派生索引恢复

`.tantivy-writer.lock` 的路径存在不代表锁仍被占用：Tantivy 通过 OS 文件锁判定 owner，句柄关闭后锁自然释放。Session / workspace writer 创建失败时必须保留锁文件并返回真实错误，禁止在未证明无活跃 writer 时 unlink。

Session index 是完全派生数据。打开、commit、reload 或 search 遇到缺失 segment / Tantivy data corruption 时，`SessionIndex` 在唯一写锁下再次确认故障，然后删除 `search_index/sessions` 并从权威会话文件重建、重试原操作。`sessions.json` 与 JSONL 永不参与回滚或补偿事务。

## Record 索引策略

Tauri setup 取得全局 `RecordStore` 后，`SearchEngine` 先订阅其 broadcast，再读取 `all_search_documents()` 做 baseline rebuild；先订阅可关闭 baseline 读取期间的变更窗口。baseline ready 后发既有 `record-search-index-ready` 投影，后续 create/update/delete 按 Record change identity 增量 upsert/delete。索引是完全派生数据，RecordStore 始终是 source of truth；索引失败不得回写 Record、阻塞录音或转录 terminal。

Record 已有单一写 owner 和 in-process change broadcast，因此不再增加第二个 filesystem watcher、轮询器或索引 outbox。启动 baseline 提供可重建性，broadcast 提供进程内实时性；App 重启会重新对账。

## 文件系统观察者 (`watcher.rs`)

### 为什么选 watcher 而不是 writer 主动通知

Session 文件由 Node.js Sidecar 写入，索引在 Rust。两个显而易见的替代方案都有问题：

1. **Bun → Rust 反向调用**：Rust 只做 Bun 的 HTTP 代理，没有反向通道；为一个 cross-cutting concern 新增进程耦合得不偿失
2. **每个写入方都记得调通知**：今天只有 Sidecar，明天是 CLI、迁移脚本、崩溃恢复 — 任何一个忘记通知就静默孤立索引

**Watcher 让正确行为成为默认路径**：任何进程接触 `~/.myagents/sessions/` 都会自动流入索引，与 `local_http` / `process_cmd` 同属 pit-of-success 模式。

### 去抖策略

`notify-debouncer-full`，5s 滑动窗口。每次新事件重置计时器，仅在空闲 5s 后批量 flush。在活跃对话期间，消息追加每条都写 JSONL，去抖让 reindex 成本按"会话数"缩放而不是按"消息数"。

### 事件处理

1. **路径分类（结构匹配，非绝对路径相等）**：
   - `.../sessions/<id>.jsonl` → `SessionFile(id)`
   - `.../sessions.json` → `SessionsJson`
   - 其他 → 忽略
   - **陷阱**：macOS 上 `notify` 可能汇报 APFS firmlink 路径（`/System/Volumes/Data/Users/...`），绝对路径相等会静默失配所有事件
2. **每个 tick 内 dedup**：`HashSet` 合并同一会话的多次事件（create + modify 常见于某些平台）
3. **sessions.json diff**：检测仅元数据变更的场景（标题编辑、手工 JSON 编辑），这些不会触发任何 JSONL 写事件
4. **先应用 delete 再 reindex**：处理 rename 等 delete+readd 序列时不让陈旧 delete 覆盖新索引

### 监听范围

- `sessions_dir`（非递归）— 捕获 JSONL 写入/删除
- `data_dir`（非递归）— 捕获 `sessions.json` 变更（大多数平台不允许监听单个文件）

### 与 Session 导航投影 watcher 的边界

`src-tauri/src/session_metadata.rs` 另有一个 300ms 去抖的 App 级 watcher，观察同一权威文件并在 history-visible metadata 投影发生变化时发出 `session:metadata-changed { agentDirs }`。GlobalSidebar 的 app-global store 用它定向失效已加载的工作区 Session slice；因此桌面、IM、Cron、Floating Ball、CLI/迁移等写入者无需各自通知 Renderer，也不需要先打开历史搜索才能刷新侧栏。由于 OS watcher 和 Tauri event 都没有注册前 replay，Rust 在 observer ready 后发 broad invalidation，Renderer listener 注册成功后也必须权威对账；任一侧先 ready 都能关闭另一侧的启动窗口。

这两个 watcher 不得合并生命周期：搜索 watcher 的 5s 窗口服务于较重的 Tantivy 内容索引，且依赖派生 SearchEngine 成功初始化；导航投影需要更短延迟，并且即使搜索索引损坏或不可用也必须继续响应。二者只共享 `sessions.json` / JSONL 这份权威输入，不互为 owner。

## 工作区文件索引策略

### 懒加载 + 持久 manifest

工作区文件索引有两层磁盘状态：

- Tantivy index 本体：`~/.myagents/search_index/workspaces/<fnv-hash>/`
- `.file_index_manifest.json`：保存独立的 `manifestVersion`、`schemaVersion`、`workspace`、可搜索的 workspace-relative folder path 集合，以及 `rel_path → (mtimeMs, size)` 文件快照

`FileIndexManager::search` 在进程内 slot 为空时优先打开磁盘已有 index + manifest；如果 index/manifest 缺失、版本不匹配、损坏，或该 workspace slot 正在被后台 refresh / cold build 占用，前台搜索 **不等待冷建**，而是走 bounded direct scan fallback。Direct scan 在同一次有界目录遍历中发现 folder metadata，并只读取至多 `DIRECT_SCAN_MAX_FILES` 个候选文件；`DIRECT_SCAN_MAX_ENTRIES` 同时约束纯目录树和文件 hit 已满后的遍历，防止目录搜索绕开前台预算。

Folder 不是 Tantivy 内容文档。cold direct scan 与 warm manifest 共用 `search_folder_paths`：普通 query 只匹配 basename，含 `/` 或 `\` 的 query 匹配规范化 relative path；排序依次为 basename exact、prefix、contains、path contains，再按深度和 path 稳定排序。Folder 与 file 各有独立上限（folder 固定 50，file 使用调用方 `limit`），不会互相抢预算。隐藏目录、skip dir 与 symlink 继续服从同一 workspace scan policy；后代文件命中不会带出祖先 folder。

`manifestVersion` 只管理 manifest shape，和 Tantivy `SCHEMA_VERSION` 分离。缺少 folder collection 的旧 manifest 会明确失效并安全重建；仅修改 manifest shape 不应无理由 bump Tantivy schema。

这样有两个效果：

- 热路径仍走 Tantivy，速度和排序最好。
- 冷路径 / rebuild 路径不会让文件区一直停在“搜索中...”。后台 `refresh_or_create` 可以继续慢慢建索引，但用户查询始终先拿到当前文件系统的直接结果。

### Stale-While-Revalidate 搜索路径

前端 `DirectoryPanel` 对非空 query 的顺序：

1. 立即调用 `searchWorkspaceFiles(query, workspace)`，从当前可用 index 返回结果
2. 后台调用 `refreshWorkspaceFileIndex(workspace)`，只扫描元数据并 diff
3. 当前 query 仍有效时再次调用 `searchWorkspaceFiles`，用一个 `{ folderHits, hits }` response 原子替换结果

冷工作区的首次查询走 direct scan fallback，不在前台全量建索引；已有磁盘 index 的工作区会先显示可能稍旧的 Tantivy/manifest 结果，再在后台收敛到最新文件系统状态。刷新后无条件重搜当前 query，是因为新增/删除空目录不会改变 `changedFiles`，但仍必须刷新 folder hits。两类 hit 共用同一个 request id fence 和 React state commit，不能先后拼接。前端不在 Tab mount 或空搜索模式下预热/刷新索引，避免重 IO/CPU 工作排在用户真实 query 前面。

核心函数 `FileIndexManager::refresh_or_create`：

- **冷路径**（显式 refresh 且无可用 index）：全量扫描 → 构建 Tantivy 索引（大型资料库可能需要几十秒或更久，但不阻塞前台 search）
- **热路径**（显式刷新时）：仅遍历元数据 → 按 `(rel_path → (mtime_ms, size))` diff → 只对变更文件执行 `delete_term + add_document`；folder collection 即使只发生空目录变化也会更新 manifest

并发模型：全局 map 只短暂锁住以取得 `workspace → slot`；真正的刷新 / 冷建在该 workspace 的 slot 锁内执行，并由 `SearchEngine` 包进 `tokio::task::spawn_blocking`。前台 `search` 使用 `try_lock`：拿到锁才用 Tantivy index，拿不到锁直接 fallback scan。后果：同一 workspace 的 index 写入仍保持串行一致性，不同 workspace 互不排队，也不会把同步 IO/CPU 工作压在 async runtime 线程上；同时大型 workspace 的后台建索引不会堵住用户继续输入新 query。

### 工作区目录命名 — FNV-1a 64-bit

```rust
// file_indexer.rs
fn simple_hash(s: &str) -> String {
    let mut hash = FNV_OFFSET_BASIS;  // 0xcbf29ce484222325
    for byte in s.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);  // 0x100000001b3
    }
    format!("{:016x}", hash)
}
```

**禁止**使用 `std::collections::hash_map::DefaultHasher` — 其哈希算法没有稳定性保证，不同进程/版本可能产出不同值，静默孤立所有历史索引。也不用 sha256（过重，对此场景没意义）。

### 扫描过滤

- **跳过目录**：`node_modules`, `.git`, `__pycache__`, `.next`, `dist`, `build`, `.turbo`, `.cache`, `target`, `.venv`, `venv`, `.myagents`, `.claude`
- **跳过二进制扩展名**：图片/视频/音频/压缩包/字体/可执行/office 文档等
- **最大文件大小**：1 MB
- **跳过 symlink**：扫描使用 `symlink_metadata`，不跟随工作区内 symlink；读取文件内容前会再次 `symlink_metadata` 校验 `(mtimeMs, size)` 与 discovery 快照一致，Unix/macOS 打开文件时使用 no-follow，并用 bounded read 防止扫描后文件被换成 symlink 或长大越过 1 MB cap

### 失效路径

`cmd_invalidate_workspace_index` 硬删内存中的 `WorkspaceFileIndex` 和对应磁盘目录；下次搜索走 direct scan fallback，下次 refresh 触发冷路径。保留为硬重置出口（schema 迁移、索引损坏恢复），常规场景走 `refresh_or_create`。

## 高亮渲染

### UTF-16 offset 跨边界传输

Rust `str` 是 UTF-8 字节索引，JavaScript `String` 是 UTF-16 代码单元索引。直接把 Rust 字节 offset 传给 JS，中文内容会产出严重偏移的高亮位置（3 UTF-8 字节 vs 1 UTF-16 unit / CJK 字符）。

**约定**：所有越过 Rust → JS 边界的 offset MUST 用 `util::byte_to_utf16` 转换。前端 `SearchHighlight.tsx` 用 `String.prototype.slice()` 直接消费 `[start, end]` 对。

### Char boundary 安全夹紧

snippet 构建常见 "取匹配位置前后各 N 字符" 的近似切片。裸 `str.get(a..b)` 对中文/emoji 会在 codepoint 中间 panic。`util::floor_char_boundary` / `ceil_char_boundary` 提供夹紧方法，配合 `char_indices() + c.len_utf8()` 迭代是字节安全的。

### XSS 安全

高亮以 `[start, end]` 数组形式传输，不是 `<mark>` HTML 字符串。`SearchHighlight.tsx` 用 React children 拼接 `<mark>` 节点，零 `dangerouslySetInnerHTML`。同时合并重叠高亮、按 start 排序，避免重复渲染。

## 前端集成入口

| 入口 | 文件 | 触发路径 |
|------|------|---------|
| **Session 搜索 Overlay** | `components/global-sidebar/GlobalSidebar.tsx`（稳定 shell）+ `components/HistorySearchOverlayContent.tsx`（lazy content） | 全局侧栏搜索按钮 → 以浏览态打开，右侧紧凑搜索框获得键盘焦点 → 用户激活后向左展开并聚焦输入框 |
| **文件搜索模式** | `components/DirectoryPanel.tsx` facade → `components/directory-panel/DirectoryPanel.tsx` + `hooks/useDirectorySearch.ts` | 侧边栏搜索按钮切换 mode → 用户输入 query → `searchWorkspaceFiles` 原子返回 folder/file → 后台 `refreshWorkspaceFileIndex` → 重搜当前 query |
| **结果项** | `search/SessionSearchItem.tsx`, `search/FileSearchResults.tsx` | Folder 固定置于 file 上方；folder 点击定位并展开目录，file 点击预览，chunk 点击预览并定位行 |
| **文件跳转定位行** | `components/directory-panel/DirectoryPanel.tsx` + `FilePreviewModal.tsx` + `MonacoEditor.tsx` | `FileSearchResults` 触发 `FilePreviewFocusTarget` 事件，已打开 editor 也会重新 `revealLineInCenter()`；`initialLineNumber` 仅保留为兼容字段 |
| **文件树定位** | `components/directory-panel/DirectoryPanel.tsx` + `workspace-tree/WorkspaceTreeViewport.tsx` | 搜索结果 path-based reveal，逐层展开祖先目录，通过 Virtuoso `scrollToIndex` 滚动并消费 `revealRequest` |
| **高亮渲染** | `search/SearchHighlight.tsx` | 消费 `[start, end][]` UTF-16 offsets |

### Session 搜索 Overlay 的首帧与长列表

全局侧栏搜索只把 `searchOpen` 交给 `useGlobalSidebarTaskCenterData`，由该 app-global store projection 发起一次静默 full revalidate；`HistorySearchOverlayContent` mount 时不得再发第二次全量刷新。Overlay 先消费当前 snapshot，冷模块加载期间由 App Shell 立即绘制同尺寸搜索壳，搜索按钮 hover/focus 时提前请求 lazy chunk，避免点击后出现空白间隔。Backdrop、面板 DOM、`useCloseLayer` 和入口动画的唯一 owner 是 Suspense 外层的 App Shell frame；lazy `HistorySearchOverlayContent` 只渲染面板内容。fallback → real content 的交接必须保留同一个面板节点，禁止真实内容再持有第二套 opacity-from-zero 根动画，否则首次加载会表现为“出现 → 消失 → 再出现”。

空 query 是“浏览全部历史”而不是全文搜索：Session metadata 仍由既有全局 authority 一次加载，以保留工作区/收藏/用户 Tag/来源筛选和 SessionID 直达语义；前端用 `react-virtuoso` 只 mount 可视区及小幅 overscan，禁止对 `filteredSessions` 全量 `.map()` 成 DOM。这里不新增后端 offset/page authority，否则会让客户端筛选、全局排序和直接 ID 匹配跨页漂移。非空 query 继续走 Tantivy，并由 `searchSessions()` 的 50 条上限保持结果集有界；单选用户 Tag 作为结构化参数传给 Rust，不拼进 query string。

## 工作区文件搜索结果导航

搜索结果导航是 **renderer-side 交互协议**，不是 Rust 搜索引擎的一部分。Rust `SearchEngine` 负责在同一个 `FileSearchResult` 中返回 `FolderSearchHit`、`FileSearchHit` 与 `FileMatchLine`；预览、行定位、右键菜单、回到文件树均复用现有前端文件系统抽象和目录树，不新增 Sidecar HTTP 端点，也不新增 Rust IPC 命令。

关键不变量：

- **路径归一化**：`useDirectorySearch` 在一次 state commit 前调用 `normalizeFolderSearchHits` / `normalizeFileSearchHits`，把 Windows `\` 转为 `/`。后续 active target、ancestor 计算、文件树 reveal 都只处理 workspace-relative slash path。
- **结果菜单 path-based**：搜索结果右键菜单维护独立的 `SearchResultContextMenuState`，菜单固定为 `预览`、`在文件目录中展示`、`打开所在文件夹`，不依赖 `findInTree(...)` 反查已加载 node，也不复用普通文件树的删除 / 重命名等高风险菜单项。
- **Reveal-in-tree**：`handleRevealSearchResultInTree(path)` 用 `ancestorDirectoryPaths(path)` 逐层 `openPath`，必要时通过现有 `expandDir` 加载目录。目标 node 找到后才退出搜索模式、选中节点，并发送 `treeRevealRequest`；folder hit 额外传入 `expandTargetDirectory`，使目标目录本身也打开并完成 lazy load。退出搜索不清空 query。
- **Reveal 请求消费**：`WorkspaceTreeViewport` 在 `items` 中找到目标 path，等待 Virtuoso `totalListHeightChanged` 与 DOM 滚动区域都容纳当前固定行高列表后，调用 `scrollToIndex({ align: 'center', behavior: 'auto' })`。只有目标行落入实际 viewport 才触发 `onRevealHandled(id)`；容器已有高度或已过两帧不代表虚拟内容已提交。隐藏面板保留请求，ResizeObserver 在恢复可见时继续定位；请求替换、清空或组件卸载会取消待执行回调。
- **内容预览密度**：每文件默认显示两条命中，每条最多两行文本；展开后每条仍遵守两行限制。文件行不展示命中数量 badge；定位按钮在 hover / keyboard focus 时绝对覆盖于最右侧，不占正文宽度，展开 / 收起按钮在行内居中。
- **取消语义**：新的 reveal 请求会让旧请求返回 `cancelled`，不弹错误 toast；只有目标确实 missing 才提示 `文件不存在或已删除`。
- **Preview focus event**：点击搜索命中行会生成 `FilePreviewFocusTarget`。该事件通过 `DirectoryPanel -> Chat/FileActionContext -> FilePreviewModal -> MonacoEditor` 传递。Monaco 侧以 focus target 对象身份去重，而不是只看 `requestId`，所以不同来源不会碰撞，同一行重复点击也能重新定位。
- **Markdown 源码定位**：Markdown rendered preview 没有稳定源码行号映射。带 search focus target 打开 Markdown 时切到 edit/source Monaco 视图定位，不做 rendered DOM 反推。
- **Chunk 渐进披露**：每个 file 默认渲染前 2 条真实正文命中，显式“展开”后渲染 Rust 本次响应提供的全部命中（最多 10 条），并可“收起”回 2 条；file header 不再有把 chunk 全隐藏的 chevron。filename-only file 的 `matchCount` 为 0，只显示并高亮文件名，不显示 badge、空 chunk 或展开控件。
- **展开状态保留**：expanded set 只表达“2 条 → 最多 10 条”。新 query、退出再进入 search 都清空；同 query 后台 refresh 使用 `mergeExpandedFilesAfterRefresh`，只保留仍存在文件的手动 expanded path，新增命中文件保持默认 2 条，消失文件被移除。Folder 没有折叠状态。

## 与 Pit-of-Success 模块的关系

**搜索子系统与 `local_http` / `process_cmd` / `proxy_config` 三驾马车无关**：

- 不发 HTTP（纯 Rust 内部 + Tauri IPC）
- 不启动子进程（Tantivy + jieba 都是 in-process Rust crate）
- 不与代理相关（无任何 outbound 网络调用）

**但搜索的 watcher 自身是第四个 pit-of-success 典范**：把"任何写入者都必须记得通知索引"这条必然会被违反的隐性契约，替换成"watcher 观察结果目录"的可靠模式。这一设计本身就是 MyAgents 长期架构延续性原则的案例（见 CLAUDE.md 核心架构约束第一原则）。

## 已知陷阱速查

| 场景 | 症状 | 根因 | 解决 |
|------|------|------|------|
| 修改 schema 后启动崩溃 | Tantivy panic | schema 不匹配 | `SCHEMA_VERSION` bump 触发自动重建 |
| 中文搜索零命中 | 空结果 | 字段未引用 `"chinese"` tokenizer 或 writer 在 register 之前 | `chinese_text_options()` + register 先于 writer |
| 所有 session 反复被当新增 reindex | 启动后 CPU 飙高 | watcher 先于 `index_all_sessions` 启动 | 保持 `start_background_indexing` 内的顺序 |
| macOS 上 watcher 零事件 | 搜索不自动刷新 | APFS firmlink 路径不等于监听路径 | `classify_path` 结构匹配 |
| 多字节字符 panic | snippet 构建时 abort | 裸字节切片落在 codepoint 中间 | `floor/ceil_char_boundary` + `char_indices()` |
| 升级版本后历史索引全丢 | 工作区索引全量重建 | 换了不稳定的 hasher | FNV-1a 64-bit 稳定哈希 |
| 浏览器 dev 模式报错 | `invoke is not defined` | 搜索只存在于 Tauri 路径 | UI 入口按 Tauri 环境守卫 |
| Writer 打不开 | `tantivy-writer.lock` 冲突 | 另一个活跃 writer 持有 OS lock | 保留锁文件并返回真实错误；禁止按路径存在与否猜测 stale |
| Session 索引反复报 `FileDoesNotExist(.del)` | watcher 每批 commit 都失败 | Tantivy metadata 引用了缺失 segment | `SessionIndex` 单 owner 清空派生目录，从 `sessions.json` + JSONL 重建并重试一次 |
| 重启后第一次文件搜索仍冷建 | 文件区显示长时间“搜索中” | 前台 `search` 错误调用了 cold build，或等待正在 cold build 的 workspace slot | `search` 只能用持久 index 或 direct scan fallback；cold build 只能由后台 `refresh_or_create` 触发 |
| 文件 symlink 指到工作区外 | 搜索结果泄露外部文件片段 | 扫描或读取阶段跟随 symlink | `file_indexer` 扫描和读前都用 `symlink_metadata`，并按 discovery state 二次校验 |
| 搜索命中同文件不跳转 | 右侧仍停在上一次行号 | 只依赖一次性的 `initialLineNumber` 或 remount editor | 使用 `FilePreviewFocusTarget` 事件驱动已 mount Monaco |
| 点击“在文件目录中展示”后偶发跳旧文件 | 目录树重渲染时旧 reveal 再次执行 | `revealRequest` 没有被消费清空 | `WorkspaceTreeViewport` 成功 `scrollToIndex` 后调用 `onRevealHandled` |
| Windows 搜索结果无法在树中定位 | 搜索 hit path 带 `\`，文件树 path 带 `/` | 前端没有在搜索结果入口归一化 path | `normalizeFileSearchHits` 入 state 前统一转 slash path |
| 新增空目录后搜索不刷新 | 文件内容没有变化，`changedFiles` 仍为 0 | SWR 只在 file diff 非零时重搜 | refresh 完成后只要 query generation 仍有效就重搜，并原子提交 folder/file |
| 文件名命中显示“1 条正文” | 后端用 `max(1)` 把 filename hit 冒充内容 hit | 文件对象命中与正文 chunk 混为一个计数 | filename-only 的 `matchCount = 0`；UI 不渲染 badge/chunk |

## 相关代码索引

- 后端入口：`src-tauri/src/search/mod.rs`
- Tauri 注册：`src-tauri/src/lib.rs`（`invoke_handler` + `.setup()` 初始化）
- 前端 API：`src/renderer/api/searchClient.ts`
- 前端组件：`src/renderer/components/search/`
- 搜索导航 helper：`src/renderer/utils/workspaceSearchNavigation.ts`
- 文件预览跳转：`src/renderer/components/FilePreviewModal.tsx`, `MonacoEditor.tsx`
