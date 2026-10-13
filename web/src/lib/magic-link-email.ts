// The sign-in email. Plain text plus a matching simple HTML part (no images, no tracking): a text-only message
// with one long link is the shape spam filters associate with phishing. Replies go to a mailbox that exists.

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function magicLinkEmail(url: string, minutes = 15) {
  const host = new URL(url).host;
  const subject = "Sign in to Beckon";
  const text = [
    `Hi,`,
    ``,
    `Use this link to sign in to Beckon (${host}):`,
    ``,
    url,
    ``,
    `The link works once and expires in ${minutes} minutes.`,
    `If you didn't ask to sign in, you can ignore this email: nobody can sign in without the link.`,
    ``,
    `Beckon, a remote inbox for terminal agents`,
    `https://${host}`,
  ].join("\n");
  const u = escapeHtml(url);
  const h = escapeHtml(host);
  const html = `<!doctype html>
<html lang="en">
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1f2328; line-height: 1.5;">
<p>Hi,</p>
<p>Use this button to sign in to Beckon (${h}):</p>
<p><a href="${u}" style="display: inline-block; padding: 10px 18px; background: #1f2328; color: #ffffff; text-decoration: none; border-radius: 6px;">Sign in to Beckon</a></p>
<p>Or paste this link into your browser:<br><a href="${u}">${u}</a></p>
<p>The link works once and expires in ${minutes} minutes. If you didn't ask to sign in, you can ignore this email: nobody can sign in without the link.</p>
<p style="color: #59636e; font-size: 13px;">Beckon, a remote inbox for terminal agents · <a href="https://${h}" style="color: #59636e;">${h}</a></p>
</body>
</html>`;
  return { subject, text, html };
}
