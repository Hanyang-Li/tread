# tread 并发安全：修竞态，不引数据库

日期：2026-08-08
状态：待评审

## 1. 背景

tread 即将进入的使用形态是：**多个 zsh 同时激活不同的 env，各自跑不同的 agent**。当前的状态写入在这个形态下有已证实的竞态。

起点是一个具体的提议——把状态改存 SQLite（bun 已内置 `bun:sqlite`，`--compile` 出的单二进制可直接使用，实测体积增量为零）。经过必要性讨论后否决：本文档记录否决的理由，以及取而代之的三个修复。

### 1.1 已复现的缺陷

按 `touchLastUsed` 的实际写法（`env.ts:430-434`）复现丢更新：

```
两个 shell 各自 read({}) → A 写 {envA} → B 写 {envB}
final: { "lastUsed": { "envB": "t2" } }   ← envA 丢失
```

根因是 `readState() → 改 → writeState()` 这个读-改-写序列既非原子也无锁，而 `state.json` 是**全体并发进程共享的单文件**。

### 1.2 激活路径上的三个写

`shell.ts:215-217`，每次 `tread use` 都执行：

```ts
ensureSkeleton(dir);   // 每 env：建骨架 + syncHomeLinks
touchLastUsed(name);   // 全局单文件
writeShims();          // 全局单目录
```

后两个是**跨 env 争用同一份资源**——env 不同一点都不减轻竞争。第一个只在同 env 双开时争用。这条界线决定了本次的修复范围。

## 2. 为什么不引 SQLite

`lastUsed` 的病根不是"缺锁"，而是**一个天然属于各 env 的属性被塞进了全局单文件**。把它拆回 env 自身，竞态从构造上消失，不需要任何锁、数据库、WAL 边车文件或 schema 迁移。

引入 SQLite 反而会让 CLI 比现在更不稳：

- 今天 `readState()` 有良好的降级性质（`env.ts:412-419`）——`state.json` 怎么坏都只是 catch 住返回空 map，最坏后果是 `tread ls` 少一列时间戳。
- 换成 SQLite，`tread use` 这条交互路径上会多出今天不存在的失败模式：`SQLITE_BUSY` 超时（恰在高并发场景下最可能发生）、进程被 SIGKILL 后残留的 `-wal`/`-shm`、升级时的 schema 迁移错误。后果不是"少一列"，而是**进不去环境**。
- 把每次 DB 调用都 try/catch 成 best-effort 可以缓解，但那等于建了个自己不信任的数据库。
- 排查成本：今天 `cat state.json`；之后单二进制不带 `sqlite3`，需另补 `tread state dump`。

**SQLite 留给未来真正需要它的场景**：按 env 分区这一招只对能按 env 切开的状态有效；已知未来要加的是**与 env 无关**的功能，那类全局状态切不开，真出现跨行事务、计数器、队列时，SQLite 才名副其实。届时 bun 内置，随时可引，本次不需要为它做任何铺垫。

## 3. 修复范围

| 状态 | 位置 | 并发暴露 | 处置 |
|---|---|---|---|
| `lastUsed` | `state.json` | **跨 env 全争用**，读-改-写丢更新（已复现） | 拆成每 env 一份文件 |
| shims 内容 | `shims/*` | 跨 env 全争用；内容是确定性派生物，非状态 | 改原子替换 |
| env 骨架/软链/账本 | `<env>/**` | 仅同 env 双开 | 加进程间互斥锁 |
| config | 两个 `config.yaml` | 只读 | 不动 |
| **有哪些 env** | `envs/` 目录 | — | **文件系统保持唯一真相** |

最后一行是硬约束：`listEnvs()` 直接列目录，`discoverExisting()` 能从盘上反推账本。任何"注册表"式的设计都会让 `rm -rf` 一个 env 留下孤儿记录、让恢复备份失联。本次不引入任何存在性登记。

## 4. 修复一：`lastUsed` 拆回各 env

### 4.1 存储

`<env>/.tread/last-used`，内容一行 ISO 时间戳。

写入用同目录 `last-used.<pid>.tmp` + `renameSync`：

- 临时名带 pid，避免两个写者连临时文件都撞上。
- 必须同目录——`rename` 只在同一文件系统内原子。
- 单个 env 的时间戳只有该 env 的激活者会写，**不存在跨 env 争用**。同一 env 双开时两者都写，但 rename 原子、后写者胜，且两个值都是合法的"此刻"——没有读-改-写，因此没有可丢失的更新。这里不需要锁。

