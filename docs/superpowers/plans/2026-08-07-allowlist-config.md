# 白名单化：用户可配置的 home 共享策略

2026-08-07

## 为什么

`syncHomeLinks` 现在是黑名单：默认把真 home 的一切 symlink 进 env，只 deny 掉几条。
今天把 claude 也改成 `needsHome: true` 之后，三个 agent 全部在移动后的 HOME 下运行 ——
agent 直接 `ls ~` 就能看到整个 home。默认全共享的代价变大了。

翻转成白名单。但白名单的失败模式（东西不存在，在工具深处静默出错）比黑名单
（东西泄漏，事后可查）更难诊断，所以设计要围绕"让白名单漏项尽可能不发生"：

1. tread **自带**一份默认清单，沉淀"什么工具需要什么"的知识，用户不从零写。
2. 用户配置是**补丁**，不是全量替换 —— 默认清单演进时老用户能吃到新增项。
3. `doctor` 能报出"配置里写了但真 home 没有"这类问题。

## 三层叠加

```
tread 内置默认  →  ~/.config/tread/config.yaml  →  <env>/.tread/config.yaml
                        （补丁）                        （补丁）
```

解析顺序：

```
set = DEFAULT_ALLOW(platform)
for layer in [global, perEnv]:
    if layer.replace 存在:  set = layer.replace          # 逃生舱
    else:                   set = (set ∪ extra) \ remove  # 层内 remove 压过 extra
set = set \ HARD_DENY                                      # 硬 deny 永远最后、永远赢
```

层内 `remove` 压过 `extra`；跨层后一层的 `extra` 可以把前一层 `remove` 掉的加回来
（否则 per-env 无法放宽全局的收紧）。

## 硬 deny：不可配置的那一层

用户配置碰不到这些，写了也不生效（`doctor` 会报）：

| 路径 | 为什么 |
|---|---|
| `.local/state` | tread 自己的 state，link 进去会让 env 嵌套自己 |
| `.tread` | per-env 配置本身，被 link 覆盖就自举失败 |
| `.config/tread` | 全局配置，不该出现在 env 内 |
| 各 agent 的 `dir` | `.claude` / `.cursor` / `.kimi-code`，必须是 env 里的真目录 |
| 各 agent 的 `isolate()` | cursor 的 globalStorage 等 |

## 配置格式

YAML。`Bun.YAML` 内建 `parse` **和** `stringify`（`Bun.TOML` 只有 `parse`），零依赖。

```yaml
allow:
  extra:   [.yqg-cli]     # 默认清单之外还要共享的
  remove:  [.cache]       # 默认清单里不想共享的
  replace: [...]          # 逃生舱：忽略默认清单，全量指定
```

路径规则：相对 home、`/` 分隔、不允许绝对路径和 `..`。

## 位置

- 全局：`~/.config/tread/config.yaml`（XDG 约定）
- per-env：`<env-root>/.tread/config.yaml`

per-env 放在 env 内的理由：跟 env 自包含，`tread rm` 顺手清掉，`tread show` 好展示。
反对意见"env root 就是 agent 眼里的 HOME，agent 能改自己的策略"权重不高 ——
agent 本来就能通过链接农场写到真 home 任何地方，tread 防的是 skill 算 `homedir()`
这种**意外**泄漏，不是对抗性逃逸。

两个位置都不能落在同步树管辖内（config 决定链接，不能被链接逻辑管），所以都进硬 deny。

## 遍历规则

从"允许树"和"硬 deny 树"出发，不再 readdir 整个 home：

| 节点状态 | 处理 |
|---|---|
| 被允许，且底下没有硬 deny | 整个 symlink 出去 |
| 被允许，但底下埋着硬 deny | `mkdir` 真目录，readdir 真 home 这一层，逐个递归（子项默认继承"允许"） |
| 未被允许，但底下有被允许的后代 | `mkdir` 真目录，**只**下钻到指名的子项，不 readdir |
| 其余 | 不碰 |

第三种支持细粒度允许（只 allow `.config/gh` 而不是整个 `.config`）。

## 清理（prune）

遍历时收集"应该存在的路径集合"。之后扫一遍 env：

- 指向真 home 的 symlink，悬空 **或** 不在集合里 → 删
- 目录 → 递归；回来后若为空、且不是 agent 目录、不在集合里 → `rmdir`

`rmdir` 只删空目录，不会碰用户数据。**这条是白名单化的关键**：用户从配置里删掉一项，
如果不 prune，对已有 env 就是空操作 —— 配置收紧了但实际没收紧，是最坏的失败。

## `doctor --fix` 的作用域

**config 是唯一真相，env 是派生物。`--fix` 只把 env 修成符合 config 的样子，永不改 config。**
（`Bun.YAML.stringify` 不保留注释，回写会吃掉用户写的理由。）

新增检查：

1. 配置解析失败 / 未知键 / 绝对路径 / `..` → 报，不 fix
2. 配置条目在真 home 不存在（拼错、工具卸了）→ 报，不 fix
3. 配置条目命中硬 deny → 报，不 fix
4. env 里有该 prune 的链接 / 缺失的链接 → `--fix` 重新同步
5. **shim 内容漂移** → `--fix` 重新生成。现在 `shimsHealthy()` 只看文件在不在、
   `real=` 活没活，不比对内容，所以升级 tread 后 shim 一直是旧的而 doctor 报 ok。
   既然 doctor 要当修复入口，这个洞同期堵上。

## 阶段

1. `src/config.ts`：schema、三层合并、校验、`DEFAULT_ALLOW`、`HARD_DENY`
2. `src/env.ts`：`syncHomeLinks` 换成允许树遍历 + prune
3. `src/shims.ts`：内容漂移检测
4. `src/commands.ts`：doctor 接入
5. 测试

每阶段跑 `bun test` + `bunx tsc --noEmit`。
