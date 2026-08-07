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

| agent | 变量 | 环境内位置 |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | `<env>/.claude/` |
| cursor | `CURSOR_CONFIG_DIR` + `CURSOR_DATA_DIR` | `<env>/.cursor/` |
| kimi | `KIMI_CODE_HOME` | `<env>/.kimi-code/`、`<env>/.agents/skills/` |

**为什么光有 config dir 变量不够。** 变量只管得住 agent **自己**解析的路径，管不住它
跑起来的第三方代码。cursor 的 `mcp.json` 与 `hooks.json` 是硬编码 `join(homedir(),
".cursor", …)`，完全无视 `CURSOR_CONFIG_DIR`；kimi 的用户级 skill 在 `~/.agents/skills`；
claude 自己确实处处遵守 `CLAUDE_CONFIG_DIR`，但一个装 hook 的 skill 会去算
`join(homedir(), ".claude", "settings.json")`，照样写进真 home。

所以三个 agent 的 shim **都**把 `HOME` 指向环境根。HOME 只对 agent 进程生效——在 shim 里
设置，不污染你的 shell。

环境目录做成 home 的形状，把真 home 里**被允许的部分** symlink 进来：

```
默认共享：.gitconfig  .ssh  .config  .cache  .npmrc  .cargo  .rustup
          .asdf  .tool-versions  .docker  .kube  .aws  …（见 defaultAllow）
永不共享：.claude  .cursor  .kimi-code  .agents  .local/state
          .tread  .config/tread
          Library/Application Support/Cursor/User/globalStorage   ← macOS
```

环境隔离的是 agent 工具链，不是整个账号——agent 仍然要 shell 出去跑 git、ssh、npm，
所以共享面必须够宽。清单由 tread 自带：让每个用户自己踩一遍"原来 git 要这个"，
收益和成本不成比例。

**没在清单上的东西留在环境里。** 这正是关键性质：某个 skill 自己建的状态目录天然隔离，
tread 不需要预先知道它叫什么名字。

改共享范围写 YAML，是**补丁**不是全量列表——这样 tread 的默认清单以后变大，你也能吃到：

```yaml
# ~/.config/tread/config.yaml     所有环境
# <env>/.tread/config.yaml        单个环境
allow:
  extra:  [.my-tool]
  remove: [.cache]
```

三层叠加：内置默认 → 全局 → 单环境。层内 `remove` 压过 `extra`，跨层后一层的 `extra`
可以把前一层 `remove` 的加回来。想彻底不要默认清单就用 `replace:`。

"永不共享"那几条配置碰不到（写了 `doctor` 会报）：agent 目录必须是环境里的真目录，
否则隔离无从谈起；`.local/state` 是 tread 自己的状态，链了会把环境套进自己；
`.tread` 和 `.config/tread` 是配置本身，被链接覆盖就自举失败。

拒绝项支持嵌套：`.config` 整体共享，但里面的 `tread` 子目录挖掉——这一层改用镜像真目录
而不是整个 symlink，兄弟目录照常共享。macOS 那条同理，是 Cursor 桌面版缓存 skill/plugin
索引的状态库。

链接在**每次激活时重新同步**。环境自己记一份清单（`<env>/.tread/sync.json`），所以从配置里
删掉一项会真的把链接摘掉——只收紧配置却不摘链接，是白名单最坏的失败方式。摘除只动指向真
home 的 symlink 和空目录，绝不 `rm -r`：环境里自己建的真实文件永远优先。

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

每个环境都自带一个 `tread` skill，三个 agent 的 skills 目录里各装一份，每次激活跟着更新。
里面写清了整套 CLI、各目录位置、以及"你的 `$HOME` 不是用户的真 home"——agent 最容易
猜错的就是这件事，与其指望用户去解释，不如把说明放在它手边。

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

加 `--probe`（TUI 里按 `t`）才做完整 MCP 握手并列出工具。握手是**流式读到应答就停**，
不等 server 退出或流关闭——MCP server 应答后本来就继续活着。

http 探测先走 `fetch`，失败再退回 `curl`。Bun 的 fetch 不支持 socks5，也会把某些本地代理
在 CONNECT 应答里带的 `Transfer-Encoding: chunked` 判成非法响应；curl 两样都能处理，
且读同一套代理环境变量。所以 `ep tread mcp … --probe` 这种带代理的用法能正常工作。这是刻意的：**stdio 的 MCP server 没有"连接"可观测**——它是 agent 每次会话 fork 出来的子进程，探测它等于新起一个实例；而 http 探测会把你存的凭证发出去。这两件事都应该由你按下按键那一刻触发。

MCP 的 header 与 env **只显示 key，值一律打码**。

## 已知限制

- **claude 每个环境要单独 `/login` 一次。** 它的凭证在 keychain 里且与 config dir 绑定，磁盘上没有可复制的东西（实测：全量复制 config dir 也无效）。kimi 的凭证在磁盘上，tread 建环境时 symlink 回真 home，不用重登。

- **macOS 的 login keychain 必须共享（`Library/Keychains`）。** keychain 是按 `$HOME` 找的，
  HOME 一移动，`security default-keychain` 直接报 *a default keychain could not be found* ——
  claude 和 cursor 的登录态全在里面，表现就是死活登不上、弹窗说找不到钥匙串。只共享
  `Library/Keychains` 这一条，`Library` 本身改用镜像目录，其余 app 状态照旧隔离。
- **cursor 会往新环境里自动下载你账号的默认插件。** 实测新建环境 32 秒后它自己拉了一份
  `dbt / github / redis-development / superpowers`——是独立副本不是泄漏，但新环境对 cursor
  而言不是全空的。要清掉用 `cursor-agent plugin` 自己处理。
- **只管理环境级（全局）内容。** project scope 的 skill / plugin / MCP / hook 不读也不显示——那是各 agent 自己的事。
- **新建 kimi 环境会从真 home 播种 provider / model 配置**（剥掉 hooks）。kimi 把模型设置和凭证分开存，不播种的话环境根本起不来。
- `tread use` 需要 shell 集成。脚本里用 `tread exec` 代替。

## starship

```bash
tread init starship --write     # 两步都替你做了
tread init starship             # 或者打印出来自己贴
```

starship 只渲染顶层 `format` 点到名的模块，所以光加 `[env_var.tread]` 表是不够的：写了显式
`format` 的配置还得把 `${env_var.tread}` 放进去，否则胶囊永远不出现。`--write` 两件事一起做——
追加模块，并把 `${env_var.tread}` 插到顶层 `format` 最前面（没有顶层 `format` 时不动，默认的
`$all` 已经覆盖 `env_var.*`）。想换位置就自己挪那一处引用。未激活时胶囊自动消失。

## 开发

```bash
bun install
bun test              # 129 个测试，含 e2e
bun run typecheck
bun run src/index.ts  # 直接从源码跑
```

目录：

- `~/.local/state/tread/envs/<name>/` — 环境（`TREAD_STATE_DIR` 可覆盖）
- `~/.local/state/tread/state.json` — 上次使用时间
- `~/.local/state/tread/shims/` — agent 启动垫片（`tread doctor --fix` 可重建）
- `~/.local/bin/tread` — 二进制

设计文档在 `docs/superpowers/specs/`，实施计划在 `docs/superpowers/plans/`。