### 4.2 读取

`lastUsed()` 就着 `listEnvs()` 已有的目录扫描，逐个读文件拼回同样的 `Record<string, string>`。读不到或内容坏了就跳过该 env——与今天 `readState()` 的降级行为一致。

4 个消费点（`views.ts:32,57,88`、`tui/ls.tsx:21`）签名不变，一行不用改。

### 4.3 老数据

**不做迁移动作。** `lastUsed()` 在某个 env 没有新文件时，回退读旧 `state.json` 里对应的 key。

- 读路径上不写盘——写就又制造并发。
- 旧文件随各 env 被使用而自然失效。
- `state.json` 保留不删，从此只读不写。

### 4.4 生命周期

`removeEnv` 里改 state 的两行（`env.ts:403-405`）删除——时间戳跟着 env 目录一起消失，这本就该是它的生命周期。

`.tread/last-used` 加进 `copy.ts` 的 `SHARED_VOLATILE`：副本显示"从未使用"直到首次激活，与 §1 既有约定（"cp 不写 lastUsed，所以新环境显示 never"）一致。

## 5. 修复二：shims 原子替换

`shims.ts:75` 的 `writeFileSync(target, body, { mode: 0o755 })` 改为写同目录 tmp 再 `renameSync`。

- POSIX 下 rename 覆盖正在被 exec 的文件是安全的，运行中的进程握着旧 inode。
- 实测确认 `renameSync` 覆盖已存在目标不报错。
- 其后的 `chmodSync` 保留，它能自愈被改坏的权限位。

这一项与数据库无关，纯粹是"截断后再写"的窗口期问题：并发的第三个进程可能 exec 到一个半截的 shim。

## 6. 修复三：sync 互斥锁

### 6.1 原语选型（均已实测验证）

| 原语 | 实测结果 |
|---|---|
| `openSync(path, "wx")` 原子创建 | 第二次得 `EEXIST` |
| `renameSync` 抢占选举 | 第二个得 `ENOENT`，**只有一个赢家** |
| `process.kill(pid, 0)` 探活 | 不存在的 pid 得 `ESRCH` |
| `Atomics.wait` 同步睡眠 | 请求 120ms 实测 122ms，不烧 CPU |

第二条是正确性的核心：没有它，两个进程同时判定锁失效并抢占，会制造出双持有者。

### 6.2 锁的形态

`<env>/.tread/sync.lock`，`openSync(path, "wx")` 创建，内容写持有者身份 `{ pid, host, at }`。

获取流程（`held` 为进程内已持有集合）：

```
if held.has(lock) → 重入，直接执行，不获取也不释放
deadline = now + timeout
loop:
  try  openSync(lock,"wx") → 写身份 → held.add → 获得
  catch EEXIST → 继续
  catch 其它(EACCES/EROFS/ENOSPC) → 抛真实 errno，不假装成功
  if 判定失效 → 抢占（rename 选举，输了当无事发生）
  if now >= deadline → 抛超时错误
  Atomics.wait(退避 25→200ms，且不超过剩余时间)
```

失效判定：

```
owner = 读身份            // 读不到 → 退回用锁文件自身 mtime，加 5s 宽限期
age   = max(0, now - owner.at)          // 时钟回拨钳到 0，视作刚创建
if owner.host != hostname → 只看 age > MAX_AGE     // 跨主机 pid 无意义
if pid 不存活 (ESRCH)     → 失效                    // 主信号
return age > MAX_AGE                                // pid 可能被回收，年龄兜底
```

抢占：`renameSync(lock, lock + ".dead." + pid)`。赢家唯一；输家得 `ENOENT`，回到等待循环。赢家删掉 dead 文件后走正常获取路径（此时仍可能输给第三方，那就继续等）。

释放：读回身份比对 pid，**确认仍是自己才 unlink**——防止自己卡太久、锁被合法抢走后，误删新持有者的锁。释放永远在 `finally`。

### 6.3 逐个失效场景

