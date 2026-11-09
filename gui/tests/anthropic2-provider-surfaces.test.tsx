/**
 * UX-04 and UX-05 for the second Anthropic pool ("Anthropic · Pool 2", provider anthropic2).
 *
 * Pool 2 shares the account IDs, the components and the endpoints of the primary pool, so a
 * wrong predicate or a missing provider parameter would not fail loudly: it would silently
 * read or write pool A. Every case below names the provider each surface actually sent.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import { useT, type TFn } from "../src/i18n/shared";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import CatalogAccountRow from "../src/components/provider-catalog/CatalogAccountRow";
import type { OAuthAccountRow, ProviderAuthHandlers } from "../src/components/provider-workspace/types";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import { useProviderAccountPools, type Config as PoolHookConfig } from "../src/hooks/useProviderAccountPools";
import { useProvidersOAuth } from "../src/pages/use-providers-oauth";
import { buildAddModalAccountRows } from "../src/pages/providers-page-utils";
import type { OAuthAccount, OAuthStatus, ProvidersConfig } from "../src/pages/providers-shared";
import { oauthTosCopyKeys, oauthTosRisk } from "../src/oauth-tos-risk";

type Recorded = { method: string; path: string; provider: string | null; body: Record<string, unknown> | null };
type Call = unknown[];

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let host: HTMLElement;
let requests: Recorded[];
let respond: (request: Recorded) => Promise<Response>;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previousGlobals;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  requests = [];
  respond = async request => { throw new Error("unexpected " + request.method + " " + request.path); };
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
    fetch: { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      const provider = url.searchParams.get("provider") ?? (typeof body?.provider === "string" ? body.provider : null);
      const request = { method: init?.method ?? "GET", path: url.pathname, provider, body };
      requests.push(request);
      return respond(request);
    } },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  try { if (root) await act(async () => { root!.unmount(); }); }
  finally {
    root = undefined; win.close();
    for (const key of globals) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

async function render(element: ReactNode) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root ??= createRoot(host); root.render(<LanguageProvider>{element}</LanguageProvider>); });
}
async function tick() {
  await act(async () => {
    await new Promise<void>(resolve => win.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}
async function click(target: Element | null | undefined) {
  expect(target).toBeTruthy();
  await act(async () => { (target as HTMLElement).click(); });
  await tick();
  await tick();
}
function buttonsByText(label: string): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent?.trim() === label);
}
function poolToggle(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('button.toggle[aria-label="' + en["anthropicPool.title"] + '"]');
}
function grantBadges(): Array<string | null> {
  return [...host.querySelectorAll("[data-anthropic-grant-badge]")].map(node => node.getAttribute("data-anthropic-grant-badge"));
}

const POOL_A = { name: "anthropic", adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" } as unknown as WorkspaceItem;
const POOL_B = { ...POOL_A, name: "anthropic2", anthropicOAuthInstance: "anthropic2" } as unknown as WorkspaceItem;
const CUSTOM_B = { name: "anthropic2", adapter: "openai-chat", baseUrl: "https://gateway.example.test/v1", authMode: "oauth" } as unknown as WorkspaceItem;

/** Both pools hold accounts with the SAME IDs; only the pool tells them apart. */
function accounts(pool: string): OAuthAccountRow[] {
  return ["shared", "other"].map((id, index) => ({
    id, email: id + "@" + pool + ".test", active: index === 0, paused: false,
    autoSwitchThresholdOverride: null, autoSwitchThreshold: 70, effectiveAutoSwitchThreshold: 70,
  })) as OAuthAccountRow[];
}
function poolSettings(provider: string, enabled: boolean, threshold: number) {
  return { provider, kind: "anthropic", enabled, enabledEffective: enabled, autoSwitchThreshold: threshold, nativeMessages: true };
}
function grantSnapshot(provider: string, resets: number) {
  return {
    provider, accountId: "shared", eligible: true, ineligibleReason: null, atLimit: false,
    grants: [{
      id: "fixture-grant", label: "Launch reset", resetsTotal: resets, resetsLeft: resets,
      startsAt: "2026-09-22T16:00:00+00:00", endsAt: "2099-10-22T16:00:00+00:00", clears: ["five_hour", "seven_day"],
      paused: false, usableNow: true, useRequiresLimit: false, percentUsed: { five_hour: 3, seven_day: 14 },
    }],
    nextGrantId: "fixture-grant", pendingOperation: null, journalAvailable: true,
  };
}
function idOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && "id" in value ? (value as { id: unknown }).id : value;
}
function recordingHandlers(calls: Call[]): ProviderAuthHandlers {
  const record = (name: string) => (provider: string, ...args: unknown[]) => { calls.push([name, provider, ...args.map(idOf)]); };
  return {
    onLogin: record("login"), onLogout: record("logout"), onReauth: record("reauth"), onSwitchAccount: record("switch"),
    onPauseAccount: record("pause"), onRemoveAccount: record("remove"), onEditAlias: record("alias"),
    onAccountThreshold: async (provider, account, threshold) => { calls.push(["threshold", provider, account.id, threshold]); return true; },
    onAccountPoolThreshold: (provider, threshold) => { calls.push(["poolThreshold", provider, threshold]); },
    onAddApiKey: async () => true, onSwitchApiKey: record("switchKey"), onRemoveApiKey: record("removeKey"),
  };
}

