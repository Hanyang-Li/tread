# tread

conda 风格的 AI agent 环境管理器。为 Claude Code、Cursor Agent、Kimi Code 提供互相隔离、也与真实 home 隔离的环境，激活一次，后续直接敲 `claude` / `cursor-agent` / `kimi` 就在环境里。

**tread 不安装 skill / plugin / MCP / hooks。** 它给你隔离的容器和一个检视器；装东西用各 agent 自己的工具。

[English](README.md) · 仅支持 macOS（Apple Silicon）

## 安装

```sh
curl -fsSL https://raw.githubusercontent.com/Hanyang-Li/tread/main/install.sh | sh
```

脚本会从 GitHub Releases 下载 Apple Silicon 二进制到 `~/.local/bin`（无需 sudo），校验 sha256，把 `~/.local/bin` 加入 `PATH`，并执行 `tread init <你的 shell> --write`。也可以设置 `VERSION=v0.2.0` 安装指定版本、`INSTALL_DIR=/path` 改安装目录、`NO_MODIFY_PATH=1` 跳过修改 shell rc（改为打印手动步骤）。

装完开个新终端，或者 `source ~/.zshrc`。

**二进制是自足的**——运行时不需要 bun、node 或任何随附的 CLI。

目录：

| 路径 | 内容 |
|---|---|
| `~/.local/bin/tread` | 二进制 |
| `~/.local/state/tread/envs/<name>/` | 环境（根目录可用 `TREAD_STATE_DIR` 覆盖） |
| `~/.local/state/tread/shims/` | agent 启动垫片（`tread doctor --fix` 可重建） |
| `~/.local/state/tread/state.json` | 上次使用时间 |
| `~/.local/share/tread/_tread` | zsh 补全 |
| `~/.config/tread/config.yaml` | 全局配置（可选） |

### shell 集成

`tread init zsh --write` 做两件事：往 `~/.zshrc` 的标记区块里追加一行 `eval "$(tread init zsh)"`，以及把 tab 补全写到 `~/.local/share/tread/_tread`，由那行 eval 自己接进 `fpath`。补全覆盖子命令、环境名、agent 名、类别，以及每个环境里实际装着的 skill / plugin / MCP server / hook event。

也可以只把这一行手抄进 `~/.zshrc`：

```sh
eval "$(tread init zsh)"
```

那样不装补全——片段发现 `_tread` 不在就安静跳过，`tread doctor` 会告诉你它没装。

bash / fish 同理，但没有补全；fish 用 `tread init fish | source`。

`tread use` 和 `tread deactivate` 依赖这套集成，因为子进程不能修改父 shell 的环境变量。脚本里用 `tread exec` 代替。

### starship

```sh
tread init starship --write     # 两步都替你做了
tread init starship             # 或者打印出来自己贴
```

starship 只渲染顶层 `format` 点到名的模块，所以光加 `[env_var.tread]` 表是不够的：写了显式 `format` 的配置还得把 `${env_var.tread}` 放进去，否则胶囊永远不出现。`--write` 两件事一起做——追加模块，并把 `${env_var.tread}` 插到顶层 `format` 最前面（没有顶层 `format` 时不动，默认的 `$all` 已经覆盖 `env_var.*`）。想换位置就自己挪那一处引用。未激活时胶囊自动消失。

## 快速上手

```sh
tread create work
tread use work

claude          # 用的是 work 环境的配置
cursor-agent    # 同上
kimi            # 同上

tread deactivate    # 回到你原本的 ~/.claude 等
```

新开一个终端就是未激活状态，真实 home 完全不受影响。未激活时 shim 不在 `PATH` 上，`claude` 就是真的 claude；即使直接调用 shim，它也会原样透传。

## 命令详解

```
tread init <zsh|bash|fish|starship>   打印 shell 集成
tread create <name>                   创建环境
tread cp <src> <dst>                  复制一个环境
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
tread doctor [env] [--fix]            体检（给了 env 就只查这一个）
```

`ls` 和 `show` 是 TUI（圆角边框、键盘 + 鼠标、随窗口自适应）。非 TTY、`--plain`、或终端小于 30×8 时自动退回纯文本。

### `cp` 复制的是工具链，不是快照

`cp` 把 skills / plugins / MCP / hooks / commands 以及 agent 自己建的目录逐字节拷过去，会话记录、历史、日志、遥测、缓存不拷——实测一个 26M 的环境里这些占了一半，而它们指的是另一个环境做过的事。拷完直接把新环境的 `status` 表打出来，与 `tread status <dst>` 逐字一致。

