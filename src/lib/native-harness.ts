/**
 * `nativeHarnessOnly`: subscription accounts serve only their vendor's own harness.
 *
 * When on, Antigravity accounts serve only `agy` through the `/agy` pass-through lane, and
 * Anthropic subscription (OAuth) accounts serve only Claude Code through the strict
 * byte-preserving Messages lane. Every request the hub would build itself while presenting an
 * Antigravity client identity, or a Claude Code identity on a subscription account, refuses at
 * its send site: translated Codex/Chat/Claude routes, images, quota probes, model discovery and
 * project discovery. Token refresh at Google's or Anthropic's standard OAuth endpoint remains,
 * because a pool cannot serve without it.
 *
 * The live server binds its config object once at startup (`setLiveStateStoreConfig`), so a
 * management write that changes the field takes effect without a restart.
 */
import type { OcxConfig } from "../types";

let bound: Pick<OcxConfig, "nativeHarnessOnly"> | null = null;

export function bindNativeHarnessConfig(config: Pick<OcxConfig, "nativeHarnessOnly"> | null): void {
  bound = config;
}

export function nativeHarnessOnly(): boolean {
  return bound?.nativeHarnessOnly === true;
}

export type NativeHarnessVendor = "antigravity" | "anthropic";

export class NativeHarnessRefusal extends Error {
  constructor(readonly vendor: NativeHarnessVendor) {
    super(vendor === "antigravity"
      ? "Antigravity accounts serve only the agy harness through /agy (nativeHarnessOnly is on)"
      : "Anthropic subscription accounts serve only Claude Code through the strict Messages lane (nativeHarnessOnly is on)");
    this.name = "NativeHarnessRefusal";
  }
}

/** Refuse a hub-built send that would present `vendor`'s harness identity on a subscription account. */
export function assertNativeHarnessSend(vendor: NativeHarnessVendor): void {
  if (nativeHarnessOnly()) throw new NativeHarnessRefusal(vendor);
}