test("UX-04: Pool 2 onboarding and sign-in start browser OAuth for anthropic2 and offer no CLI import", async () => {
  respond = async request => request.path === "/api/pool/settings"
    ? Response.json(poolSettings("anthropic2", false, 55))
    : Response.json(grantSnapshot("anthropic2", 1));
  const tEn = ((key: keyof typeof en) => en[key]) as unknown as TFn;
  const row = buildAddModalAccountRows({ providers: {} } as unknown as ProvidersConfig, ["anthropic2", "anthropic"], tEn)
    .find(entry => entry.id === "anthropic2");
  expect(row).toEqual({ id: "anthropic2", label: "Anthropic · Pool 2", kind: "oauth" });
  // The Providers page routes this provider through the same consent gate as the primary pool.
  expect(oauthTosRisk("anthropic2")).toBe("high");
  expect(oauthTosCopyKeys("anthropic2", "high").title).toBe("oauthTos.anthropicTitle");

  const catalogLogins: Array<[string, boolean | undefined]> = [];
  await render(<CatalogAccountRow row={row!} busyProvider={null} loginHint={null}
    onLogin={(provider, addAccount) => { catalogLogins.push([provider, addAccount]); }} />);
  await click(buttonsByText(en["modal.accountLogin"])[0]);
  expect(catalogLogins).toEqual([["anthropic2", undefined]]);

  const calls: Call[] = [];
  await render(<ProviderAuthPanel item={POOL_B} apiBase="" oauth={{ loggedIn: false }} authHandlers={recordingHandlers(calls)} />);
  await tick();
  await click(buttonsByText(en["prov.login"])[0]);
  expect(calls.filter(call => call[0] !== "poolThreshold")).toEqual([["login", "anthropic2", false]]);
  // Browser OAuth only: no file import and no CLI import control for Pool 2.
  expect(host.querySelector('input[type="file"]')).toBeNull();
  expect(buttonsByText(en["pws.cockpitImportChooseFile"])).toEqual([]);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(request => request.provider === "anthropic2")).toBe(true);
});

type AccountSet = { activeAccountId: string | null; accounts: OAuthAccount[] };
type LoginView = {
  loginOAuth: ReturnType<typeof useProvidersOAuth>["loginOAuth"];
  accountSets: Record<string, AccountSet>; oauthStatus: Record<string, OAuthStatus>; busy: string | null; notices: string[];
};
const PRIMARY_SETS: Record<string, AccountSet> = {
  anthropic: { activeAccountId: "shared", accounts: [{ id: "shared", email: "shared@anthropic.test", active: true }] },
};
const PRIMARY_STATUS: Record<string, OAuthStatus> = { anthropic: { loggedIn: true, email: "shared@anthropic.test" } };

