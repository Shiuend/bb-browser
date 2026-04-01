/**
 * bb-browser Daemon — CDP-direct backend
 *
 * Unified daemon that handles ALL browser commands (operations + observation)
 * via direct Chrome DevTools Protocol connection.
 *
 * Two-phase startup:
 *   1. HTTP server starts immediately (commands queue until CDP is ready)
 *   2. CDP connection established asynchronously
 */

import { parseArgs } from "node:util";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DAEMON_PORT, DAEMON_HOST } from "@bb-browser/shared";
import { HttpServer } from "./http-server.js";
import { CdpConnection } from "./cdp-connection.js";
import { TabStateManager } from "./tab-state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PID_FILE_PATH = "/tmp/bb-browser.pid";
const DAEMON_DIR = path.join(os.homedir(), ".bb-browser");
const TOKEN_FILE = path.join(DAEMON_DIR, "daemon.token");
const DEFAULT_CDP_PORT = 19825;
const MANAGED_BROWSER_DIR = path.join(os.homedir(), ".bb-browser", "browser");
const MANAGED_USER_DATA_DIR = path.join(MANAGED_BROWSER_DIR, "user-data");
const MANAGED_PORT_FILE = path.join(MANAGED_BROWSER_DIR, "cdp-port");

// ---------------------------------------------------------------------------
// Managed browser launch
// ---------------------------------------------------------------------------

