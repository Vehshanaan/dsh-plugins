# dsh-memory

Claude Code 风格的跨会话记忆插件：模型可以主动保存记忆，也可以在配置后从对话中自动提炼；记忆存在 `$DSH_HOME/memory`（默认 `~/.dsh/memory`），下次会话自动注入索引，跨会话"想起来"。

## 语义

记忆分两层，注入范围不同——这是省 token 的关键：

| 层 | 存什么 | 注入范围 |
|---|---|---|
| **global** | 跨项目通用：用户身份与偏好、对 AI 行为的纠正、通用工作方式 | 所有会话 |
| **project** | 仅当前项目成立：仓库结构、项目约定、项目专属决策 | 该项目（会话 cwd 的 git root）的会话 |

`memory_save` 工具描述里写明判断准则；拿不准时倾向 project（项目级条目永远不会污染其他项目）。`/memory move` 可以手动纠正分错的层。

每个层一个 `MEMORY.md` 索引（限 200 行 / 25KB，可配），模型看到的是每条记忆一行简介；需要细节时调用 `memory_search` 读全文。注入文本带防漂移提示：记忆里提到的文件/函数可能已被改名或删除，引用前先验证。

## 存储格式

纯 Markdown，无数据库，可以直接用编辑器查看和修改：

```
~/.dsh/memory/
├── MEMORY.md                  # 全局索引
├── global/<标题>.md           # 全局条目（frontmatter + 正文）
└── projects/<slug>/
    ├── MEMORY.md              # 项目索引
    └── <标题>.md              # 项目条目
```

条目 frontmatter：`name` / `description`（单行）/ `type`（user|feedback|project|reference，封闭四类型，对齐 Claude Code）/ `created` / `updated`。同标题保存 = 更新同一条目（保留创建时间）。手写/手工编辑的条目立即出现在注入索引里（索引实时从目录渲染）。

## 模型体验

- **`memory_save`**：保存一条记忆。参数：`scope`（global|project）、`title`、`description`、`type`、`content`。无 agent 或 project 无会话 cwd 时拒绝。
- **`memory_search`**：检索并返回全文。参数：`query`、可选 `scope`（global|project|all）、`limit`。内容超 `maxContentChars` 截断并标记。
- **注入上下文**：`memory:index`（prompt order 150），含全局索引 + 当前项目索引 + 防漂移句；无记忆时不注入。

## 用户命令

- `/memory` / `/memory list [global|project]`：列出记忆
- `/memory search <词>`：搜索并显示全文
- `/memory view <标题>`：查看全文
- `/memory delete <标题>`：删除
- `/memory move <标题> <global|project>`：移动层级（项目↔全局）

命令直接操作文件，不经过模型，只记录 `command/run`/`command/done` 生命周期事件，不进模型历史。

## 自动提取（可选）

配置 `autoExtract` 后，每个顶层会话（子代理会话除外）的 `step/end` 之后，用轻量模型调用审查最近的用户消息并提议值得记住的事实；与已有标题去重后写入。默认每会话 10 分钟最多一次，失败只记日志，绝不阻塞会话。

```yaml
config:
  autoExtract:
    provider: deepseek-official
    model: deepseek-v4-flash
    maxTokens: 1024
    maxInputChars: 12000
    minIntervalMs: 600000
    perTurnMax: 2
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `root` | `$DSH_HOME/memory` | 记忆根目录 |
| `indexLineLimit` | 200 | 注入索引行数上限 |
| `indexByteLimit` | 25000 | 注入索引字节上限 |
| `maxContentChars` | 2000 | `memory_search`/命令返回的内容截断上限 |
| `injectGlobalIndex` | true | 注入全局索引 |
| `injectProjectIndex` | true | 注入项目索引 |
| `autoExtract` | 关 | 自动提取配置（见上） |

配置校验 fail-loud：非法值在加载时报错，不会静默降级。

## 挂载

按 [SETUP.md](../SETUP.md) §3 挂载：

```yaml
- insert:
    - id: memory
      name: 'file:///<checkout>/memory/dist/index.js'
```

## 已知限制与待办

- 召回是"注入索引 + 显式搜索"，没有 Claude Code 的 Sonnet 侧查询智能筛选（v1 索引有行/字节上限，成本可控）；后续可按需加侧查询。
- 自动提取不会覆盖用户手动编辑过的条目（标题去重只增不改），也**不**提取子代理会话。
- 索引注入每次请求实时从目录渲染（同步读，条目数少时开销可忽略）；条目非常多时可考虑 mtime 缓存。
- `memory_save` 要求模型自己选 `scope`；模型判断错误时用 `/memory move` 纠正。
- 注入的索引和工具调用都会进入会话日志（模型可见 ⟺ 可记录）；自动提取的模型调用本身是旁路的（同 automode-guardrail 的 classifier，不产生会话事件，其结果以注入索引的形式出现在后续请求中）。