function LoginHarness({ onView }: { onView: (view: LoginView) => void }) {
  const t = useT();
  const aliveRef = useRef(true);
  const [accountSets, setAccountSets] = useState(PRIMARY_SETS);
  const [oauthStatus, setOauthStatus] = useState(PRIMARY_STATUS);
  const [busy, setBusy] = useState<string | null>(null);
  const [, setStatus] = useState("");
  const [, setLoginInfo] = useState<{ provider: string; url?: string; instructions?: string; deviceCode?: string } | null>(null);
  const [notices, setNotices] = useState<string[]>([]);
  const { loginOAuth } = useProvidersOAuth({
    apiBase: "", t, aliveRef, accountSets, setAccountSets, setBusy, setStatus, setLoginInfo, setOauthStatus,
    notify: message => { setNotices(current => [...current, message]); },
    fetchConfig: async () => {}, fetchOauth: async () => {}, fetchAccountSets: async () => undefined,
    fetchProviderQuotas: async () => {}, bumpModelsRefresh: () => {},
  });
  useLayoutEffect(() => { onView({ loginOAuth, accountSets, oauthStatus, busy, notices }); },
    [onView, loginOAuth, accountSets, oauthStatus, busy, notices]);
  return null;
}

test("UX-04: a failed Pool 2 sign-in names only anthropic2 and leaves the primary pool untouched", async () => {
  let view!: LoginView;
  let failure: "refused" | "network" = "refused";
  respond = async request => {
    if (request.path === "/api/oauth/login") {
      if (failure === "network") throw new TypeError("connection reset");
      return Response.json({ error: "pool 2 sign-in refused" }, { status: 502 });
    }
    return Response.json({ ok: true, cancelled: true });
  };
  await render(<LoginHarness onView={next => { view = next; }} />);
  await act(async () => { await view.loginOAuth("anthropic2"); });
  expect(view.notices).toEqual(["pool 2 sign-in refused"]);
  failure = "network";
  await act(async () => { await view.loginOAuth("anthropic2", true); });
  expect(requests.map(request => [request.method, request.path, request.provider])).toEqual([
    ["POST", "/api/oauth/login", "anthropic2"],
    ["POST", "/api/oauth/login", "anthropic2"],
    ["POST", "/api/oauth/login/cancel", "anthropic2"],
  ]);
  expect(requests[1]?.body).toMatchObject({ provider: "anthropic2", addAccount: true });
  expect(view.notices).toHaveLength(2);
  expect(view.busy).toBeNull();
  // Referential identity: the primary pool's roster and status were never rewritten.
  expect(view.accountSets).toBe(PRIMARY_SETS);
  expect(view.oauthStatus).toBe(PRIMARY_STATUS);
});

test("UX-05: every Pool 2 account, pool-settings and reset-grant mutation names anthropic2", async () => {
  const calls: Call[] = [];
  respond = async request => {
    if (request.path === "/api/pool/settings") return Response.json(poolSettings("anthropic2", request.method === "PUT", 55));
    if (request.path === "/api/anthropic/reset-grants") return Response.json(grantSnapshot("anthropic2", 1));
    if (request.path === "/api/anthropic/reset-grants/consume") {
      return Response.json({ provider: "anthropic2", code: "reset", replayed: false, resetsLeft: 0 });
    }
    throw new Error("unexpected " + request.method + " " + request.path);
  };
  await render(<ProviderAuthPanel item={POOL_B} apiBase="" accounts={accounts("anthropic2")} authHandlers={recordingHandlers(calls)} />);
  await tick();
  await tick();
  expect(calls).toEqual([["poolThreshold", "anthropic2", 55]]);
  expect(grantBadges()).toEqual(["1", "1"]);

  await click(poolToggle());
  expect(poolToggle()?.getAttribute("aria-pressed")).toBe("true");
  await click(host.querySelectorAll('button[aria-label^="' + en["codexAuth.pause"] + ' — "]')[1]);
  await click(host.querySelectorAll("button.codex-account-auto-switch-toggle")[1]);
  await click(host.querySelectorAll(".pwi-auth-row-main")[1]);
  await click(buttonsByText(en["prov.editAlias"])[1]);
  await click(host.querySelectorAll(".pwi-auth-row-remove")[1]);
  await click(host.querySelector("[data-anthropic-grant-badge]"));
  await click(host.querySelector("[data-anthropic-grant-use]"));
  await click(host.querySelector("[data-anthropic-grant-confirm]"));

  expect(calls.filter(call => call[0] !== "poolThreshold")).toEqual([
    ["pause", "anthropic2", "other", true],
    ["threshold", "anthropic2", "other", 70],
    ["switch", "anthropic2", "other"],
    ["alias", "anthropic2", "oauth", "other", undefined],
    ["remove", "anthropic2", "other"],
  ]);
  expect(calls.every(call => call[1] === "anthropic2")).toBe(true);
  const sent = requests.map(request => request.method + " " + request.path);
  expect(sent).toContain("PUT /api/pool/settings");
  expect(sent).toContain("POST /api/anthropic/reset-grants/consume");
  expect(requests.find(request => request.path.endsWith("/consume"))?.body).toMatchObject({ provider: "anthropic2", accountId: "shared" });
  // No request reached an endpoint without naming Pool 2.
  expect(requests.every(request => request.provider === "anthropic2")).toBe(true);
});

