# tread 产品化重构设计

日期：2026-08-07
状态：待评审

## 1. 背景

tread 现有代码是一版未经执行、未经验证的初步设想（编译过二进制，但从未创建过任何环境）。它试图做「pyenv 风格的 AI agent 环境管理器」，为 claude / cursor-agent / kimi 建立互相隔离的环境。

现状的核心问题：

1. **没有「当前环境」概念**。每条命令都要重复 `<agent> <name>`，与 pyenv/conda 的心智模型不符。
2. **包装层过重**。为 kimi 逆向复刻插件磁盘格式（220 行）、为 cursor 自实现 marketplace clone+copy（110 行），官方格式一变就要跟。
3. **隔离手段错误**。cursor 用 `HOME=<env>` 劫持，副作用波及 ssh / git / npm，已经开始打补丁（`GIT_CONFIG_GLOBAL`）。
4. **多处路径假设与实际不符**（见 §3.4）。
5. 单二进制却仍依赖系统装有 bun（`skill.ts` 里 `Bun.spawn(["bun","run",...])`）。

## 2. 目标与非目标

### 目标

解决一个痛点：**多套 agent 配置互不污染，且能快速切换**。

- 环境之间的 skills / plugins / MCP / hooks 完全隔离，不互相干扰、不撑大上下文、不误触发。
- 切换成本接近零，肌肉记忆不变（激活后直接敲 `claude`）。
- 能一眼看清某个环境里到底装了什么。

### 非目标（明确排除）

- **可复现 / 分发**：不做声明式清单，不做导出/导入，不追求换机器还原。
- **跨 agent 同配置**：不做配置翻译层，不追求「一份配置三家通用」。
- **沙箱安全**：不以隔离不可信代码为设计目标。
- **接管 skill/plugin/MCP/hooks 的生命周期**：见 §4。

## 3. 关键事实（均经实测，非推断）

这些事实是整个设计的地基。

### 3.1 三家都有一等公民的 config dir 环境变量

| agent | 变量 | 验证方式 |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | 重定向后 `.claude.json` / `projects/` / `sessions/` / `backups/` 全部落入新目录 |
| cursor | `CURSOR_CONFIG_DIR` + `CURSOR_DATA_DIR` | 重定向后 `cursor-agent about` 正常运行并写入 `cli-config.json` |
| kimi | `KIMI_CODE_HOME` | 其自带文档明示「resolves the user-global directory as `KIMI_CODE_HOME` first」 |

cursor 的解析逻辑（从 bundle 中提取）：

```js
function G(){                                    // config dir
  const e = process.env.CURSOR_CONFIG_DIR;  if (e?.trim()) return e;
  const t = process.env.XDG_CONFIG_HOME;    if (t?.trim()) return join(t, "cursor");
  return join(homedir(), ".cursor");
}
function H(){                                    // data dir
  const e = process.env.CURSOR_DATA_DIR;    if (e?.trim()) return e;
  return join(homedir(), ".cursor");
}
```

**推论：cursor 不需要 HOME 劫持。** `GIT_CONFIG_GLOBAL` 补丁可删。

### 3.2 登录隔离性三家不同

| agent | 凭证位置 | 跨环境 | 证据 |
|---|---|---|---|
| cursor | keychain，不受 `CURSOR_CONFIG_DIR` 影响 | ✅ 自动共享 | 重定向后 `about` 仍显示账号与订阅等级 |
| kimi | `<KIMI_CODE_HOME>/credentials/` + `oauth/` | ⚙️ symlink 可共享 | 磁盘文件 |
| claude | keychain，**与 config dir 绑定** | ❌ 每环境需 `/login` | 见下 |

claude 的验证链（含控制组）：

| 实验 | 结果 |
|---|---|
| 空 `CLAUDE_CONFIG_DIR` 跑 `claude -p` | `Not logged in` |
| 种入真 `.claude.json` 的 `oauthAccount` + `userID` | 仍 `Not logged in` |
| 全量复制 `~/.claude`（27M，排除 projects）+ 真 `.claude.json` | 仍 `Not logged in` |
| **控制组**：不设 `CLAUDE_CONFIG_DIR` | `OK`，正常 |

控制组通过，排除「子进程拿不到 keychain」。凭证不在 config dir 的磁盘文件里（全量复制无效），故无 symlink 绕法。二进制中仅找到 `-credentials` 后缀常量，前缀拼接逻辑未定位——列为实现阶段探查项（§15）。

