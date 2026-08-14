# dsh-vscode — `/vscode` 在 VS Code 中打开工作区

主对话中输入 `/vscode` 在 VS Code 中打开当前会话的工作目录；`/vscode <相对路径>` 打开工作区内的子路径或文件。命令在宿主侧直接执行，**不经过模型**，主会话只留下两条 log-only 生命周期事件。

## 用法

```
/vscode                     打开当前会话工作目录
/vscode src/index.ts        打开工作区内文件
/vscode packages/           打开工作区内子目录
```

## 语义与边界

- 目标路径基于 `agent.session.header.cwd` 解析，**必须落在工作区内**（`..` 逃逸与绝对路径一律拒绝），命令无法让编辑器打开任意宿主路径
- **含空格路径（如 `My Project/design notes.md`）正确处理**：Windows cmd 模式下自动加引号整体传递，不会按空格拆成多个文件打开（`quoteArgsForShell`）
- 无工作目录的会话 → 明确报错
- 编辑器 CLI 缺失（ENOENT）→ 报错提示安装 VS Code 并确保 `code` 命令可用（Windows 使用 `code.cmd`）
- 进程以 detached + unref 启动，编辑器窗口独立于 dsh 生命周期
- 命令名与附加参数可配置（见下），其余错误原样回显

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `command` | `code` | 编辑器 CLI 命令名（如 `codium`） |
| `args` | `[]` | 追加在目标路径前的 CLI 参数（如 `["--reuse-window"]`） |

例（profile patch）：

```yaml
- insert:
    - id: vscode
      name: '.../dsh-plugins/vscode/dist/index.js'
      config:
        command: code
        args: ['--reuse-window']
```

## 构建与测试

```sh
npx esbuild src/index.ts src/invariant.ts --bundle --format=esm --platform=node --target=node22 --outdir=dist --external:@deepseek-ai/*
npx tsc --noEmit -p tsconfig.json
npx vitest run
```

依赖解析同 `btw/`：`@deepseek-ai/*` 经 `dsh-plugins/node_modules/@deepseek-ai` junction 指向 `$DSH_HOME/profiles/node_modules`。