# automode-guardrail

[English](README.md) | 中文

全自动模式（full-access）下的指令安全护栏：当会话处于"武装"沙箱模式（默认 `danger-full-access`，即文件沙箱不限制任何修改）时，每一次工具调用在执行前都要过筛。本插件是策略控制，不是安全边界——一次误放行就意味着调用真的执行了。

两层防线：

- **硬规则**——一个同步、单调、只可否决的守卫（`ctx.tools.guard`）对 shell 命令（`bash`、`pwsh`）做不可逆灾难特征匹配：递归删除文件系统根、用户主目录、工作区根或根级通配符；写裸设备（`dd of=/dev/…`）；`mkfs`；`format <盘符>:`；`diskpart clean`；以及关机/重启类机器停机操作。守卫的否决无法被任何 `tools/pre-execute` 监听器推翻。
- **LLM 分类器**（可选）——一个最外层的 `tools/pre-execute` 监听器，把其余每次调用连同构造好的 JSON 输入（工具名、完整参数、最近最多 20 条摘要化的人类消息与工具调用、当前沙箱政策）交给分类模型裁决。`allow` 放行；`deny` 直接截断管线，把理由作为工具错误返回给模型。分类器任何故障——超时、服务商报错、输出格式非法——一律拒绝（fail closed，绝不默认放行）。

固定的只读工具集合（`read`、`glob`、`grep`、`read_image`、`job_output`、`job_list`、`todo_write`、`get_goal`、`list_agents`、`skill`、`ask_user_question`、`exit_plan_mode`）跳过分类，但硬规则依然生效；`skip` 可追加豁免名单。

## 配置

```yaml
config:
  modes: ['danger-full-access']   # 武装护栏的沙箱模式
  skip: []                        # 额外豁免分类的只读工具名
  classifier:                     # 省略则只跑硬规则模式
    provider: deepseek-official   # 已注册的 LLM 服务商路由
    model: deepseek-v4-flash      # 具体模型 id
    maxInputBytes: 12000          # 分类输入的最大 UTF-8 字节数
    maxOutputTokens: 1024         # 分类输出 token 上限
    reasoningEffort: off          # 思考强度；off 让裁决更快（默认）
```

配置错误在加载时立即报错：未知模式、空的 `skip` 条目、非法的分类器预算、配置了分类器但没有 LLM 服务，都会抛出异常。硬规则表和固定只读集合是安全不变量——不可配置。

## 拒绝文本

被拒的调用会以工具错误的形式呈给模型：

```
Error: auto-safety guardrail denied bash (destructive): recursive delete (rm with -r and -f) targeting a filesystem root, the home directory, the workspace root, or a root glob
```

判定元数据（规则 id、裁决类别、分类器路由与输入大小）写入宿主日志。本插件不新增任何会话事件类型，因此不认识该插件的 harness 版本仍能正常读取会话日志；模型可见的拒绝文本已经由工具管线自身的 `tool/result` 事件完整记录，可随时回放重建。

## 加载方式

构建后，让 profile 补丁以 ile:// URL 形式指向构建产物——loader 会把条目名直接交给 import()，Windows 裸盘符路径会被当成协议拒绝（启动器完全不变）：

```sh
corepack pnpm install && corepack pnpm run build
dsh --profile web --patch ./dsh-plugins/cordis.yml
```

或把打包产物装进 profile（`dsh plugin --profile web add ./automode-guardrail-0.1.0.tgz`），再在 profile 补丁中加入 `automode-guardrail`。harness 各包以 peerDependencies 声明：插件从 profile 自己的依赖树解析它们，与运行时共享同一份实例。

## Model Experience

### 请求上下文：护栏激活提示

#### 模型看到什么

会话生效沙箱模式处于武装状态时，运行时上下文快照增加一句话：

```markdown
Auto-safety guardrail active: this session runs with unrestricted file access, and tool calls are screened before execution. Denied calls return a reason — adapt with a different approach instead of re-issuing the denied call.
```

#### Token 影响

武装期间每次请求固定一句话；未武装时零 token。

#### KV Cache 影响

仅在保留历史之后追加；武装/解除切换只改变这一段，稳定的系统提示前缀不受影响。

### 工具结果：拒绝

#### 模型看到什么

被拒调用返回 `isError` 工具结果，内容即上述拒绝文本。分类器自己的回复永远不会进入模型上下文。

#### Token 影响

每次被拒调用一条错误消息；放行的调用不产生任何分类器来源的 token。

#### KV Cache 影响

只追加；拒绝以普通工具结果形式出现，不重写任何先前的请求前缀。

## 已知限制与后续工作

- **是策略控制，不是安全边界**——误放行即真实执行；分类器挡不住操作系统层面能做的事。上线前先用 `IMPLEMENTATION-PLAN.md` 中的评测集标定误放行率，部署环境允许时尽量保留机器级沙箱。
- **没有人工升级通道**——分类器只允许或拒绝，拒绝即该调用终结，由模型自行改道（转交审批 seam 的人工升级留待交互式 full-access 部署需要时再做）。
- **没有判定缓存**——同形重复调用每次都付一次分类器往返，per-turn 判定缓存留待后续。
- **截断仍可能拒绝**——`max-tokens` 结束的流如果裁决行完整会正常解析；裁决生成前被截断则拒绝（fail closed）。分类器默认 `reasoningEffort: off`，裁决很短、1024 token 上限很少触顶；把强度调高的部署应同步调大 `maxOutputTokens`。
- **不新增会话事件**——harness 尚未给仓库外插件开放事件类型注册面，判定元数据只进宿主日志，事后复核靠日志关联而非会话回放。
- **分类摘要不含助手文本与工具结果**——范围判断只用最近的人类消息与工具调用，输入有界但上下文更少。