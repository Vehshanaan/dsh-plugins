# 新插件开发指南

三个插件（`btw/`、`vscode/`、`automode-guardrail/`）遵循同一套骨架。照此模式新增插件即可被 workspace 统一构建/测试/挂载。

## 1. 目录结构

```
<插件名>/
├── package.json        # 名称 dsh-<插件名>，scripts: build/typecheck/test
├── tsconfig.json       # strict，noEmit；moduleResolution: Bundler
├── vitest.config.ts    # include tests/**/*.spec.ts，environment: node
├── src/
│   ├── index.ts        # 插件主体：name/inject/Config/apply（function plugin）
│   ├── types.ts        # Config 类型 + resolveConfig（fail-loud 校验）
│   └── invariant.ts    # invariant companion（无独立不变量时给具体理由）
├── tests/
│   ├── <插件名>.spec.ts      # 纯函数单元测试
│   └── integration.spec.ts   # 真实插件 + mock LLM 的闭环测试
└── README.md           # 语义、配置、模型体验、挂载
```

## 2. package.json 要点

```jsonc
{
  "name": "dsh-<插件名>",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "esbuild src/index.ts src/invariant.ts --bundle --format=esm --platform=node --target=node22 --outdir=dist --external:@deepseek-ai/*",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.1 <5.0.0",
    "@deepseek-ai/schemastery": ">=3.18.1 <4.0.0",
    // …运行时用到的 @deepseek-ai/*（esbuild 对其保持 external，运行时从 dsh 树解析）
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "esbuild": "^0.25.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
    // …测试 import 到的每个 @deepseek-ai/* 都必须显式声明（peer 或 dev），
    //   否则 pnpm 不为其创建链接，测试会报 Cannot find package
  }
}
```

然后在根 `pnpm-workspace.yaml` 的 `packages:` 列表中加入插件目录，`corepack pnpm install`。

## 3. 插件主体模式（src/index.ts）

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveConfig, type MyConfig } from './types.ts'

export const name = 'my-plugin'
export const inject = ['…需要注入的服务…']     // 可选服务用 ctx.get / ctx.inject 条件组合
export const Config = z.object({ … })

export function apply(ctx: Context, config: MyConfig): void {
  const resolved = resolveConfig(config)
  // 通过 ctx 扩展点注册能力（命令 → ctx.inject(['commands'])；工具 → ctx.tools…）
}
```

约定：

- **命令**：`ctx.inject(['commands'], commandCtx => commandCtx.commands.register({ name, description, input, handler }))`——handler 直接执行、不经过模型；命令生命周期由 registry 自动记录为 log-only 事件（`command/run`/`command/done`），不进模型历史
- **模型可见 ⟺ 已记录**：任何会到达模型请求的输入必须可从事务日志重建；旁路/瞬态数据不要塞进主会话
- **配置 fail-loud**：`resolveConfig` 对未知键、空串、越界值抛错；schema 只做形状校验
- **不变量**：`invariant.ts` 注册包名；无独立事件序列时给出具体理由（"由 XX 包的不变量拥有"），不要留空注释

## 4. 测试模式

- **单元测试**：测 `resolveConfig` 全分支与导出的纯函数
- **闭环集成测试**：`ctx.plugin(…)` 组合真实服务（LlmRuntime/SessionStore/SystemPrompt/Tools/Agent/AgentLoop/Commands/…）+ 本插件，模型用脚本化 MockAdapter（`tests/` 内自备，参考 `btw/tests/mock-adapter.ts`）。断言用户可见行为：命令结果、会话日志语义、失败路径、取消

```sh
corepack pnpm --dir <插件名> run test
```

## 5. 挂载与发布

按 [SETUP.md](SETUP.md) §3 挂载（profile patch，`file:///<checkout>/<插件名>/dist/index.js`）。对外发布时：去掉 `private: true`、填写 license 与 repository，可选打包为 bundle（`dsh` 字段声明）供 `dsh plugin add` 安装。