### 3.3 skills 格式统一，只有落点不同

`skills` CLI（v1.5.21）内置 **93 个 agent 的注册表**，每条 entry 只有三个字段：

```js
"claude-code":  { skillsDir: ".claude/skills",  globalSkillsDir: join(claudeHome, "skills") }
cursor:         { skillsDir: ".agents/skills",  globalSkillsDir: join(home, ".cursor/skills") }
"kimi-code-cli":{ skillsDir: ".agents/skills",  globalSkillsDir: join(home, ".agents/skills") }
```

其中 `claudeHome = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude")`，**只有 claude 那条读环境变量**，cursor / kimi 走 `os.homedir()`。

`skills` CLI **没有指定目标目录的 flag**（只有 `-g` 全局 / `-p` 项目），`$HOME` 是唯一杠杆。

### 3.4 现有代码的路径错误

| 位置 | 声明 | 实际 |
|---|---|---|
| `paths.ts:56` cursor skillsDir | `<env>/.agents/skills` | `<env>/.cursor/skills` |

kimi 的 `mcpFile: <env>/.kimi-code/mcp.json` 经查证是**正确的**（kimi 内嵌 MCP SDK，其自带文档确认路径与 `mcpServers` wrapper）。

### 3.5 hooks 与 plugins 三家格式确实分歧

hooks：

| agent | 文件 | 结构 | 事件词汇 |
|---|---|---|---|
| claude | `settings.json` | 嵌套 `hooks.<Event>[].hooks[]` + matcher | `PreToolUse`（Pascal） |
| cursor | `hooks.json` | 扁平 `hooks.<event>[]` | `afterAgentResponse`（camel） |
| kimi | `config.toml` | TOML `[[hooks]]` | `SessionStart`（Pascal） |

plugins：

| agent | 可脚本化 | manifest | 磁盘状态 |
|---|---|---|---|
| claude | 完整 CLI | `.claude-plugin/plugin.json` | `installed_plugins.json` + `known_marketplaces.json` + `marketplaces/` + `cache/` |
| cursor | 仅 `plugin marketplace`，无 install | `.cursor-plugin/marketplace.json` | `.cursor/plugins/{cache,local,marketplaces}` |
| kimi | 无（仅 TUI `/plugins`） | `kimi.plugin.json` \| `.kimi-plugin/plugin.json` | `plugins/managed/` + `installed.json` |

MCP：三家统一为 JSON + 顶层 `mcpServers` + `command/args/env` 或 `url/headers`，仅文件位置不同。

## 4. 核心架构决策：只做 Layer A

把可能的职责分成两层：

- **Layer A（容器层）**：环境是一个目录；每个 agent 有一条隔离配方（一个环境变量）。
- **Layer B（统一操作层）**：`tread plugin add` 之类跨 agent 一致的写操作，需要理解每家格式。

**决策：只做 Layer A，不做 Layer B。**

类比 conda：conda env 里能同时装 python / R / node 的包，conda 从不为此做跨语言包管理翻译层——它给你目录和 activate，你在里面用各自的原生工具。env 是容器，不是抽象。

因此：

| 事项 | 谁负责 |
|---|---|
| 装 skill | 用户，用任意安装器（`skills`、`clawhub`、手拷） |
| 装 plugin | 用户，用 `claude plugin install` / `cursor-agent plugin marketplace` / kimi 的 `/plugins` |
| 配 MCP | 用户，用 `claude mcp add` / `cursor-agent mcp` / 编辑 `mcp.json` |
| 配 hooks | 用户，手编各自配置文件 |
| **只读展示以上四类** | **tread**（见 §8） |

这个决策是**可加的**：将来若要 `tread mcp add`，Layer A 不构成阻碍。现在不做只是不欠债。

## 5. 数据模型

**环境 = 场景，跨 agent。** 一个环境目录下每个 agent 一棵各自原生的配置树。

```
~/.local/state/tread/
├── state.json                       {"lastUsed": {"work": "2026-08-07T…"}}
└── envs/
    ├── work/
    │   ├── .claude/                 CLAUDE_CONFIG_DIR
    │   ├── .cursor/                 CURSOR_CONFIG_DIR + CURSOR_DATA_DIR
    │   ├── .kimi-code/              KIMI_CODE_HOME
    │   │   ├── config.toml          extra_skill_dirs = ["<env>/.agents/skills"]
    │   │   ├── credentials  → ~/.kimi-code/credentials
    │   │   └── oauth        → ~/.kimi-code/oauth
    │   └── .agents/skills/          kimi 的 skill 落点
    ├── personal/
    └── sandbox/
```