test("UX-05: late Pool 2 settings and reset reads never render in the primary pool after a switch", async () => {
  const calls: Call[] = [];
  const held: Array<() => void> = [];
  respond = async request => {
    // The primary pool's legacy reset read carries no provider parameter.
    const pool = request.provider ?? "anthropic";
    const response = request.path === "/api/pool/settings"
      ? Response.json(poolSettings(pool, pool === "anthropic2", pool === "anthropic2" ? 55 : 40))
      : Response.json(grantSnapshot(pool, pool === "anthropic2" ? 3 : 1));
    if (pool !== "anthropic2") return response;
    return new Promise<Response>(resolve => { held.push(() => resolve(response)); });
  };
  await render(<ProviderAuthPanel item={POOL_B} apiBase="" accounts={accounts("anthropic2")} authHandlers={recordingHandlers(calls)} />);
  await tick();
  await tick();
  expect(held).toHaveLength(3);

  await render(<ProviderAuthPanel item={POOL_A} apiBase="" accounts={accounts("anthropic")} authHandlers={recordingHandlers(calls)} />);
  await tick();
  await tick();
  // A stalled Pool 2 read does not occupy the primary pool's read slots.
  expect(grantBadges()).toEqual(["1", "1"]);
  expect(poolToggle()?.getAttribute("aria-pressed")).toBe("false");

  await act(async () => { held.forEach(release => release()); });
  await tick();
  await tick();
  expect(grantBadges()).toEqual(["1", "1"]);
  expect(poolToggle()?.getAttribute("aria-pressed")).toBe("false");
  expect(calls).toEqual([["poolThreshold", "anthropic", 40]]);
});

for (const item of [POOL_A, POOL_B]) {
  for (const uncertain of [false, true]) {
    test(`${item.name}: pause closes the reset dialog until a click${uncertain ? " and recovers the same uncertain operation" : ""}`, async () => {
      const posts: Array<Record<string, unknown>> = [];
      let pendingOperation: Record<string, unknown> | null = null;
      respond = async request => {
        const provider = request.provider ?? "anthropic";
        if (request.path === "/api/pool/settings") return Response.json(poolSettings(provider, true, 55));
        if (request.path === "/api/anthropic/reset-grants") return Response.json({ ...grantSnapshot(provider, 1), pendingOperation });
        if (request.path.endsWith("/consume")) {
          posts.push(request.body!);
          if (posts.length === 1) {
            pendingOperation = { ...request.body, retryableUntil: Date.now() + 60_000 };
            throw new TypeError("synthetic unknown claim outcome");
          }
          pendingOperation = null;
          return Response.json({ provider, code: "reset", resetsLeft: 0 });
        }
        throw new Error("unexpected request");
      };
      const rows = accounts(item.name);
      const handlers = recordingHandlers([]);
      const panel = (roster: OAuthAccountRow[]) => <ProviderAuthPanel item={item} apiBase="" accounts={roster} authHandlers={handlers} />;
      await render(panel(rows));
      await tick();
      await tick();
      await click(host.querySelector("[data-anthropic-grant-badge]"));
      expect(host.querySelector("dialog[open]")).not.toBeNull();
      if (uncertain) {
        await click(host.querySelector("[data-anthropic-grant-use]"));
        await click(host.querySelector("[data-anthropic-grant-confirm]"));
        expect(posts).toHaveLength(1);
        expect(host.querySelector("[data-anthropic-grant-retry]")).not.toBeNull();
      }
      await render(panel(rows.map(row => row.id === "shared" ? { ...row, paused: true } : row)));
      expect(host.querySelector("dialog")).toBeNull();
      await render(panel(rows));
      await tick();
      await tick();
      expect(host.querySelector("dialog")).toBeNull();
      expect(posts).toHaveLength(uncertain ? 1 : 0);
      await click(host.querySelector("[data-anthropic-grant-badge]"));
      expect(host.querySelector("dialog[open]")).not.toBeNull();
      if (uncertain) {
        expect(host.querySelector("[data-anthropic-grant-use]")).toBeNull();
        await click(host.querySelector("[data-anthropic-grant-retry]"));
        expect(posts).toHaveLength(2);
        expect(posts[1]).toEqual(posts[0]);
      } else expect(posts).toEqual([]);
    });
  }
}