**复制完两个环境彻底无关。** 这需要两件事，光"别用 symlink"不够：

指向真 home 的链接由新环境**自己的配置**重新生成，而不是从源环境抄一份——源环境建立时的 allow 清单可能早就和现在的配置不一样了。其余链接照旧是链接，但指向源环境内部的绝对链接会被改成指向新环境自己的副本，否则新环境只是旧环境的一个别名。判断"哪些是共享链接"要把 `~/.local/state/tread` 挖掉：环境自己就住在真 home 底下，不挖的话插件树里 `AGENTS.md -> CLAUDE.md` 这种同级链接也会被误判成共享而丢掉。

文件内容里的源环境**绝对路径会被重写**。agent 会把自己的 config dir 硬编码进它写的东西：claude 的 hook 命令与 `installed_plugins.json`、cursor 的 `hooks.json`、kimi 的 `extra_skill_dirs`，还有某个 skill 自己的安装脚本算出来的路径。不重写的话新环境会静默地去读旧环境的目录——你在新环境改了 hook，跑起来还是老那个。只替换完整绝对路径，绝不替换环境**名字**：`test` 这种名字会在正文里到处误伤。

排除清单按 **env 相对路径精确匹配**，不按目录名：`.claude/cache` 是垃圾，`.claude/plugins/cache` 是插件本体（那 9.3M）。按名字匹配会把插件删光，而 `status` 表照样显示插件在装——因为计数读的是清单文件。

### MCP 连通状态

`tread mcp` 默认只做免费检查：http 服务器不发请求，stdio 服务器只查命令存在且可执行。

加 `--probe`（TUI 里按 `t`）才做完整 MCP 握手并列出工具。握手是**流式读到应答就停**，不等 server 退出或流关闭——MCP server 应答后本来就继续活着。

http 探测先走 `fetch`，失败再退回 `curl`。Bun 的 fetch 不支持 socks5，也会把某些本地代理在 CONNECT 应答里带的 `Transfer-Encoding: chunked` 判成非法响应；curl 两样都能处理，且读同一套代理环境变量。所以 `ep tread mcp … --probe` 这种带代理的用法能正常工作。

探测做成手动是刻意的：**stdio 的 MCP server 没有"连接"可观测**——它是 agent 每次会话 fork 出来的子进程，探测它等于新起一个实例；而 http 探测会把你存的凭证发出去。这两件事都应该由你按下按键那一刻触发。

MCP 的 header 与 env **只显示 key，值一律打码**。

## 工具安装：用各 agent 原生的工具

激活环境后：

```sh
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

每个环境都自带一个 `tread` skill，三个 agent 的 skills 目录里各装一份，每次激活跟着更新。里面写清了整套 CLI、各目录位置、以及"你的 `$HOME` 不是用户的真 home"——agent 最容易猜错的就是这件事，与其指望用户去解释，不如把说明放在它手边。

## 工作原理

激活做两件事：export 各 agent 的 config dir 变量，并把 `<state>/shims` 放到 `PATH` 最前。

| agent | 变量 | 环境内位置 |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | `<env>/.claude/` |
| cursor | `CURSOR_CONFIG_DIR` + `CURSOR_DATA_DIR` | `<env>/.cursor/` |
| kimi | `KIMI_CODE_HOME` | `<env>/.kimi-code/`、`<env>/.agents/skills/` |

**为什么光有 config dir 变量不够。** 变量只管得住 agent **自己**解析的路径，管不住它跑起来的第三方代码。cursor 的 `mcp.json` 与 `hooks.json` 是硬编码 `join(homedir(), ".cursor", …)`，完全无视 `CURSOR_CONFIG_DIR`；kimi 的用户级 skill 在 `~/.agents/skills`；claude 自己确实处处遵守 `CLAUDE_CONFIG_DIR`，但一个装 hook 的 skill 会去算 `join(homedir(), ".claude", "settings.json")`，照样写进真 home。

所以三个 agent 的 shim **都**把 `HOME` 指向环境根。HOME 只对 agent 进程生效——在 shim 里设置，不污染你的 shell。

移动 HOME 有个代价：claude 找 project 级配置时是拿 `$HOME` 当遍历终点的，HOME 一挪，真 home 就不再是边界。见[已知限制](#已知限制)里的目录相关泄漏，`tread doctor` 会按你当前所在的目录报。

环境目录做成 home 的形状，把真 home 里**被允许的部分** symlink 进来：

```
默认共享：.gitconfig  .ssh  .config  .cache  .npmrc  .cargo  .rustup
          .asdf  .tool-versions  .docker  .kube  .aws  …（见 defaultAllow）