**目录刻意做成 home 的形状**，因为按 `os.homedir()` 解析路径的工具（如 `skills` CLI）在 `HOME=<env>` 下的落点，恰好与各 agent 的 config dir 变量指向同一处：

| `HOME=<env>` 时安装器的落点 | agent 实际读取处 | 对齐 |
|---|---|---|
| `<env>/.claude/skills` | `$CLAUDE_CONFIG_DIR/skills` | ✅ |
| `<env>/.cursor/skills` | `$CURSOR_CONFIG_DIR/skills` | ✅ |
| `<env>/.agents/skills` | `config.toml` 的 `extra_skill_dirs` 桥接 | ✅ |

**agent 子目录在 `create` 时全部建好**（eager）。原因：零 shim 意味着用户敲 `kimi` 时 tread 不在链路上，没有 lazy 时机，而 kimi 需要 tread 预先写 `config.toml` 桥接和两条凭证 symlink。成本是 3 个空目录 + 1 个小 toml + 2 条 symlink。`tread use` 每次做幂等 ensure，手工删掉的子目录会自愈。

**凭证策略**：能免登的就免登。cursor 天然共享；kimi symlink 共享；claude 无解，每环境 `/login` 一次。

**范围**：只管理环境级（全局）工具。project scope 的 skill/plugin/MCP/hook 一律不读、不显示——那是 agent 自己的事。

## 6. 激活机制：零 shim

因为三家都有 config dir 变量，`tread use` 只需在当前 shell export，`claude` / `cursor-agent` / `kimi` 是真二进制、自己读变量。**不拦截命令、不改 PATH、不放 shim 文件。** `which claude` 永远指向真的 claude。

未激活时不设任何变量，一切照旧，真 home 完全不受影响。

### `tread init zsh` 输出

```sh
tread() {
  case "$1" in
    use|deactivate)
      eval "$(command tread _export "$@")" ;;
    ls)
      local __f; __f=$(mktemp -t tread) || return 1
      command tread ls "${@:2}" --emit "$__f"; local __c=$?
      [ -s "$__f" ] && eval "$(cat "$__f")"
      rm -f "$__f"; return $__c ;;
    *) command tread "$@" ;;
  esac
}
export TREAD_SHELL=zsh
```

只有 `ls` 走 `--emit`，因为**子进程无法修改父 shell 环境**。TUI 在终端正常渲染，用户 Enter 激活时把 export 语句写进临时文件，退出后 shell eval。（fzf / pyenv 的标准做法。）

`show` 是纯只读浏览器，不提供激活动作，因此不需要 `--emit`，直接走 `command tread`。

### `tread use work` 实际 eval 的内容

```sh
export TREAD_ENV=work
export TREAD_ENV_DIR=$HOME/.local/state/tread/envs/work
export CLAUDE_CONFIG_DIR=$TREAD_ENV_DIR/.claude
export CURSOR_CONFIG_DIR=$TREAD_ENV_DIR/.cursor
export CURSOR_DATA_DIR=$TREAD_ENV_DIR/.cursor
export KIMI_CODE_HOME=$TREAD_ENV_DIR/.kimi-code
```

`deactivate` unset 这六个。新终端天然是默认状态。

### starship 联动

`TREAD_ENV` 已 export，starship 自行读取即可，tread 侧零工作量。`tread init starship` 打印：

```toml
[env_var.tread]
variable = 'TREAD_ENV'
format   = '[  $env_value ]($style)'
style    = 'bold fg:255 bg:99'
disabled = false
```

并提示把 `${env_var.tread}` 放进顶层 `format`（带点的模块名必须用 `${...}` 引用）。未设 `default`，故 `deactivate` 后胶囊自动消失。

### Agent 适配器表

隔离机制塌缩成一张表，加 agent = 加一行：

```ts
const AGENTS = {
  claude: { bin: "claude",       dir: ".claude",     env: { CLAUDE_CONFIG_DIR: "$dir" } },
  cursor: { bin: "cursor-agent", dir: ".cursor",     env: { CURSOR_CONFIG_DIR: "$dir",
                                                            CURSOR_DATA_DIR:   "$dir" } },
  kimi:   { bin: "kimi",         dir: ".kimi-code",  env: { KIMI_CODE_HOME: "$dir" } },
}
```

## 7. 命令面

