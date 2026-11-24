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
import { markProxyError } from "./client-error-body";

let bound: Pick<OcxConfig, "nativeHarnessOnly"> | null = null;

export function bindNativeHarnessConfig(config: Pick<OcxConfig, "nativeHarnessOnly"> | null): void {
  bound = config;
}

export function nativeHarnessOnly(): boolean {
  return bound?.nativeHarnessOnly === true;
}

export const VIBE_PROVIDER_ID = "mistral-vibe";

export type NativeHarnessVendor = "antigravity" | "anthropic" | "mistral-vibe";

export class NativeHarnessRefusal extends Error {
  constructor(readonly vendor: NativeHarnessVendor) {
    super(vendor === "antigravity"
      ? "Antigravity accounts serve only the agy harness through /agy (nativeHarnessOnly is on)"
      : vendor === "mistral-vibe"
        ? "Mistral Vibe accounts serve only the native Vibe harness through /vibe (nativeHarnessOnly is on)"
        : "Anthropic subscription accounts serve only Claude Code through the strict Messages lane (nativeHarnessOnly is on)");
    this.name = "NativeHarnessRefusal";
    // The sentence is the proxy's own, so every client protocol may show it verbatim.
    markProxyError(this);
  }
}

/** The only client a provider's subscription accounts serve while the switch is on. */
export type NativeHarness = "agy" | "claude-code" | "vibe";

/**
 * Which client a provider is reserved to, or undefined when it is not (switch off, or not a
 * subscription row). `googleMode` is the caller's resolved Google mode, so this module stays free of
 * the provider registry that the adapters importing it also load.
 */
export function nativeHarnessFor(
  provider: { adapter?: string; authMode?: string },
  googleMode: string | null | undefined,
  providerName?: string,
): NativeHarness | undefined {
  if (!nativeHarnessOnly()) return undefined;
  if (providerName === VIBE_PROVIDER_ID) return "vibe";
  if (provider.authMode !== "oauth") return undefined;
  if (googleMode === "cloud-code-assist") return "agy";
  return provider.adapter === "anthropic" ? "claude-code" : undefined;
}

/** Refuse a hub-built send that would present `vendor`'s harness identity on a subscription account. */
export function assertNativeHarnessSend(vendor: NativeHarnessVendor): void {
  if (nativeHarnessOnly()) throw new NativeHarnessRefusal(vendor);
}