永不共享：.claude  .cursor  .kimi-code  .agents  .local/state
          .tread  .config/tread
          Library/Application Support/Cursor/User/globalStorage   ← macOS
```

环境隔离的是 agent 工具链，不是整个账号——agent 仍然要 shell 出去跑 git、ssh、npm，所以共享面必须够宽。清单由 tread 自带：让每个用户自己踩一遍"原来 git 要这个"，收益和成本不成比例。

**没在清单上的东西留在环境里。** 这正是关键性质：某个 skill 自己建的状态目录天然隔离，tread 不需要预先知道它叫什么名字。

改共享范围写 YAML，是**补丁**不是全量列表——这样 tread 的默认清单以后变大，你也能吃到：

```yaml
# ~/.config/tread/config.yaml     所有环境
# <env>/.tread/config.yaml        单个环境
allow:
  extra:  [.my-tool]
  remove: [.cache]
```

三层叠加：内置默认 → 全局 → 单环境。层内 `remove` 压过 `extra`，跨层后一层的 `extra` 可以把前一层 `remove` 的加回来。想彻底不要默认清单就用 `replace:`。

"永不共享"那几条配置碰不到（写了 `doctor` 会报）：agent 目录必须是环境里的真目录，否则隔离无从谈起；`.local/state` 是 tread 自己的状态，链了会把环境套进自己；`.tread` 和 `.config/tread` 是配置本身，被链接覆盖就自举失败。

拒绝项支持嵌套：`.config` 整体共享，但里面的 `tread` 子目录挖掉——这一层改用镜像真目录而不是整个 symlink，兄弟目录照常共享。macOS 那条同理，是 Cursor 桌面版缓存 skill/plugin 索引的状态库。

链接在**每次激活时重新同步**。环境自己记一份清单（`<env>/.tread/sync.json`），所以从配置里删掉一项会真的把链接摘掉——只收紧配置却不摘链接，是白名单最坏的失败方式。摘除只动指向真 home 的 symlink 和空目录，绝不 `rm -r`：环境里自己建的真实文件永远优先。

### 登录态是共享的，不是每环境一份

在真 home 上登录一次，所有环境就都是已登录状态，`create` 和 `cp` 都一样。三家走的路不同，只有一家需要 tread 额外做事：

| agent | 凭证存哪 | 怎么到达环境 |
|---|---|---|
| cursor | keychain，service name 固定 | 共享 `Library/Keychains` 就是全部机制 |
| kimi | 文件（`~/.kimi-code/credentials`、`oauth/`）| `create` 时 symlink 回真 home；`config.toml` 仍然每环境独立 |
| claude | keychain，**service name 里掺了 `CLAUDE_CONFIG_DIR` 的哈希** | 需要把 `CLAUDE_SECURESTORAGE_CONFIG_DIR` 定义为空 |

claude 是唯一的例外。它的 service name 是 `Claude Code-credentials` 加上 config dir 的 sha256 前 8 位，所以把 `CLAUDE_CONFIG_DIR` 指向环境，等于悄悄指向了**另一个** keychain item —— 这就是新环境以前非要自己 `/login` 一次的原因，也是为什么复制 config dir 从来没用。把 `CLAUDE_SECURESTORAGE_CONFIG_DIR` 设成**空字符串**就会去掉那段哈希，item 变回真 home 已经在用的那个。必须是空字符串而不是不设，两者含义相反；claude 自己还专门写了一处特判，保证这个空值能传进子进程。shim 已经替你做了。

想让某个环境挂另一个账号：

```yaml
# <env>/.tread/config.yaml
login:
  isolate: [claude]
