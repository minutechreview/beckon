import Link from "next/link";
import { auth } from "@/auth";
import { UpgradeButton } from "@/components/BillingButtons";
import { Icon } from "@/components/Icon";
import { PLAN_LIMITS } from "@/lib/plans";
import { DOCS } from "@/lib/site";

export const metadata = { title: "Pricing · Beckon", description: "Free for one machine and two devices. Pro is $8 a month or $80 a year for unlimited machines, devices and 30 days of history." };

function Feature({ children }: { children: React.ReactNode }) {
  return <li><Icon name="check" size={18} strokeWidth={2.2} />{children}</li>;
}

export default async function Pricing({ searchParams }: { searchParams: Promise<{ billing?: string }> }) {
  const signedIn = Boolean((await auth())?.user);
  const sp = await searchParams;
  const free = PLAN_LIMITS.free;
  const pro = PLAN_LIMITS.pro;
  return (
    <div className="site-inner pricing">
      <header className="page-head">
        <h1>Pricing</h1>
        <p className="lead">Start free on one machine. Upgrade when Beckon is watching more than one. Every plan has end-to-end encryption, notifications and answers.</p>
      </header>
      {sp.billing === "canceled" && (
        <p className="notice info" role="status"><Icon name="info" size={18} /><span>Checkout was cancelled. Nothing was charged.</span></p>
      )}
      <div className="plans">
        <section className="card plan" data-testid="plan-free" aria-labelledby="plan-free-h">
          <h2 id="plan-free-h">Free</h2>
          <p className="price">$0</p>
          <p className="plan-for">For trying Beckon with one agent machine.</p>
          <ul className="plan-features">
            <Feature>{free.hosts} host</Feature>
            <Feature>{free.devices} devices</Feature>
            <Feature>{free.historyHours} hours of history</Feature>
            <Feature>Push notifications and approve/deny</Feature>
          </ul>
          <Link className="btn large block" href={signedIn ? "/app" : "/signin?callbackUrl=%2Fapp%2Fstart"}>{signedIn ? "Open app" : "Get started"}</Link>
        </section>
        <section className="card plan pro" data-testid="plan-pro" aria-labelledby="plan-pro-h">
          <h2 id="plan-pro-h">Pro</h2>
          <p className="price">$8<span>/month</span> <span className="alt">or $80/year, two months free</span></p>
          <p className="plan-for">For every machine you run agents and long jobs on.</p>
          <ul className="plan-features">
            <Feature>Unlimited hosts and devices</Feature>
            <Feature>{pro.historyHours / 24} days of history</Feature>
            <Feature>Per-app notification rules</Feature>
            <Feature>Everything in Free</Feature>
          </ul>
          <div className="plan-actions">
            <UpgradeButton interval="month" signedIn={signedIn} label="Upgrade · $8/month" />
            <UpgradeButton interval="year" signedIn={signedIn} label="Upgrade · $80/year" />
          </div>
        </section>
      </div>

      <section className="pricing-notes" aria-labelledby="notes-h">
        <h2 id="notes-h" className="section-h">Good to know</h2>
        <dl className="qa">
          <div><dt>Can I cancel any time?</dt><dd>Yes, from Settings. Pro stays until the end of the period you paid for. Changed your mind? Ask within 14 days of your first payment, or of a yearly renewal, for a full refund.</dd></div>
          <div><dt>What if I downgrade?</dt><dd>Nothing is deleted. Your most recently active host stays enabled, and saved per-app rules are kept until you upgrade again.</dd></div>
          <div><dt>Who handles payment?</dt><dd>Link, Stripe&apos;s merchant of record service. Link charges your card, works out and pays the tax, and sends receipts. Card details never reach Beckon.</dd></div>
          <div><dt>Rather run it yourself?</dt><dd>The server is open source. <a href={`${DOCS}/self-hosting.md`}>Self-host it</a> on one Linux VM.</dd></div>
        </dl>
        <p className="pricing-fine">
          Prices are in US dollars and include any VAT or sales tax. <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link>
        </p>
      </section>
    </div>
  );
}
