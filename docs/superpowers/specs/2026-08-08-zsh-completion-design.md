# zsh 补全：`_tread`

日期：2026-08-08
状态：待评审

## 1. 背景

tread 的命令表已经不小了：16 个子命令，位置参数是 `[env] [agent] [name]` 三层，还有 `--probe` / `--fix` / `--home` / `--plain` 这类各命令自己的 flag。日常最高频的一条是 `tread use <env>`，而环境名只存在于 `~/.local/state/tread/envs/` 下，人得先 `tread ls` 一遍才知道自己有哪些。

目标：装上 zsh 补全，按 TAB 补出子命令、环境名、agent 名、类别名、skill/plugin/MCP/hook 的具体名字，以及各命令的 flag。

参照 `verge-proxy`：它在 `install` 时把 `_verge-proxy` 写到 `~/.local/share/verge-proxy/`，再软链到 `~/.local/share/zsh/site-functions/`，由 `install.sh` 负责把那个目录塞进 `.zshrc` 的 fpath。本设计沿用"补全文件写在自己的 data dir 下"这一点，但接线方式不同，见 §4。

**不做**：bash / fish 补全。

## 2. 与 verge-proxy 的关键差异

verge-proxy 的 `install` 是个一次性命令。tread 的对应物 `tread init zsh` 不是——它打印的片段是被 `.zshrc` 里的 `eval` 吃掉的，**每开一个 shell 都要跑一次**。所以"生成补全文件"和"把补全接进 zsh"必须拆开：

| | 何时发生 | 做什么 |
|---|---|---|
| `tread init zsh` | 每次开 shell | 只打印片段（含 fpath / compdef 接线）。不碰磁盘。 |
| `tread init zsh --write` | 用户显式跑 | 追加 `.zshrc`，并把 `_tread` 写出来 |
| `tread doctor [--fix]` | 用户显式跑 | 报告 `_tread` 是否与当前二进制一致，`--fix` 重写 |

于是开 shell 的代价只有一次 `stat`，而不是一次写盘。

## 3. 路径：`paths.ts` 加 `dataDir()`

```ts
/** Where tread writes files other tools read. The zsh completion, for now. */
export function dataDir(): string {
  return process.env.TREAD_DATA_DIR ?? path.join(realHome(), ".local/share/tread");
}

export function completionFile(): string {
  return path.join(dataDir(), "_tread");
}
```

形状照抄 `stateDir()`，两点都是有意的：

- 走 `realHome()` 而不是 `os.homedir()`。agent 的 shim 会把 HOME 改成环境根目录，一个从 claude 里 shell out 回来的 `tread` 如果用 `os.homedir()`，会把 `_tread` 写进环境里去。
- `TREAD_DATA_DIR` 覆盖，理由和 `TREAD_STATE_DIR` 一样：测试要能落在临时目录里。

`~/.local/share/tread/` 是 XDG 的 data 目录，`_tread` 是 zsh 补全函数的命名惯例（`#compdef` 文件必须叫 `_<命令名>`，autoload 靠这个名字找它）。

## 4. 接线：片段自带 fpath，不走 site-functions

`initSnippet("zsh")` 的输出末尾追加（`bash` 分支不加）：

```zsh
if [[ -r '<dataDir>/_tread' ]]; then
  (( ${fpath[(I)<dataDir>]} )) || fpath=('<dataDir>' $fpath)
  (( $+functions[compdef] )) && { autoload -Uz _tread && compdef _tread tread }
fi
```

`<dataDir>` 在生成时插值成绝对路径并单引号包起来——片段是 tread 打印的，它知道真实的家在哪，不需要 shell 再算一遍 `$HOME`。

三个守卫各挡一件事，缺一件就会有人踩到：

1. **`-r`** 挡"手写了 `eval` 行但从没跑过 `--write`"。没有它，`compdef _tread tread` 会注册一个不存在的函数，第一次按 TAB 报 `_tread: function definition file not found`。
2. **`(I)`** 挡重复 `eval`。有人在 `.zshrc` 里 source 两次，或者开了嵌套 shell，fpath 会一路涨。
3. **`$+functions[compdef]`** 挡顺序。`compdef` 要 `compinit` 跑过才存在；如果 `eval` 行在 `compinit` 之前，这一句静默跳过，而第 2 步加好的 fpath 会被随后的 `compinit` 自己捡到——两种顺序都能用。

不学 verge-proxy 软链到 `~/.local/share/zsh/site-functions/` 的理由：那条路要求 `install.sh` 去改用户的 `.zshrc` 加 fpath 和 `compinit`，而 tread 的 `install.sh` 现在只做编译，不碰 shell 配置。片段自带接线之后 `.zshrc` 里仍然只有 tread 的一行 `eval`。

## 5. `tread _complete`：隐藏子命令，只出数据

**语法在 zsh 里，词汇全部问二进制。**

和 `_export` 同一路数：不进 `HELP`，不进 `_complete commands` 自己的输出，从 `tread help` 完全看不见。

