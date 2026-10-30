import type { OcxConfig } from "../types";
import { AuxiliaryListenerBindError } from "../server/ports";
import { managementIngressHostname } from "../server/bind-host";
import { createServer } from "node:net";

/**
 * Reject impossible auxiliary binds before startup creates private state. On Windows
 * that publication requires several synchronous ACL subprocesses. This is only an
 * early rejection: startServer still owns the actual bind and transactional rollback
 * if another process takes the port between this probe and startup.
 */
export async function assertAuxiliaryListenerPortsAvailable(config: OcxConfig): Promise<void> {
  const loopback = config.unauthenticatedLoopbackListener;
  const management = config.runtimeRole === "hub" ? config.hub?.managementIngress : undefined;
  const targets = [
    { listener: "unauthenticatedLoopbackListener", port: loopback?.enabled ? loopback.port : undefined, hostname: "127.0.0.1" },
    { listener: "hub.managementIngress", port: management?.enabled ? management.port : undefined,
      hostname: managementIngressHostname(config) },
  ] as const;
  // Each probe releases its socket, so two listeners configured for one port would both
  // pass and startup would still fail on the second bind. Reject the collision directly.
  if (targets[0].port !== undefined && targets[0].port === targets[1].port) {
    throw new AuxiliaryListenerBindError(
      "hub.managementIngress", targets[1].port, targets[1].hostname,
      new Error("port is also configured for unauthenticatedLoopbackListener"),
    );
  }
  for (const { listener, port, hostname } of targets) {
    // The port-less companion shares the public bind; it has no independent target.
    if (port === undefined) continue;
    await new Promise<void>((resolve, reject) => {
      const probe = createServer(socket => socket.destroy());
      const fail = (cause: unknown) => reject(new AuxiliaryListenerBindError(listener, port, hostname, cause));
      probe.once("error", fail);
      probe.once("listening", () => probe.close(error => error ? fail(error) : resolve()));
      try { probe.listen({ port, host: hostname }); } catch (error) { fail(error); }
    });
  }
}
