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

新开一个终端就是未激活状态，真实 home 完全不受影响。`which claude` 永远指向真的 claude——tread 不装 shim、不改 PATH、不代理任何命令。

## 工作原理

激活就是在当前 shell 里 export 几个变量，三家 agent 自己读：

| agent | 变量 | 环境内位置 |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | `<env>/.claude/` |
| cursor | `CURSOR_CONFIG_DIR` + `CURSOR_DATA_DIR` | `<env>/.cursor/` |
| kimi | `KIMI_CODE_HOME` | `<env>/.kimi-code/` |

环境目录做成了 home 的形状（`.claude/`、`.cursor/`、`.agents/skills/`），所以任何按 `$HOME` 解析路径的安装器都能通过 `tread exec --home` 正确落地。

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
- **只管理环境级（全局）内容。** project scope 的 skill / plugin / MCP / hook 不读也不显示——那是各 agent 自己的事。
- `tread use` 需要 shell 集成。脚本里用 `tread exec` 代替。

## starship

```bash
tread init starship
```

把打印出来的片段放进 `~/.config/starship.toml`，再把 `${env_var.tread}` 放进顶层 `format`。未激活时胶囊自动消失。

## 开发

```bash
bun install
bun test              # 105 个测试，含 e2e
bun run typecheck
bun run src/index.ts  # 直接从源码跑
```

目录：

- `~/.local/state/tread/envs/<name>/` — 环境（`TREAD_STATE_DIR` 可覆盖）
- `~/.local/state/tread/state.json` — 上次使用时间
- `~/.local/bin/tread` — 二进制

设计文档在 `docs/superpowers/specs/`，实施计划在 `docs/superpowers/plans/`。
