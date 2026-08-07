import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tread-atomic-"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { writeFileAtomic } = await import("../src/atomic.ts");

describe("writeFileAtomic", () => {
  test("写得进去，且父目录会被建出来", () => {
    const f = path.join(tmp, "a/b/c.txt");
    writeFileAtomic(f, "hello");
    expect(fs.readFileSync(f, "utf8")).toBe("hello");
  });

  test("覆盖已存在的文件", () => {
    const f = path.join(tmp, "over.txt");
    writeFileAtomic(f, "one");
    writeFileAtomic(f, "two");
    expect(fs.readFileSync(f, "utf8")).toBe("two");
  });

  test("带 mode 时权限位生效", () => {
    const f = path.join(tmp, "exec.sh");
    writeFileAtomic(f, "#!/bin/sh\n", 0o755);
    expect(fs.statSync(f).mode & 0o777).toBe(0o755);
  });

  test("不留下临时文件", () => {
    const d = path.join(tmp, "clean");
    writeFileAtomic(path.join(d, "x"), "x");
    expect(fs.readdirSync(d)).toEqual(["x"]);
  });

  test("写失败时不留临时文件，且原文件不动", () => {
    const f = path.join(tmp, "keep.txt");
    writeFileAtomic(f, "original");
    // renaming onto a non-empty directory fails
    const bad = path.join(tmp, "adir");
    fs.mkdirSync(path.join(bad, "sub", "inner"), { recursive: true });
    expect(() => writeFileAtomic(path.join(bad, "sub"), "nope")).toThrow();
    expect(fs.readdirSync(bad)).toEqual(["sub"]);
    expect(fs.readFileSync(f, "utf8")).toBe("original");
  });
});
