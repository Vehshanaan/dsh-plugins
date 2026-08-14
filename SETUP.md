# dsh-plugins 接入指南

本文档回答"换一台机器怎么把插件跑起来"，是各插件 README 与根 README 的接入总纲。文中 `<checkout>` 指本仓库克隆到的目录（例如 `~/deepseek-harness/dsh-plugins`）。

## 1. 前置条件

- **dsh**：任意安装方式（npm 全局、npx、源码）均可；**至少成功启动过一次 `dsh web`**——这会初始化 `$DSH_HOME/profiles/<profile>/node_modules` 依赖树，是挂载与（可选的）依赖链接的前提
- **Node.js ≥ 22.19**（建议 24）
- **corepack**（Node 自带）或 pnpm ≥ 9

## 2. 接入步骤

### 2.1 克隆并安装依赖

```sh
git clone <本仓库地址> <checkout>
cd <checkout>
corepack pnpm install        # 安装全部插件依赖（@deepseek-ai/* peer 依赖 + 开发工具链）
corepack pnpm -r run build   # 构建全部插件 → 各插件 dist/
```

依赖解析说明：插件以 ESM bundle 发布，对 `@deepseek-ai/*` 保持 external，运行时从插件所在位置向上解析 `node_modules`。`pnpm install` 已在 workspace 内为每个插件链接好它声明的 peer 依赖，因此插件与运行中的 dsh 共享**同一版本的包实例**（避免 Cordis 双实例）。

### 2.2 （可选）与运行中 dsh 版本强一致

pnpm 安装的是 registry 上满足版本范围的最新包。如果你希望插件**精确**解析到当前 `$DSH_HOME` 中 dsh 安装使用的依赖树（例如 dsh 由 npx 缓存运行、registry 版本滞后时），可以把 `node_modules/@deepseek-ai` 替换为指向 dsh 依赖树的链接（以下命令在 `<checkout>` 下执行，先删除 pnpm 链接）：

**Windows（PowerShell）**：

```powershell
Remove-Item node_modules/@deepseek-ai -Force
New-Item -ItemType Junction -Path node_modules/@deepseek-ai -Target "$env:DSH_HOME/profiles/node_modules/@deepseek-ai"
```

**macOS / Linux**：

```bash
rm node_modules/@deepseek-ai
ln -s "$DSH_HOME/profiles/node_modules/@deepseek-ai" node_modules/@deepseek-ai
```

> 提示：这会改变 workspace 内的解析结果，`pnpm install` 之后需要重新执行。日常使用推荐默认的 pnpm 解析；仅当遇到版本行为差异时再启用本小节。

### 2.3 验证构建产物

```sh
node --input-type=module -e "await import('<checkout>/btw/dist/index.js').then(m => console.log(m.name))"
```

应输出 `btw`（vscode、automode-guardrail 同理）。

## 3. 挂载

**推荐：写入 profile 用户层**（`$DSH_HOME/profiles/web/cordis.patch.yml`），`dsh web` 零参数启动即带插件，且该文件支持配置级 HMR（配置修改热生效；插件增删属结构变更，需重启）：

```yaml
- insert:
    - id: automode-guardrail
      name: 'file:///<checkout>/automode-guardrail/dist/index.js'
      config:
        modes: ['danger-full-access']
        skip: []
        classifier:
          provider: deepseek-official
          model: deepseek-v4-flash
          maxInputBytes: 12000
          maxOutputTokens: 1024
          reasoningEffort: off
          timeoutMs: 5000
- insert:
    - id: btw
      name: 'file:///<checkout>/btw/dist/index.js'
- insert:
    - id: vscode
      name: 'file:///<checkout>/vscode/dist/index.js'
```

**备选：启动时 `--patch`**（不写入 profile，适合临时验证）：

```sh
dsh web --patch ./cordis.yml
```

（仓库内的 `cordis.yml` 是挂载配置的源参考；两处修改时需保持同步，防止双挂载。）

**路径注意**：挂载 `name` 必须是 `file://` URL 形式的绝对路径（Windows 裸盘符路径 `D:/…` 会被 loader 拒绝）。换机器时把 `<checkout>` 替换为新路径。

## 4. 验证

```sh
dsh --profile web --dump-config
```

应看到三个插件行。随后 `dsh web` 启动，在会话中输入 `/btw 你好` 冒烟；`automode-guardrail` 在 `danger-full-access` 会话中自动生效。

## 5. 更新与维护

1. 修改 `src/` 后重建对应插件：`corepack pnpm --dir <插件> run build`
2. 如需改插件配置 → 同步修改 profile patch（与 `cordis.yml` 源参考一致）
3. 重启 `dsh web`

## 6. 应急关闭

编辑 profile patch：给对应 entry 加 `disabled: true`（保留配置、可逆）或删除整个 `- insert:` 块，然后重启 `dsh web`。insert 是结构变更，配置级 HMR 不卸载插件，必须重启。

## 7. 故障排查

| 症状 | 原因与处理 |
|---|---|
| boot 报 `Only URLs with a scheme in: file, data, and node` | 挂载 `name` 用了裸盘符路径；改成 `file:///…` |
| boot 报 `failed to import loader entry …` | 对应插件 `dist/` 未构建（§2.1），或 `name` 路径不存在 |
| 插件内 `Cannot find package '@deepseek-ai/…'` | 未执行 `corepack pnpm install`；或该包未声明在插件 `package.json`（peer/devDependencies）中 |
| 挂载两处都启用后命令重复/冲突 | 双挂载；只保留 profile patch 一处 |
| 插件行为与 dsh 不符（版本漂移） | 按 §2.2 让插件精确解析到 `$DSH_HOME` 当前依赖树 |
| `pnpm install` 网络失败 | registry 抖动；重试或指定镜像：`corepack pnpm install --registry https://registry.npmmirror.com` |