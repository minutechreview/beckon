import { auth, signOut } from "@/auth";
import { DeleteAccount } from "@/components/DeleteAccount";
import { HelpLinks } from "@/components/HelpLinks";
import { Icon } from "@/components/Icon";
import { PlanPanel } from "@/components/PlanPanel";
import { Settings } from "@/components/Settings";

export default async function Page() {
  const session = await auth();
  const email = session?.user?.email;
  return (
    <>
      <Settings />
      <h2 className="section-title">Plan</h2>
      <PlanPanel />
      <HelpLinks />
      <h2 className="section-title">Account</h2>
      <section className="group" aria-label="Account" data-testid="account">
        <div className="list-row">
          <div className="list-main">
            <span className="list-meta">Signed in as</span>
            <span className="list-title">{email ?? "your account"}</span>
          </div>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/signin" });
            }}
          >
            <button className="btn small" type="submit"><Icon name="signOut" size={18} />Sign out</button>
          </form>
        </div>
      </section>
      {email && <DeleteAccount email={email} />}
    </>
  );
}
