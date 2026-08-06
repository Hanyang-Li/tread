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
const { initSnippet, exportLines, deactivateLines, shellLoaded } = await import(
  "../src/shell.ts"
);

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
});
