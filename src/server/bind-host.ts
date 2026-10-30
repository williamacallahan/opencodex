import type { OcxConfig } from "../types";

/** The public listener's bind spelling, shared with ownership discovery. */
export function normalizeBindHostname(hostname: string | undefined): string {
  const configuredHost = hostname?.trim();
  return !configuredHost || /^localhost\.?$/i.test(configuredHost) ? "127.0.0.1" : configuredHost;
}

/** Shared by the auxiliary-port preflight and the actual management bind. */
export function managementIngressHostname(config: OcxConfig): "127.0.0.1" | "0.0.0.0" {
  const ingress = config.runtimeRole === "hub" ? config.hub?.managementIngress : undefined;
  if (!ingress?.enabled || ingress.bind !== "container") return "127.0.0.1";
  if (!config.hub?.managementPublicOrigin?.startsWith("https://")) {
    throw new Error("Container management ingress requires HTTPS managementPublicOrigin");
  }
  if (config.hostname !== "0.0.0.0") {
    throw new Error("Container management ingress requires hostname 0.0.0.0 for authenticated management");
  }
  return "0.0.0.0";
}
