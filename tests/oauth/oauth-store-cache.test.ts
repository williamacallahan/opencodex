import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as atomicWrites from "../../src/config/atomic-write";
import {
  clearAuthStoreCacheForTests,
  getAccountSet,
  listAccounts,
  mutateStore,
  saveCredential,
} from "../../src/oauth/store";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("OAuth store stat-validated read cache", () => {
  let home: string;
  let savedHome: string | undefined;
  let release: (() => void) | undefined;

  beforeEach(() => {
    savedHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-oauth-cache-"));
    process.env.OPENCODEX_HOME = home;
    release = acquireOwnedSpendHome();
    clearAuthStoreCacheForTests();
  });

  afterEach(() => {
    clearAuthStoreCacheForTests();
    release?.();
    release = undefined;
    if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = savedHome;
    removeTreeWithRetry(home);
  });

  test("serves unchanged auth.json from cache with zero reads, invalidates on external/perm changes, and isolates returned arrays", async () => {
    await saveCredential("google-antigravity", {
      access: "tok-1",
      refresh: "ref-1",
      expires: Date.now() + 3_600_000,
      accountId: "acct-1",
    });
    const authPath = join(home, "auth.json");
    const past = new Date(Date.now() - 5_000);
    utimesSync(authPath, past, past);

    const fs = await import("node:fs");
    const readSpy = spyOn(fs, "readFileSync");
    const countAuthReads = () => readSpy.mock.calls.filter(([target]) => String(target) === authPath).length;
    try {
      // Prime cache after aged mtime; second read hits stat validation with zero readFileSync calls.
      expect(listAccounts("google-antigravity")).toHaveLength(1);
      const afterPrime = countAuthReads();
      expect(listAccounts("google-antigravity")).toHaveLength(1);
      expect(getAccountSet("google-antigravity")?.accounts).toHaveLength(1);
      expect(countAuthReads()).toBe(afterPrime);

      // Mutating returned array/set does not corrupt cached entries.
      const listed = listAccounts("google-antigravity");
      listed.pop();
      const set = getAccountSet("google-antigravity")!;
      set.accounts.length = 0;
      expect(listAccounts("google-antigravity")).toHaveLength(1);

      // External content change invalidates cache via size/mtime/ctime.
      const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
      parsed["other-provider"] = {
        activeAccountId: "ext-1",
        accounts: [{ id: "ext-1", credential: { access: "x", refresh: "r", expires: Date.now() + 1000 } }],
      };
      writeFileSync(authPath, JSON.stringify(parsed, null, 2));
      const older = new Date(Date.now() - 2_000);
      utimesSync(authPath, older, older);
      expect(listAccounts("other-provider")).toHaveLength(1);
      expect(countAuthReads()).toBeGreaterThan(afterPrime);

      // Broadened permissions invalidate the cache on POSIX so hardening runs again.
      if (process.platform !== "win32") {
        const beforeChmod = countAuthReads();
        chmodSync(authPath, 0o644);
        expect(listAccounts("google-antigravity")).toHaveLength(1);
        expect(countAuthReads()).toBe(beforeChmod + 1);
      }

      // mutateStore bypasses the read cache inside the store lock.
      const beforeMutate = countAuthReads();
      await mutateStore(store => {
        expect(Object.keys(store)).toContain("other-provider");
      });
      expect(countAuthReads()).toBe(beforeMutate + 1);
    } finally {
      readSpy.mockRestore();
    }
  });

  test("a mutation whose write fails leaves readers on the stored bytes, not the unwritten change", async () => {
    await saveCredential("google-antigravity", {
      access: "tok-1",
      refresh: "ref-1",
      expires: Date.now() + 3_600_000,
      accountId: "acct-1",
    });
    const authPath = join(home, "auth.json");
    const past = new Date(Date.now() - 5_000);
    utimesSync(authPath, past, past);
    const write = atomicWrites.atomicWriteFileStreamed;
    const writeSpy = spyOn(atomicWrites, "atomicWriteFileStreamed").mockImplementation((...args) => {
      if (args[0] === authPath) throw new Error("EACCES");
      return write(...args);
    });
    try {
      await expect(mutateStore(store => {
        store["google-antigravity"]!.accounts[0]!.needsReauth = true;
      })).rejects.toThrow("EACCES");
    } finally {
      writeSpy.mockRestore();
    }
    expect(getAccountSet("google-antigravity")!.accounts[0]!.needsReauth).toBeUndefined();
  });
});
