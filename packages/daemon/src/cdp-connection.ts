/**
 * CdpConnection — manages the browser-level WebSocket to Chrome DevTools
 * Protocol. Handles target discovery, auto-attach, session multiplexing,
 * and routes per-target session events to the TabStateManager.
 *
 * Merged from cli/cdp-client.ts (connection management) and
 * cli/cdp-monitor.ts (persistent connection + event listening).
 */

import { request as httpRequest } from "node:http";
import WebSocket from "ws";
import { TabStateManager } from "./tab-state.js";
import { loadSiteScriptsConfig, matchUrl, loadUserScript } from "./site-scripts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  method: string;
}

export interface CdpTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${res.statusCode ?? 500}: ${raw}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function connectWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  );
}

// ---------------------------------------------------------------------------
// CdpConnection
// ---------------------------------------------------------------------------

export class CdpConnection {
  private socket: WebSocket | null = null;
  private pending = new Map<number, PendingCommand>();
  private nextId = 1;

  /** targetId -> sessionId (flat-mode) */
  private sessions = new Map<string, string>();
  /** sessionId -> targetId */
  private attachedTargets = new Map<string, string>();

  readonly host: string;
  readonly port: number;
  readonly tabManager: TabStateManager;

  /** Current (most recently selected) target ID. */
  currentTargetId: string | undefined;

  private connectionPromise: Promise<void> | null = null;
  private _connected = false;

  /** Resolvers for commands queued before CDP is ready. */
  private readyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  /** Per-tab debounce timers for site-script injection. */
  private injectionDebounce = new Map<string, ReturnType<typeof setTimeout>>();

  /** Per-tab auto-refresh timers (setTimeout-chained). */
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(host: string, port: number, tabManager: TabStateManager) {
    this.host = host;
    this.port = port;
    this.tabManager = tabManager;
  }

