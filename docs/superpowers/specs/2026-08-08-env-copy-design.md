# tread cp：复制一个环境

日期：2026-08-08
状态：待评审

## 1. 背景

tread 现在只能从零建环境（`tread create`）。攒了一阵子的环境——十几个 skill、几个 plugin、几台 MCP、一串 hook——想在它旁边试点别的，唯一的办法是把安装过程重跑一遍。conda 有 `--clone`，tread 没有对应能力。

目标：`tread cp <src> <dst>` 把 src 的工具链原样复制成一个新环境，**复制之后两者彻底无关**。

"无关"是这次的硬要求，有两层：

1. 不能靠 symlink 或 hardlink 指回 src——那是共享，不是复制。
2. src 之后的变更不能流到 dst，dst 的变更也不能流回 src。

第 2 条不只是"别用链接"就能满足，见 §3.1。

## 2. 命令

```
tread cp <src> <dst>     复制一个环境
```

- 两个参数都必须显式给出。不做"省略 src 时取当前激活环境"的简写：`cp` 在 shell 里从来是两个参数，一个参数的形式读者要先知道有没有激活环境才能判断它是源还是目标。
- `dst` 过 `validateEnvName`；已存在直接报错，不提供 `--force`（要覆盖自己先 `tread rm`）。
- `src` 过 `requireEnv`，拼错了走既有的 did-you-mean 提示。
- src 可以是当前激活的环境，不必先 `deactivate`：cp 只读 src。
- cp 不写 `lastUsed`，所以新环境在 `status` / `ls` 里显示 `never`。
- `HELP` 常量与 README 的命令表同步新增一行。

## 3. 关键事实（均在真实环境 `envs/test` 上实测）

### 3.1 源环境的绝对路径被写进了活配置

`grep -rl "envs/test"` 在 src 的活配置里命中：

| 文件 | 内容 |
|---|---|
| `.claude/settings.json` | SessionStart hook 的命令行指向 `<src>/.fintopia/skills-auto-update/scripts/agents/claude-session-start.mjs` |
| `.claude/plugins/installed_plugins.json` | 插件本体路径 `<src>/.claude/plugins/cache/…/superpowers/6.2.0` |
| `.claude/plugins/known_marketplaces.json` | marketplace 克隆路径 `<src>/.claude/plugins/marketplaces/…` |
| `.cursor/hooks.json` | 同一个 hook 脚本的 cursor 版本 |
| `.kimi-code/config.toml` | `extra_skill_dirs = ["<src>/.agents/skills"]` |
| `.claude/skills/skills-auto-update/scripts/install.mjs` | skill 自己算出来的安装路径 |

所以逐字节拷完并不算完：dst 会带着一串指回 src 的绝对路径，运行时读到的是 src 的目录。这正是要排除的"继承"，且是静默的——什么都不报错，只是改了 dst 的 hook 却发现没生效。`tread doctor` 已经在为 `extra_skill_dirs` 打同类补丁，说明这类硬编码不是个例。

### 3.2 `.claude/cache` 与 `.claude/plugins/cache` 只有一字之差，一个是垃圾一个是全部内容

`.claude/cache`（484K）是运行期缓存；`.claude/plugins/cache`（9.3M）是插件本体，`installed_plugins.json` 直接指着它。26M 的环境里插件占了三分之一。

**推论：排除清单必须按 env 相对路径精确匹配，不能按目录名匹配。** 按名字匹配 `cache` 会把插件整个删掉，而 `status` 表照样显示 3 个 plugin（计数读的是 `installed_plugins.json`），要等真的启动 agent 才发现问题。

### 3.3 会话与缓存占了一半体积，且对新环境没有意义

| 类别 | 体积 |
|---|---|
| 全部 | 26.1 M |
| 会话 / 历史 / 缓存 / 日志 / 遥测 | 13.5 M |
| 工具与配置（实际拷贝） | 12.6 M |

会话记录（`.claude/projects`、`.cursor/chats`、`.kimi-code/sessions`）拷过去后会出现在新环境的 `--resume` 列表里，指向的却是另一个环境做过的事。

### 3.4 env 里存在非常规文件

`.cursor/projects/…/worker.sock` 是 unix socket。cp 必须只处理常规文件、目录、符号链接，遇到 socket / fifo / 设备节点跳过——不是优化，是不跳过就会拷失败。