| 场景 | 防御 |
|---|---|
| 持有者被 SIGKILL / 断电，残锁永存 | `process.kill(pid,0)` 探活，`ESRCH` 即刻破锁；年龄兜底 60s |
| pid 被回收，探活误判为活 | 不单靠探活——`pid 活 && age > 60s` 同样破锁 |
| 锁在网络挂载上，跨主机 pid 无意义 | 身份记 `host`；不匹配时只看年龄 |
| 两个进程同时破锁 → 双持有者 | `rename` 选举，只有一个赢 |
| 系统时钟回拨 | age 钳到 `>= 0`，负值视作刚创建 → 尊重锁 |
| 异常导致锁不释放 | `try/finally` |
| Ctrl-C / SIGTERM 时持锁 | 只装一次的信号处理器 + `process.on("exit")` 兜底；即便全没跑到，探活也会立刻破锁 |
| 卡太久锁被抢走，release 时误删他人锁 | release 前比对 pid |
| 未来重构引入嵌套调用 → 自死锁 | `held` 集合重入放行。今天无嵌套路径（doctor 的 `:282` 与 `:302` 是顺序非嵌套），这是给以后买的保险 |
| 锁被 sync 覆盖 / 被 cp 继承 | `.tread` 已是 hardDeny（`config.ts:80`），`discoverExisting` 因此跳过；`.tread/sync.lock` 加进 `SHARED_VOLATILE` |
| `.tread/` 尚不存在 | acquire 先 `mkdirSync(dirname, { recursive: true })` |
| 身份文件缺失/损坏（创建与写入之间崩溃） | 退回用锁文件 mtime 算年龄，加 5s 宽限期（创建与写入之间只有微秒级窗口） |

**不可能卡死**：deadline 进入时一次算定，每轮重新判定，睡眠时长被剩余时间夹住。没有任何路径能无限等待。

### 6.4 加锁边界

- **只锁 `dryRun: false` 的路径。** doctor 的探查不改盘，与并发修改撞上顶多报告差一点，不值得为它引入等待。
- **锁绝不跨越 `Bun.spawn`。** `commands.ts:137` 的 `ensureSkeleton(root)` 之后紧接 `:145` 拉起 agent，可能跑一小时。锁在 `ensureSkeleton` 内部即释放，否则一个长跑 agent 会锁死整个 env 一小时。此条以测试钉住。

### 6.5 超时报错，且重试干净

超时抛错，走既有多行错误风格：

```
环境 "work" 正在被另一个进程同步

  持有者  pid 48213（已持有 11s）
  已等待  10s

  这次没有做任何改动，稍后重试即可
  tread doctor --fix   如果确认那个进程已经不在
```

**"重试无副作用"由代码结构保证**：acquire 是 `syncHomeLinks` 里的第一件事，排在任何 `symlinkSync` / `mkdirSync` / `rmdirSync` / 账本写入之前。超时抛出发生在获取阶段，此刻进程一字节未写盘，重试严格等价于首次调用。此条写成测试断言，不靠约定。

超时默认 10s，`TREAD_LOCK_TIMEOUT_MS` 可覆盖（测试需要）。`MAX_AGE` 默认 60s，远超任何正常 sync。

### 6.6 doctor 集成

doctor 探查到失效锁时报为一个 issue，`--fix` 清除——与现有 broken symlink 的处理模式一致，也给 §6.5 错误提示里那句建议一个真实落点。

## 7. 测试

回归测试（钉住已证实的缺陷）：

- 两个**真实进程**并发 `touchLastUsed` 不同 env → 两个时间戳都在（§1.1 丢更新的反向断言）
- 同 env 并发两次 `syncHomeLinks` → 不抛异常，终态正确

锁的防御测试：

- 伪造 pid 已死的锁 → 立刻破锁，不等满超时
- 伪造 pid 存活但超龄的锁 → 破锁
- 伪造 pid 存活且新鲜的锁 → 尊重，等到超时报错
- 超时路径 → 抛错，且**断言盘上零改动**；随后释放锁重试 → 成功
- 重入：进程内嵌套调用不自死锁
- release 不误删被抢走的锁

边界测试：

- 锁不跨越 `exec` 的 spawn
- `lastUsed` 老数据回退：只有 `state.json` 没有 per-env 文件时仍读得到
- `cp` 出来的环境不继承时间戳与锁文件
- shims 覆写期间文件始终可执行且非空

e2e：

- 并发 `tread use` 多个不同 env → 全部成功，`tread ls` 中每个 env 的时间戳都在

## 8. 非目标

- 不引入 SQLite，不为其做任何铺垫。
- 不改变 `listEnvs()` 的文件系统真相来源。
- 不动 config 的读取与解析。
- 不为 `~/.zshrc` 的追加写（`shell.ts:198`）加锁——那是用户主动的一次性操作，实际不并发。