  get connected(): boolean {
    return this._connected && this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Connect to Chrome's browser-level WebSocket endpoint.
   * Idempotent — returns immediately if already connected.
   */
  async connect(): Promise<void> {
    if (this._connected) return;
    if (this.connectionPromise) return this.connectionPromise;

    this.connectionPromise = this.doConnect();
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    const versionData = (await fetchJson(
      `http://${this.host}:${this.port}/json/version`,
    )) as JsonObject;
    const wsUrl = versionData.webSocketDebuggerUrl;
    if (typeof wsUrl !== "string" || !wsUrl) {
      throw new Error("CDP endpoint missing webSocketDebuggerUrl");
    }

    const ws = await connectWebSocket(wsUrl);
    this.socket = ws;
    this._connected = true;
    this.setupListeners(ws);

    // Discover + auto-attach existing page targets
    await this.browserCommand("Target.setDiscoverTargets", { discover: true });
    const result = await this.browserCommand<{
      targetInfos: Array<{ targetId: string; type: string; title: string; url: string }>;
    }>("Target.getTargets");

    const pages = (result.targetInfos || []).filter((t) => t.type === "page");
    for (const page of pages) {
      await this.attachAndEnable(page.targetId).catch(() => {});
    }

    // Notify any waiters that CDP is ready
    for (const waiter of this.readyWaiters) {
      waiter.resolve();
    }
    this.readyWaiters = [];
  }

  /** Wait until CDP connection is established (for two-phase startup). */
  waitUntilReady(): Promise<void> {
    if (this._connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  /** Gracefully close the CDP connection. */
  disconnect(): void {
    this.stopAllAutoRefresh();

    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
    }
    this.socket = null;
    this._connected = false;

    for (const p of this.pending.values()) {
      p.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();

    // Reject any waiters
    for (const waiter of this.readyWaiters) {
      waiter.reject(new Error("CDP connection closed before ready"));
    }
    this.readyWaiters = [];
  }

  // ---------------------------------------------------------------------------
  // WebSocket message handling
  // ---------------------------------------------------------------------------

  private setupListeners(ws: WebSocket): void {
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as JsonObject;

      // Response to a browser-level command
      if (typeof message.id === "number") {
        const p = this.pending.get(message.id);
        if (!p) return;
        this.pending.delete(message.id);
        if (message.error) {
          p.reject(
            new Error(
              `${p.method}: ${(message.error as JsonObject).message ?? "Unknown CDP error"}`,
            ),
          );
        } else {
          p.resolve(message.result);
        }
        return;
      }

      // Flat-mode attach
      if (message.method === "Target.attachedToTarget") {
        const params = message.params as JsonObject;
        const sessionId = params.sessionId;
        const targetInfo = params.targetInfo as JsonObject;
        if (typeof sessionId === "string" && typeof targetInfo?.targetId === "string") {
          this.sessions.set(targetInfo.targetId, sessionId);
          this.attachedTargets.set(sessionId, targetInfo.targetId);
        }
        return;
      }

      if (message.method === "Target.detachedFromTarget") {
        const params = message.params as JsonObject;
        const sessionId = params.sessionId;
        if (typeof sessionId === "string") {
          const targetId = this.attachedTargets.get(sessionId);
          if (targetId) {
            this.sessions.delete(targetId);
            this.attachedTargets.delete(sessionId);
            this.tabManager.removeTab(targetId);
            if (this.currentTargetId === targetId) {
              this.currentTargetId = undefined;
            }
          }
        }
        return;
      }

      // New target auto-attach
      if (message.method === "Target.targetCreated") {
        const params = message.params as JsonObject;
        const targetInfo = params.targetInfo as JsonObject;
        if (targetInfo?.type === "page" && typeof targetInfo.targetId === "string") {
          this.attachAndEnable(targetInfo.targetId).catch(() => {});
        }
        return;
      }

      if (message.method === "Target.targetDestroyed") {
        const params = message.params as JsonObject;
        const targetId = params.targetId;
        if (typeof targetId === "string") {
          this.stopAutoRefresh(targetId);
          const sessionId = this.sessions.get(targetId);
          if (sessionId) {
            this.sessions.delete(targetId);
            this.attachedTargets.delete(sessionId);
          }
          this.tabManager.removeTab(targetId);
          if (this.currentTargetId === targetId) {
            this.currentTargetId = undefined;
          }
        }
        return;
      }

      // Flat protocol: session events carry sessionId directly
      if (typeof message.sessionId === "string" && typeof message.method === "string") {
        const targetId = this.attachedTargets.get(message.sessionId as string);
        if (targetId) {
          this.handleSessionEvent(targetId, message).catch(() => {});
        }
      }
    });

    ws.on("close", () => {
      this._connected = false;
      this.socket = null;
      for (const p of this.pending.values()) {
        p.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });

    ws.on("error", () => {});
  }

  // ---------------------------------------------------------------------------
  // Session event routing (network, console, errors, dialog)
  // ---------------------------------------------------------------------------

  private async handleSessionEvent(targetId: string, event: JsonObject): Promise<void> {
    const method = event.method;
    const params = (event.params ?? {}) as JsonObject;
    if (typeof method !== "string") return;

    const tab = this.tabManager.getTab(targetId);
    if (!tab) return;

    // Dialog handling
    if (method === "Page.javascriptDialogOpening") {
      if (tab.dialogHandler) {
        await this.sessionCommand(targetId, "Page.handleJavaScriptDialog", {
          accept: tab.dialogHandler.accept,
          ...(tab.dialogHandler.promptText !== undefined
            ? { promptText: tab.dialogHandler.promptText }
            : {}),
        });
      }
      return;
    }

    // Navigation events — site-script auto-injection
    if (method === "Page.frameNavigated") {
      const frame = params.frame as JsonObject | undefined;
      if (!frame) return;
      // Only process main frame navigations (no parentId)
      if (frame.parentId) return;
      const url = typeof frame.url === "string" ? frame.url : "";
      const loaderId = typeof frame.loaderId === "string" ? frame.loaderId : null;
      if (url) {
        tab.pendingNavigationUrl = url;
        // Clear the injection guard when:
        // 1. Navigating to a different URL, OR
        // 2. Same URL but a new loaderId (real page reload — e.g. user pressed F5)
        // This preserves dedup for duplicate frameNavigated events within the
        // same navigation (e.g. Turbo restores) while allowing re-injection
        // after genuine full-page reloads that wipe the JS context.
        const isNewLoad = loaderId !== null && loaderId !== tab.lastLoaderId;
        if (url !== tab.lastInjectedUrl || isNewLoad) {
          tab.lastInjectedUrl = null;
        }
        tab.lastLoaderId = loaderId;
      }
      return;
    }

    if (method === "Page.domContentEventFired") {
      const url = tab.pendingNavigationUrl;
      if (url) {
        tab.pendingNavigationUrl = null;
        this.scheduleSiteScriptInjection(targetId, url);
      }
      return;
    }

    if (method === "Page.navigatedWithinDocument") {
      // SPA pushState/replaceState — DOM is already ready
      const url = typeof params.url === "string" ? params.url : "";
      if (url) {
        this.scheduleSiteScriptInjection(targetId, url);
      }
      return;
    }

    // Network events
    if (method === "Network.requestWillBeSent") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      const request = params.request as JsonObject | undefined;
      if (!requestId || !request) return;
      tab.addNetworkRequest(requestId, {
        url: String(request.url ?? ""),
        method: String(request.method ?? "GET"),
        type: String(params.type ?? "Other"),
        timestamp: Math.round(Number(params.timestamp ?? Date.now()) * 1000),
        requestHeaders: normalizeHeaders(request.headers),
        requestBody: typeof request.postData === "string" ? request.postData : undefined,
      });
      return;
    }

    if (method === "Network.responseReceived") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      const response = params.response as JsonObject | undefined;
      if (!requestId || !response) return;
      tab.updateNetworkResponse(requestId, {
        status: typeof response.status === "number" ? response.status : undefined,
        statusText: typeof response.statusText === "string" ? response.statusText : undefined,
        responseHeaders: normalizeHeaders(response.headers),
        mimeType: typeof response.mimeType === "string" ? response.mimeType : undefined,
      });
      return;
    }

    if (method === "Network.loadingFailed") {
      const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
      if (!requestId) return;
      tab.updateNetworkFailure(
        requestId,
        typeof params.errorText === "string" ? params.errorText : "Unknown error",
      );
      return;
    }

    // Console events
    if (method === "Runtime.consoleAPICalled") {
      const type = String(params.type ?? "log");
      const args = Array.isArray(params.args) ? (params.args as JsonObject[]) : [];
      const text = args
        .map((arg) => {
          if (typeof arg.value === "string") return arg.value;
          if (arg.value !== undefined) return String(arg.value);
          if (typeof arg.description === "string") return arg.description;
          return "";
        })
        .filter(Boolean)
        .join(" ");
      const stack = params.stackTrace as JsonObject | undefined;
      const firstCallFrame = Array.isArray(stack?.callFrames)
        ? (stack?.callFrames[0] as JsonObject | undefined)
        : undefined;
      // Chrome CDP sends "warning" for console.warn(); normalize it
      const consoleTypeMap: Record<string, string> = { warning: "warn" };
      const normalizedType = consoleTypeMap[type] || type;
      tab.addConsoleMessage({
        type: ["log", "info", "warn", "error", "debug"].includes(normalizedType)
          ? (normalizedType as "log" | "info" | "warn" | "error" | "debug")
          : "log",
        text,
        timestamp: Math.round(Number(params.timestamp ?? Date.now())),
        url:
          typeof firstCallFrame?.url === "string" ? firstCallFrame.url : undefined,
        lineNumber:
          typeof firstCallFrame?.lineNumber === "number"
            ? firstCallFrame.lineNumber
            : undefined,
      });
      return;
    }

    // JS Error events
    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as JsonObject | undefined;
      if (!details) return;
      const exception = details.exception as JsonObject | undefined;
      const stackTrace = details.stackTrace as JsonObject | undefined;
      const callFrames = Array.isArray(stackTrace?.callFrames)
        ? (stackTrace.callFrames as JsonObject[])
        : [];
      tab.addJSError({
        message:
          typeof exception?.description === "string"
            ? exception.description
            : String(details.text ?? "JavaScript exception"),
        url:
          typeof details.url === "string"
            ? details.url
            : typeof callFrames[0]?.url === "string"
              ? String(callFrames[0].url)
              : undefined,
        lineNumber:
          typeof details.lineNumber === "number" ? details.lineNumber : undefined,
        columnNumber:
          typeof details.columnNumber === "number" ? details.columnNumber : undefined,
        stackTrace:
          callFrames.length > 0
            ? callFrames
                .map(
                  (frame) =>
                    `${String(frame.functionName ?? "<anonymous>")} (${String(frame.url ?? "")}:${String(frame.lineNumber ?? 0)}:${String(frame.columnNumber ?? 0)})`,
                )
                .join("\n")
            : undefined,
        timestamp: Date.now(),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Site-script auto-injection
  // ---------------------------------------------------------------------------

  /** Schedule site-script injection with debounce to handle redirect chains. */
  private scheduleSiteScriptInjection(targetId: string, url: string): void {
    const existing = this.injectionDebounce.get(targetId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.injectionDebounce.delete(targetId);
      this.injectSiteScripts(targetId, url).catch(() => {
        // Silently ignore — tab may have been destroyed
      });
    }, 100);
    this.injectionDebounce.set(targetId, timer);
  }

  /** Load site-scripts config, match URL, and inject any matching scripts. */
  private async injectSiteScripts(targetId: string, url: string): Promise<void> {
    const tab = this.tabManager.getTab(targetId);
    if (tab?.lastInjectedUrl === url) {
      console.log(`[auto-refresh] skip inject (same URL): ${url}`);
      return;
    }

    const config = loadSiteScriptsConfig();
    const rule = matchUrl(url, config);
    if (!rule) {
      console.log(`[auto-refresh] no matching rule for: ${url}`);
      this.stopAutoRefresh(targetId);
      return;
    }

    // Bind tab for reuse if configured
    if (rule.reuseTab) {
      this.tabManager.bindSiteTab(rule.match, targetId);
    }

    // Mark this URL as injected before running scripts
    if (tab) tab.lastInjectedUrl = url;

    // Inject each script
    for (const scriptName of rule.scripts) {
      try {
        const script = loadUserScript(scriptName);
        const expression = `(() => { ${script} })()`;
        await this.evaluate(targetId, expression);
      } catch {
        // Script load or injection failure — log but don't break
      }
    }

    // Schedule auto-refresh if configured (chained setTimeout)
    if (rule.refreshInterval && rule.refreshInterval > 0) {
      console.log(`[auto-refresh] scheduling ${rule.refreshInterval}ms for: ${url}`);
      this.scheduleAutoRefresh(targetId, rule.refreshInterval);
    } else {
      this.stopAutoRefresh(targetId);
    }
  }

  /**
   * Schedule the next auto-refresh for a tab after `intervalMs`.
   * Uses chained setTimeout (not setInterval) so the next reload only
   * fires after the current page has fully loaded and scripts injected.
   */
  private scheduleAutoRefresh(targetId: string, intervalMs: number): void {
    this.stopAutoRefresh(targetId);
    const timer = setTimeout(async () => {
      this.refreshTimers.delete(targetId);
      try {
        // Clear the injection guard so scripts re-inject on the same URL
        const tab = this.tabManager.getTab(targetId);
        if (tab) tab.lastInjectedUrl = null;
        console.log(`[auto-refresh] firing Page.reload for ${targetId}`);
        await this.sessionCommand(targetId, "Page.reload", { ignoreCache: false });
        // After reload, Page.domContentEventFired will fire,
        // which triggers injectSiteScripts, which calls scheduleAutoRefresh again.
      } catch (err) {
        console.log(`[auto-refresh] reload failed for ${targetId}:`, err);
        // Tab was destroyed or CDP disconnected — stop the chain
      }
    }, intervalMs);
    this.refreshTimers.set(targetId, timer);
  }

  /** Cancel a pending auto-refresh timer for a tab. */
  private stopAutoRefresh(targetId: string): void {
    const timer = this.refreshTimers.get(targetId);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(targetId);
    }
  }

  /** Cancel all pending auto-refresh timers. */
  private stopAllAutoRefresh(): void {
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
  }

  // ---------------------------------------------------------------------------
  // Target management
  // ---------------------------------------------------------------------------

  /** Attach to a target and enable required CDP domains. */
  async attachAndEnable(targetId: string): Promise<string> {
    if (this.sessions.has(targetId)) {
      // Already attached — register tab state if not present
      this.tabManager.addTab(targetId);
      return this.sessions.get(targetId)!;
    }

    const result = await this.browserCommand<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    this.sessions.set(targetId, result.sessionId);
    this.attachedTargets.set(result.sessionId, targetId);

    // Register in tab state manager
    this.tabManager.addTab(targetId);

    // Enable domains
    await this.sessionCommand(targetId, "Page.enable").catch(() => {});
    await this.sessionCommand(targetId, "Runtime.enable").catch(() => {});
    await this.sessionCommand(targetId, "Network.enable").catch(() => {});
    await this.sessionCommand(targetId, "DOM.enable").catch(() => {});
    await this.sessionCommand(targetId, "Accessibility.enable").catch(() => {});

    return result.sessionId;
  }

  /** Get all targets via CDP Target.getTargets. */
  async getTargets(): Promise<CdpTargetInfo[]> {
    const result = await this.browserCommand<{
      targetInfos: Array<{
        targetId: string;
        type: string;
        title: string;
        url: string;
      }>;
    }>("Target.getTargets");

    return (result.targetInfos || []).map((t) => ({
      id: t.targetId,
      type: t.type,
      title: t.title,
      url: t.url,
    }));
  }

  /**
   * Ensure we have a valid page target and return it. Supports resolution by:
   *   - short ID string
   *   - full target ID string
   *   - numeric index
   *   - undefined (use currentTargetId or first page)
   */
  async ensurePageTarget(tabRef?: string | number): Promise<CdpTargetInfo> {
    const targets = (await this.getTargets()).filter((t) => t.type === "page");
    if (targets.length === 0) throw new Error("No page target found");

    let target: CdpTargetInfo | undefined;

    if (typeof tabRef === "string") {
      // Try short ID first
      const resolvedTargetId = this.tabManager.resolveShortId(tabRef);
      if (resolvedTargetId) {
        target = targets.find((t) => t.id === resolvedTargetId);
      }
      // Then try full target ID
      if (!target) {
        target = targets.find((t) => t.id === tabRef);
      }
      // Then try as numeric index
      if (!target) {
        const num = Number(tabRef);
        if (!Number.isNaN(num)) {
          target = targets[num];
        }
      }
    } else if (typeof tabRef === "number") {
      target = targets[tabRef];
    } else if (this.currentTargetId) {
      target = targets.find((t) => t.id === this.currentTargetId);
    }

    if (typeof tabRef === "string" && !target) {
      throw new Error(`Tab not found: ${tabRef}`);
    }

    target ??= targets[0];
    this.currentTargetId = target.id;
    await this.attachAndEnable(target.id);
    return target;
  }

  /** Check if a session exists for a given targetId. */
  hasSession(targetId: string): boolean {
    return this.sessions.has(targetId);
  }

  // ---------------------------------------------------------------------------
  // CDP command sending
  // ---------------------------------------------------------------------------

  /** Send a browser-level CDP command. */
  async browserCommand<T = unknown>(method: string, params: JsonObject = {}): Promise<T> {
    if (!this.socket) throw new Error("CDP not connected");
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
      });
      this.socket!.send(payload);
    });
  }

  /** Send a session-level CDP command (flat protocol). */
  async sessionCommand<T = unknown>(
    targetId: string,
    method: string,
    params: JsonObject = {},
  ): Promise<T> {
    if (!this.socket) throw new Error("CDP not connected");
    const sessionId =
      this.sessions.get(targetId) ?? (await this.attachAndEnable(targetId));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, sessionId });
    return new Promise<T>((resolve, reject) => {
      const check = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString()) as JsonObject;
        if (msg.id === id && msg.sessionId === sessionId) {
          this.socket!.off("message", check);
          if (msg.error) {
            reject(
              new Error(
                `${method}: ${(msg.error as JsonObject).message ?? "Unknown CDP error"}`,
              ),
            );
          } else {
            resolve(msg.result as T);
          }
        }
      };
      this.socket!.on("message", check);
      this.socket!.send(payload);
    });
  }

  /**
   * Send a page-scoped command. If the tab has an active iframe,
   * the frameId is injected into the params.
   */
  async pageCommand<T = unknown>(
    targetId: string,
    method: string,
    params: JsonObject = {},
  ): Promise<T> {
    const tab = this.tabManager.getTab(targetId);
    const frameId = tab?.activeFrameId;
    return this.sessionCommand<T>(
      targetId,
      method,
      frameId ? { ...params, frameId } : params,
    );
  }

  /**
   * Evaluate JavaScript expression on a target.
   */
  async evaluate<T>(
    targetId: string,
    expression: string,
    returnByValue = true,
  ): Promise<T> {
    const result = await this.sessionCommand<{
      result: { type?: string; value?: T; objectId?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(targetId, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "Runtime.evaluate failed",
      );
    }
    return (result.result.value ?? result.result) as T;
  }
}
