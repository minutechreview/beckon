// Who runs this server and how to reach them, at the top of /terms and /privacy (UK Electronic Commerce Regulations
// 2002, reg. 6: name, geographic address, email).
import type { Legal } from "@/lib/legal";

export function Operator({ legal }: { legal: Legal }) {
  const who = legal.operator || "[operator]";
  const email = legal.contact.support;
  return (
    <p>
      Beckon at {legal.site} is run by {who}
      {legal.hosted ? ", a sole trader in England" : ""} (&quot;we&quot;, &quot;us&quot;).{" "}
      {legal.address ? (
        <>Postal address: {legal.address}. </>
      ) : legal.hosted ? (
        <>Postal address: being set up. Until it is listed here, write to {email} and we will reply with it. </>
      ) : null}
      {email && (
        <>
          Email: <a href={`mailto:${email}`}>{email}</a>.
        </>
      )}
    </p>
  );
}
