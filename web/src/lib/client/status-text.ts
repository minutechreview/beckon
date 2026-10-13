// What a response status reads as, in the app and in the service worker's
// result notifications. One table, so the two cannot drift apart.

const TEXT: Record<string, string> = {
  // Server statuses (SPEC §7.4)
  pending: "Waiting for the host…",
  delivered: "Waiting for the host…",
  applied: "Applied",
  rejected_stale: "Already handled",
  expired: "Expired",
  // Client-side outcomes, before or instead of a server status
  not_paired: "Pair this device with the host first",
  unavailable: "Open Beckon to answer",
  rate_limited: "Too many responses; try again in a minute",
  network: "Could not reach the server",
};

/** Why the host refused a response, for each rejected_* status other than rejected_stale. */
export const REJECTION_REASONS: Record<string, string> = {
  rejected_sig: "signature or key check failed",
  rejected_replay: "already seen",
  rejected_option: "option not offered",
  rejected_disabled: "the session is read-only (--no-respond)",
};

/** A POST the server refused without a status of its own is kept as `http_<code>`. */
const HTTP = /^http_([1-5]\d\d)$/;

/**
 * "Rejected: <reason>" for a known rejected_* status, "Rejected by the server
 * (HTTP 400)" for http_400, and plain "Rejected" for anything else unknown.
 */
export const responseStatusText = (status: string): string => {
  const known = TEXT[status];
  if (known) return known;
  const reason = REJECTION_REASONS[status];
  if (reason) return `Rejected: ${reason}`;
  const http = HTTP.exec(status);
  if (http) return `Rejected by the server (HTTP ${http[1]})`;
  return "Rejected";
};