| 命令 | 形态 | 作用 |
|---|---|---|
| `tread init <shell\|starship>` | 纯文本 | shell 集成 / starship 片段 |
| `tread create <name>` | 纯文本 | 建环境 |
| `tread use <name>` / `deactivate` | 纯文本 | 激活 / 退出 |
| `tread ls` | TUI | 环境选择器 |
| `tread status [env]` | 纯文本 | 跨 agent 一屏概览 |
| `tread show [env]` | TUI | 环境浏览器（tab + 折叠 + 详情页） |
| `tread skills\|plugins\|mcp\|hooks [env] [agent] [name]` | 纯文本 | **只读**分类列表；给 name 则打详情 |
| `tread path [env] [agent] [category]` | 纯文本 | 打印目录 |
| `tread exec <env> [--home] -- <cmd>` | 透传 | 不激活跑一条命令 |
| `tread rm <name>` | 纯文本 | 删环境 |
| `tread doctor [--fix]` | 纯文本 | 体检 |

`status` 与 `show` 拆开是关键：**`status` 回答「哪个环境装了多少」，`show` 回答「具体是什么」**。

砍掉：`rename`（`mv` 后 `doctor --fix` 修路径）、`clone`（默认空白环境）、`which`（并入 `status`）、以及全部 `skill/plugin/mcp/hooks` 的写操作。

### 机读边界（硬约束）

以下四条的输出是给机器的，**永远不能经过渲染层**，必须裸 `process.stdout.write`：

| 命令 | 原因 |
|---|---|
| `tread init` | 输出被 eval |
| `tread _export` | 同上 |
| `tread path` | 被 `$(...)` 捕获 |
| `tread exec` | 必须原样透传子进程 stdio |

### 通用安装出口

tread 不为任何特定安装器做包装。两个出口：

```sh
tread path work claude skills        # 告诉你装哪儿
tread exec work --home -- <任意安装器>  # 给按 $HOME 解析路径的工具
```

`--home` 默认关闭；若默认开启，`tread exec work -- git push` 会读错 gitconfig——正是从 cursor 那里删掉的坑。

## 8. 只读解析层

只解析环境级内容，project scope 一律跳过。读不出来显示 `?`，**绝不写**。

| | claude | cursor | kimi |
|---|---|---|---|
| skills | `<cfg>/skills/*/SKILL.md` | `<cfg>/skills/*/SKILL.md` | `<env>/.agents/skills/*/SKILL.md` |
| plugins | `plugins/installed_plugins.json`（仅 `scope=="user"`）+ `known_marketplaces.json` + `.claude-plugin/plugin.json` | `plugins/{local,cache}/` 目录枚举 | `plugins/installed.json` |
| mcp | `.mcp.json` + `.claude.json` 的 `mcpServers` | `mcp.json` | `mcp.json` |
| hooks | `settings.json` → `hooks.<Event>[].hooks[]` | `hooks.json` → `hooks.<event>[]` | `config.toml` → `[[hooks]]` |

skills 与 mcp 各只需一个解析器（SKILL.md frontmatter 是通用格式；三家 mcp 同构）。真正要写三份的只有 plugins 和 hooks。

### 可用字段

- **skills**：`SKILL.md` frontmatter 的 `name` / `version` / `description` / `metadata.requires.bins`；`<HOME>/.agents/.skill-lock.json` 的 `source` / `sourceType` / `sourceUrl` / `installedAt` / `updatedAt`。插件自带的 skill 标注来源插件。
- **plugins**：claude `installed_plugins.json` v2（`version` / `scope` / `installPath` / `installedAt` / `lastUpdated` / `gitCommitSha`）+ `known_marketplaces.json`（`source.repo` / `installLocation`）+ `.claude-plugin/plugin.json`（`name` / `description` / `author`）+ marketplace entry（`category` / `homepage`）。kimi `installed.json`（`id` / `enabled` / `originalSource` / 时间）。cursor 目录名 + 记录文件。
- **mcp**：`name` / transport / `command`+`args` 或 `url` / **header 与 env 的 key**。
- **hooks**：`event` / `matcher` / `command` / `timeout`。

### 密钥处理

header 与 env 的**值一律打码**（`••••`），只显示 key。理由具体：用户 `~/.cursor/mcp.json` 中 `X-API-Key` 为明文真实密钥，界面若原样显示，截图分享即泄露。

### hooks 合并规则