| 调用 | 输出 |
|---|---|
| `tread _complete commands` | 子命令名 + 描述 |
| `tread _complete shells` | `zsh` `bash` `fish` `starship` |
| `tread _complete envs` | `listEnvs()` 的结果，当前激活的那个描述成 `active` |
| `tread _complete targets <cmd> [已输入的词...]` | 下一个位置参数的候选 |

输出协议：一行一个候选，`值` 或 `值:描述`。值里的字面冒号转义成 `\:`——`_describe` 拿第一个未转义的冒号当值/描述的分隔符，而 skill 目录名理论上可以含冒号。没有候选就空输出退 0；用法错了退 1，且**不往 stdout 写任何东西**（错误照现有约定走 stderr）。

### 5.1 `targets` 为什么必须在 TS 侧

`splitTargets()` 的规则是"第一个词不是 agent 名就当环境名"，位置不固定。把这条规则抄进 zsh，就等于在两个语言里各维护一份 agent 名单和一份消歧逻辑。改成把已输入的词原样丢回给 `splitTargets()`：

```
tread skills <TAB>              → splitTargets([])           → 环境名 + agent 名
tread skills work <TAB>         → {env:work, agent:null}     → agent 名 + work/claude 的 skill 名
tread skills claude <TAB>       → {env:null, agent:claude}   → 当前激活环境/claude 的 skill 名
tread skills work claude <TAB>  → {env:work, agent:claude}   → skill 名
tread path  work claude <TAB>   → 同上，但末格出类别而非 item 名
```

`{env:null, agent:claude}` 且没有激活环境时，`resolveEnv()` 会抛错——补全里要吞掉，输出空，而不是让报错文本变成候选项。

item 名字复用 `skillsList` / `pluginsList` / `mcpList` / `hooksList` 已经在读的那些文件，所以 MCP server 名（`.mcp.json`）和 hook event 名（claude 的 `settings.json`、cursor 的 `hooks.json`、kimi 的 `config.toml`）也能补——这两类在纯 zsh 方案里是补不出来的。`mcpList` 用 `probe = false` 调，补全不该起网络。

### 5.2 静态列表也走 `_complete`

命令名、agent 名、类别名、shell 名都是编译期已知的，本可以在生成 `_tread` 时插值进去，省掉 `tread <TAB>` 这种最高频按键的一次进程启动。这里选择不插值：

`_tread` 里只剩语法（哪个命令吃哪些位置参数和 flag），词汇一概向二进制现问。好处是 `_tread` 变成一个很少需要改的薄文件——加一个子命令不必重写它——于是 §7 那条 doctor 检查基本永远是 `ok`，用户很少会碰到"补全落后于二进制"。代价是每次 TAB 一次进程启动，bun 编译产物量级在几十毫秒，补全场景可接受。

## 6. `_tread` 的结构

`src/completion.ts` 导出一个静态字符串，和 `shell.ts` 里的 `posix()` / `FISH` / `STARSHIP` 是一路东西。

```zsh
#compdef tread

_tread_ask() {
  local tag=$1; shift
  local -a c
  c=(${(f)"$(command tread _complete "$@" 2>/dev/null)"})
  (( $#c )) && _describe -t "$tag" "$tag" c
}

_tread() {
  local curcontext="$curcontext" state line
  typeset -A opt_args
  _arguments -C \
    '(- *)'{-h,--help}'[show help]' \
    '(- *)'{-v,--version}'[show version]' \
    '1: :->cmd' \
    '*:: :->args'

  case $state in
    cmd) _tread_ask command commands ;;
    args)
      case $words[1] in
        init)  _arguments '(-w --write)'{-w,--write}'[append to your shell rc]' \
                          '1:shell:{_tread_ask shell shells}' ;;
        use)   _arguments '1:environment:{_tread_ask environment envs}' ;;
        cp)    _arguments '1:source:{_tread_ask environment envs}' '2:new name: ' ;;
        rm)    _arguments '(-f --force)'{-f,--force}'[skip the confirmation]' \
                          '1:environment:{_tread_ask environment envs}' ;;
        doctor) _arguments '--fix[repair what it can]' \
                          '1:environment:{_tread_ask environment envs}' ;;
        status) _arguments '1:environment:{_tread_ask environment envs}' ;;
        show)  _arguments '--plain[no TUI]' '1:environment:{_tread_ask environment envs}' ;;
        ls)    _arguments '--plain[no TUI]' ;;
        exec)  ... ;;   # 见 §6.1
        skills|plugins|hooks|path)
               _tread_ask target targets $words[1] "${(@)words[2,CURRENT-1]}" ;;
        mcp)   _arguments '--probe[contact each server]' \
                          '*:: :{_tread_ask target targets mcp "${(@)words[2,CURRENT-1]}"}' ;;
        create|deactivate|help) ;;
      esac ;;
  esac
}

_tread "$@"
```

（上面是形状，不是逐字最终稿；`_arguments` 的具体写法在实现时调。）

### 6.1 `exec` 的 `--`

