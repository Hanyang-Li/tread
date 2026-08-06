export const MASK = "••••";

export interface SkillInfo {
  name: string;
  version: string | null;
  description: string | null;
  /** short, human-facing origin: "open.feishu.cn" | "vercel-labs/agent-skills" */
  source: string | null;
  sourceUrl: string | null;
  path: string;
  installedAt: string | null;
  requiresBins: string[];
}

export interface PluginInfo {
  name: string;
  version: string | null;
  description: string | null;
  author: string | null;
  marketplace: string | null;
  marketplaceSource: string | null;
  commit: string | null;
  installedAt: string | null;
  updatedAt: string | null;
  path: string | null;
  enabled: boolean;
}

export interface McpServerInfo {
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  url: string | null;
  /** keys only — values are never carried into any output path */
  headerKeys: string[];
  envKeys: string[];
  source: string;
}

export interface HookInfo {
  event: string;
  /** merged: identical commands under one event collapse into one entry */
  matchers: string[];
  command: string;
  timeout: number | null;
  source: string;
  /** how many raw entries this row represents */
  count: number;
}

export interface Inventory {
  skills: SkillInfo[];
  plugins: PluginInfo[];
  mcp: McpServerInfo[];
  hooks: HookInfo[];
  /** false when the agent dir holds nothing but tread's own skeleton */
  used: boolean;
}
