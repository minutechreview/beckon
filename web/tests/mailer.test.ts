import nodemailer from "nodemailer";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { magicLinkEmail } from "@/lib/magic-link-email";
import { redact, resetMailerForTests, sendMail, smtpOptions, type Mail } from "@/lib/mailer";
import { makeCert, parseMessage, startFakeSmtp, type Cert } from "./fake-smtp";

const LINK = "https://beckoncli.com/api/auth/callback/email?token=abc&email=a%40b.c";
const USER = "AKIAEXAMPLEUSER";
// A realistic SES SMTP password: base64, so it can contain + and /, which must be percent-encoded in the URL.
const PASS = "BExample+pass/word0123456789abcdef";
const enc = encodeURIComponent;

const mail = (): Mail => ({
  from: "Beckon <login@beckoncli.com>",
  to: "someone@example.org",
  replyTo: "support@beckoncli.com",
  ...magicLinkEmail(LINK),
});

const lf = (s: string) => s.replace(/\r\n/g, "\n");

let cert: Cert;
let tlsOpts: { ca: string };
beforeAll(() => {
  cert = makeCert();
  tlsOpts = { ca: cert.cert };
});

const servers: { close(): Promise<void> }[] = [];
async function fake(...args: Parameters<typeof startFakeSmtp>) {
  const s = await startFakeSmtp(...args);
  servers.push(s);
  return s;
}