`tread exec <env> [--home] -- <cmd>` 里 `--` 之后是任意命令，应该交还给 zsh 的通用补全 `_normal`，于是 `tread exec work -- cla<TAB>` 补成 `claude`，`tread exec work -- claude --<TAB>` 走 claude 自己的补全（如果它有）。

**但直接挂 `_normal` 不行**，两种写法都不行——这是实测出来的，写这份 spec 时想当然了：

| 写法 | `_normal` 看到的 |
|---|---|
| `'(-)*::command:_normal'` | `words=[work \| -- \| ]`，`CURRENT=3` —— 把 `work` 当成要补的命令，于是补它的参数，最后落到文件名 |
| `'(-)*:::command:_normal'` | `words=[-- \| ]`，`CURrent=2` —— 把 `--` 当成命令 |

两种都到不了「命令位」。得先把打头的 `--` 剥掉再交给 `_normal`，所以中间要垫一个 `_tread_exec_cmd`。

同一个坑还有第二个症状：`(-)` 一旦吃掉第一个位置参数就不再认选项，于是 `tread exec work -<TAB>` 补不出 `--home`——而 `HELP` 明明写着 `exec <env> [--home] -- <cmd>`。所以那个垫片在 `--` 到来之前还要负责给出 `--home`，靠 `opt_args` 判断它是不是已经给过了。

教训记在这里而不是只记在代码里：**这一段是整个语法里唯一靠读代码看不出对错的地方**，`zsh -n` 能过、单测能过、四轮评审都过了，直到有人真的在 pty 里按了那个键。凡是改 `exec` 分支，必须按键验。

## 7. `doctor` 的一行

在 `shell` 行之后插一行，两行都是 shell 集成，放一起：

```
shell        ok            zsh · TREAD_ENV=work
completion   ok            ~/.local/share/tread/_tread
state dir    ok            ~/.local/state/tread · 3 envs
shims        ok            ~/.local/state/tread/shims
```

三态，判定方式和 `shimsHealthy()` / `writeShims()` 完全对称：

| 磁盘状态 | 无 `--fix` | 有 `--fix` |
|---|---|---|
| 内容与当前二进制一致 | `ok` | `ok` |
| 内容不一致 | `stale`（黄） | `regenerated`（绿），重写 |
| 文件不存在 | `not installed`（dim），备注给出 `tread init zsh --write` | 同左，**不创建** |

第三行是有意的：`--fix` 的职责是把已经装好的东西拉回一致，装一个从没装过的东西是 `init` 的事。否则一个 fish 用户跑 `tread doctor --fix` 会平白多出一个他永远用不到的 zsh 补全文件。

这一行和 `shims` 行一样只是状态行，不进每环境的 problem 计数（`remaining`）。

## 8. `--write` 的行为与输出

`writeInit("zsh")` 除了原有的追加 `.zshrc`，额外用 `writeFileAtomic()` **无条件重写** `_tread`，返回值多一个字段说明是新写还是重写：

```ts
{ file: string; changed: boolean; format?: ...; completion?: "written" | "rewritten" }
```

用 `writeFileAtomic` 而不是 `writeFileSync`，理由和 shims 那次一样：`compinit` 可能正在读这个文件，截断后再写会让它读到半个文件。

输出：

```
$ tread init zsh --write
tread: added to ~/.zshrc
  restart your shell, or: source ~/.zshrc
tread: completion written to ~/.local/share/tread/_tread

$ tread init zsh --write          # 第二次
tread: already present in ~/.zshrc
tread: completion rewritten at ~/.local/share/tread/_tread
```

`bash` / `fish` / `starship` 的 `--write` 不受影响，不写 `_tread`。

## 9. 测试

| 文件 | 覆盖 |
|---|---|
| `test/paths.test.ts` | `dataDir()` 认 `TREAD_DATA_DIR`；不认时走 `realHome()` 而非 `os.homedir()` |
| `test/completion.test.ts`（新） | 脚本首行是 `#compdef tread`；调的是 `command tread _complete`；`zsh -n` 能解析（PATH 上没有 zsh 就 skip） |
| `test/shell.test.ts` | `initSnippet("zsh")` 含接线块且路径是绝对路径；`initSnippet("bash")` 不含 |
| `test/commands.test.ts` | `_complete commands` 不吐 `_export` 和 `_complete` 自己；`_complete envs` 列出环境并把激活的标成 `active`；`_complete targets` 各格与 `splitTargets` 同步；没激活环境且没给 env 时输出空而不是报错文本；含冒号的名字被转义 |
| `test/commands.test.ts` | `init zsh --write` 在 `TREAD_DATA_DIR` 下落文件并报 `written`，二次运行报 `rewritten`；`init bash --write` 不落 |
| `test/commands.test.ts` | `doctor` 三态：一致 `ok`、篡改后 `stale`、`--fix` 后 `regenerated`；文件不存在时 `not installed` 且 `--fix` 不创建 |

## 10. 文档

- `README.md` 加一小节：`tread init zsh --write` 会同时装补全，以及补全文件在哪。
- `HELP` 常量不动。`init` 那一行已经说了 "print shell integration"，补全是 `--write` 的副作用，而 `--write` 本来就没在 HELP 里列。
