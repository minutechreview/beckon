// Process-wide notifier for Next route handlers (the gateway's Service owns its own).
import { pubsub } from "@/gateway/pubsub";
import { Notifier } from "./notifier";
import { senderFromEnv } from "./push";

const g = globalThis as unknown as { __beckonNotifier?: Notifier };
export function notifier(): Notifier {
  return (g.__beckonNotifier ??= new Notifier({ bus: pubsub(), sender: senderFromEnv() }));
}