afterEach(async () => {
  resetMailerForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
afterAll(() => resetMailerForTests());

function expectDelivered(received: Awaited<ReturnType<typeof fake>>["received"]) {
  const m = mail();
  expect(received.data).toHaveLength(1);
  expect(received.mailFrom[0]).toContain("<login@beckoncli.com>");
  expect(received.rcptTo[0]).toContain("<someone@example.org>");
  const msg = parseMessage(received.data[0]);
  expect(msg.headers["from"]).toBe("Beckon <login@beckoncli.com>");
  expect(msg.headers["to"]).toBe("someone@example.org");
  expect(msg.headers["reply-to"]).toBe("support@beckoncli.com");
  expect(msg.headers["subject"]).toBe("Sign in to Beckon");
  expect(msg.headers["content-type"]).toMatch(/^multipart\/alternative/);
  const text = msg.parts.find((p) => p.type === "text/plain");
  const html = msg.parts.find((p) => p.type === "text/html");
  expect(lf(text!.content).trim()).toBe(lf(m.text).trim());
  expect(lf(html!.content).trim()).toBe(lf(m.html).trim());
}

describe("SMTP delivery", () => {
  it("delivers over implicit TLS (smtps://, port 465 style) with login and percent-encoded password", async () => {
    const s = await fake({ mode: "implicit-tls" }, cert);
    const env = { SMTP_URL: `smtps://${USER}:${enc(PASS)}@127.0.0.1:${s.port}` };
    await sendMail(mail(), { env, tls: tlsOpts });
    expect(s.received.auth).toEqual([{ user: USER, pass: PASS }]);
    expect(s.received.tlsAtAuth).toEqual([true]);
    expectDelivered(s.received);
  });

  it("delivers over STARTTLS (smtp://, port 587 style) and only authenticates after the upgrade", async () => {
    const s = await fake({ mode: "starttls" }, cert);
    const env = { SMTP_URL: `smtp://${USER}:${enc(PASS)}@127.0.0.1:${s.port}` };
    await sendMail(mail(), { env, tls: tlsOpts });
    expect(s.received.auth).toEqual([{ user: USER, pass: PASS }]);
    expect(s.received.tlsAtAuth).toEqual([true]);
    expectDelivered(s.received);
  });

  it("refuses a smtp:// server that does not offer STARTTLS, before sending credentials or mail", async () => {
    const s = await fake({ mode: "plain" }, cert);
    const env = { SMTP_URL: `smtp://${USER}:${enc(PASS)}@127.0.0.1:${s.port}` };
    await expect(sendMail(mail(), { env, tls: tlsOpts })).rejects.toThrow(/email send failed \(smtp /);
    expect(s.received.auth).toEqual([]);
    expect(s.received.mailFrom).toEqual([]);
    expect(s.received.data).toEqual([]);
  });

  it("verifies the server certificate", async () => {
    const s = await fake({ mode: "implicit-tls" }, cert);
    const env = { SMTP_URL: `smtps://${USER}:${enc(PASS)}@127.0.0.1:${s.port}` };
    // No `ca` for the test certificate: the handshake must fail and nothing may be sent.
    await expect(sendMail(mail(), { env, tls: {} })).rejects.toThrow(/email send failed/);
    expect(s.received.auth).toEqual([]);
    expect(s.received.data).toEqual([]);
  });

  it("creates the transporter once and reuses it", async () => {
    const s = await fake({ mode: "implicit-tls" }, cert);
    const env = { SMTP_URL: `smtps://${USER}:${enc(PASS)}@127.0.0.1:${s.port}` };
    const spy = vi.spyOn(nodemailer, "createTransport");
    await sendMail(mail(), { env, tls: tlsOpts });
    await sendMail(mail(), { env, tls: tlsOpts });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(s.received.data).toHaveLength(2);
  });
});

describe("SMTP options", () => {
  it("defaults the port and TLS mode from the scheme, with timeouts of 10 s", () => {
    const a = smtpOptions("smtps://u:p@email-smtp.eu-west-1.amazonaws.com");
    expect(a).toMatchObject({ host: "email-smtp.eu-west-1.amazonaws.com", port: 465, secure: true, requireTLS: false });
    const b = smtpOptions("smtp://u:p@email-smtp.eu-west-1.amazonaws.com:587");
    expect(b).toMatchObject({ port: 587, secure: false, requireTLS: true });
    for (const o of [a, b]) {
      expect(o.connectionTimeout).toBe(10_000);
      expect(o.greetingTimeout).toBe(10_000);
      expect(o.socketTimeout).toBe(10_000);
      expect(o.tls?.minVersion).toBe("TLSv1.2");
    }
  });

  it("rejects unsupported or malformed values without echoing them", () => {
    expect(() => smtpOptions("http://user:hunter2@mail.example.com")).toThrow(/smtps:\/\/ or smtp:\/\//);
    let msg = "";
    try {
      smtpOptions("not a url but hunter2");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/not a valid URL/);
    expect(msg).not.toContain("hunter2");
  });
});

describe("transport selection", () => {
  it("prefers SMTP over Resend when both are set, and says so once", async () => {
    const s = await fake({ mode: "implicit-tls" }, cert);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { SMTP_URL: `smtps://${USER}:${enc(PASS)}@127.0.0.1:${s.port}`, RESEND_API_KEY: "re_secret_key" };
    await sendMail(mail(), { env, tls: tlsOpts });
    await sendMail(mail(), { env, tls: tlsOpts });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(s.received.data).toHaveLength(2);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes("SMTP_URL and RESEND_API_KEY are both set"))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(PASS);
    expect(lines.join("\n")).not.toContain("re_secret_key");
  });

  it("uses Resend when only RESEND_API_KEY is set, with the same message content", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const m = mail();
    await sendMail(m, { env: { RESEND_API_KEY: "re_key" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_key");
    expect(JSON.parse(init.body as string)).toEqual({
      from: m.from,
      to: m.to,
      reply_to: m.replyTo,
      subject: m.subject,
      text: m.text,
      html: m.html,
    });
  });

  it("reports a failed Resend send by status only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    await expect(sendMail(mail(), { env: { RESEND_API_KEY: "re_key" } })).rejects.toThrow("email send failed: 403");
  });

  it("fails clearly when neither is configured", async () => {
    await expect(sendMail(mail(), { env: {} })).rejects.toThrow(/SMTP_URL \(or RESEND_API_KEY\) is required/);
  });
});

describe("credential redaction", () => {
  it("does not leak the URL or credentials when the server rejects the login and echoes them", async () => {
    const s = await fake({ mode: "implicit-tls", behavior: "reject-auth" }, cert);
    const url = `smtps://${USER}:${enc(PASS)}@127.0.0.1:${s.port}`;
    let err: Error | undefined;
    try {
      await sendMail(mail(), { env: { SMTP_URL: url }, tls: tlsOpts });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/^email send failed \(smtp EAUTH\)/);
    // The fake server put the username and password in its 535 reply; none of it may survive.
    expect(s.received.auth).toEqual([{ user: USER, pass: PASS }]);
    const everything = `${err!.message}\n${err!.stack}\n${String((err as { cause?: unknown }).cause)}`;
    for (const secret of [PASS, enc(PASS), USER, url]) expect(everything).not.toContain(secret);
    expect(err!.message).toContain("[redacted]");
  });

  it("does not leak credentials when the connection is refused", async () => {
    const s = await fake({ mode: "implicit-tls" }, cert);
    const port = s.port;
    await s.close();
    servers.length = 0;
    const url = `smtps://${USER}:${enc(PASS)}@127.0.0.1:${port}`;
    const err = await sendMail(mail(), { env: { SMTP_URL: url }, tls: tlsOpts }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^email send failed \(smtp ESOCKET\)/);
    for (const secret of [PASS, enc(PASS), USER, url]) expect((err as Error).message).not.toContain(secret);
  });

  it("redact() removes the URL, user and password in raw and decoded form", () => {
    const url = `smtp://${USER}:${enc(PASS)}@mail.example.com:587`;
    const out = redact(`bad ${url} / ${USER} / ${PASS} / ${enc(PASS)}`, url);
    expect(out).toBe("bad [redacted] / [redacted] / [redacted] / [redacted]");
  });
});

describe("timeouts", () => {
  it("gives up when the server never sends a greeting", async () => {
    const s = await fake({ mode: "plain", behavior: "silent" }, cert);
    const env = { SMTP_URL: `smtp://${USER}:${enc(PASS)}@127.0.0.1:${s.port}` };
    const t0 = Date.now();
    const err = await sendMail(mail(), { env, tls: tlsOpts, timeoutMs: 300 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^email send failed \(smtp ETIMEDOUT\)/);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(s.received.auth).toEqual([]);
  });

  it("gives up when the server stops answering mid-conversation", async () => {
    const s = await fake({ mode: "plain", behavior: "silent-after-ehlo" }, cert);
    const env = { SMTP_URL: `smtp://${USER}:${enc(PASS)}@127.0.0.1:${s.port}` };
    const t0 = Date.now();
    const err = await sendMail(mail(), { env, tls: tlsOpts, timeoutMs: 300 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^email send failed \(smtp ETIMEDOUT\)/);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect((err as Error).message).not.toContain(PASS);
  });
});
