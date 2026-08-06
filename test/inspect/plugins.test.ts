import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let env: string;
beforeAll(() => {
  env = fs.mkdtempSync(path.join(os.tmpdir(), "tread-plugins-"));
  const pd = path.join(env, ".claude/plugins");
  const installPath = path.join(pd, "cache/official/feature-dev/1.4.0");
  fs.mkdirSync(path.join(installPath, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(installPath, ".claude-plugin/plugin.json"),
    JSON.stringify({
      name: "feature-dev",
      description: "Feature workflow",
      author: { name: "Anthropic" },
    }),
  );
  fs.writeFileSync(
    path.join(pd, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "feature-dev@official": [
          {
            scope: "user",
            version: "1.4.0",
            gitCommitSha: "909649d1234",
            installPath,
            installedAt: "2026-04-11T03:46:05.098Z",
            lastUpdated: "2026-08-06T07:50:32.960Z",
          },
        ],
        "scoped@official": [
          {
            scope: "project",
            version: "1.0.0",
            projectPath: "/some/project",
            installPath: "/x",
            installedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    }),
  );
  fs.writeFileSync(
    path.join(pd, "known_marketplaces.json"),
    JSON.stringify({
      official: { source: { source: "github", repo: "anthropics/claude-plugins-official" } },
    }),
  );

  const kd = path.join(env, ".kimi-code/plugins");
  fs.mkdirSync(kd, { recursive: true });
  fs.writeFileSync(
    path.join(kd, "installed.json"),
    JSON.stringify({
      version: 1,
      plugins: [
        {
          id: "my-tool",
          root: "/r",
          source: "github",
          enabled: true,
          installedAt: "2026-07-15T00:00:00.000Z",
          originalSource: "github.com/me/my-tool",
        },
      ],
    }),
  );
});
afterAll(() => fs.rmSync(env, { recursive: true, force: true }));

const { readPlugins } = await import("../../src/inspect/plugins.ts");

describe("readPlugins", () => {
  test("claude: 读版本/sha/时间，并从 manifest 补 description", () => {
    const p = readPlugins(env, "claude");
    expect(p).toHaveLength(1);
    expect(p[0].name).toBe("feature-dev");
    expect(p[0].version).toBe("1.4.0");
    expect(p[0].commit).toBe("909649d");
    expect(p[0].description).toBe("Feature workflow");
    expect(p[0].author).toBe("Anthropic");
    expect(p[0].marketplace).toBe("official");
    expect(p[0].marketplaceSource).toBe("github:anthropics/claude-plugins-official");
  });

  test("project scope 一律跳过", () => {
    expect(readPlugins(env, "claude").some((p) => p.name === "scoped")).toBe(false);
  });

  test("kimi: 读 installed.json", () => {
    const p = readPlugins(env, "kimi");
    expect(p).toHaveLength(1);
    expect(p[0].name).toBe("my-tool");
    expect(p[0].enabled).toBe(true);
    expect(p[0].marketplaceSource).toBe("github.com/me/my-tool");
  });

  test("cursor: 无插件目录时返回空", () => {
    expect(readPlugins(env, "cursor")).toEqual([]);
  });
});
