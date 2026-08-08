import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-completion-"));
  process.env.TREAD_DATA_DIR = path.join(tmp, "share");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { ZSH_COMPLETION, writeCompletion, completionState } =
  await import("../src/completion.ts");
const { completionFile } = await import("../src/paths.ts");

describe("completion file", () => {
  test("是一个 zsh 补全函数文件，候选一概问二进制", () => {
    expect(ZSH_COMPLETION.startsWith("#compdef tread\n")).toBe(true);
    expect(ZSH_COMPLETION).toContain("command tread _complete");
    expect(ZSH_COMPLETION.trimEnd().endsWith('_tread "$@"')).toBe(true);
  });

  test("zsh 能解析它", async () => {
    const zsh = Bun.which("zsh");
    if (!zsh) return; // no zsh on this machine — nothing to check against
    const f = path.join(tmp, "_tread");
    fs.writeFileSync(f, ZSH_COMPLETION);
    const proc = Bun.spawn([zsh, "-n", f], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(code).toBe(0);
  });

  test("写之前是 missing，写完是 ok，改一个字就是 stale", () => {
    expect(completionState()).toBe("missing");
    writeCompletion();
    expect(fs.readFileSync(completionFile(), "utf8")).toBe(ZSH_COMPLETION);
    expect(completionState()).toBe("ok");
    fs.appendFileSync(completionFile(), "# hand-edited\n");
    expect(completionState()).toBe("stale");
    writeCompletion();
    expect(completionState()).toBe("ok");
  });

  test("目录不存在也能写", () => {
    fs.rmSync(path.dirname(completionFile()), { recursive: true, force: true });
    writeCompletion();
    expect(completionState()).toBe("ok");
  });
});
