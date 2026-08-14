# dsh-plugins

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的 Claude Code 风格命令与安全插件集。所有插件都是标准的 Cordis 插件：构建为 ESM bundle，通过 profile patch 挂载，运行时与 dsh 共享同一套依赖。

## 插件

| 插件 | 功能 | 命令 |
|---|---|---|
| [`btw/`](btw/README.md) | **旁路提问**：主任务进行中顺手问一个问题，回答不进主对话历史、不影响后续正式对话（由独立子会话回答，默认无工具） | `/btw <问题>` |
| [`vscode/`](vscode/README.md) | **在 VS Code 中打开工作区**：打开当前会话工作目录或工作区内子路径/文件，不经过模型 | `/vscode [相对路径]` |
| [`automode-guardrail/`](automode-guardrail/README.md) | **工具调用安全闸**：全访问会话（`danger-full-access`）中，硬规则 + 可选 LLM 分类器在工具执行前拦截不可逆灾难操作 | —（自动生效） |

## 快速开始

前置：已安装 dsh（任意安装方式）并成功启动过一次 `dsh web`；Node.js ≥ 22.19（建议 24）。

```sh
git clone <本仓库> dsh-plugins
cd dsh-plugins
corepack pnpm install        # 安装依赖（含各插件 devDeps 与 @deepseek-ai/* peer 依赖）
corepack pnpm -r run build   # 构建全部插件 → dist/
```

然后按 [SETUP.md](SETUP.md) §3 把插件挂载进 `$DSH_HOME/profiles/web/cordis.patch.yml`（把 `<checkout>` 替换为仓库实际路径），启动：

```sh
dsh web
```

在会话中试一下 `/btw 你好`。

## 文档

- [SETUP.md](SETUP.md) — 跨机器接入总纲：依赖解析、构建、挂载、路径替换、应急关闭、故障排查
- [ADDING-A-PLUGIN.md](ADDING-A-PLUGIN.md) — 新插件开发指南（骨架、模式、测试、挂载）
- 各插件 README — 语义、配置、模型体验说明

## 开发

```sh
corepack pnpm -r run typecheck   # 全部插件类型检查
corepack pnpm -r run test        # 全部插件测试（vitest，mock 模型，无需 API key）
```

测试为真实插件 + mock LLM 的组合测试：验证命令注册、会话日志语义（如 `/btw` 主会话零污染）与失败路径。

## 许可

[MIT](LICENSE)