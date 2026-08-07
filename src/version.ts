import pkg from "../package.json" with { type: "json" };

/**
 * One source of truth for `tread --version` and the bundled skill's
 * frontmatter, so `tread skills` reports the version that actually wrote it.
 */
export const VERSION: string = pkg.version;
