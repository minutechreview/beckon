import Link from "next/link";
import { Icon } from "@/components/Icon";
import { GITHUB } from "@/lib/site";

export const metadata = { title: "Security · Beckon", description: "What Beckon's server can and cannot see or do, how answers are checked on your machine, and the known limits." };

export default function Security() {
  return (
    <div className="site-inner doc">
      <header className="page-head">
        <p className="eyebrow">Trust</p>
        <h1>Security</h1>
        <p className="lead">
          A tool that tells you when a terminal job needs you, and lets you answer from your phone, has to be built so that a mistake or a breach
          on our side cannot reach your machine. This page is the plain-language version of{" "}
          <a href={`${GITHUB}/blob/main/SECURITY.md`}>SECURITY.md</a>, which has the details and the tests behind each claim.
        </p>
      </header>

      <section aria-labelledby="assume-h">
        <h2 id="assume-h">What we assume</h2>
        <p>An attacker who controls our server and database completely: reading every row, injecting messages, and serving any key they like.</p>
      </section>

      <div className="can-cannot">
        <section className="card" aria-labelledby="can-h">
          <h2 id="can-h"><Icon name="alert" size={20} />What they can still do</h2>
          <ul className="doc-list">
            <li>Hold back or delay messages, so a notification can be late or never arrive.</li>
            <li>See the metadata the server needs to route things: which app, its state (working, blocked, done…), timestamps, your host labels, device names and public keys, and the length of each message.</li>
            <li>Show you a false &quot;X needs permission&quot; line: those routing fields are not signed. They cannot forge the message text.</li>
            <li>Serve you modified web app code. The app is delivered by the server it is protecting you from; see the limits below.</li>
          </ul>
        </section>
        <section className="card" aria-labelledby="cannot-h">
          <h2 id="cannot-h"><Icon name="shield" size={20} />What they cannot do</h2>
          <ul className="doc-list">
            <li><strong>Read your messages, commands or working directories.</strong> The helper encrypts them on your machine to the devices you paired. The server stores ciphertext.</li>
            <li><strong>Change a message or move it to another record.</strong> The helper signs every message and binds it to its session, path and revision; your device checks the signature against the key it pinned when you paired.</li>
            <li><strong>Add a device you did not approve.</strong> Pairing shows the same six words on the host and on the device. If a server swaps keys, the words differ and pairing is refused.</li>
            <li><strong>Type into your terminal.</strong> The helper types only keys for an option it offered itself, for one specific prompt, and only if the answer is signed by a device in its own local list of paired devices. The keys never leave your machine.</li>
          </ul>
        </section>
      </div>

      <section aria-labelledby="check-h">
        <h2 id="check-h">How an answer is checked, on your machine</h2>
        <p>Before typing anything the helper checks, and types nothing if any check fails:</p>
        <ol className="doc-list numbered">
          <li>the signature, against a device in its own list of paired devices;</li>
          <li>that the prompt is still waiting, at the same revision;</li>
          <li>that you haven&apos;t typed an answer at the keyboard since;</li>
          <li>that nobody answered it first;</li>
          <li>that the answer is fresh and not a replay;</li>
          <li>that it names an option the helper offered;</li>
          <li>that the session accepts answers (it wasn&apos;t started with <code>--no-respond</code>);</li>
          <li>for a prompt it detected on screen, that the same prompt is still on screen.</li>
        </ol>
      </section>

      <section aria-labelledby="notif-h">
        <h2 id="notif-h">Notifications</h2>
        <p>
          A push contains a generic line and some IDs. The message text is decrypted on your phone by the app&apos;s service worker, and only if its
          signature checks out. Once shown, it sits in your phone&apos;s notification history; set lock-screen previews to &quot;never&quot; if that
          matters to you. Push services (Google, Apple, Mozilla, Microsoft) learn that a push happened, when, and its size.
        </p>
      </section>

      <section aria-labelledby="helper-h">
        <h2 id="helper-h">The helper and its installer</h2>
        <ul className="doc-list">
          <li>Releases are built in public by a GitHub Actions workflow. Each release has a SHA-256 checksum file, signed keylessly with cosign using the workflow&apos;s identity.</li>
          <li>The installer script downloads the release for your platform, checks the checksum and refuses to install on a mismatch. If <code>cosign</code> is installed it also verifies the signature. It installs to <code>~/.local/bin</code> and never uses sudo.</li>
          <li>The script is served at <a href="/install.sh">/install.sh</a>; read it before you run it. Like any <code>curl | sh</code>, trust in it rests on this site and on the repository.</li>
        </ul>
      </section>

      <section aria-labelledby="svc-h">
        <h2 id="svc-h">On the service</h2>
        <ul className="doc-list">
          <li>HTTPS only, with HSTS, a strict content security policy, no framing, and an Origin check on the live connection.</li>
          <li>Sign-in, device-code and pairing endpoints are rate limited.</li>
          <li>Payments are handled by Stripe. We never see card numbers.</li>
        </ul>
      </section>

      <section className="card limits" aria-labelledby="limits-h">
        <h2 id="limits-h"><Icon name="info" size={20} />Known limits</h2>
        <ul className="doc-list">
          <li>The web app code comes from the server. A compromised server could ship code that misuses your device&apos;s keys while the app is open. End-to-end encryption protects your data at rest and against database leaks, not against a malicious frontend.</li>
          <li>You can still be rushed into approving something dangerous. Beckon proves who answered, not whether the answer was wise. Read the message first.</li>
          <li>Any paired device can answer any prompt on a host that trusts it. There is no second factor, so keep your phone locked and revoke lost devices from Settings.</li>
          <li>There is no forward secrecy: a stolen device key exposes old messages sealed to it.</li>
        </ul>
      </section>

      <section aria-labelledby="report-h">
        <h2 id="report-h">Report a problem</h2>
        <p>Email <strong className="mono">security@beckoncli.com</strong> (please not a public issue). See also the <Link href="/faq">FAQ</Link>.</p>
      </section>
    </div>
  );
}
