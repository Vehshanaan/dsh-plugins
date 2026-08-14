# dsh-btw — `/btw` 旁路提问

主任务进行中顺手问一个问题：`/btw <问题>`。回答通过命令卡片显示，**不进主对话历史**（模型上下文零污染），**不影响后续正式对话**。

## 语义

一次 `/btw` 的完整行为：

1. 命令注册于 `ctx.commands`，handler 直接执行，不经过主模型。
2. 问题作为 prompt 交给 `ctx.subagents.start('spawn', …)` 启动的独立 side 子会话（零父上下文、默认无工具）。
3. 回答完成后，主会话日志只新增两条 log-only 生命周期事件（`command/run` + `command/done`）。它们不进入 `deriveMessages()`，因此模型历史、KV cache 完全无痕。
4. side 子会话独立落盘（`origin: 'subagent'`，parent = 主会话），完整问答可审计。
5. 回答文本进入 `command/done.text`，Web 端命令卡片自动渲染，无需客户端改动。

## 用法

```
/btw 这个函数为什么报错？
/btw 帮我查一下 pnpm 文档里 workspace 协议怎么用
```

空输入返回错误提示。取消（中止 UI 请求）会取消正在运行的 side 子会话。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | `spawn` | subagent provider 名（`spawn` = 零父上下文；可换 `fork` 等） |
| `toolFilter` | `{ allow: [] }` | 子会话工具范围；默认无工具，side 问答不能改文件/跑命令 |
| `persona` | — | 可选子会话人设（shadow 部署 persona） |
| `agentOptions` | — | 可选子会话 LLM 路由 `{ provider, model, maxTokens }` |
| `maxOutputChars` | `8000` | 回答长度上限，超出截断并标记 |

例（`dsh-plugins/cordis.yml` 或用户 patch 覆盖）：

```yaml
- insert:
    - id: btw
      name: '.../dsh-plugins/btw/dist/index.js'
      config:
        maxOutputChars: 4000
```

## 构建与测试

```sh
npx esbuild src/index.ts src/invariant.ts --bundle --format=esm --platform=node --target=node22 --outdir=dist --external:@deepseek-ai/*
npx tsc --noEmit -p tsconfig.json
npx vitest run
```

## 依赖解析

插件 bundle 对 `@deepseek-ai/*` 保持 external，运行时从插件文件位置向上解析。`dsh-plugins/node_modules/@deepseek-ai` 是指向 `$DSH_HOME/profiles/node_modules/@deepseek-ai` 的 junction，因此插件与运行中的 dsh（安装版）共享同一套依赖；类型检查也解析到同一套 `.d.ts`，无版本漂移。