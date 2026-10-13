// A tiny in-process SMTP server for tests: just enough of RFC 5321 for nodemailer to deliver one message.
// Modes: implicit TLS (smtps), STARTTLS (smtp), or no TLS at all. Everything it sees is recorded.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

export type Received = {
  /** For each AUTH seen: whether the connection was already encrypted. */
  tlsAtAuth: boolean[];
  auth: { user: string; pass: string }[];
  mailFrom: string[];
  rcptTo: string[];
  data: string[];
  connections: number;
};

export type FakeSmtpOptions = {
  mode: "implicit-tls" | "starttls" | "plain";
  /**
   * reject-auth: answer AUTH with a 535 that echoes the username and password, as a careless server might.
   * silent: accept the connection and never send a greeting.
   * silent-after-ehlo: greet, then never answer EHLO.
   */
  behavior?: "ok" | "reject-auth" | "silent" | "silent-after-ehlo";
};

export type Cert = { key: string; cert: string };

/** A throwaway self-signed certificate for 127.0.0.1, made with the openssl CLI. */
export function makeCert(): Cert {
  const dir = mkdtempSync(join(tmpdir(), "beckon-smtp-"));
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
        "-days", "2", "-subj", "/CN=localhost",
        "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function startFakeSmtp(opts: FakeSmtpOptions, cert: Cert) {
  const behavior = opts.behavior ?? "ok";
  const received: Received = { tlsAtAuth: [], auth: [], mailFrom: [], rcptTo: [], data: [], connections: 0 };
  const sockets = new Set<net.Socket>();

  const serve = (socket: net.Socket, startsEncrypted: boolean) => {
    received.connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});

    let out: net.Socket = socket; // replaced by the TLS socket after STARTTLS
    let encrypted = startsEncrypted;
    let buf = "";
    let inData = false;
    let pendingAuth: "plain" | "login-user" | "login-pass" | undefined;
    let loginUser = "";
    const say = (line: string) => out.write(line + "\r\n");

    const finishAuth = (user: string, pass: string) => {
      received.tlsAtAuth.push(encrypted);
      received.auth.push({ user, pass });
      if (behavior === "reject-auth") say(`535 5.7.8 Authentication failed for ${user} with password ${pass}`);
      else say("235 2.7.0 Authentication successful");
    };

    const onLine = (line: string) => {
      if (pendingAuth === "plain") {
        pendingAuth = undefined;
        const [, user, pass] = Buffer.from(line, "base64").toString().split("\0");
        return finishAuth(user, pass);
      }
      if (pendingAuth === "login-user") {
        loginUser = Buffer.from(line, "base64").toString();
        pendingAuth = "login-pass";
        return say("334 " + Buffer.from("Password:").toString("base64"));
      }
      if (pendingAuth === "login-pass") {
        pendingAuth = undefined;
        return finishAuth(loginUser, Buffer.from(line, "base64").toString());
      }
      const cmd = line.toUpperCase();
      if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) {
        if (behavior === "silent-after-ehlo") return;
        const caps = ["250-fake.smtp", "250-8BITMIME"];
        if (opts.mode === "starttls" && !encrypted) caps.push("250-STARTTLS");
        caps.push("250 AUTH PLAIN LOGIN");
        return caps.forEach(say);
      }
      if (cmd === "STARTTLS" && (opts.mode !== "starttls" || encrypted)) return say("502 5.5.1 STARTTLS not available");
      if (cmd === "STARTTLS") {
        say("220 2.0.0 Ready to start TLS");
        socket.removeListener("data", onData);
        const upgraded = new tls.TLSSocket(socket, { isServer: true, key: cert.key, cert: cert.cert });
        upgraded.on("error", () => {});
        upgraded.on("data", onData);
        out = upgraded;
        encrypted = true;
        buf = "";
        return;
      }
      if (cmd.startsWith("AUTH PLAIN")) {
        const arg = line.slice("AUTH PLAIN".length).trim();
        if (!arg) {
          pendingAuth = "plain";
          return say("334 ");
        }
        const [, user, pass] = Buffer.from(arg, "base64").toString().split("\0");
        return finishAuth(user, pass);
      }
      if (cmd.startsWith("AUTH LOGIN")) {
        pendingAuth = "login-user";
        return say("334 " + Buffer.from("Username:").toString("base64"));
      }
      if (cmd.startsWith("MAIL FROM:")) {
        received.mailFrom.push(line.slice(10).trim());
        return say("250 2.1.0 OK");
      }
      if (cmd.startsWith("RCPT TO:")) {
        received.rcptTo.push(line.slice(8).trim());
        return say("250 2.1.5 OK");
      }
      if (cmd === "DATA") {
        inData = true;
        return say("354 End data with <CR><LF>.<CR><LF>");
      }
      if (cmd === "QUIT") {
        say("221 2.0.0 Bye");
        return out.end();
      }
      say("250 OK");
    };

    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          received.data.push(buf.slice(0, end));
          buf = buf.slice(end + 5);
          inData = false;
          say("250 2.0.0 Queued");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        onLine(line);
      }
    };

    socket.on("data", onData);
    if (behavior !== "silent") say("220 fake.smtp ESMTP ready");
  };

  const server =
    opts.mode === "implicit-tls"
      ? tls.createServer({ key: cert.key, cert: cert.cert }, (s) => serve(s, true))
      : net.createServer((s) => serve(s, false));
  server.on("tlsClientError", () => {});
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    received,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}

/** Minimal MIME reader for what nodemailer produces: headers, then multipart/alternative parts. */
export function parseMessage(raw: string) {
  const split = (s: string) => {
    const i = s.indexOf("\r\n\r\n");
    return [s.slice(0, i), s.slice(i + 4)] as const;
  };
  const headers = (h: string) => {
    const out: Record<string, string> = {};
    for (const l of h.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
      const c = l.indexOf(":");
      if (c > 0) out[l.slice(0, c).toLowerCase()] = l.slice(c + 1).trim();
    }
    return out;
  };
  const decode = (body: string, enc: string | undefined) => {
    const e = enc?.toLowerCase();
    if (e === "quoted-printable") {
      const bytes = body
        .replace(/=\r\n/g, "")
        .replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      return Buffer.from(bytes, "latin1").toString("utf8");
    }
    if (e === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    return body;
  };
  const [head, body] = split(raw);
  const top = headers(head);
  const boundary = /boundary="?([^";]+)"?/.exec(top["content-type"] ?? "")?.[1];
  const parts: { type: string; content: string }[] = [];
  if (boundary) {
    for (const seg of body.split(`--${boundary}`).slice(1)) {
      if (seg.startsWith("--")) break;
      const [ph, pb] = split(seg.replace(/^\r\n/, ""));
      const h = headers(ph);
      parts.push({
        type: (h["content-type"] ?? "").split(";")[0],
        content: decode(pb.replace(/\r\n$/, ""), h["content-transfer-encoding"]),
      });
    }
  }
  return { headers: top, parts };
}
