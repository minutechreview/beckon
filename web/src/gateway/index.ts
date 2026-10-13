// Both WebSocket gateways behind one `attach`. This module only needs an
// http.Server, so it can move out of the Next process later unchanged.
import type { Server } from "node:http";
import { Service } from "./service";
import { HostGateway } from "./host-gateway";
import { ClientGateway } from "./client-gateway";
import { pubsub, type PubSub } from "./pubsub";
import { reject } from "./http";

export interface Gateways {
  close(): Promise<void>;
  /** Host plus client sockets currently open. */
  openSockets(): number;
}

export async function attachGateways(
  server: Server,
  opts: { bus?: PubSub; service?: Service; hostGateway?: (service: Service, bus: PubSub) => HostGateway } = {},
): Promise<Gateways & { service: Service }> {
  const bus = opts.bus ?? pubsub();
  const service = opts.service ?? new Service(bus);
  const host = opts.hostGateway?.(service, bus) ?? new HostGateway(service, bus);
  const client = new ClientGateway(bus);
  await Promise.all([host.start(), client.start()]);

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://x");
    const run = pathname === "/ws/host" ? host.upgrade(req, socket, head)
      : pathname === "/ws/client" ? client.upgrade(req, socket, head)
      : null;
    if (!run) return; // not ours (e.g. Next HMR): other listeners handle it
    run.catch((err) => {
      console.error("[gateway] upgrade failed", err);
      reject(socket, 500, "Internal Server Error");
    });
  });

  return {
    service,
    openSockets: () => host.openCount() + client.openCount(),
    async close() {
      await Promise.all([host.close(), client.close()]);
    },
  };
}
