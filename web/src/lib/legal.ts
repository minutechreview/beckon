// Who runs this server, for the privacy policy and the terms, and where people write to. On beckoncli.com (and on a
// dev server with no origin configured) the defaults are the hosted service's. Anywhere else they are blank until set
// with BECKON_OPERATOR, BECKON_LEGAL_COUNTRY and BECKON_SUPPORT_EMAIL, and the pages show a draft banner meanwhile.
// BECKON_LEGAL_ADDRESS is the operator's geographic address (UK Electronic Commerce Regulations 2002, reg. 6).
import { isHostedService, siteOrigin, type Env } from "@/lib/config";

export interface Legal {
  /** A legal name, or a business name and its owner. */
  operator: string;
  /** A geographic (postal) address, or "" while there is none to publish. */
  address: string;
  /** The country whose law applies. */
  country: string;
  /** The date the current policies took effect (YYYY-MM-DD). */
  effective: string;
  /** The host name the policies are about, e.g. beckoncli.com. */
  site: string;
  /** The hosted service at beckoncli.com, whose pages say more: who the sole trader is, and the card statement text. */
  hosted: boolean;
  contact: { support: string; privacy: string; security: string };
}

const HOSTED = {
  operator: "Jay Stewart",
  // A business address service is being set up. Until it is, the pages say so and give the address by email.
  address: "",
  country: "England and Wales",
  effective: "2026-10-11",
  contact: { support: "support@beckoncli.com", privacy: "privacy@beckoncli.com", security: "security@beckoncli.com" },
};

const BLANK = { operator: "", address: "", country: "", effective: "", contact: { support: "", privacy: "", security: "" } };

export function legal(env: Env = process.env): Legal {
  const hosted = isHostedService(env);
  const base = hosted ? HOSTED : BLANK;
  const support = env.BECKON_SUPPORT_EMAIL || base.contact.support;
  return {
    operator: env.BECKON_OPERATOR || base.operator,
    address: env.BECKON_LEGAL_ADDRESS || base.address,
    country: env.BECKON_LEGAL_COUNTRY || base.country,
    effective: env.BECKON_LEGAL_EFFECTIVE || base.effective,
    site: new URL(siteOrigin(env)).host,
    hosted,
    contact: {
      support,
      privacy: env.BECKON_PRIVACY_EMAIL || base.contact.privacy || support,
      security: env.BECKON_SECURITY_EMAIL || base.contact.security || support,
    },
  };
}

/** This server's details, read once at start-up. */
export const LEGAL = legal();

export const legalComplete = (l: Legal = LEGAL) => l.operator !== "" && l.country !== "" && l.contact.support !== "";