### 3.5 指回真 home 的 symlink 是配置的产物，不是内容

env 根下大半是 `syncHomeLinks` 按 allow 清单建的链接（`.ssh`、`.config/*`、`.zshrc`、kimi 的 `credentials`/`oauth`…）。这些由 dst 自己的配置层重新决定，不该从 src 抄一份快照——src 建立时的 allow 清单可能已经和现在的配置不一样了。

## 4. 拷贝规则

新文件 `src/copy.ts`，导出 `copyEnv(srcName, dstName): CopyResult`。

遍历 src，每一项按四类处理，**判定顺序即下表顺序**：

| 类 | 判定 | 处理 |
|---|---|---|
| 1 | volatile 清单命中（§5） | 跳过，不递归 |
| 2 | symlink 且指向真 home | 跳过——`ensureSkeleton(dst)` 会按 dst 的配置重建 |
| 3 | 其它 symlink（指向 src 内部或第三处） | **解引用**，把目标内容拷成 dst 里的真实文件 |
| 4 | 常规文件 / 目录 | 逐字节拷，保留权限位 |
| — | socket / fifo / 设备节点 | 跳过 |

第 3 类解引用而不是照抄链接：留成链接就等于把 dst 钉在 src 上。解引用带深度上限（8 层）防环，超限则跳过并计入 `CopyResult.skipped`。

拷完依次做三件事：

1. `ensureSkeleton(dst)` —— 建 agent 骨架、link kimi 凭证、`syncHomeLinks(dst)`、`installTreadSkill(dst)`。
2. 路径重写（§6）。
3. 渲染输出（§8）。

`.tread/` 的处理：`config.yaml` 跟着拷（它是这个环境的定义的一部分，复制它是复制不是继承）；`sync.json` 不拷，由 `ensureSkeleton` 重新生成——它记的是"tread 上次在这个 env 里建了哪些链接"，抄过来会让 dst 的第一次 prune 拿着 src 的账本干活。

## 5. volatile 清单

按 **env 相对路径精确匹配**（§3.2）。分两处放，各自贴着已有的同类知识：

**per-agent**：`AGENT_SPECS[a]` 新增 `volatile: string[]`（agent 目录相对），与现有的 `isolate()` 并列——每个 agent 的路径知识本来就在那里。

```
claude   projects  sessions  session-env  shell-snapshots  history.jsonl
         telemetry  cache  backups  .last-cleanup
cursor   chats  projects  ai-tracking  statsig-cache.json
kimi     sessions  logs  search-index  user-history  session_index.jsonl
         telemetry  device_id
```

**跨 agent**：`copy.ts` 的常量，env 根相对。

```
.tread/sync.json
.local/state                      tread 自己的状态，加上 gh/claude 的锁与 device-id
Library/Caches                    cursor 的 compile cache
Library/Application Support       cursor 桌面版的 skill 索引库等
```

清单之外的一切默认跟着走，包括 agent 自己发明的目录（实测有 `.fintopia/skills-auto-update`）。这与 allow 清单的取向一致：tread 不需要预先知道每个 skill 建了什么目录。

明确**保留**的几项，因为它们是配置不是垃圾：`.claude/.claude.json`（含 onboarding、主题、信任过的目录）、`.claude/.credentials.json`、`policy-limits.json`、`remote-settings.json`、`.cursor/cli-config.json`、`.cursor/managed`（团队下发的 hook）、`.cursor/skills-cursor`、`.kimi-code/tui.toml`、`workspaces.json`、`workspace-trust`、`migrations-effort.json`、以及所有 `commands/`。

## 6. 路径重写

在 `ensureSkeleton(dst)` 之后扫一遍 dst 的全部常规文件，把内容里出现的 srcRoot 绝对路径替换成 dstRoot。放在 `ensureSkeleton` 之后而不是之前，是因为它会生成新文件；tread 自带的 skill 由 `installTreadSkill` 直接写对，不依赖这一步。

