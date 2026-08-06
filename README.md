# tread

pyenv 风格的 AI agent 虚拟环境管理器。为 Claude Code、Cursor Agent（`cursor-agent` CLI）、Kimi Code 创建相互隔离的环境，每个环境独立管理 skills、plugins、hooks、MCP 配置。

## 安装

```bash
git clone <this-repo> && cd tread
./install.sh
```

`install.sh` 做两件事：

1. `bun build --compile` 编译单二进制到 `~/.local/bin/tread`（macOS 会自动 ad-hoc 签名）
2. 把运行时依赖（[`skills`](https://github.com/vercel-labs/skills) CLI）安装到 `~/.local/share/tread`

要求：Bun ≥ 1.3（注意 bun 1.3.12 的编译签名 bug 已由 install.sh 内置 workaround 处理）、git。确保 `~/.local/bin` 在 `PATH` 中。

## 工作原理

环境保存在 `~/.local/state/tread/<agent>/<name>/`，每个环境就是一个普通目录，可以随意往里放自己的文件。隔离机制：

| agent | 启动时的重定向 | 环境内配置位置 |
|---|---|---|
| claude | `CLAUDE_CONFIG_DIR` | `<env>/.claude/` |
| cursor | `HOME=<env>` | `<env>/.cursor/` |
| kimi | `KIMI_CODE_HOME` | `<env>/.kimi-code/` |

安装 skill 时 tread 把 `HOME` 指向环境目录，`skills` CLI 的全局安装因此落进环境内；claude/kimi 的 skills 路径与该 agent 的重定向目录天然对齐，kimi 通过创建环境时写入 `config.toml` 的 `extra_skill_dirs` 桥接，cursor-agent 本身就会发现 home 下的 `.agents/skills/`。

## 命令

```bash
# 环境管理
tread create <agent> <name>        # agent: claude | cursor | kimi
tread ls [agent]
tread rm <agent> <name> [--force]
tread path <agent> <name>          # 打印环境目录（配合 cd $(tread path ...) 使用）

# 以环境启动 agent（-- 后的参数透传）
tread run claude work
tread run cursor work -- --print "hello"
tread run kimi work -- -p "hello"

# skills（封装 npx skills，非交互 --copy 安装）
tread skill add claude work vercel-labs/agent-skills --skill web-design-guidelines
tread skill ls kimi work
tread skill rm cursor work <skill-name>
tread skill update claude work

# plugins
tread plugin add claude work <marketplace-source> [name@marketplace]   # 官方 claude plugin CLI
tread plugin add kimi work official                                    # 列出官方 marketplace
tread plugin add kimi work official <id>                               # 从 marketplace 安装
tread plugin add kimi work <github-url|zip-url|local-path>             # 直接安装
tread plugin add cursor work <marketplace-git-url> [plugin-name]       # 复制到 <env>/plugins/，启动时 --plugin-dir 加载
tread plugin ls|rm|update <agent> <env>

# 只读查看（tread 不负责安装 hooks / MCP）
tread hooks <agent> <env>
tread mcp <agent> <env>
```

## 已知限制

- **cursor 环境需要各自登录**：每个环境是独立 HOME，首次 `tread run cursor <env>` 后需要 `cursor-agent login`（或用 `CURSOR_API_KEY`）。环境内的 git 全局配置通过 `GIT_CONFIG_GLOBAL` 指回真实 home。
- **kimi / cursor 的 plugin 是直接写文件**实现的（它们没有可脚本化的安装 CLI）：kimi 写 `plugins/managed/` + `installed.json`（与官方格式一致），cursor 复制插件目录并在启动时注入 `--plugin-dir`。官方格式变更时需要跟进。
- kimi 的 plugin 安装后需要重启会话（或 `/reload`）生效；`plugin rm kimi` 与官方行为一致，只删安装记录、保留 managed 副本。
- cursor 的账号级 marketplace（`cursor-agent plugin marketplace add`）不随环境隔离，tread 不使用它。

## 开发

```bash
bun install
bun test                 # 单元测试（使用 TREAD_STATE_DIR/TREAD_SHARE_DIR 隔离）
bunx tsc --noEmit        # 类型检查
bun run src/index.ts     # 直接从源码运行
```

目录说明：

- `~/.local/state/tread/` — 所有环境（可用 `TREAD_STATE_DIR` 覆盖）
- `~/.local/share/tread/` — tread 的 npm 依赖与 marketplace 缓存（可用 `TREAD_SHARE_DIR` 覆盖）
- `~/.local/bin/tread` — 编译产物