同一 event 下命令相同的多条 hook 合并为一行，matcher 用 `│` 连接。计数按真实条数报，合并只影响显示。（真实数据中 `SessionStart` 有 4 条 matcher 跑同一脚本，不合并就是 4 行完全一样的噪音。）

## 9. MCP 连通状态

**stdio 的 MCP server 不存在「连通状态」**：它不是常驻服务，而是 agent 启动时 fork、退出时杀掉的子进程。tread 去「检查连通」实际是新起一个实例；轮询即反复 spawn，而有些 server 启动会抢锁、占端口、走 OAuth、产生费用。

因此按「这个信号是否诚实」分级：

| | 列表页（可轮询） | 详情页（进入时一次） |
|---|---|---|
| **http** | 真探活：POST `initialize`，2s 超时 → `● ok` / `✗ 401` / `✗ timeout`。每 10s 刷新 | 完整 `tools/list`，显示工具与延迟，措辞 `● connected` |
| **stdio** | 只查命令**存在且可执行** → `● ok` / `✗ not found` / `✗ not executable`。免费，随意刷新 | 才 spawn，`initialize` + `tools/list`，取完杀掉，措辞 `● responds` |

不用同一个词描述两种不同事实。纯文本侧对应 `--probe` flag，复用同一探测函数。

## 10. TUI

### 技术栈

`@opentui/react` + React 19。选型依据（实测）：

| | vue-tui | vue-termui | @opentui/react |
|---|---|---|---|
| 鼠标 | ❌ 主动丢弃 SGR 上报 | ❌ 无 mouse 导出 | ✅ `onMouseDown/Up/Move/Drag/Over/Out` |
| 维护 | 0.3.0 / 338★ | 0.2.0 / 968★，依赖 opentui `^0.4.1`（已 0.5.1） | 0.5.1，两天前更新 |
| 单二进制 | ✅ +1.9 MB | ✅ | ✅ +11.5 MB |

`@opentui/vue` 停在 0.1.25（2025-09），Vue 绑定线在 opentui 侧已废弃。选 React 是为了鼠标。

实测已确认：`bun build --compile` 能把 opentui 的原生 `.dylib` 真正嵌入（纯净目录 + 空 `HOME` 下跑通）；鼠标追踪模式在启动时开启（`?1000h ?1002h ?1003h ?1006h`）；`useOnResize` / `useTerminalDimensions` 可用。

**未验证项**：鼠标事件端到端投递（测试环境无法向 pty 注入 stdin）。见 §15。

用 JSX（`jsxImportSource: "@opentui/react"`），不引入 SFC/额外打包步骤，`bun build --compile` 直接编译。

opentui 默认使用 alt screen；两个 TUI 界面都不需要 scrollback 留存，采用默认。

### 颜色约定

下文 mockup 中 `▓▓▓` 表示**白底黑字**。

### `tread ls` — 环境选择器

```
╭─ tread ────────────────────────────────────╮
│                                            │
│  ●  work                    2 minutes ago  │
│     personal                     3 days    │
│     ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓   │
│     sandbox                       never    │
│                                            │
╰─ ↑↓  ⏎ activate  s show  c create  r rm ───╯
```

`●` = 当前生效环境；反白 = 光标行。**两者独立**——可以把光标停在别的环境按 `s` 看详情而不切走。`lastUsed` 在 `tread use` 时写入 `state.json`。

每个环境都有全部 agent，故不显示 agent 列（无信息量）。

### `tread show` — 三层浏览

**层 1**：agent 以 tab 呈现（反白标识当前，`←→` 切换），四类默认全折叠。

```
╭─ work ─────────────────────────────────────────────────────╮
│   claude    cursor    kimi                                 │
│  ▓▓▓▓▓▓▓▓                                                  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│   ▸  skills      12                                        │
│   ▸  plugins      3                                        │
│   ▸  mcp          2                                        │
│   ▸  hooks        6                                        │
│                                                            │
╰─ ←→ agent   ↑↓   ␣ expand   esc back   q ──────────────────╯
```

**层 2**：展开成表，每类固定三列。

| | 列 1 | 列 2 | 列 3 |
|---|---|---|---|
| skills | name | version | source |
| plugins | name | version | marketplace |
| mcp | name | transport | status |
| hooks | event | matcher | command（basename） |