test("a reset selection is hidden outside its roster and scope without adopting an equal-ID paused row", async () => {
  respond = async request => request.path === "/api/pool/settings"
    ? Response.json(poolSettings(request.provider ?? "anthropic", true, 55))
    : Response.json(grantSnapshot(request.provider ?? "anthropic", 1));
  const handlers = recordingHandlers([]);
  await render(<ProviderAuthPanel item={POOL_A} apiBase="" accounts={accounts("anthropic")} authHandlers={handlers} />);
  await tick();
  await tick();
  await click(host.querySelector("[data-anthropic-grant-badge]"));
  await render(<ProviderAuthPanel item={POOL_A} apiBase="" accounts={accounts("anthropic").filter(row => row.id !== "shared")} authHandlers={handlers} />);
  expect(host.querySelector("dialog")).toBeNull();
  await render(<ProviderAuthPanel item={POOL_B} apiBase="" accounts={accounts("anthropic2").map(row => ({ ...row, paused: true }))} authHandlers={handlers} />);
  expect(host.querySelector("dialog")).toBeNull();
  await render(<ProviderAuthPanel item={POOL_A} apiBase="" accounts={accounts("anthropic")} authHandlers={handlers} />);
  expect(host.querySelector("dialog[open]")).not.toBeNull();
  expect(requests.filter(request => request.method === "POST")).toEqual([]);
});

test("UX-05: an unmarked custom anthropic2 row receives neither pool's settings nor reset reads", async () => {
  respond = async () => Response.json({});
  await render(<ProviderAuthPanel item={CUSTOM_B} apiBase="" accounts={accounts("custom")} authHandlers={recordingHandlers([])} />);
  await tick();
  await tick();
  expect(poolToggle()).toBeNull();
  expect(grantBadges()).toEqual([]);
  expect(requests).toEqual([]);
});

function PoolsHarness({ onPools, config = null, onNotice }: {
  onPools: (pools: ReturnType<typeof useProviderAccountPools>) => void;
  config?: PoolHookConfig | null;
  onNotice?: (message: string) => void;
}) {
  const aliveRef = useRef(true);
  const t = useT();
  const pools = useProviderAccountPools({ apiBase: "", config, aliveRef,
    t: onNotice ? (key, ...args) => t(key as keyof typeof en, args[0] as Record<string, string>) : key => key, oauthStatus: {},
    notify: message => onNotice?.(message), fetchConfig: async () => {}, fetchOauth: async () => {}, fetchProviderQuotas: async () => {},
    codexActiveNeedsReauth: false });
  useLayoutEffect(() => { onPools(pools); }, [onPools, pools]);
  return null;
}

