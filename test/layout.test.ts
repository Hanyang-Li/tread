import { describe, expect, test } from "bun:test";
const { pickLayout, scrollWindow } = await import("../src/tui/layout.ts");

describe("pickLayout", () => {
  test("宽度断点", () => {
    expect(pickLayout(100, 30).mode).toBe("full");
    expect(pickLayout(70, 30).mode).toBe("wide");
    expect(pickLayout(50, 30).mode).toBe("narrow");
    expect(pickLayout(35, 30).mode).toBe("minimal");
    expect(pickLayout(29, 30).mode).toBe("plain");
  });

  test("高度不足也退化", () => {
    expect(pickLayout(100, 7).mode).toBe("plain");
    expect(pickLayout(100, 10).showDetail).toBe(false);
    expect(pickLayout(100, 12).showDetail).toBe(true);
  });

  test("列数随宽度收缩", () => {
    expect(pickLayout(100, 30).columns).toBe(3);
    expect(pickLayout(50, 30).columns).toBe(2);
    expect(pickLayout(35, 30).columns).toBe(1);
  });
});

describe("scrollWindow", () => {
  test("放得下就全显示", () => {
    expect(scrollWindow(0, 3, 10)).toEqual({ start: 0, end: 3 });
  });

  test("光标居中", () => {
    expect(scrollWindow(10, 100, 5)).toEqual({ start: 8, end: 13 });
  });

  test("不越过两端", () => {
    expect(scrollWindow(0, 100, 5)).toEqual({ start: 0, end: 5 });
    expect(scrollWindow(99, 100, 5)).toEqual({ start: 95, end: 100 });
  });
});