```
╭─ work ─────────────────────────────────────────────────────╮
│   claude    cursor    kimi                                 │
│  ▓▓▓▓▓▓▓▓                                                  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│   ▸  skills      12                                        │
│   ▸  plugins      3                                        │
│   ▸  mcp          2                                        │
│                                                            │
│   ▾  hooks        6                                        │
│        PreToolUse     Grep|Glob         cbm-code-disco…    │
│        ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓    │
│        SessionStart   *                 herdr-agent-st…    │
│        SessionStart   startup│resume│⋯  cbm-session-re…    │
│                                                            │
╰─ ↑↓   ⏎ detail   ␣ fold   ←→ agent   esc   q ──────────────╯
```

**层 3**：单项详情页。

skill：

```
╭─ work · claude · skill ────────────────────────────────────╮
│                                                            │
│   lark-mail                                        1.0.0   │
│                                                            │
│   飞书邮箱：Use when user mentions 起草邮件、写邮件、草稿、   │
│   发送/回复/转发邮件、查阅邮件、搜索邮件…                     │
│                                                            │
│   source      open.feishu.cn                well-known     │
│   url         https://open.feishu.cn/.well-known/skills/…  │
│   path        .claude/skills/lark-mail                     │
│   installed   2026-06-26                                   │
│   requires    lark-cli                          ✓ found    │
│                                                            │
╰─ esc back   o reveal   q ──────────────────────────────────╯
```

plugin（不列其内含的 skill/mcp/hook）：

```
╭─ work · claude · plugin ───────────────────────────────────╮
│                                                            │
│   feature-dev                                      1.4.0   │
│                                                            │
│   Comprehensive feature development workflow with          │
│   specialized agents for codebase exploration,             │
│   architecture design, and quality review                  │
│                                                            │
│   author       Anthropic                                   │
│   category     workflow                                    │
│   marketplace  claude-plugins-official                     │
│                github:anthropics/claude-plugins-official   │
│   commit       909649d                                     │
│   installed    2026-04-11                                  │
│   updated      2026-08-06                                  │
│   path         .claude/plugins/cache/…/feature-dev/1.4.0   │
│                                                            │
╰─ esc back   o reveal   q ──────────────────────────────────╯
```

拿不到的字段整行不显示，不占位（kimi 的 `kimi.plugin.json` 只有 `name`/`version`）。

mcp：

```
╭─ work · claude · mcp ──────────────────────────────────────╮
│                                                            │
│   sql                                        ● connected   │
│                                                            │
│   transport   http                                         │
│   url         https://datalumina.easycash.id/mcp/sql       │
│   headers     X-API-Key       ••••••••                     │
│               X-User-Email    ••••••••                     │
│   latency     84 ms                                        │
│                                                            │
│   tools  47                                                │
│     submit_query          get_query_status                 │
│     get_query_result      list_databases                   │
│     ⋮                                                      │
│                                                            │
╰─ esc back   r refresh   q ─────────────────────────────────╯
```

hook：

```
╭─ work · claude · hook ─────────────────────────────────────╮
│                                                            │
│   SessionStart                                             │
│                                                            │
│   matcher     startup │ resume │ clear │ compact           │
│   timeout     —                                            │
│   command     ~/.claude/hooks/cbm-session-reminder         │
│                             ✓ exists   ✓ executable        │
│   source      .claude/settings.json                        │
│                                                            │
╰─ esc back   q ─────────────────────────────────────────────╯
```

### 响应式

宽度断点：

| 宽度 | 形态 |
|---|---|
| ≥ 76 | 完整三列 + 完整路径 |
| 60–75 | 收窄列宽，路径中间省略 |
| 44–59 | 表列降为两列（去掉列 3） |
| 30–43 | 只保留列 1，详情靠 ⏎ 进入 |
| < 30 | 放弃 TUI |

高度断点：≥ 20 完整；12–19 压缩留白；8–11 仅列表；< 8 放弃 TUI。

长路径用**中间省略**（`~/.local/…/envs/work`），不用尾部截断——尾部才是有信息量的部分。resize 时保持选中项可见。

### TUI 运行中被缩小

不退出、不丢状态，在 alt screen 内换成提示，拖回去自动恢复：

```
╭────────────────────────╮
│                        │
│   terminal too small   │
│                        │
│   need   30 x 8        │
│   have   22 x 6        │
│                        │
│   resize, or q to quit │
│                        │
╰────────────────────────╯
```

比该提示框还小（< 24×8）则不画框，裸文字硬裁；< 10 列只剩 `too small`。**任何尺寸下都不得出现花屏或空屏。**

## 11. 纯文本输出

### 降级触发

