# tread

conda 风格的 AI agent 环境管理器。为 Claude Code、Cursor Agent、Kimi Code 提供互相隔离的环境，激活一次，后续直接敲 `claude` / `cursor-agent` / `kimi` 就在环境里。

**tread 不安装 skill / plugin / MCP / hooks。** 它给你隔离的容器和一个检视器；装东西用各 agent 自己的工具。

## 安装

```bash
git clone <this-repo> && cd tread
./install.sh
```

然后把 shell 集成加进 `~/.zshrc`：

```bash
eval "$(tread init zsh)"
```

（`bash` / `fish` 同理；fish 用 `tread init fish | source`。）

要求：Bun ≥ 1.3 用于编译，`~/.local/bin` 在 `PATH` 中。**编译产物是自足的单二进制**，运行时不需要 bun。

## 用法

```bash
tread create work
tread use work

claude          # 用的是 work 环境的配置
cursor-agent    # 同上
kimi            # 同上

tread deactivate    # 回到你原本的 ~/.claude 等
```

新开一个终端就是未激活状态，真实 home 完全不受影响。未激活时 shim 不在 `PATH` 上，
`claude` 就是真的 claude；即使直接调用 shim，它也会原样透传。

## 工作原理

激活做两件事：export 各 agent 的 config dir 变量，并把 `<state>/shims` 放到 `PATH` 最前。

| agent | 变量 | 是否重定向 HOME | 环境内位置 |
|---|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | 否 | `<env>/.claude/` |
| cursor | `CURSOR_CONFIG_DIR` + `CURSOR_DATA_DIR` | **是** | `<env>/.cursor/` |
| kimi | `KIMI_CODE_HOME` | **是** | `<env>/.kimi-code/`、`<env>/.agents/skills/` |

**为什么需要 shim 和 HOME 重定向。** cursor 的 `mcp.json` 与 `hooks.json` 是用硬编码的
`join(homedir(), ".cursor", …)` 解析的，完全无视 `CURSOR_CONFIG_DIR`；kimi 的用户级 skill
在 `~/.agents/skills`。实测：只设 config dir 变量时，真 home 的 MCP 服务器和 28 个 skill
会原封不动带进环境；把 `HOME` 指向环境后归零。

HOME 只对需要它的 agent 进程生效——shim 里设置，不会污染你的 shell，所以 `git`、`ssh`、
`npm` 照常工作。claude 把一切都放在 config dir 内，因此不动它的 HOME。

环境目录做成 home 的形状，并把真 home 的内容 symlink 进来——**默认全部共享，只拒绝该隔离的**：

```
拒绝：.claude  .cursor  .kimi-code  .agents  .local/state
      Library/Application Support/Cursor/User/globalStorage   ← macOS
共享：其余一切（.ssh  .config  .zshrc  .npmrc  .cargo  …）
```

拒绝项支持嵌套：最后那条是 Cursor 桌面版的状态库，缓存着 skill / plugin 索引，
共享它会把你装过的每个 skill 都带进来；但整个 `Library` 又是 cursor 登录态所在，
所以只挖掉这一个子路径，它的祖先照常镜像、兄弟目录照常共享。拒绝项由 agent 适配器
声明并区分平台，注册新 agent 时跟着它一起走。

用拒绝表而不是允许表，是因为允许表会漏掉你以后才装的工具。链接在**每次激活时重新同步**，
新增的配置自动接上，真 home 里删掉的会被摘除。环境里自己建的真实文件永远优先，不会被链接覆盖。

`.local` 不整体链接（tread 自己的状态在里面，链了会把环境套进自己），改为往下一层
链 `bin`、`share` 等，只跳过 `state`。

## 装东西：用各 agent 原生的工具

激活环境后：

```bash
# plugins
claude plugin install <name>@<marketplace>
cursor-agent plugin marketplace add <url>
kimi                                        # 在 TUI 里 /plugins

# MCP
claude mcp add ...
cursor-agent mcp ...
$EDITOR "$(tread path work kimi)/mcp.json"

# hooks
$EDITOR "$(tread path work claude)/settings.json"

# skills（任何安装器；--home 让按 $HOME 解析的工具落进环境）
tread exec work --home -- skills add vercel-labs/agent-skills -g -a claude-code
tread exec work --home -- clawhub install <name>
```

## 命令

```
tread init <zsh|bash|fish|starship>   打印 shell 集成
tread create <name>                   创建环境
tread use <name> / deactivate         激活 / 退出
tread ls                              浏览并切换环境（TUI）
tread status [env]                    每个环境装了多少
tread show [env]                      浏览一个环境（TUI）

tread skills  [env] [agent] [name]    只读列表 / 详情
tread plugins [env] [agent] [name]
tread mcp     [env] [agent] [name] [--probe]
tread hooks   [env] [agent] [event]

tread path [env] [agent] [category]   打印目录
tread exec <env> [--home] -- <cmd>    在环境里跑一条命令
tread rm <name> [--force]             删除环境
tread doctor [--fix]                  体检
```

`ls` 和 `show` 是 TUI（圆角边框、键盘 + 鼠标、随窗口自适应）。非 TTY、`--plain`、或终端小于 30×8 时自动退回纯文本。

## MCP 连通状态

`tread mcp` 默认只做免费检查：http 服务器不发请求，stdio 服务器只查命令存在且可执行。

加 `--probe`（TUI 里按 `t`）才做完整 MCP 握手并列出工具。这是刻意的：**stdio 的 MCP server 没有"连接"可观测**——它是 agent 每次会话 fork 出来的子进程，探测它等于新起一个实例；而 http 探测会把你存的凭证发出去。这两件事都应该由你按下按键那一刻触发。

MCP 的 header 与 env **只显示 key，值一律打码**。

## 已知限制

- **claude 每个环境要单独 `/login` 一次。** 它的凭证在 keychain 里且与 config dir 绑定，磁盘上没有可复制的东西（实测：全量复制 config dir 也无效）。cursor 的凭证在 keychain 且不受 config dir 影响，自动共享；kimi 的凭证在磁盘上，tread 建环境时 symlink 回真 home，也不用重登。
- **cursor 会往新环境里自动下载你账号的默认插件。** 实测新建环境 32 秒后它自己拉了一份
  `dbt / github / redis-development / superpowers`——是独立副本不是泄漏，但新环境对 cursor
  而言不是全空的。要清掉用 `cursor-agent plugin` 自己处理。
- **只管理环境级（全局）内容。** project scope 的 skill / plugin / MCP / hook 不读也不显示——那是各 agent 自己的事。
- **新建 kimi 环境会从真 home 播种 provider / model 配置**（剥掉 hooks）。kimi 把模型设置和凭证分开存，不播种的话环境根本起不来。
- `tread use` 需要 shell 集成。脚本里用 `tread exec` 代替。

## starship

```bash
tread init starship
```

把打印出来的片段放进 `~/.config/starship.toml`，再把 `${env_var.tread}` 放进顶层 `format`。未激活时胶囊自动消失。

## 开发

```bash
bun install
bun test              # 127 个测试，含 e2e
bun run typecheck
bun run src/index.ts  # 直接从源码跑
```

目录：

- `~/.local/state/tread/envs/<name>/` — 环境（`TREAD_STATE_DIR` 可覆盖）
- `~/.local/state/tread/state.json` — 上次使用时间
- `~/.local/state/tread/shims/` — agent 启动垫片（`tread doctor --fix` 可重建）
- `~/.local/bin/tread` — 二进制

设计文档在 `docs/superpowers/specs/`，实施计划在 `docs/superpowers/plans/`。