test("UX-05: equal account IDs keep pool-keyed rosters and thresholds in the account hook", async () => {
  let pools!: ReturnType<typeof useProviderAccountPools>;
  let holdNextPool2 = true;
  let releasePool2: (() => void) | undefined;
  let pool2Override: number | null = null;
  // The fake server persists Pool 2's override, so the hook's follow-up roster refresh agrees with it.
  const roster = (pool: string) => ({ activeAccountId: "shared", accounts: accounts(pool).map(row =>
    pool === "anthropic2" && row.id === "other"
      ? { ...row, autoSwitchThresholdOverride: pool2Override, effectiveAutoSwitchThreshold: pool2Override ?? 70 }
      : row) });
  respond = async request => {
    if (request.path === "/api/oauth/accounts/auto-switch") {
      pool2Override = Number(request.body?.threshold);
      return Response.json({ autoSwitchThresholdOverride: pool2Override, autoSwitchThreshold: 70, effectiveAutoSwitchThreshold: pool2Override });
    }
    if (request.path !== "/api/oauth/accounts") throw new Error("unexpected " + request.method + " " + request.path);
    const response = Response.json(roster(request.provider ?? "missing"));
    if (request.provider !== "anthropic2" || !holdNextPool2) return response;
    holdNextPool2 = false;
    return new Promise<Response>(resolve => { releasePool2 = () => resolve(response); });
  };
  await render(<PoolsHarness onPools={next => { pools = next; }} />);
  let pending!: Promise<boolean>;
  await act(async () => { pending = pools.fetchAccountSets(["anthropic2"]); await Promise.resolve(); });
  await act(async () => { await pools.fetchAccountSets(["anthropic"]); });
  await act(async () => { releasePool2!(); await pending; });
  expect(pools.accountSets.anthropic?.accounts.map(row => row.email)).toEqual(["shared@anthropic.test", "other@anthropic.test"]);
  expect(pools.accountSets.anthropic2?.accounts.map(row => row.email)).toEqual(["shared@anthropic2.test", "other@anthropic2.test"]);

  const mutationStart = requests.length;
  const other = pools.accountSets.anthropic2!.accounts[1]!;
  await act(async () => { expect(await pools.setAccountThreshold("anthropic2", other, 25)).toBe(true); });
  await tick();
  expect(requests[mutationStart]?.body).toEqual({ provider: "anthropic2", accountId: "other", threshold: 25 });
  expect(pools.accountSets.anthropic2?.accounts[1]?.autoSwitchThresholdOverride).toBe(25);
  expect(pools.accountSets.anthropic?.accounts[1]?.autoSwitchThresholdOverride).toBeNull();

  await act(async () => { await pools.setAccountPoolThreshold("anthropic2", 60); });
  expect(pools.accountSets.anthropic?.accounts.map(row => row.autoSwitchThreshold)).toEqual([70, 70]);
  expect(requests.slice(mutationStart).every(request => request.provider === "anthropic2")).toBe(true);
});