| 触发 | 判断 |
|---|---|
| 尺寸不足 | `width < 30` 或 `height < 8` |
| 非 TTY | `!process.stdout.isTTY` |
| 显式 | `--plain` |
| 哑终端 | `TERM=dumb` 或未设 |

### create

```
$ tread create work
created  ~/.local/state/tread/envs/work
```

一行。claude 需重新 `/login` 这件事不在此处说教，而在 `status` 中体现为 `not used yet` 状态。

### use / deactivate

```
$ tread use work
tread: work

$ tread deactivate
tread: deactivated
```

### status

单环境：

```
$ tread status work
work                                        active · 2 minutes ago

          skills   plugins   mcp   hooks
claude        12         3     2       6
cursor         0         0     2       1
kimi           —         —     —       —   not used yet
```

`not used yet` 的判定：该 agent 的 config dir 内除 tread 自己写入的骨架（kimi 的 `config.toml` 与两条 symlink）之外无任何内容。此状态即隐含「claude 在这里尚未 `/login`」，不需要单独说教。

全部环境：

```
$ tread status
          skills  plugins  mcp  hooks
work          16        4    4       8   active
personal       3        0    1       2
sandbox        —        —    —       —
```

### 分类列表与详情

```
$ tread skills work claude
lark-mail        1.0.0   open.feishu.cn
superpowers      6.2.0   plugin
dataviz              —   vercel-labs
⋮
12 skills

$ tread mcp work claude
sql                   http    ok       47 tools
codebase-memory-mcp   stdio   ok

$ tread hooks work claude
PreToolUse     Grep|Glob                      cbm-code-discovery-gate
SessionStart   *                              herdr-agent-state.sh
SessionStart   startup|resume|clear|compact   cbm-session-reminder

$ tread mcp work claude sql
sql
  transport   http
  url         https://datalumina.easycash.id/mcp/sql
  headers     X-API-Key ••••   X-User-Email ••••
  status      connected   84 ms
  tools       47
```

### path / exec

```
$ tread path                              # 当前环境根
$ tread path work                         # 指定环境根
$ tread path work claude                  # 该 agent 的 config dir
$ tread path work claude skills           # 再下一层（skills|plugins|mcp|hooks）

$ tread exec work -- claude -p "hi"
$ tread exec work --home -- skills add vercel-labs/agent-skills -g -a cursor
```

`exec` 时 tread 自身不输出，子进程 stdio 原样透传，退出码即子进程退出码。

### rm

```
$ tread rm sandbox
remove  ~/.local/state/tread/envs/sandbox

  .claude       2.1 MB    12 skills   3 plugins
  .cursor           0 B
  .kimi-code    340 KB     4 skills   1 plugin

this cannot be undone.  [y/N]
```

正在激活的环境拒绝删除，提示先 `deactivate`（二进制无法 unset 父 shell 变量）。

### doctor

```
$ tread doctor
⠋ probing agent CLIs…

shell        ok    zsh · tread() loaded · TREAD_ENV=work
state dir    ok    ~/.local/state/tread · 3 envs

  claude          ok    ~/.local/bin/claude
  cursor-agent    ok    ~/.local/bin/cursor-agent
  kimi            ok    ~/.kimi-code/bin/kimi

work        ok
personal    2 problems
  ✗  .kimi-code/credentials   broken symlink → ~/.kimi-code/credentials
  ✗  .kimi-code/config.toml   extra_skill_dirs → /old/path/personal

2 problems in 1 env.    tread doctor --fix
```

保持纯文本（线性报告，`--fix` 顶多逐条 y/N），仅探测时用 spinner。另检测：装了 starship 但配置中无 `TREAD_ENV` 时给出提示。

### TUI 降级形态

```
$ tread ls
* work       2 minutes ago
  personal   3 days
  sandbox    never

  tread use <name>
```

`tread show` 降级后**不倾倒全部内容**，退回概览 + 指路：

```
$ tread show work
work                                        active · 2 minutes ago

          skills   plugins   mcp   hooks
claude        12         3     2       6
cursor         0         0     2       1
kimi           —         —     —       —

  tread skills work claude       list
  tread mcp work claude sql      detail
```

## 12. 错误样式

三段式：`tread: 出了什么事` → 缩进的上下文 → 缩进的下一步。不吐 stack trace，永远给出口。

```
$ tread use wrok
tread: no environment named "wrok"

  did you mean "work"?
  tread ls   to see all

$ tread use work        # 未 eval tread init
tread: shell integration not loaded

  `tread use` needs to modify the current shell.
  add this to ~/.zshrc, then restart your shell:

      eval "$(tread init zsh)"

  or run a one-off without activating:
      tread exec work -- claude
```

