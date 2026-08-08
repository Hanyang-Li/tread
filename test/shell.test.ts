import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-shell-"));
  process.env.TREAD_STATE_DIR = path.join(tmp, "state");
  delete process.env.TREAD_SHELL;
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { createEnv } = await import("../src/env.ts");
const { initSnippet, exportLines, deactivateLines, shellLoaded, spliceStarshipFormat } =
  await import("../src/shell.ts");

describe("shell integration", () => {
  test("zsh 片段定义 tread() 且只让 ls 走 --emit", () => {
    const s = initSnippet("zsh");
    expect(s).toContain("tread()");
    expect(s).toContain("--emit");
    expect(s).toContain("TREAD_SHELL=zsh");
    // show is read-only and must not go through the emit branch
    expect(s).not.toMatch(/ls\|show\)/);
  });

  test("fish 用 function 而非 POSIX 语法", () => {
    const s = initSnippet("fish");
    expect(s).toContain("function tread");
    expect(s).not.toContain('case "$1" in');
  });

  test("starship 片段是 TOML 且引用 env_var.tread", () => {
    const s = initSnippet("starship");
    expect(s).toContain("[env_var.tread]");
    expect(s).toContain("variable = 'TREAD_ENV'");
    expect(s).toContain("${env_var.tread}");
  });

  test("未知 shell 报错", () => {
    expect(() => initSnippet("tcsh")).toThrow(/unknown shell/);
  });

  test("exportLines 导出全部变量", () => {
    createEnv("work");
    const out = exportLines("work");
    for (const k of [
      "TREAD_ENV", "TREAD_ENV_DIR", "CLAUDE_CONFIG_DIR",
      "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "KIMI_CODE_HOME",
    ]) {
      expect(out).toContain(`export ${k}=`);
    }
    expect(out).toContain("TREAD_ENV='work'");
  });

  test("值被单引号包裹", () => {
    createEnv("qu.ote");
    expect(exportLines("qu.ote")).toContain("TREAD_ENV='qu.ote'");
  });

  test("deactivateLines unset 全部", () => {
    const out = deactivateLines();
    expect(out).toContain("unset TREAD_ENV");
    expect(out).toContain("unset KIMI_CODE_HOME");
    expect(out).toContain("unset CURSOR_DATA_DIR");
  });

  test("shellLoaded 依据 TREAD_SHELL", () => {
    delete process.env.TREAD_SHELL;
    expect(shellLoaded()).toBe(false);
    process.env.TREAD_SHELL = "zsh";
    expect(shellLoaded()).toBe(true);
    delete process.env.TREAD_SHELL;
  });

  test("zsh 片段把补全接进 fpath，bash 片段不接", () => {
    const z = initSnippet("zsh");
    expect(z).toContain("autoload -Uz _tread");
    expect(z).toContain("compdef _tread tread");
    // guarded three ways: a file that was never written, a doubly-sourced rc,
    // and an eval line that lands before compinit
    expect(z).toContain("[[ -r ");
    expect(z).toContain("${fpath:#");
    expect(z).toContain("$+functions[compdef]");
    expect(initSnippet("bash")).not.toContain("compdef");
  });

  test("zsh 片段能被 zsh 解析", async () => {
    const zsh = Bun.which("zsh");
    if (!zsh) return;
    const f = path.join(tmp, "snippet.zsh");
    fs.writeFileSync(f, initSnippet("zsh"));
    const proc = Bun.spawn([zsh, "-n", f], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  });
});

// starship 只渲染顶层 format 点名的模块：光追加 [env_var.tread] 表，
// 对写了显式 format 的配置来说等于什么都没发生
describe("starship format", () => {
  const CONFIG =
    'format = """\n' +
    "[](red)\\\n" +
    "$directory\\\n" +
    '$character"""\n' +
    "\n" +
    "[directory]\n" +
    'format = "[ $path ]($style)"\n';

  const spliced = (toml: string): string => {
    const r = spliceStarshipFormat(toml);
    if (r.kind !== "spliced") throw new Error(`expected spliced, got ${r.kind}`);
    return r.text;
  };

  test("插入到顶层 format 最前，且不破坏 \"\"\" 的续行", () => {
    // 换行仍紧跟 """（TOML 会吃掉它），自己这行以 \ 结尾，不给 prompt 加空行
    expect(spliced(CONFIG)).toContain('format = """\n${env_var.tread}\\\n[](red)\\\n');
  });

  test("只动顶层 format，不碰模块自己的 format", () => {
    expect(spliced(CONFIG)).toContain('[directory]\nformat = "[ $path ]($style)"');
  });

  test("已经引用过就不再插入", () => {
    expect(spliceStarshipFormat(spliced(CONFIG)).kind).toBe("present");
  });

  test("没有顶层 format：$all 已经覆盖 env_var.*，无需改动", () => {
    expect(spliceStarshipFormat('[directory]\nformat = "x"\n').kind).toBe("default");
    expect(spliceStarshipFormat('# format = "$all"\n').kind).toBe("default");
  });

  test("单行 format 直接插在引号后", () => {
    expect(spliced("format = '$directory$character'\n")).toContain(
      "format = '${env_var.tread}$directory$character'",
    );
  });

  test("顶层多行字符串里的 [ 不算表头", () => {
    const cfg = 'right_format = """\n[](red)\\\n"""\nformat = "$directory"\n';
    expect(spliced(cfg)).toContain('format = "${env_var.tread}$directory"');
  });

  test("''' 里没有续行语法，宁可让人自己动手", () => {
    expect(spliceStarshipFormat("format = '''\n$directory\n'''\n").kind).toBe("manual");
  });
});