for (const item of [POOL_A, POOL_B]) {
  for (const statusRead of ["slow", "failed", "null"] as const) {
    test(`${item.name}: a settled lost response survives pause and close with ${statusRead} GET`, async () => {
      const posts: Array<Record<string, unknown>> = [];
      const releases: Array<() => void> = [];
      let settled = false;
      let reread = false;
      let physicalClaims = 0;
      respond = async request => {
        const provider = request.provider ?? "anthropic";
        if (request.path === "/api/pool/settings") return Response.json(poolSettings(provider, true, 55));
        if (request.path === "/api/anthropic/reset-grants") {
          if (reread && statusRead === "slow") await new Promise<void>(resolve => releases.push(resolve));
          if (reread && statusRead === "failed") throw new TypeError("synthetic status failure");
          // Real settled journal rows are NOT returned by pendingAnthropicResetOperation.
          return Response.json(grantSnapshot(provider, 1));
        }
        posts.push(request.body!);
        if (!settled) {
          physicalClaims++;
          settled = true;
          throw new TypeError("the server settled the claim but its HTTP response was lost");
        }
        if (posts.length === 2) return Response.json({ error: { code: "ledger_busy" } }, { status: 503 });
        expect(posts.at(-1)).toEqual(posts[0]);
        return Response.json({ provider, code: "reset", replayed: true, resetsLeft: 1,
          operationId: request.body!.operationId });
      };
      const rows = accounts(item.name);
      const handlers = recordingHandlers([]);
      const apiBase = `http://${item.name}-${statusRead}.example.test`;
      const panel = (roster: OAuthAccountRow[]) => <ProviderAuthPanel item={item} apiBase={apiBase}
        accounts={roster} authHandlers={handlers} />;
      try {
        await render(panel(rows));
        await tick();
        await tick();
        await click(host.querySelector("[data-anthropic-grant-badge]"));
        await click(host.querySelector("[data-anthropic-grant-use]"));
        await click(host.querySelector("[data-anthropic-grant-confirm]"));
        expect(posts).toHaveLength(1);
        reread = true;
        await render(panel(rows.map(row => row.id === "shared" ? { ...row, paused: true } : row)));
        expect(host.querySelector("dialog")).toBeNull();
        await render(panel(rows));
        await tick();
        expect(host.querySelector("dialog")).toBeNull();
        expect(posts).toHaveLength(1);
        await click(host.querySelector("[data-anthropic-grant-badge]"));
        expect(host.querySelector("[data-anthropic-grant-use]")).toBeNull();
        expect(host.querySelector("[data-anthropic-grant-retry]")).not.toBeNull();
        // A preliminary refusal cannot release an earlier uncertain claim.
        await click(host.querySelector("[data-anthropic-grant-retry]"));
        expect(posts[1]).toEqual(posts[0]);
        await click(buttonsByText(en["common.close"]).at(-1));
        expect(host.querySelector("dialog")).toBeNull();
        await click(host.querySelector("[data-anthropic-grant-badge]"));
        expect(host.querySelector("[data-anthropic-grant-use]")).toBeNull();
        reread = false;
        await click(host.querySelector("[data-anthropic-grant-retry]"));
        expect(posts).toHaveLength(3);
        expect(posts[2]).toEqual(posts[0]);
        expect(physicalClaims).toBe(1);
        expect(host.querySelector("[data-anthropic-grant-retry]")).toBeNull();
      } finally {
        reread = false;
        await act(async () => { releases.forEach(release => release()); });
      }
    });
  }
  test(`${item.name}: an in-flight claim survives a full panel remount and isolates equal IDs`, async () => {
    let release!: () => void;
    const heldResponse = new Promise<void>(resolve => { release = resolve; });
    const posts: Array<Record<string, unknown>> = [];
    respond = async request => {
      const provider = request.provider ?? "anthropic";
      if (request.path === "/api/pool/settings") return Response.json(poolSettings(provider, true, 55));
      if (request.path === "/api/anthropic/reset-grants") return Response.json(grantSnapshot(provider, 1));
      posts.push(request.body!);
      await heldResponse;
      return Response.json({ provider, code: "reset", resetsLeft: 1, operationId: request.body!.operationId });
    };
    const handlers = recordingHandlers([]);
    const apiBase = `http://${item.name}-remount.example.test`;
    const panel = (key: string, scope = apiBase, pool = item) => <ProviderAuthPanel key={key} item={pool}
      apiBase={scope} accounts={accounts(pool.name)} authHandlers={handlers} />;
    try {
      await render(panel("first"));
      await tick();
      await tick();
      await click(host.querySelector("[data-anthropic-grant-badge]"));
      await click(host.querySelector("[data-anthropic-grant-use]"));
      await click(host.querySelector("[data-anthropic-grant-confirm]"));
      expect(posts).toHaveLength(1);
      await render(panel("remounted"));
      await tick();
      await click(host.querySelector("[data-anthropic-grant-badge]"));
      expect(host.querySelector("[data-anthropic-grant-use]")).toBeNull();
      expect(host.querySelector<HTMLButtonElement>("[data-anthropic-grant-retry]")?.disabled).toBe(true);
      // Neither another hub nor the sibling pool adopts the same account's hold.
      for (const [scope, pool] of [["http://other-hub.example.test", item], [apiBase, item === POOL_A ? POOL_B : POOL_A]] as const) {
        await render(panel(scope + pool.name, scope, pool));
        await tick();
        await click(host.querySelector("[data-anthropic-grant-badge]"));
        expect(host.querySelector("[data-anthropic-grant-retry]")).toBeNull();
        expect(host.querySelector("[data-anthropic-grant-use]")).not.toBeNull();
      }
      await render(panel("returned"));
      await tick();
      await click(host.querySelector("[data-anthropic-grant-badge]"));
      expect(host.querySelector<HTMLButtonElement>("[data-anthropic-grant-retry]")?.disabled).toBe(true);
      await act(async () => { release(); });
      await tick();
      expect(host.querySelector("[data-anthropic-grant-retry]")).toBeNull();
      expect(posts).toHaveLength(1);
    } finally { await act(async () => { release(); }); }
  });
}