「shell integration not loaded」是最关键的一条——未 source 集成时 `tread use` 会**静默失效**（子进程 export 了个寂寞）。检测方式：集成脚本 export `TREAD_SHELL`，二进制看不到就报此条。

颜色：错误标题红、`ok` 绿、`warn` 黄、路径与提示 dim。`NO_COLOR` 或非 TTY 时全关。退出码：`0` 成功，`1` 任何错误。

## 13. 删除清单

| 现有代码 | 删除理由 |
|---|---|
| `src/plugin/kimi.ts`（220 行逆向 `installed.json`） | 环境内直接用 kimi 的 TUI `/plugins` |
| `src/plugin/cursor.ts`（110 行 clone+copy） | 用 `cursor-agent plugin marketplace` |
| `src/plugin/claude.ts` | 直接敲 `claude plugin install` |
| `src/plugin/market.ts` 的 marketplace 缓存 | 无人使用 |
| `src/skill.ts` | 通用出口取代 |
| `run.ts` 的 cursor HOME 劫持 + `GIT_CONFIG_GLOBAL` | `CURSOR_CONFIG_DIR` 取代 |
| `~/.local/share/tread/` 整个目录 | vendored `skills` CLI 不再需要 |
| 对系统 `bun` 的运行时依赖 | 不再 spawn `bun run`，单二进制自足 |

`install.sh` 只剩编译一步。

## 14. 测试策略

- **单元**：路径解析、名称校验、四类只读解析器（用固定 fixture 覆盖三家真实格式，含畸形输入的容错）、hooks 合并规则、响应式断点选择函数。沿用 `TREAD_STATE_DIR` 隔离。
- **快照**：全部纯文本命令的输出走快照测试（含降级形态）。
- **TUI**：把「数据 → 行/列」的映射和断点决策全部抽成纯函数单独测（不经过渲染器）。渲染器本身只做一个冒烟测试：能挂载、能卸载、不抛异常。不追求帧级快照。
- **e2e（新增，现在完全没有）**：`create → use → 在环境里落一个假 skill → status 能读到 → rm` 的完整链路，跑在临时 state dir 上。
- **CI**：现在没有，需要建。至少 `bun test` + `bunx tsc --noEmit` + 编译产物冒烟。

## 15. 待验证项与风险

| # | 项 | 说明 |
|---|---|---|
| 1 | **鼠标端到端** | opentui 的鼠标追踪确认已开启、props 齐全，但事件投递未验证（自动化环境无法向 pty 注入 stdin）。实现的第一步就是在真终端里手工点击验证；若不通，回退 vue-tui + 纯键盘（`useInput` 只有 key/paste，需去掉全部鼠标交互）。 |
| 2 | claude keychain 服务名 | 二进制中仅定位到 `-credentials` 后缀常量。若能推出前缀规则，或存在跨 config dir 共享凭证的受支持方式，可省掉每环境 `/login`。 |
| 3 | kimi `extra_skill_dirs` 是否支持相对路径或 `~` | 若支持，环境目录移动后无需 `doctor --fix`。 |
| 4 | opentui 在窄终端下的 resize 无残影 | Yoga 重排在收缩时是否留下伪影，需实测。 |
| 5 | @opentui/react 版本锁定 | 0.5.1，更新频繁（两天前发版），须锁定并定期评估。 |
| 6 | 二进制体积 | 61.4 MB → 约 73 MB。可接受，但需在 README 说明。 |

## 16. 明确的开放决策记录

| 决策 | 选择 | 备选与代价 |
|---|---|---|
| 分层 | 只做 Layer A | Layer B 可后加，不阻塞 |
| 数据模型 | 环境=场景，跨 agent | per-agent 拆分不减少 adapter 数量 |
| 激活 | shell 内 env vars，零 shim | 脚本场景须用 `tread exec` |
| 新环境 | 空白 + 尽量共享登录 | claude 无法共享，每环境一次 `/login` |
| TUI 库 | @opentui/react（为鼠标） | 代价：React 而非 Vue、+10MB、鼠标模式干扰终端划选复制 |
| MCP 状态 | http 轮询探活；stdio 列表页只查可执行性，详情页才 spawn | 若接受 spawn 代价，可改为列表页也握手 |
| project scope | 不显示 | 用户可在 agent 内查看 |
