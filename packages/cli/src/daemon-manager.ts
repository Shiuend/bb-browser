/**
 * Daemon manager - spawn, health-check, and communicate with the daemon process
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "@bb-browser/shared";
import { DAEMON_PORT, COMMAND_TIMEOUT } from "@bb-browser/shared";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DAEMON_DIR = path.join(os.homedir(), ".bb-browser");
const TOKEN_FILE = path.join(DAEMON_DIR, "daemon.token");

// ---------------------------------------------------------------------------
// Cached state
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;
let daemonReady = false;

// ---------------------------------------------------------------------------
// Low-level HTTP helpers
// ---------------------------------------------------------------------------

function httpJson<T>(
  method: "GET" | "POST",
  urlPath: string,
  token: string,
  body?: unknown,
  timeout = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = httpRequest(
      {
        hostname: "localhost",
        port: DAEMON_PORT,
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Daemon HTTP ${res.statusCode}: ${raw}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            reject(new Error(`Invalid JSON from daemon: ${raw}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Daemon request timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

async function readToken(): Promise<string | null> {
  try {
    return (await readFile(TOKEN_FILE, "utf8")).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getDaemonPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = dirname(currentFile);
  const sameDirPath = resolve(currentDir, "daemon.js");
  if (existsSync(sameDirPath)) {
    return sameDirPath;
  }
  return resolve(currentDir, "../../daemon/dist/index.js");
}

/**
 * Ensure the daemon is running and ready to accept commands.
 * - Reads token from ~/.bb-browser/daemon.token
 * - Checks health via GET /status
 * - If not running, spawns daemon process (detached) and waits for health
 */
export async function ensureDaemon(): Promise<void> {
  if (daemonReady && cachedToken) {
    // Quick re-check: is it still alive?
    try {
      await httpJson<{ running: boolean }>("GET", "/status", cachedToken, undefined, 2000);
      return;
    } catch {
      daemonReady = false;
      cachedToken = null;
    }
  }

  // Try reading existing token and checking if daemon is alive
  let token = await readToken();
  if (token) {
    try {
      const status = await httpJson<{ running?: boolean }>("GET", "/status", token, undefined, 2000);
      if (status.running) {
        cachedToken = token;
        daemonReady = true;
        return;
      }
    } catch {
      // Daemon not running — fall through to spawn
    }
  }

  // Spawn daemon process
  const daemonPath = getDaemonPath();
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for daemon to become healthy (up to 15 seconds — daemon may need to launch Chrome)
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    // Re-read token each iteration (daemon writes it on startup)
    token = await readToken();
    if (!token) continue;
    try {
      const status = await httpJson<{ running?: boolean }>("GET", "/status", token, undefined, 2000);
      if (status.running) {
        cachedToken = token;
        daemonReady = true;
        return;
      }
    } catch {
      // Not ready yet
    }
  }

  throw new Error(
    "bb-browser: Daemon did not start in time.\n\nMake sure Chrome is installed, then try again.",
  );
}

/**
 * Send a command to the daemon via POST /command.
 */
export async function daemonCommand(request: Request): Promise<Response> {
  if (!cachedToken) {
    cachedToken = await readToken();
  }
  if (!cachedToken) {
    throw new Error("No daemon token found. Is the daemon running?");
  }
  return httpJson<Response>("POST", "/command", cachedToken, request, COMMAND_TIMEOUT);
}

/**
 * Stop the daemon via POST /shutdown.
 */
export async function stopDaemon(): Promise<boolean> {
  const token = cachedToken ?? (await readToken());
  if (!token) return false;
  try {
    await httpJson("POST", "/shutdown", token);
    daemonReady = false;
    cachedToken = null;
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if daemon is running by querying GET /status.
 */
export async function isDaemonRunning(): Promise<boolean> {
  const token = cachedToken ?? (await readToken());
  if (!token) return false;
  try {
    const status = await httpJson<{ running?: boolean }>("GET", "/status", token, undefined, 2000);
    return status.running === true;
  } catch {
    return false;
  }
}

/**
 * Get full daemon status (for the status command).
 */
export async function getDaemonStatus(): Promise<Record<string, unknown> | null> {
  const token = cachedToken ?? (await readToken());
  if (!token) return null;
  try {
    return await httpJson<Record<string, unknown>>("GET", "/status", token, undefined, 2000);
  } catch {
    return null;
  }
}

/**
 * Legacy alias for backward compatibility.
 * Commands that import ensureDaemonRunning will continue to work.
 */
export const ensureDaemonRunning = ensureDaemon;
