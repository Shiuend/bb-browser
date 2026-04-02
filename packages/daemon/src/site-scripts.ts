/**
 * Site-Scripts — config-driven URL→script mapping and site-bound tab reuse.
 *
 * Reads `~/.bb-browser/site-scripts.json` to determine which user scripts
 * should be auto-injected when a tab navigates to a matching URL.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SiteScriptRule {
  /** URL pattern, e.g. "https://mail.google.com/**" */
  match: string;
  /** Script filenames relative to ~/.bb-browser/scripts/ */
  scripts: string[];
  /** Whether to reuse the same tab for this site pattern */
  reuseTab: boolean;
}

export interface SiteScriptsConfig {
  sites: SiteScriptRule[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BB_DIR = path.join(os.homedir(), ".bb-browser");
const CONFIG_PATH = path.join(BB_DIR, "site-scripts.json");
const SCRIPTS_DIR = path.join(BB_DIR, "scripts");
const CONFIG_CACHE_TTL_MS = 5_000;

// ---------------------------------------------------------------------------
// Config loading (with mtime-based cache)
// ---------------------------------------------------------------------------

let cachedConfig: SiteScriptsConfig | null = null;
let cachedConfigMtime = 0;
let cachedConfigCheckTime = 0;

export function loadSiteScriptsConfig(): SiteScriptsConfig {
  const now = Date.now();

  // Skip fs.stat if we checked recently
  if (cachedConfig && now - cachedConfigCheckTime < CONFIG_CACHE_TTL_MS) {
    return cachedConfig;
  }

  try {
    const stat = fs.statSync(CONFIG_PATH);
    const mtime = stat.mtimeMs;
    cachedConfigCheckTime = now;

    if (cachedConfig && mtime === cachedConfigMtime) {
      return cachedConfig;
    }

    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);

    if (!parsed || !Array.isArray(parsed.sites)) {
      cachedConfig = { sites: [] };
    } else {
      cachedConfig = {
        sites: parsed.sites.filter(
          (s: unknown): s is SiteScriptRule =>
            typeof s === "object" &&
            s !== null &&
            typeof (s as SiteScriptRule).match === "string" &&
            Array.isArray((s as SiteScriptRule).scripts) &&
            typeof (s as SiteScriptRule).reuseTab === "boolean",
        ),
      };
    }
    cachedConfigMtime = mtime;
    return cachedConfig;
  } catch {
    // File missing or unreadable — return empty config
    cachedConfig = { sites: [] };
    cachedConfigCheckTime = now;
    return cachedConfig;
  }
}

/** Reset config cache (for testing). */
export function resetConfigCache(): void {
  cachedConfig = null;
  cachedConfigMtime = 0;
  cachedConfigCheckTime = 0;
}

// ---------------------------------------------------------------------------
// URL matching
// ---------------------------------------------------------------------------

/**
 * Match a URL against a pattern string.
 *
 * Pattern format: `protocol://host/path-glob`
 * - Host is matched exactly
 * - Path supports `*` (single path segment) and `**` (any number of segments)
 *
 * Examples:
 *   "https://mail.google.com/\*\*" matches any path on mail.google.com
 *   "https://github.com/OWNER/pull/ID" with wildcards matches owner/pull/id
 */
export function matchUrlPattern(url: string, pattern: string): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }

  let parsedPattern: URL;
  try {
    // Replace wildcards temporarily to parse as URL
    const sanitized = pattern
      .replace(/\*\*/g, "__DOUBLE_STAR__")
      .replace(/\*/g, "__SINGLE_STAR__");
    parsedPattern = new URL(sanitized);
  } catch {
    return false;
  }

  // Protocol must match
  if (parsedUrl.protocol !== parsedPattern.protocol) {
    return false;
  }

  // Host must match exactly
  const patternHost = parsedPattern.hostname
    .replace(/__DOUBLE_STAR__/g, "**")
    .replace(/__SINGLE_STAR__/g, "*");
  if (parsedUrl.hostname !== patternHost) {
    return false;
  }

  // Path matching with wildcards
  const patternPath = parsedPattern.pathname
    .replace(/__DOUBLE_STAR__/g, "**")
    .replace(/__SINGLE_STAR__/g, "*");

  return matchPath(parsedUrl.pathname, patternPath);
}

/**
 * Match a URL path against a glob pattern.
 * `*` matches a single segment, `**` matches any number of segments.
 */
function matchPath(urlPath: string, patternPath: string): boolean {
  const urlSegments = urlPath.split("/").filter(Boolean);
  const patternSegments = patternPath.split("/").filter(Boolean);

  let ui = 0;
  let pi = 0;

  while (pi < patternSegments.length) {
    const ps = patternSegments[pi];

    if (ps === "**") {
      // If ** is the last pattern segment, it matches everything remaining
      if (pi === patternSegments.length - 1) {
        return true;
      }
      // Try matching the rest of the pattern against every possible position
      for (let skip = ui; skip <= urlSegments.length; skip++) {
        if (matchPath(
          "/" + urlSegments.slice(skip).join("/"),
          "/" + patternSegments.slice(pi + 1).join("/"),
        )) {
          return true;
        }
      }
      return false;
    }

    if (ui >= urlSegments.length) {
      return false;
    }

    if (ps === "*") {
      // Single wildcard matches any one segment
      ui++;
      pi++;
      continue;
    }

    // Exact match
    if (urlSegments[ui] !== ps) {
      return false;
    }

    ui++;
    pi++;
  }

  return ui === urlSegments.length;
}

/**
 * Find the first matching rule for a given URL. Returns null if no match.
 */
export function matchUrl(url: string, config: SiteScriptsConfig): SiteScriptRule | null {
  for (const rule of config.sites) {
    if (matchUrlPattern(url, rule.match)) {
      return rule;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Script loading
// ---------------------------------------------------------------------------

const scriptCache = new Map<string, string>();

/**
 * Load a user script from ~/.bb-browser/scripts/<name>.
 * Rejects path traversal attempts.
 */
export function loadUserScript(scriptName: string): string {
  // Security: reject path traversal and absolute paths
  if (
    scriptName.includes("..") ||
    path.isAbsolute(scriptName) ||
    scriptName.includes("\0")
  ) {
    throw new Error(`Invalid script name: ${scriptName}`);
  }

  const cached = scriptCache.get(scriptName);
  if (cached) return cached;

  const scriptPath = path.join(SCRIPTS_DIR, scriptName);

  // Verify the resolved path is still within SCRIPTS_DIR
  const resolved = path.resolve(scriptPath);
  if (!resolved.startsWith(SCRIPTS_DIR + path.sep) && resolved !== SCRIPTS_DIR) {
    throw new Error(`Invalid script name: ${scriptName}`);
  }

  const content = fs.readFileSync(scriptPath, "utf-8");
  scriptCache.set(scriptName, content);
  return content;
}

/** Reset script cache (for testing). */
export function resetScriptCache(): void {
  scriptCache.clear();
}