for (const item of [POOL_A, POOL_B]) {
  for (const code of ["unknown_outcome_expired", "operation_identity_mismatch"]) {
    test(`${item.name}: ${code} releases only its held attempt`, async () => {
      const posts: Array<Record<string, unknown>> = [];
      respond = async request => {
        const provider = request.provider ?? "anthropic";
        if (request.path === "/api/pool/settings") return Response.json(poolSettings(provider, true, 55));
        if (request.path === "/api/anthropic/reset-grants") return Response.json(grantSnapshot(provider, 1));
        posts.push(request.body!);
        if (posts.length === 1) throw new TypeError("synthetic uncertain delivery");
        return Response.json({ error: { code } }, { status: 409 });
      };
      await render(<ProviderAuthPanel item={item} apiBase={`http://${item.name}-${code}.example.test`}
        accounts={accounts(item.name)} authHandlers={recordingHandlers([])} />);
      await tick();
      await tick();
      await click(host.querySelector("[data-anthropic-grant-badge]"));
      await click(host.querySelector("[data-anthropic-grant-use]"));
      await click(host.querySelector("[data-anthropic-grant-confirm]"));
      await click(host.querySelector("[data-anthropic-grant-retry]"));
      expect(posts).toHaveLength(2);
      expect(posts[1]).toEqual(posts[0]);
      expect(host.querySelector("[data-anthropic-grant-retry]")).toBeNull();
      expect(host.querySelector("[data-anthropic-grant-use]")).not.toBeNull();
    });
  }
}

for (const item of [POOL_A, POOL_B]) {
  test(`${item.name} reset-grant dialog keeps the ordinal account label`, async () => {
    respond = async request => request.path === "/api/pool/settings"
      ? Response.json(poolSettings(item.name, false, 55))
      : Response.json(grantSnapshot(item.name, 1));
    await render(<ProviderAuthPanel item={item} apiBase="" accounts={accounts(item.name)} authHandlers={recordingHandlers([])} />);
    await tick();
    await click(host.querySelector("[data-anthropic-grant-badge]"));
    expect(win.document.body.textContent).toContain("Account 1");
    expect(win.document.body.textContent).not.toContain(`shared@${item.name}.test`);
  });
}

for (const item of [POOL_A, POOL_B, CUSTOM_B, { ...POOL_A, name: "cursor", adapter: "cursor" } as WorkspaceItem]) {
  for (const deleteOk of [false, true]) {
    test(`${item.name}/${item.adapter} remove and pause interactions preserve scoped label privacy (${deleteOk})`, async () => {
      let pools!: ReturnType<typeof useProviderAccountPools>;
      const notices: string[] = [];
      const config = { port: 0, defaultProvider: item.name, providers: { [item.name]: item } } as PoolHookConfig;
      respond = async request => request.method === "GET"
        ? Response.json({ activeAccountId: "shared", accounts: accounts(item.name) })
        : new Response(null, { status: request.method === "DELETE" && deleteOk ? 200 : 500 });
      await render(<PoolsHarness config={config} onPools={next => { pools = next; }} onNotice={message => notices.push(message)} />);
      await act(async () => { await pools.fetchAccountSets([item.name]); });
      const target = pools.accountSets[item.name]!.accounts[0]!;
      await act(async () => { await pools.pauseAccount(item.name, target, true); });
      let pending!: Promise<void>;
      await act(async () => { pending = pools.removeAccount(item.name, target); await Promise.resolve(); });
      const expected = item === POOL_A || item === POOL_B ? "Account 1" : `shared@${item.name}.test`;
      expect(win.document.querySelector("dialog")?.textContent).toContain(expected);
      if (item === POOL_A || item === POOL_B) expect(win.document.body.textContent).not.toContain(`shared@${item.name}.test`);
      const confirm = [...win.document.querySelectorAll("dialog button")].find(button => button.textContent === en["common.remove"]);
      expect(confirm).toBeTruthy();
      await act(async () => { (confirm as unknown as HTMLElement).click(); await pending; });
      expect(notices).toHaveLength(2);
      expect(notices.every(message => message.includes(expected))).toBe(true);
      if (item === POOL_A || item === POOL_B) expect(notices.join(" ")).not.toContain(`shared@${item.name}.test`);
    });
  }
}
