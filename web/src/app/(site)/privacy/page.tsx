import { Operator } from "@/components/Operator";
import { LEGAL, legalComplete } from "@/lib/legal";

export const metadata = { title: "Privacy policy · Beckon" };

// A UK GDPR Art. 13 notice. Every retention period here must stay true: they come from lib/retention.ts (hourly),
// the Auth.js settings in auth.ts, Docker's log cap in deploy/vm/bootstrap.sh and the backup expiry in docs/deploy.md.
export default function Privacy() {
  const who = LEGAL.operator || "[operator]";
  const privacy = LEGAL.contact.privacy || "[privacy email]";
  return (
    <div className="site-inner prose">
      {!legalComplete() && (
        <p className="draft" role="note">DRAFT: the operator and governing country are not filled in yet.</p>
      )}
      <h1>Privacy policy</h1>
      <p>Effective {LEGAL.effective}.</p>
      <Operator legal={LEGAL} />
      <p>
        {who} is the controller of the personal data described here, under the UK GDPR and the Data Protection Act 2018. In short: we keep
        what we need to relay your sessions and run your account. We cannot read your message text, and there are no ads, no analytics or
        tracking scripts, and we never sell data.
      </p>

      <h2>What we store, why, and our lawful basis</h2>
      <ul>
        <li>
          <strong>Account:</strong> your email address, and the GitHub account link if you sign in with GitHub. If you signed up by email first, we link your GitHub account to it only when GitHub confirms the same address is verified. To sign you in and send
          service emails. <em>Basis: contract.</em>
        </li>
        <li>
          <strong>Your machines and devices:</strong> host labels, device names, public keys, when each was last seen, and each device&apos;s
          push subscription (which lets us send it notifications). To relay sessions and notifications. <em>Basis: contract.</em>
        </li>
        <li>
          <strong>Session metadata we can read:</strong> the program&apos;s name, its state (idle, working, blocked, done, error), the kind of
          prompt, progress, the record path, timestamps and exit code. To show your sessions and decide when to notify you.{" "}
          <em>Basis: contract.</em>
        </li>
        <li>
          <strong>Content we cannot read:</strong> message text, titles, commands and working directories are stored only as ciphertext sealed
          to your paired devices. <em>Basis: contract.</em>
        </li>
        <li>
          <strong>Your settings:</strong> notification preferences (time zone, quiet hours, per-state and per-app switches).{" "}
          <em>Basis: contract.</em>
        </li>
        <li>
          <strong>Operational records:</strong> a log of notification decisions (without message text), used for rate limits and summaries.{" "}
          <em>Basis: contract.</em> An audit log of response attempts (which device, which prompt, and the outcome), so we can see what
          answered a prompt and spot misuse. <em>Basis: legitimate interests (security).</em>
        </li>
        <li>
          <strong>Billing:</strong> your plan, its renewal or end date, and the customer and subscription identifiers Stripe gives us. To know
          which plan you are on. <em>Basis: contract.</em>
        </li>
        <li>
          <strong>Security records:</strong> our web server logs each request&apos;s IP address, time, path (without query strings), status and
          browser user agent. Rate limits store a one-way hash of your IP address (or its /64 network for IPv6), your email address or your account
          ID, for the length of the limit window. To keep accounts and the service secure and stop abuse.{" "}
          <em>Basis: legitimate interests (security).</em>
        </li>
      </ul>
      <p>
        An email address is needed to have an account. We do not send marketing email. Nothing here involves automated decisions with legal
        or similarly significant effects on you.
      </p>

      <h2>Payments</h2>
      <p>
        Pro subscriptions are sold through Link, Stripe&apos;s merchant of record service. Link and Stripe collect your payment and billing
        details (name, address, card) as an independent controller under their own privacy policies; card details never reach us. We
        receive your Stripe customer and subscription identifiers, the subscription&apos;s status and its renewal or end date.
      </p>

      <h2>Who else handles data</h2>
      <ul>
        <li>Hetzner hosts the service and its database in Helsinki, Finland (EU).</li>
        <li>Cloudflare provides DNS, forwards mail sent to our addresses, and stores our encrypted backups (in North America).</li>
        <li>Stripe and Link handle payments, as above.</li>
        <li>Amazon Web Services (Amazon SES, EU (Ireland) region) delivers sign-in emails.</li>
        <li>GitHub, if you choose to sign in with it.</li>
        <li>Browser push services (Google, Apple, Mozilla, Microsoft) relay notifications. They see that a push happened, when, and its size, not its content.</li>
      </ul>
      <p>
        Some of these companies are in the United States. Where personal data leaves the UK, it is protected by the UK&apos;s adequacy
        regulations (including the UK-US data bridge for certified companies) or by the UK International Data Transfer Addendum to the
        providers&apos; standard contractual clauses. Ask us for details.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>State-change history: 24 hours on the Free plan, 30 days on Pro.</li>
        <li>Sign-in links: expire after 15 minutes and are deleted within the hour after that.</li>
        <li>Pairing requests and helper sign-in codes: deleted a day after they expire.</li>
        <li>Notification decision logs: deleted after 7 days.</li>
        <li>Rate-limit counters: deleted within the hour after their window ends.</li>
        <li>Your signed-in session: a cookie that lasts up to 30 days; we keep no copy of it.</li>
        <li>Server logs: overwritten as they rotate (each service keeps at most 30 MB), usually within days.</li>
        <li>Backups: encrypted database backups are kept for up to 90 days, then deleted automatically.</li>
        <li>Everything else, including the response audit log: until you delete it or delete your account.</li>
        <li>Payment records: kept by Stripe and Link as the law requires them to. We keep none after you delete your account.</li>
      </ul>

      <h2>Deleting your data</h2>
      <p>
        Settings → Delete account cancels any subscription and deletes all of the data above from the live service, immediately. Copies in
        backups expire within 90 days and are only used to recover from a failure.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of your data, to correct it, to delete it, to restrict how we use it, or to have it in a portable format. Much
        of this is in Settings; for anything else write to {privacy} and we will reply within one month.
      </p>
      <p>
        <strong>You can object at any time</strong> to our use of your data based on legitimate interests (the security records and response
        audit log above). We will stop unless we have compelling grounds, such as preventing abuse of the service or of your account.
      </p>
      <p>
        If you are unhappy with how we handle your data, please tell us first. You can also complain to the UK Information
        Commissioner&apos;s Office (<a href="https://ico.org.uk/make-a-complaint/" rel="noopener noreferrer">ico.org.uk/make-a-complaint</a>,
        0303 123 1113) or, in the EU, to your national data protection authority.
      </p>

      <h2>Cookies and browser storage</h2>
      <p>
        Only what the service needs to work, so there is no consent banner: a session cookie while you are signed in, short-lived security
        cookies during sign-in, and a cookie listing which of your hosts this browser is paired with, so pages draw correctly. Your
        device&apos;s encryption keys stay in the browser&apos;s own storage and never leave it. No analytics or advertising cookies.
      </p>

      <h2>Children</h2>
      <p>Beckon is not for anyone under 16, and we do not knowingly collect their data.</p>

      <h2>Changes</h2>
      <p>We will update this page when what we do changes, and email account holders about significant changes before they take effect.</p>
    </div>
  );
}
