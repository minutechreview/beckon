import { Operator } from "@/components/Operator";
import { LEGAL, legalComplete } from "@/lib/legal";

export const metadata = { title: "Terms of service · Beckon" };

// A plain-language draft, not reviewed by a lawyer, written against the Consumer Rights Act 2015 (no exclusion of
// reasonable care and skill, death or injury, or fraud; a liability cap for business users only), the Consumer
// Contracts Regulations 2013 (a full refund on request within 14 days) and the E-Commerce Regulations 2002 (reg. 6).
export default function Terms() {
  const country = LEGAL.country || "[country]";
  const support = LEGAL.contact.support || "[support email]";
  const ukCourts = LEGAL.country === "England and Wales";
  return (
    <div className="site-inner prose">
      {!legalComplete() && (
        <p className="draft" role="note">DRAFT: the operator and governing country are not filled in yet.</p>
      )}
      <h1>Terms of service</h1>
      <p>Effective {LEGAL.effective}.</p>
      <Operator legal={LEGAL} />
      <p>
        These terms apply when you use Beckon. By creating an account you agree to them; if you use Beckon for work, you agree to them for
        your organisation too. If you are a consumer (using Beckon for yourself, not for a business), you also have legal rights that these
        terms do not take away.
      </p>

      <h2>1. The service</h2>
      <p>
        Beckon relays status from commands you run to your own devices, and relays your signed answers back. Message text is encrypted on
        your machine to your paired devices, and we cannot read it. You are responsible for the machines you connect, the devices you pair,
        and keeping access to your email account secure. You must be at least 16 to have an account, and 18 to buy Pro.
      </p>

      <h2>2. Your responsibility for approvals</h2>
      <p>
        Beckon can carry an approval from your phone to a terminal. Approving an action is your decision. We do not judge whether what a
        program asks is safe, and we are not responsible for what you approve or for actions taken by programs you run.
      </p>

      <h2>3. Acceptable use</h2>
      <p>
        Do not use Beckon to attack others, to break the law, to get around plan limits, or to interfere with its operation. We may suspend or
        close an account that breaks these rules; where it is reasonable we will warn you first, and for a paid account we will tell you why,
        except where the law prevents it.
      </p>

      <h2>4. Plans, payment and cancelling</h2>
      <ul>
        <li>Free costs nothing. Free and Pro are described on the pricing page. We may change what Free includes, with notice.</li>
        <li>
          Pro is paid in advance, monthly or yearly. <strong>Prices include any VAT or sales tax.</strong> Checkout may show the price
          converted into your currency.
        </li>
        <li>
          Payments are handled by <strong>Link, Stripe&apos;s merchant of record service</strong>: Link sells the subscription to you on our
          behalf, charges your card, collects and pays the tax, and sends receipts. Link&apos;s own terms apply to the payment.
          {LEGAL.hosted && <> Your card statement shows &quot;LINK.COM*&quot; followed by BECKONCLI.COM (shortened to fit).</>}
        </li>
        <li>
          A subscription renews automatically at the end of each month or year until you cancel. Cancel any time in Settings, or through
          Link. Pro then stays until the end of the period you paid for.
        </li>
        <li>
          <strong>Refunds:</strong> if you ask within 14 days of your first payment, or of a yearly renewal, we refund that payment in full.
          Otherwise we do not refund part-used periods, except where the law requires it or we close the service (section 5). To ask, email{" "}
          {support} or contact Link support.
        </li>
        <li>If we change prices, we will email Pro subscribers at least 30 days before the first renewal at the new price, so you can cancel first.</li>
        <li>
          If you move back to Free, nothing is deleted: your most recently active host stays enabled, and saved per-app rules are kept until you
          upgrade again.
        </li>
      </ul>

      <h2>5. Availability and changes to the service</h2>
      <p>
        We work to keep Beckon running, but we cannot promise it will always be available or error-free. Notifications can be delayed or
        lost, so do not rely on Beckon alone for anything safety-critical. We may change features. If we close Beckon, we will give at least
        30 days&apos; notice by email and refund any paid time you have not used.
      </p>

      <h2>6. Our responsibility to you</h2>
      <ul>
        <li>
          We provide Beckon with reasonable care and skill. If you are a consumer, you have legal rights in relation to services that are not
          provided that way, and nothing in these terms affects them.
        </li>
        <li>
          We are responsible for loss you suffer that is a foreseeable result of our breaking these terms or our negligence. We are not
          responsible for loss that was not foreseeable, or for what programs you run do after you approve them (section 2).
        </li>
        <li>
          If you use Beckon for a business, we are not liable for loss of profit, revenue, business, goodwill or data, and our total liability
          for all claims in any 12 months is limited to the greater of what you paid us in those 12 months and £100.
        </li>
        <li>
          Nothing in these terms limits liability that the law does not allow us to limit, including for death or personal injury caused by
          negligence, or for fraud.
        </li>
      </ul>

      <h2>7. Ending</h2>
      <p>
        You can stop using Beckon and delete your account at any time in Settings. Deleting it also cancels Pro at once; within the 14 days
        in section 4 you can still ask for a refund. We can close an account under section 3, or as part of closing the service under
        section 5.
      </p>

      <h2>8. Changes to these terms</h2>
      <p>
        We will email account holders about material changes at least 30 days before they apply. If you do not agree, you can cancel and
        delete your account before then, and we will refund paid time you have not used.
      </p>

      <h2>9. Complaints and law</h2>
      <p>
        If something goes wrong, email {support}; we aim to reply within five working days. These terms are governed by the law of {country}
        {ukCourts ? (
          <>
            , and claims go to the courts of England and Wales. If you are a consumer living in Scotland or Northern Ireland, you can also bring a
            claim in your local courts.
          </>
        ) : (
          <>, without affecting mandatory consumer protections where you live.</>
        )}
      </p>
    </div>
  );
}
