// Outbound email for magic links. Transport, in order of precedence:
//   1. SMTP_URL      any SMTP provider (Amazon SES, Postmark, Mailgun, your own relay) through nodemailer
//   2. RESEND_API_KEY  Resend's HTTP API (kept for existing self-hosters)
// Neither set is an error. The dev console fallback lives in auth.ts, which only calls this in production.
import nodemailer from "nodemailer";
import type { SMTPTransportOptions, Transporter } from "nodemailer";

type Env = Record<string, string | undefined>;

export type Mail = {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
};

export type SendOptions = {
  env?: Env;
  /** Connection, greeting and socket timeout in ms. Default 10 s: a hung server must not hang a request. */
  timeoutMs?: number;
  /** TLS overrides, for tests that talk to a server with a private certificate. */
  tls?: SMTPTransportOptions["tls"];
};

const DEFAULT_TIMEOUT_MS = 10_000;

/** Remove every secret-bearing string from a message before it is logged or thrown. */
export function redact(message: string, smtpUrl: string | undefined): string {
  let out = message;
  const secrets = new Set<string>();
  if (smtpUrl) {
    secrets.add(smtpUrl);
    try {
      const u = new URL(smtpUrl);
      for (const s of [u.username, u.password]) {
        if (!s) continue;
        secrets.add(s);
        try {
          secrets.add(decodeURIComponent(s));
        } catch {
          /* not percent-encoded */
        }
      }
    } catch {
      /* not parseable: only the whole string is removed */
    }
  }
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s.length > 0) out = out.split(s).join("[redacted]");
  }
  return out;
}

/** Turns SMTP_URL into nodemailer options. Throws without echoing any part of the URL. */
export function smtpOptions(smtpUrl: string, opts: SendOptions = {}): SMTPTransportOptions {
  let u: URL;
  try {
    u = new URL(smtpUrl);
  } catch {
    throw new Error("SMTP_URL is not a valid URL (expected smtps://USER:PASS@host:465 or smtp://USER:PASS@host:587)");
  }
  if (u.protocol !== "smtps:" && u.protocol !== "smtp:") {
    throw new Error(`SMTP_URL must start with smtps:// or smtp://, not ${u.protocol}//`);
  }
  if (!u.hostname) throw new Error("SMTP_URL has no host");
  const implicitTls = u.protocol === "smtps:";
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const user = u.username ? decodeURIComponent(u.username) : "";
  const pass = u.password ? decodeURIComponent(u.password) : "";
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : implicitTls ? 465 : 587,
    // smtps: TLS from the first byte. smtp: plain connect, then STARTTLS is mandatory (never plaintext auth).
    secure: implicitTls,
    requireTLS: !implicitTls,
    auth: user || pass ? { user, pass } : undefined,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    tls: { minVersion: "TLSv1.2", ...opts.tls },
  };
}

let cached: { url: string; timeoutMs: number; tls: SendOptions["tls"]; transport: Transporter } | undefined;
let warnedBoth = false;

/** One transporter per SMTP_URL, created on first use. */
function transporter(smtpUrl: string, opts: SendOptions): Transporter {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (cached && cached.url === smtpUrl && cached.timeoutMs === timeoutMs && cached.tls === opts.tls) return cached.transport;
  cached?.transport.close();
  const transport = nodemailer.createTransport(smtpOptions(smtpUrl, opts));
  cached = { url: smtpUrl, timeoutMs, tls: opts.tls, transport };
  return transport;
}

/** Test hook: forget the cached transporter and the "both configured" warning. */
export function resetMailerForTests(): void {
  cached?.transport.close();
  cached = undefined;
  warnedBoth = false;
}

async function sendSmtp(smtpUrl: string, mail: Mail, opts: SendOptions): Promise<void> {
  const transport = transporter(smtpUrl, opts);
  try {
    await transport.sendMail({
      from: mail.from,
      to: mail.to,
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    const code = typeof e.code === "string" ? e.code : "ERROR";
    const detail = redact(typeof e.message === "string" ? e.message : "", smtpUrl);
    // No `cause`: nothing from the original error (its command or response fields) is carried along.
    throw new Error(`email send failed (smtp ${code}): ${detail}`);
  }
}

async function sendResend(key: string, mail: Mail): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: mail.from,
      to: mail.to,
      reply_to: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    }),
  });
  if (!res.ok) throw new Error(`email send failed: ${res.status}`);
}

/** Sends through SMTP_URL, else RESEND_API_KEY; throws if neither is configured. */
export async function sendMail(mail: Mail, opts: SendOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const smtpUrl = env.SMTP_URL?.trim();
  const resendKey = env.RESEND_API_KEY;
  if (smtpUrl) {
    if (resendKey && !warnedBoth) {
      warnedBoth = true;
      console.log("[auth] SMTP_URL and RESEND_API_KEY are both set: sending magic links through SMTP");
    }
    return sendSmtp(smtpUrl, mail, opts);
  }
  if (resendKey) return sendResend(resendKey, mail);
  throw new Error("SMTP_URL (or RESEND_API_KEY) is required to send magic links in production");
}
