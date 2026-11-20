import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import { resolveClaudeBridgePoolSession } from "../../src/server/claude-bridge-pool-session";

// Direct handler fixtures skip the HTTP router that normally supplies admission.
export const loopbackAdmission: DataPlaneAdmission = { kind: "loopback", source: "loopback" };
export function admittedLane(headers: Headers, admission: DataPlaneAdmission = loopbackAdmission): string | undefined {
  return resolveClaudeBridgePoolSession({ ingress: headers, replay: headers, admission });
}
