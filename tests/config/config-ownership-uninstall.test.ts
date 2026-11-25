import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_OWNER_FILE,
  CONFIG_UNINSTALL_MANIFEST,
  recordOwnedConfigPath,
  removeOwnedConfigState,
  uninstallUsageHistoryRefusal,
} from "../../src/lib/config-ownership";
import { setUninstallElevationProbeForTests } from "../../src/lib/config-ownership-removal";
import { writePristineCatalogBackup } from "../../src/codex/catalog/parsing";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function manifestPaths(dir: string): string[] {
  return (JSON.parse(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")) as { paths: string[] }).paths;
}

describe("owned config uninstall", () => {
  // These removal fixtures exercise the owning user's unelevated path. Elevated Windows
  // junction refusal is covered separately in config-ownership-removal.test.ts.
  beforeEach(() => { if (process.platform === "win32") setUninstallElevationProbeForTests(() => false); });
  afterEach(() => { if (process.platform === "win32") setUninstallElevationProbeForTests(null); });

  (process.platform === "win32" ? test.skip : test)("refuses elevated removal when the root permits shared writes (POSIX modes required)", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-mode-"));
    const dir = join(parent, "config");
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writeFileSync(join(dir, "config.json"), "owned");
      chmodSync(dir, 0o777);
      const manifestBefore = readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8");
      const elevation = spyOn(process, "geteuid").mockReturnValue(0);
      try {
        expect(removeOwnedConfigState(dir).status).toBe("refused");
        expect(existsSync(join(dir, "config.json"))).toBe(true);
        // Refused before the tombstone: the manifest is byte-for-byte what it was.
        expect(readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8")).toBe(manifestBefore);
      } finally { elevation.mockRestore(); }
    } finally { chmodSync(dir, 0o700); removeTreeWithRetry(parent); }
  });
  function checkNestedParent(kind: "dir" | "junction"): void {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-nested-"));
    const dir = join(parent, "config");
    const other = join(parent, "other");
    const nested = join(dir, "nested");
    const recorded = join(nested, "owned.txt");
    mkdirSync(dir);
    mkdirSync(other);
    try {
      expect(recordOwnedConfigPath(dir, recorded)).toBe(true);
      writeFileSync(join(other, "owned.txt"), "keep");
      symlinkSync(other, nested, kind);
      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("partial");
      expect(result.residualPaths).toContain(recorded);
      expect(readFileSync(join(other, "owned.txt"), "utf8")).toBe("keep");
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
    } finally {
      removeTreeWithRetry(parent);
    }
  }

  (process.platform === "win32" ? test.skip : test)("reports an unresolved nested owned path (directory links require POSIX)", () => {
    checkNestedParent("dir");
  });

  (process.platform === "win32" ? test : test.skip)("reports an unresolved nested owned path (junctions require Windows)", () => {
    checkNestedParent("junction");
  });

  (process.platform === "win32" ? test.skip : test)("removes owned state through an aliased ancestor of the root (directory links require POSIX)", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-root-alias-"));
    const real = join(parent, "real");
    const dir = join(real, "config");
    const alias = join(parent, "alias");
    mkdirSync(real);
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      expect(recordOwnedConfigPath(dir, join(dir, "nested", "owned.txt"))).toBe(true);
      writeFileSync(join(dir, "config.json"), "owned");
      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "nested", "owned.txt"), "owned");
      symlinkSync(real, alias, "dir");
      const result = removeOwnedConfigState(join(alias, "config"));
      // The unrecorded nested directory stays; both recorded files go.
      expect(result.status).toBe("partial");
      expect(result.residualPaths).toEqual([join(alias, "config", "nested")]);
      expect(existsSync(join(dir, "config.json"))).toBe(false);
      expect(existsSync(join(dir, "nested", "owned.txt"))).toBe(false);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("keeps the usage ledger and every recorded archive path, twice, and still removes other owned state", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-usage-history-"));
    const dir = join(parent, "config");
    const archive = join(dir, "usage-archive");
    const segment = join(archive, "2026-11-01T08-30-00.000Z_123-456.jsonl");
    try {
      // A manifest an older build wrote: the archive directory itself and one of its children are listed.
      for (const path of [join(dir, "config.json"), archive, segment, join(archive, "nested", "child.txt")]) {
        expect(recordOwnedConfigPath(dir, path)).toBe(true);
      }
      expect(manifestPaths(dir)).toContain("usage.jsonl");
      writeFileSync(join(dir, "config.json"), "owned");
      writeFileSync(join(dir, "usage.jsonl"), "{\"requestId\":\"recent\"}\n");
      mkdirSync(join(archive, "nested"), { recursive: true });
      const files: Record<string, string> = {
        [segment]: "{\"requestId\":\"old\"}\n",
        [`${segment.slice(0, -".jsonl".length)}.hourly.json`]: "{}",
        [`${segment}.ocx.1.2.tmp`]: "temp",
        [join(archive, "operator-notes.txt")]: "notes",
        [join(archive, "nested", "child.txt")]: "child",
      };
      for (const [path, bytes] of Object.entries(files)) writeFileSync(path, bytes);

      const first = removeOwnedConfigState(dir);
      expect(first.status).toBe("partial");
      expect(first.reason).toContain("usage ledger and usage archive were kept");
      expect(first.residualPaths).toEqual(expect.arrayContaining([join(dir, "usage.jsonl"), archive]));
      expect(existsSync(join(dir, "config.json"))).toBe(false);
      const second = removeOwnedConfigState(dir);
      expect(second.status).not.toBe("removed");

      expect(readFileSync(join(dir, "usage.jsonl"), "utf8")).toBe("{\"requestId\":\"recent\"}\n");
      for (const [path, bytes] of Object.entries(files)) expect(readFileSync(path, "utf8")).toBe(bytes);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  /** Every path below `root` with its bytes, link target or kind, so a refused run's untouched tree can be compared. */
  function treeSnapshot(root: string): Map<string, string> {
    const seen = new Map<string, string>();
    const walk = (path: string, rel: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        const name = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) seen.set(name, `link:${readlinkSync(child)}`);
        else if (entry.isDirectory()) { seen.set(name, "dir"); walk(child, name); }
        else seen.set(name, readFileSync(child, "base64"));
      }
    };
    walk(root, "");
    return seen;
  }

  /** A home with one unrelated owned file, a plain ledger and a plain archive, plus `extra` recorded entries. */
  function historyHome(prefix: string, extra: string[] = []): { parent: string; dir: string } {
    const parent = mkdtempSync(join(tmpdir(), prefix));
    const dir = join(parent, "config");
    for (const rel of ["config.json", "usage-archive", ...extra]) expect(recordOwnedConfigPath(dir, join(dir, ...rel.split("/")))).toBe(true);
    writeFileSync(join(dir, "config.json"), "owned");
    writeFileSync(join(dir, "usage.jsonl"), "recent\n");
    mkdirSync(join(dir, "usage-archive"));
    writeFileSync(join(dir, "usage-archive", "2026-11-01T08-30-00.000Z_1-2.jsonl"), "old\n");
    return { parent, dir };
  }

  function expectRefusedIntact(dir: string, mention: string): void {
    const before = treeSnapshot(dir);
    const result = removeOwnedConfigState(dir);
    expect(result.status).toBe("refused");
    expect(result.reason).toContain(mention);
    expect(result.reason).toContain("nothing was removed");
    expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
    expect(treeSnapshot(dir)).toEqual(before);
    expect(uninstallUsageHistoryRefusal(dir)).toBe(result.reason!);
  }

  test("refuses, before removing anything, a manifest entry that spells a usage-history name another way", () => {
    for (const alias of ["Usage-Archive", "USAGE-ARCHIVE/2026-11-01T08-30-00.000Z_1-2.jsonl", "Usage.JSONL"]) {
      const { parent, dir } = historyHome("ocx-config-usage-alias-", [alias]);
      try {
        expectRefusedIntact(dir, join(dir, alias.split("/")[0]!));
      } finally {
        removeTreeWithRetry(parent);
      }
    }
  });

  (process.platform === "win32" ? test.skip : test)("refuses, before removing anything, a linked ledger, a linked archive, or a link inside the archive (links require POSIX)", () => {
    const cases: Array<{ name: string; arrange: (dir: string) => string }> = [
      { name: "linked ledger", arrange: dir => {
        rmSync(join(dir, "usage.jsonl"));
        mkdirSync(join(dir, "data"));
        writeFileSync(join(dir, "data", "ledger.jsonl"), "recent\n");
        symlinkSync(join(dir, "data", "ledger.jsonl"), join(dir, "usage.jsonl"));
        return join(dir, "usage.jsonl");
      } },
      { name: "linked archive", arrange: dir => {
        rmSync(join(dir, "usage-archive"), { recursive: true });
        mkdirSync(join(dir, "data", "archive-store"), { recursive: true });
        writeFileSync(join(dir, "data", "archive-store", "seg.jsonl"), "old\n");
        symlinkSync(join(dir, "data", "archive-store"), join(dir, "usage-archive"), "dir");
        return join(dir, "usage-archive");
      } },
      // The reviewer's case: an archive member links to a file inside owned state the run would remove.
      { name: "archive member linked into owned artifacts", arrange: dir => {
        mkdirSync(join(dir, "artifacts"));
        writeFileSync(join(dir, "artifacts", "seg.jsonl"), "old\n");
        symlinkSync(join(dir, "artifacts", "seg.jsonl"), join(dir, "usage-archive", "2026-11-02T00-00-00.000Z_3-4.jsonl"));
        return join(dir, "usage-archive", "2026-11-02T00-00-00.000Z_3-4.jsonl");
      } },
    ];
    for (const { arrange } of cases) {
      const { parent, dir } = historyHome("ocx-config-usage-link-", ["artifacts", "data"]);
      try {
        const link = arrange(dir);
        expectRefusedIntact(dir, link);
      } finally {
        removeTreeWithRetry(parent);
      }
    }
  });

  (process.platform === "win32" || process.getuid?.() === 0 ? test.skip : test)("refuses, before removing anything, an archive it cannot list (POSIX modes required)", () => {
    const { parent, dir } = historyHome("ocx-config-usage-unreadable-");
    const archive = join(dir, "usage-archive");
    try {
      chmodSync(archive, 0o000);
      const result = removeOwnedConfigState(dir);
      chmodSync(archive, 0o700);
      expect(result).toMatchObject({ status: "refused" });
      expect(result.reason).toContain(archive);
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
      expect(readFileSync(join(dir, "config.json"), "utf8")).toBe("owned");
      expect(readFileSync(join(archive, "2026-11-01T08-30-00.000Z_1-2.jsonl"), "utf8")).toBe("old\n");
    } finally {
      chmodSync(archive, 0o700);
      removeTreeWithRetry(parent);
    }
  });

  test("removes a recorded nested file", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-nested-file-"));
    const dir = join(parent, "config");
    const path = join(dir, "nested", "owned.txt");
    try {
      expect(recordOwnedConfigPath(dir, path)).toBe(true);
      mkdirSync(join(dir, "nested"));
      writeFileSync(path, "owned");
      expect(removeOwnedConfigState(dir).status).toBe("partial");
      expect(existsSync(path)).toBe(false);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("first owned write creates a missing config root and its metadata", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-first-owned-path-"));
    const dir = join(parent, "config");

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "usage.jsonl"))).toBe(true);
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
      expect(existsSync(join(dir, CONFIG_UNINSTALL_MANIFEST))).toBe(true);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("refuses a legacy config directory without ownership metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-legacy-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, '{"keep":true}\n');

    try {
      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("refused");
      expect(result.reason).toContain("ownership");
      expect(readFileSync(configPath, "utf8")).toBe('{"keep":true}\n');
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("removes manifest-owned state and the empty config directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-owned-"));
    const configPath = join(dir, "config.json");

    try {
      expect(recordOwnedConfigPath(dir, configPath)).toBe(true);
      writeFileSync(configPath, '{"owned":true}\n');

      expect(removeOwnedConfigState(dir)).toEqual({
        status: "removed",
        residualPaths: [],
      });
      expect(existsSync(dir)).toBe(false);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("preserves unowned files and reports a partial uninstall", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-shared-"));
    const ownedPath = join(dir, "config.json");
    const foreignPath = join(dir, "personal.txt");

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, '{"owned":true}\n');
      writeFileSync(foreignPath, "keep me\n");

      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("partial");
      expect(result.residualPaths).toEqual([foreignPath]);
      expect(existsSync(ownedPath)).toBe(false);
      expect(readFileSync(foreignPath, "utf8")).toBe("keep me\n");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("recursively removes a manifest-owned state directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-uninstall-tree-"));
    const artifacts = join(dir, "artifacts");

    try {
      expect(recordOwnedConfigPath(dir, artifacts)).toBe(true);
      mkdirSync(join(artifacts, "nested"), { recursive: true });
      writeFileSync(join(artifacts, "nested", "image.bin"), "owned");

      expect(removeOwnedConfigState(dir)).toEqual({
        status: "removed",
        residualPaths: [],
      });
      expect(existsSync(dir)).toBe(false);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("unlinks an owned directory link without traversing its external target", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-link-"));
    const dir = join(parent, "config");
    const external = join(parent, "external");
    const linkedArtifacts = join(dir, "artifacts");
    mkdirSync(dir);
    mkdirSync(external);
    writeFileSync(join(external, "keep.bin"), "external");

    try {
      expect(recordOwnedConfigPath(dir, linkedArtifacts)).toBe(true);
      symlinkSync(external, linkedArtifacts, process.platform === "win32" ? "junction" : "dir");

      expect(removeOwnedConfigState(dir).status).toBe("removed");
      expect(readFileSync(join(external, "keep.bin"), "utf8")).toBe("external");
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("rejects a manifest path that escapes the config directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-traversal-"));
    const dir = join(parent, "config");
    const ownedPath = join(dir, "config.json");
    const external = join(parent, "keep.txt");
    mkdirSync(dir);
    writeFileSync(external, "external");

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, "{}\n");
      const manifestPath = join(dir, CONFIG_UNINSTALL_MANIFEST);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
      manifest.paths = ["../keep.txt"];
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(external, "utf8")).toBe("external");
      expect(readFileSync(ownedPath, "utf8")).toBe("{}\n");
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("rejects linked ownership metadata without deleting owned state", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-linked-metadata-"));
    const dir = join(parent, "config");
    const external = join(parent, "external");
    const ownedPath = join(dir, "config.json");
    mkdirSync(dir);
    mkdirSync(external);

    try {
      expect(recordOwnedConfigPath(dir, ownedPath)).toBe(true);
      writeFileSync(ownedPath, "{}\n");
      rmSync(join(dir, CONFIG_UNINSTALL_MANIFEST));
      symlinkSync(
        external,
        join(dir, CONFIG_UNINSTALL_MANIFEST),
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(ownedPath, "utf8")).toBe("{}\n");
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("a fresh config save creates ownership metadata and records config.json", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-first-write-"));
    const dir = join(parent, "config");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;

    try {
      saveConfig(getDefaultConfig());
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(dir, CONFIG_UNINSTALL_MANIFEST), "utf8"),
      ) as { paths: string[] };
      expect(manifest.paths).toContain("config.json");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });

  test("an existing nonempty config directory is not retroactively claimed", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-config-legacy-write-"));
    const dir = join(parent, "config");
    const foreignPath = join(dir, "personal.txt");
    mkdirSync(dir);
    writeFileSync(foreignPath, "keep me\n");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;

    try {
      saveConfig(getDefaultConfig());
      expect(existsSync(join(dir, CONFIG_OWNER_FILE))).toBe(false);
      expect(removeOwnedConfigState(dir).status).toBe("refused");
      expect(readFileSync(foreignPath, "utf8")).toBe("keep me\n");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });

  test("uninstall removes recorded admin tokens and per-home catalog backups", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-self-written-"));
    const dir = join(parent, "config");

    try {
      // Establish ownership the way production does: the first owned write into an empty dir.
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writeFileSync(join(dir, "config.json"), "{}\n");
      writeFileSync(join(dir, "admin-api-token"), "token\n");
      const backupPath = join(dir, "catalog-backup-0123456789abcdef.json");
      expect(recordOwnedConfigPath(dir, backupPath)).toBe(true);
      writeFileSync(backupPath, "{}\n");

      const result = removeOwnedConfigState(dir);
      expect(result).toMatchObject({ status: "removed" });
      expect(existsSync(dir)).toBe(false);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("an unrecorded matching catalog backup name is never removed", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-lookalike-"));
    const dir = join(parent, "config");

    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      const foreign = join(dir, "catalog-backup-0123456789abcdef.json");
      mkdirSync(foreign);
      const nested = join(foreign, "mine.txt");
      writeFileSync(nested, "mine\n");

      const result = removeOwnedConfigState(dir);
      expect(result.status).toBe("partial");
      expect(readFileSync(nested, "utf8")).toBe("mine\n");
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("writePristineCatalogBackup records a backup it writes itself", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-write-"));
    const dir = join(parent, "config");
    const catalogPath = join(parent, "models.json");
    const backupPath = join(dir, "catalog-backup-0123456789abcdef.json");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;

    try {
      mkdirSync(dir, { recursive: true });
      // Ownership is claimed by the first owned write into an empty dir, as in production.
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writeFileSync(catalogPath, '{"models":[]}\n');

      writePristineCatalogBackup(backupPath, catalogPath, { models: [] });

      expect(readFileSync(backupPath, "utf8")).toBe('{"models":[]}\n');
      expect(manifestPaths(dir)).toContain("catalog-backup-0123456789abcdef.json");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });

  for (const existing of ['{"models":[{"slug":"user-owned"}]}\n', '{"models":[]}\n']) {
    test(`writePristineCatalogBackup does not adopt an existing regular backup: ${existing.trim()}`, () => {
      const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-existing-"));
      const dir = join(parent, "config");
      const catalogPath = join(parent, "models.json");
      const name = "catalog-backup-0123456789abcdef.json";
      const backupPath = join(dir, name);
      const previous = process.env.OPENCODEX_HOME;
      process.env.OPENCODEX_HOME = dir;
      try {
        expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
        writeFileSync(catalogPath, '{"models":[]}\n');
        writeFileSync(backupPath, existing);
        const before = manifestPaths(dir);
        writePristineCatalogBackup(backupPath, catalogPath, { models: [] });
        expect(manifestPaths(dir)).toEqual(before);
        expect(manifestPaths(dir)).not.toContain(name);
        const result = removeOwnedConfigState(dir);
        expect(result.status).toBe("partial");
        expect(result.residualPaths).toEqual([backupPath]);
        expect(readFileSync(backupPath, "utf8")).toBe(existing);
      } finally {
        if (previous === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = previous;
        removeTreeWithRetry(parent);
      }
    });
  }

  test("serialized pristine fallback records only the newly written backup", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-fallback-"));
    const dir = join(parent, "config");
    const backupPath = join(dir, "catalog-backup-0123456789abcdef.json");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writePristineCatalogBackup(backupPath, join(parent, "missing.json"), { models: [] });
      expect(JSON.parse(readFileSync(backupPath, "utf8"))).toEqual({ models: [] });
      expect(manifestPaths(dir)).toContain("catalog-backup-0123456789abcdef.json");
      expect(removeOwnedConfigState(dir).status).toBe("removed");
      expect(existsSync(backupPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });

  test("a routed-only catalog creates neither a backup nor an ownership entry", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-routed-"));
    const dir = join(parent, "config");
    const name = "catalog-backup-0123456789abcdef.json";
    const backupPath = join(dir, name);
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      const before = manifestPaths(dir);
      writePristineCatalogBackup(backupPath, join(parent, "missing.json"), { models: [{ slug: "provider/model" }] });
      expect(existsSync(backupPath)).toBe(false);
      expect(manifestPaths(dir)).toEqual(before);
      expect(manifestPaths(dir)).not.toContain(name);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });

  test("failed pristine copying does not register an unwritten backup", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-failure-"));
    const dir = join(parent, "config");
    const catalogPath = join(parent, "models.json");
    const backupPath = join(dir, "missing", "catalog-backup-0123456789abcdef.json");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writeFileSync(catalogPath, '{"models":[]}\n');
      const before = manifestPaths(dir);
      expect(() => writePristineCatalogBackup(backupPath, catalogPath, { models: [] })).toThrow();
      expect(existsSync(backupPath)).toBe(false);
      expect(manifestPaths(dir)).toEqual(before);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });

  test("preserving an already recorded pristine backup keeps its original ownership", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-owned-"));
    const dir = join(parent, "config");
    const catalogPath = join(parent, "models.json");
    const backupPath = join(dir, "catalog-backup-0123456789abcdef.json");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      writeFileSync(catalogPath, '{"models":[]}\n');
      writePristineCatalogBackup(backupPath, catalogPath, { models: [] });
      const before = manifestPaths(dir);
      writePristineCatalogBackup(backupPath, catalogPath, { models: [{ slug: "other" }] });
      expect(manifestPaths(dir)).toEqual(before);
      expect(readFileSync(backupPath, "utf8")).toBe('{"models":[]}\n');
      expect(removeOwnedConfigState(dir).status).toBe("removed");
      expect(existsSync(backupPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });

  test("an existing matching backup directory stays unclaimed after the writer visits it", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-uninstall-pristine-directory-"));
    const dir = join(parent, "config");
    const backupPath = join(dir, "catalog-backup-0123456789abcdef.json");
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      expect(recordOwnedConfigPath(dir, join(dir, "config.json"))).toBe(true);
      mkdirSync(backupPath);
      const nested = join(backupPath, "mine.txt");
      writeFileSync(nested, "keep me\n");
      const before = manifestPaths(dir);
      writePristineCatalogBackup(backupPath, join(parent, "missing.json"), { models: [] });
      expect(manifestPaths(dir)).toEqual(before);
      expect(removeOwnedConfigState(dir).residualPaths).toEqual([backupPath]);
      expect(readFileSync(nested, "utf8")).toBe("keep me\n");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(parent);
    }
  });
});