function findBrowserExecutable(): string | null {
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "/Applications/Arc.app/Contents/MacOS/Arc",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
    return candidates.find((c) => existsSync(c)) ?? null;
  }

  if (process.platform === "linux") {
    const candidates = ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"];
    for (const candidate of candidates) {
      try {
        const resolved = execSync(`which ${candidate}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (resolved) return resolved;
      } catch {}
    }
    return null;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ...(localAppData ? [
        `${localAppData}\\Google\\Chrome Dev\\Application\\chrome.exe`,
        `${localAppData}\\Google\\Chrome SxS\\Application\\chrome.exe`,
        `${localAppData}\\Google\\Chrome Beta\\Application\\chrome.exe`,
      ] : []),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ];
    return candidates.find((c) => existsSync(c)) ?? null;
  }

  return null;
}

async function launchManagedBrowser(port: number): Promise<{ host: string; port: number } | null> {
  const executable = findBrowserExecutable();
  if (!executable) {
    return null;
  }

  mkdirSync(MANAGED_USER_DATA_DIR, { recursive: true });

  // Set profile name so the Chrome window shows "bb-browser" in the title bar
  const defaultProfileDir = path.join(MANAGED_USER_DATA_DIR, "Default");
  const prefsPath = path.join(defaultProfileDir, "Preferences");
  mkdirSync(defaultProfileDir, { recursive: true });
  try {
    let prefs: Record<string, unknown> = {};
    try { prefs = JSON.parse(readFileSync(prefsPath, "utf8")); } catch {}
    if (!(prefs.profile as Record<string, unknown>)?.name || (prefs.profile as Record<string, unknown>).name !== "bb-browser") {
      prefs.profile = { ...(prefs.profile as Record<string, unknown> || {}), name: "bb-browser" };
      writeFileSync(prefsPath, JSON.stringify(prefs), "utf8");
    }
  } catch {}

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${MANAGED_USER_DATA_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "about:blank",
  ];

  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    return null;
  }

  mkdirSync(MANAGED_BROWSER_DIR, { recursive: true });
  writeFileSync(MANAGED_PORT_FILE, String(port), "utf8");

  // Wait for Chrome to start accepting CDP connections (up to 8 seconds)
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
        if (response.ok) {
          return { host: "127.0.0.1", port };
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface DaemonOptions {
  host: string;
  port: number;
  cdpHost: string;
  cdpPort: number;
  token: string;
}

function parseOptions(): DaemonOptions {
  const { values } = parseArgs({
    allowPositionals: true,
    options: {
      host: {
        type: "string",
        short: "H",
        default: DAEMON_HOST,
      },
      port: {
        type: "string",
        short: "p",
        default: String(DAEMON_PORT),
      },
      "cdp-host": {
        type: "string",
        default: "127.0.0.1",
      },
      "cdp-port": {
        type: "string",
        default: String(DEFAULT_CDP_PORT),
      },
      token: {
        type: "string",
        default: "",
      },
      help: {
        type: "boolean",
        short: "h",
        default: false,
      },
    },
  });

  if (values.help) {
    console.error(`
bb-browser-daemon — CDP-direct backend for bb-browser

Usage:
  bb-browser-daemon [options]

Options:
  -H, --host <host>          HTTP server host (default: ${DAEMON_HOST})
  -p, --port <port>          HTTP server port (default: ${DAEMON_PORT})
      --cdp-host <host>      Chrome CDP host (default: 127.0.0.1)
      --cdp-port <port>      Chrome CDP port (default: ${DEFAULT_CDP_PORT})
      --token <token>        Bearer auth token (auto-generated if empty)
  -h, --help                 Show this help message

Endpoints:
  POST /command      Send command and get result (via CDP)
  GET  /status       Daemon health + per-tab stats
  POST /shutdown     Graceful shutdown
`);
    process.exit(0);
  }

  // Auto-generate token if not provided
  let token = values.token ?? "";
  if (!token) {
    token = randomBytes(16).toString("hex");
  }

  return {
    host: values.host ?? DAEMON_HOST,
    port: parseInt(values.port ?? String(DAEMON_PORT), 10),
    cdpHost: values["cdp-host"] ?? "127.0.0.1",
    cdpPort: parseInt(values["cdp-port"] ?? String(DEFAULT_CDP_PORT), 10),
    token,
  };
}

// ---------------------------------------------------------------------------
// PID / token file management
// ---------------------------------------------------------------------------

function writePidFile(): void {
  writeFileSync(PID_FILE_PATH, String(process.pid), "utf-8");
}

function cleanupPidFile(): void {
  if (existsSync(PID_FILE_PATH)) {
    try {
      unlinkSync(PID_FILE_PATH);
    } catch {}
  }
}

function writeTokenFile(token: string): void {
  try {
    mkdirSync(DAEMON_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch {}
}

function cleanupTokenFile(): void {
  if (existsSync(TOKEN_FILE)) {
    try {
      unlinkSync(TOKEN_FILE);
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// CDP port discovery (simplified — daemon is told the port)
// ---------------------------------------------------------------------------

async function discoverCdpPort(host: string, port: number): Promise<{ host: string; port: number }> {
  // Try connecting to the specified port first
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(`http://${host}:${port}/json/version`, {
        signal: controller.signal,
      });
      if (response.ok) {
        return { host, port };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {}

  // Try reading managed browser port file
  const managedPortFile = path.join(os.homedir(), ".bb-browser", "browser", "cdp-port");
  try {
    const rawPort = readFileSync(managedPortFile, "utf8").trim();
    const managedPort = parseInt(rawPort, 10);
    if (Number.isInteger(managedPort) && managedPort > 0) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
          const response = await fetch(`http://127.0.0.1:${managedPort}/json/version`, {
            signal: controller.signal,
          });
          if (response.ok) {
            return { host: "127.0.0.1", port: managedPort };
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {}
    }
  } catch {}

  throw new Error(
    `Cannot connect to Chrome CDP at ${host}:${port}. ` +
    `Make sure Chrome is running with --remote-debugging-port=${port}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseOptions();

  // Create tab state manager and CDP connection
  const tabManager = new TabStateManager();
  let cdpEndpoint: { host: string; port: number };

  try {
    cdpEndpoint = await discoverCdpPort(options.cdpHost, options.cdpPort);
  } catch {
    // No running Chrome found — try launching a managed browser
    console.error(
      `[Daemon] No Chrome CDP found at ${options.cdpHost}:${options.cdpPort}, launching managed browser...`,
    );
    const managed = await launchManagedBrowser(options.cdpPort);
    if (!managed) {
      console.error(
        "[Daemon] Failed to launch managed browser. Make sure Chrome is installed.",
      );
      process.exit(1);
    }
    console.error(
      `[Daemon] Managed browser started on ${managed.host}:${managed.port}`,
    );
    cdpEndpoint = managed;
  }

  const cdp = new CdpConnection(cdpEndpoint.host, cdpEndpoint.port, tabManager);

  // Graceful shutdown handler (guarded against double-call)
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("[Daemon] Shutting down...");
    cdp.disconnect();
    await httpServer.stop();
    cleanupPidFile();
    cleanupTokenFile();
    process.exit(0);
  };

  // Phase 1: Start HTTP server immediately
  const httpServer = new HttpServer({
    host: options.host,
    port: options.port,
    token: options.token,
    cdp,
    onShutdown: shutdown,
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await httpServer.start();
  writePidFile();
  writeTokenFile(options.token);

  console.error(
    `[Daemon] HTTP server listening on http://${options.host}:${options.port}`,
  );
  console.error(`[Daemon] Auth token: ${options.token}`);

  // Phase 2: Connect to CDP asynchronously
  console.error(
    `[Daemon] Connecting to Chrome CDP at ${cdpEndpoint.host}:${cdpEndpoint.port}...`,
  );

  try {
    await cdp.connect();
    const tabCount = tabManager.tabCount;
    console.error(
      `[Daemon] CDP connected, monitoring ${tabCount} tab(s)`,
    );
  } catch (error) {
    console.error(
      `[Daemon] Failed to connect to CDP: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("[Daemon] HTTP server is running, but commands will fail until CDP connects.");
  }
}

main().catch((error) => {
  console.error("[Daemon] Fatal error:", error);
  cleanupPidFile();
  cleanupTokenFile();
  process.exit(1);
});
