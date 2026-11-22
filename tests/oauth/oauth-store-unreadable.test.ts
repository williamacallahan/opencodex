import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectOAuthDoctorChecks } from "../../src/cli/doctor";
import { loadAuthStore, saveCredential } from "../../src/oauth/store";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const UNREADABLE_LINE = "[opencodex] level=error OAuth account store unreadable; serving an empty pool";
const INVALID_BYTES = '{"anthropic":{"accounts":[{"credential":{"refresh":"fixture-refresh-in-a-truncated-file"';
const credential = { access: "fixture-access", refresh: "fixture-refresh", expires: 2_000_000_000_000 };

let home: TempHome;
let info: ReturnType<typeof spyOn>;
beforeEach(() => { home = createTempHome("ocx-auth-unreadable-"); info = spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { info.mockRestore(); home.remove(); });

const authPath = () => join(home.configDir, "auth.json");
const quarantined = () => readdirSync(home.configDir).filter(name => name.startsWith("auth.json.invalid-"));
const logged = () => info.mock.calls.map(call => String(call[0]));
const unreadableLines = () => logged().filter(line => line.includes("OAuth account store unreadable"));
/** Loads on separate milliseconds, the resolution of a quarantine file's name. */
async function loadRepeatedly(times: number): Promise<void> {
  for (let load = 0; load < times; load++) {
    expect(loadAuthStore()).toEqual({});
    await Bun.sleep(2);
  }
}
async function doctorStoreFailures(): Promise<string[]> {
  const checks = await collectOAuthDoctorChecks(Date.now(), { findLiveProxyImpl: async () => null });
  return checks.filter(check => check.level === "FAIL" && check.message.includes("auth.json is unreadable")).map(check => check.message);
}

test("a zero-byte auth.json is quarantined and reported once however many times the store loads", async () => {
  writeFileSync(authPath(), "");
  await loadRepeatedly(40);
  expect(quarantined()).toHaveLength(1);
  expect(unreadableLines()).toEqual([`${UNREADABLE_LINE} reason=empty_file`]);
  expect((await doctorStoreFailures())[0]).toContain("(empty_file)");
});

test("an unparseable auth.json is its own reason and its content is never logged", async () => {
  writeFileSync(authPath(), INVALID_BYTES);
  await loadRepeatedly(40);
  expect(quarantined()).toHaveLength(1);
  expect(unreadableLines()).toEqual([`${UNREADABLE_LINE} reason=invalid_json`]);
  expect(logged().some(line => line.includes("fixture-refresh-in-a-truncated-file"))).toBe(false);
  const failures = await doctorStoreFailures();
  expect(failures[0]).toContain("(invalid_json)");
  expect(failures[0]).not.toContain("fixture-refresh-in-a-truncated-file");
});

test("an absent auth.json is an empty pool with no report, quarantine, or doctor failure", async () => {
  await loadRepeatedly(3);
  expect(quarantined()).toEqual([]);
  expect(unreadableLines()).toEqual([]);
  expect(await doctorStoreFailures()).toEqual([]);
});

test("a store write clears the condition, and a file that goes bad again is quarantined and reported again", async () => {
  writeFileSync(authPath(), "");
  await loadRepeatedly(3);
  expect(await doctorStoreFailures()).toHaveLength(1);

  await saveCredential("anthropic", credential);
  expect(await doctorStoreFailures()).toEqual([]);
  expect(loadAuthStore().anthropic?.accounts).toHaveLength(1);
  expect(unreadableLines()).toHaveLength(1);

  await Bun.sleep(2);
  writeFileSync(authPath(), "");
  await loadRepeatedly(3);
  expect(quarantined()).toHaveLength(2);
  expect(unreadableLines()).toEqual([`${UNREADABLE_LINE} reason=empty_file`, `${UNREADABLE_LINE} reason=empty_file`]);
});

test("an auth.json that cannot be read at all is one doctor failure, not a thrown doctor", async () => {
  // A bind mount of a missing file leaves a directory where auth.json should be.
  mkdirSync(authPath());
  expect((await doctorStoreFailures())[0]).toContain("(read_failed)");
  expect(loadAuthStore()).toEqual({});
  expect(unreadableLines()).toEqual([`${UNREADABLE_LINE} reason=read_failed`]);
});
