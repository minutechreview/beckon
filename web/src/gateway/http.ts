import type { Duplex } from "node:stream";

/** Refuses a WebSocket upgrade with a plain HTTP response. */
export function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Resolves when every socket has closed, or after `ms` (peers that never answer the close frame). */
export function settleClose(sockets: Array<{ readyState: number; once(ev: "close", cb: () => void): unknown }>, ms = 2000): Promise<void> {
  const open = sockets.filter((s) => s.readyState !== 3);
  if (open.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let left = open.length;
    const done = () => --left === 0 && resolve();
    const t = setTimeout(resolve, ms);
    t.unref();
    for (const s of open) s.once("close", () => {
      done();
      if (left === 0) clearTimeout(t);
    });
  });
}
