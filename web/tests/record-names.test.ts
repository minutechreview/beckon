import { describe, expect, it } from "vitest";
import { idAddsToTitle } from "@/lib/client/labels";

describe("idAddsToTitle", () => {
  it("is false when the title already says what the id does", () => {
    expect(idAddsToTitle("stage-1", "Stage 1/5: Foundation")).toBe(false);
    expect(idAddsToTitle("stage-12", "Stage 12/12: Launch")).toBe(false);
    expect(idAddsToTitle("Build", "build")).toBe(false);
  });
  it("is true when the id tells the record apart", () => {
    expect(idAddsToTitle("us-east", "Deploying")).toBe(true);
    expect(idAddsToTitle("stage-2", "Stage 1/5: Foundation")).toBe(true);
    expect(idAddsToTitle("test_unit", "Running tests")).toBe(true);
  });
});