```

该环境会回到自己的 keychain item、自己的 `/login`。`tread doctor` 会报出每个环境解析到哪个 item、item 在不在，所以 claude 哪天改了构造方式，你看到的是一条告警而不是某天突然要重新登录。

两点要知道。所有环境共用一个账号 —— 这正是目的，但也意味着 `login: isolate` 是同时用两个账号的唯一办法。另外 claude 在刷新凭证时用的读-改-写锁放在各环境自己的目录下，跨环境不互斥；多个环境同时跑、又恰好碰上 token 轮转时，小概率会让你多登一次。

### 已知限制

- **macOS 的 login keychain 必须共享（`Library/Keychains`）。** keychain 是按 `$HOME` 找的，HOME 一移动，`security default-keychain` 直接报 *a default keychain could not be found* —— claude 和 cursor 的登录态全在里面，表现就是死活登不上、弹窗说找不到钥匙串。只共享 `Library/Keychains` 这一条，`Library` 本身改用镜像目录，其余 app 状态照旧隔离。

- **cursor 会往新环境里自动下载你账号的默认插件。** 实测新建环境 32 秒后它自己拉了一份 `dbt / github / redis-development / superpowers`——是独立副本不是泄漏，但新环境对 cursor 而言不是全空的。要清掉用 `cursor-agent plugin` 自己处理。

- **在真 home 底下、又不在 git 仓库里的目录启动 claude，真 home 的 `~/.claude` 会以 project 作用域漏进来。** claude 找 project 级 skill / agent / command 的办法是从 cwd 逐级往上收集 `<祖先>/.claude/…`，这个遍历只在 `.git` 或 `$HOME` 处停。shim 把 HOME 指向环境根之后，真 home 不再是终点，遍历会一路爬过它——`/skills` 里能看到那些 skill 标着 `project` 而不是 `user`。**在 git 仓库里工作就没有这个问题**，仓库根会截断遍历。也可以把工作目录放到 home 外面。（试过用一个临时的空 `.git` 当边界：确实能截断，但 claude 会因此把非仓库目录判成 git 仓库，且 project 级写入会落到那个假仓库根，得不偿失，已放弃。）

- **另一族在 home 底下的任何目录都会漏，`.git` 也挡不住，环境关不掉。** 它们走的是另一套遍历：一直到 `/`、包含 `$HOME` 本身。跟 HOME 有没有被移动无关，改 shim 之前之后一样漏。

  逐个实测过，会漏和不会漏的分别是：

  | 位置 | 从祖先目录漏进来 | `.git` 能挡住 |
  |---|---|---|
  | `~/.claude/skills`、`agents`、`commands` | 是 | **是** |
  | `~/.claude/CLAUDE.md`、`~/CLAUDE.md` | 是 | 否 |
  | `~/.mcp.json` | 是（列进 `mcp list`，待批准） | 否 |
  | `~/AGENTS.md`、`~/.cursor/rules` | 是，**cursor 读**（claude 不读 `AGENTS.md`） | 否 |
  | `~/.claude/settings.json` | **否** | — |
  | `~/.cursor/skills` | **否** | — |
  | kimi 的全部（`~/.agents/skills` 等） | **否** | — |

  `tread doctor` 按当前目录报，且只报**真的存在**的那些——`~/AGENTS.md`、`~/.mcp.json` 这类默认不存在，你不建就不会出现在警告里。

- **只管理环境级（全局）内容。** project scope 的 skill / plugin / MCP / hook 不读也不显示——那是各 agent 自己的事。

- **新建 kimi 环境会从真 home 播种 provider / model 配置**（剥掉 hooks）。kimi 把模型设置和凭证分开存，不播种的话环境根本起不来。

- `tread use` 需要 shell 集成。脚本里用 `tread exec` 代替。

## 开发

```sh
bun install
bun test              # 271 个测试，含 e2e
bun run typecheck
bun run src/index.ts  # 直接从源码跑
```

从源码编译并安装二进制——需要 Bun ≥ 1.3，且 `~/.local/bin` 在 `PATH` 中：

```sh
./build.sh            # 编译到 ~/.local/bin/tread（`TREAD_BIN_DIR` 可覆盖）
tread init zsh --write
source ~/.zshrc
```

`bun run build` 是同一次编译，但只产出 `dist/tread`，不安装。

设计文档在 `docs/superpowers/specs/`，实施计划在 `docs/superpowers/plans/`。

### 发布

推送以 `v` 开头的 tag 会触发 GitHub Action：构建 `aarch64-apple-darwin` 二进制、ad-hoc 签名，并把 `tread-aarch64-apple-darwin.tar.gz` 及其 `.sha256` 上传到对应 Release：

```sh
git tag v0.2.0
git push origin v0.2.0
```

## License

[MIT](LICENSE)