- 只处理文本文件：读前 8 KB，含 NUL 字节即判为二进制并跳过。
- 单文件上限 8 MiB，超限跳过并计入 `CopyResult.skipped`。
- srcRoot 是 `<state>/envs/<name>` 这样的绝对唯一路径，误替换概率可忽略；只做字面替换，不解析 JSON / TOML，因此对未知格式同样有效。
- 不做环境**名字**的替换（只替换完整绝对路径）：`test` 这样的名字会在正文里到处误伤。
- 返回重写过的文件数，进输出。

## 7. 原子性

先拷进 `<envs>/.cp-<dst>.<pid>`，全部步骤成功后 `rename` 成 `<envs>/<dst>`。任何一步抛错就 `rm -r` 临时目录再把错抛出去。

理由：半个环境比没有环境更难查——它会出现在 `tread ls` 里，`status` 表看着也像模像样。临时目录名以 `.` 开头，`listEnvs()` 只收目录不过滤点开头的项，所以额外在 `listEnvs()` 里跳过 `.` 开头的名字（`validateEnvName` 本来就不允许用户建出这种名字，所以这一条只可能是 cp 的残留）。

`rename` 在同一文件系统内是原子的，`<envs>` 下两者同盘，成立。

## 8. 输出

复用 `statusOne(dstRoot, dst, false)`，不另写渲染，所以与随后 `tread status <dst>` 逐字一致：

```
copied  test → test3

test3    never
         skills  plugins  mcp  hooks
claude       12        3    2      1
cursor        4        1    2      0
kimi          1        —    —      —

skipped sessions and caches · 6 paths rewritten
```

末行 dim，是唯一能看出"拷了但没全拷"的地方。数字取自 `CopyResult`：重写文件数如实报，`skipped` 里若有超限/超深的项，追加 `· 2 files skipped`。

## 9. 非目标

- 不做跨机器导出/导入（与既有 spec 的非目标一致）。
- 不做 TUI 入口（`ls` / `show` 里加键位是另一件事）。
- 不做 `--force` 覆盖、不做 `--dry-run`。
- 不试图让 dst 继承 src 的 claude 登录态：凭证在 keychain 且与 config dir 绑定，已实测复制 config dir 无效。dst 里 claude 需要 `/login`，但这不是 cp 要解决的问题，也不在输出里提——`status` 表里 claude 那行的 `not used yet` 已经说明了状态。

## 10. 测试（`test/copy.test.ts`，Chinese 注释，沿用 `TREAD_STATE_DIR` 临时目录模式）

1. **改 src 不影响 dst**：cp 之后在 src 里新建文件、改文件、删文件，dst 三项都不变。
2. **不继承**（可执行断言）：遍历 dst 全部常规文本文件，没有任何一个含 srcRoot 字符串。
3. **home 链接是链接**：dst 里 allow 清单上的路径仍是 symlink，且 `readlink` 指向真 home，不指向 src。
4. **精确匹配**：`.claude/cache` 不在 dst，`.claude/plugins/cache` 在 dst 且内容一致。
5. **计数相等**：逐 agent 比较 `inventory(src,a)` 与 `inventory(dst,a)` 的四类数量。
6. **解引用**：src 里指向 src 内部的 symlink，在 dst 里是真实文件。
7. **`.tread`**：`config.yaml` 内容一致；`sync.json` 是重新生成的（内容对应 dst 的路径）。
8. **错误路径**：dst 已存在 / dst 名字非法 / src 不存在 → 抛错，且 `<envs>` 下不留 `.cp-*` 临时目录。
9. **非常规文件**：src 里有 fifo 时 cp 不失败（socket 不便在测试里造，fifo 同类）。
10. **e2e**（`test/e2e.test.ts` 追加）：`tread cp a b` 的 stdout 尾部与 `tread status b` 的输出一致。

## 11. 改动的文件

| 文件 | 改动 |
|---|---|
| `src/copy.ts` | 新增，`copyEnv` 与 volatile 常量 |
| `src/agents.ts` | `AgentSpec` 新增 `volatile: string[]`，三个 agent 各填 |
| `src/commands.ts` | `cp` 分支 + `HELP` 一行 |
| `src/env.ts` | `listEnvs()` 跳过 `.` 开头的名字 |
| `test/copy.test.ts` | 新增 |
| `test/e2e.test.ts` | 追加一例 |
| `README.md` | 命令表加一行；"命令"节说明 cp 拷什么不拷什么 |
