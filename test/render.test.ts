import { describe, expect, test } from "bun:test";
const { table, displayWidth, truncateMiddle, relTime, color, tildify } = await import(
  "../src/render.ts"
);

describe("displayWidth", () => {
  test("CJK 记两格", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("飞书")).toBe(4);
    expect(displayWidth("a飞b")).toBe(4);
  });
  test("忽略 ANSI 转义", () => {
    expect(displayWidth("\x1b[31mred\x1b[0m")).toBe(3);
  });
});

describe("table", () => {
  test("按显示宽度对齐", () => {
    const rows = table([["a", "1"], ["bbb", "2"]]);
    expect(rows[0]).toBe("a    1");
    expect(rows[1]).toBe("bbb  2");
  });
  test("含 CJK 时仍对齐", () => {
    const rows = table([["飞书", "1"], ["ab", "2"]]);
    expect(displayWidth(rows[0])).toBe(displayWidth(rows[1]));
  });
  test("末列不补空格", () => {
    expect(table([["a", "1"]])[0].endsWith("1")).toBe(true);
  });
  test("空输入不崩", () => {
    expect(table([])).toEqual([]);
  });
});

describe("truncateMiddle", () => {
  test("超长时中间省略，保留尾部", () => {
    const r = truncateMiddle("/Users/me/.local/state/tread/envs/work", 20);
    expect(displayWidth(r)).toBeLessThanOrEqual(20);
    expect(r).toContain("…");
    expect(r.endsWith("work")).toBe(true);
  });
  test("不超长时原样返回", () => {
    expect(truncateMiddle("short", 20)).toBe("short");
  });
});

describe("relTime", () => {
  const now = new Date("2026-08-07T12:00:00Z");
  test("分钟/天/从未", () => {
    expect(relTime("2026-08-07T11:58:00Z", now)).toBe("2 minutes ago");
    expect(relTime("2026-08-04T12:00:00Z", now)).toBe("3 days");
    expect(relTime(null, now)).toBe("never");
  });
  test("一分钟内", () => {
    expect(relTime("2026-08-07T11:59:50Z", now)).toBe("just now");
  });
  test("坏值当从未", () => {
    expect(relTime("garbage", now)).toBe("never");
  });
});

describe("color", () => {
  test("关闭时是恒等函数", () => {
    expect(color(false).red("x")).toBe("x");
  });
  test("开启时包裹 ANSI", () => {
    expect(color(true).red("x")).toContain("\x1b[");
  });
});

describe("tildify", () => {
  test("替换 home 前缀", () => {
    expect(tildify("/Users/me/x", "/Users/me")).toBe("~/x");
    expect(tildify("/opt/x", "/Users/me")).toBe("/opt/x");
  });
});
