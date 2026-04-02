import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  matchUrlPattern,
  matchUrl,
  resetConfigCache,
  resetScriptCache,
  type SiteScriptsConfig,
} from "../site-scripts.js";
import { TabStateManager } from "../tab-state.js";

// ---------------------------------------------------------------------------
// URL pattern matching
// ---------------------------------------------------------------------------

describe("matchUrlPattern", () => {
  it("matches exact path", () => {
    assert.ok(matchUrlPattern("https://example.com/page", "https://example.com/page"));
  });

  it("matches ** wildcard (any path)", () => {
    assert.ok(matchUrlPattern("https://mail.google.com/inbox", "https://mail.google.com/**"));
    assert.ok(matchUrlPattern("https://mail.google.com/a/b/c", "https://mail.google.com/**"));
    assert.ok(matchUrlPattern("https://mail.google.com/", "https://mail.google.com/**"));
  });

  it("matches * wildcard (single segment)", () => {
    assert.ok(matchUrlPattern("https://github.com/user/pull/123", "https://github.com/*/pull/*"));
    assert.ok(!matchUrlPattern("https://github.com/user/a/pull/123", "https://github.com/*/pull/*"));
  });

  it("rejects protocol mismatch", () => {
    assert.ok(!matchUrlPattern("http://example.com/page", "https://example.com/page"));
  });

  it("rejects host mismatch", () => {
    assert.ok(!matchUrlPattern("https://other.com/page", "https://example.com/page"));
  });

  it("rejects path mismatch", () => {
    assert.ok(!matchUrlPattern("https://example.com/other", "https://example.com/page"));
  });

  it("handles root path with **", () => {
    assert.ok(matchUrlPattern("https://example.com/", "https://example.com/**"));
    assert.ok(matchUrlPattern("https://example.com", "https://example.com/**"));
  });

  it("handles invalid URL gracefully", () => {
    assert.ok(!matchUrlPattern("not-a-url", "https://example.com/**"));
  });

  it("handles invalid pattern gracefully", () => {
    assert.ok(!matchUrlPattern("https://example.com/page", "not-a-pattern"));
  });

  it("matches pattern without path", () => {
    assert.ok(matchUrlPattern("https://example.com/", "https://example.com/"));
    assert.ok(matchUrlPattern("https://example.com", "https://example.com/"));
  });
});

// ---------------------------------------------------------------------------
// matchUrl (first-match priority)
// ---------------------------------------------------------------------------

describe("matchUrl", () => {
  const config: SiteScriptsConfig = {
    sites: [
      { match: "https://mail.google.com/**", scripts: ["gmail.js"], reuseTab: true },
      { match: "https://github.com/*/pull/*", scripts: ["pr.js"], reuseTab: true },
      { match: "https://github.com/**", scripts: ["github.js"], reuseTab: false },
    ],
  };

  it("returns first matching rule", () => {
    const rule = matchUrl("https://mail.google.com/inbox", config);
    assert.ok(rule);
    assert.deepEqual(rule.scripts, ["gmail.js"]);
  });

  it("returns null when no match", () => {
    const rule = matchUrl("https://other.com/page", config);
    assert.equal(rule, null);
  });

  it("respects first-match priority", () => {
    // github.com/user/pull/1 matches both rule 2 and rule 3; should return rule 2
    const rule = matchUrl("https://github.com/user/pull/1", config);
    assert.ok(rule);
    assert.deepEqual(rule.scripts, ["pr.js"]);
  });

  it("falls through to less specific rule", () => {
    // github.com/user/issues matches only rule 3
    const rule = matchUrl("https://github.com/user/issues", config);
    assert.ok(rule);
    assert.deepEqual(rule.scripts, ["github.js"]);
  });

  it("returns null for empty config", () => {
    const rule = matchUrl("https://example.com/", { sites: [] });
    assert.equal(rule, null);
  });
});

// ---------------------------------------------------------------------------
// TabStateManager site-tab binding
// ---------------------------------------------------------------------------

describe("TabStateManager site-tab binding", () => {
  it("bindSiteTab and getSiteTab round-trip", () => {
    const mgr = new TabStateManager();
    mgr.bindSiteTab("https://example.com/**", "target-1");
    assert.equal(mgr.getSiteTab("https://example.com/**"), "target-1");
  });

  it("getSiteTab returns undefined for unbound pattern", () => {
    const mgr = new TabStateManager();
    assert.equal(mgr.getSiteTab("https://example.com/**"), undefined);
  });

  it("removeTab clears site binding", () => {
    const mgr = new TabStateManager();
    const tab = mgr.addTab("target-1");
    mgr.bindSiteTab("https://example.com/**", "target-1");
    assert.equal(mgr.getSiteTab("https://example.com/**"), "target-1");

    mgr.removeTab("target-1");
    assert.equal(mgr.getSiteTab("https://example.com/**"), undefined);
  });

  it("unbindSiteTab is a no-op for unknown targetId", () => {
    const mgr = new TabStateManager();
    mgr.bindSiteTab("https://example.com/**", "target-1");
    mgr.unbindSiteTab("target-999");
    assert.equal(mgr.getSiteTab("https://example.com/**"), "target-1");
  });

  it("overwriting binding with new targetId", () => {
    const mgr = new TabStateManager();
    mgr.bindSiteTab("https://example.com/**", "target-1");
    mgr.bindSiteTab("https://example.com/**", "target-2");
    assert.equal(mgr.getSiteTab("https://example.com/**"), "target-2");
  });
});

// ---------------------------------------------------------------------------
// TabState.pendingNavigationUrl
// ---------------------------------------------------------------------------

describe("TabState.pendingNavigationUrl", () => {
  it("defaults to null", () => {
    const mgr = new TabStateManager();
    const tab = mgr.addTab("target-1");
    assert.equal(tab.pendingNavigationUrl, null);
  });

  it("can be set and read", () => {
    const mgr = new TabStateManager();
    const tab = mgr.addTab("target-1");
    tab.pendingNavigationUrl = "https://example.com/page";
    assert.equal(tab.pendingNavigationUrl, "https://example.com/page");
  });

  it("can be cleared", () => {
    const mgr = new TabStateManager();
    const tab = mgr.addTab("target-1");
    tab.pendingNavigationUrl = "https://example.com/page";
    tab.pendingNavigationUrl = null;
    assert.equal(tab.pendingNavigationUrl, null);
  });
});
