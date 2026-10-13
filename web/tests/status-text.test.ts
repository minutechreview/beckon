import { describe, expect, it } from "vitest";
import { REJECTION_REASONS, responseStatusText } from "@/lib/client/status-text";

describe("responseStatusText", () => {
  it("reads the ordinary statuses plainly", () => {
    expect(responseStatusText("pending")).toBe("Waiting for the host…");
    expect(responseStatusText("applied")).toBe("Applied");
    expect(responseStatusText("rejected_stale")).toBe("Already handled");
    expect(responseStatusText("expired")).toBe("Expired");
    expect(responseStatusText("network")).toBe("Could not reach the server");
  });

  it("says why the host rejected a response", () => {
    expect(responseStatusText("rejected_sig")).toBe("Rejected: signature or key check failed");
    expect(responseStatusText("rejected_replay")).toBe("Rejected: already seen");
    expect(responseStatusText("rejected_option")).toBe("Rejected: option not offered");
    expect(responseStatusText("rejected_disabled")).toBe("Rejected: the session is read-only (--no-respond)");
    for (const s of Object.keys(REJECTION_REASONS)) expect(responseStatusText(s)).toMatch(/^Rejected: ./);
  });

  it("keeps the HTTP code when the server refused the POST without a status", () => {
    expect(responseStatusText("http_400")).toBe("Rejected by the server (HTTP 400)");
    expect(responseStatusText("http_503")).toBe("Rejected by the server (HTTP 503)");
    expect(responseStatusText("http_99")).toBe("Rejected");
  });

  it("reads anything unknown as plain Rejected", () => {
    expect(responseStatusText("rejected_something_new")).toBe("Rejected");
    expect(responseStatusText("rejected")).toBe("Rejected");
    expect(responseStatusText("")).toBe("Rejected");
  });
});
