// Telling a sideways swipe from a scroll, and when a released swipe dismisses the card.
import { describe, expect, it } from "vitest";
import { swipeAway, swipeAxis } from "@/lib/client/swipe";

describe("swipe to dismiss", () => {
  it("waits until the finger has moved, then picks the clearly dominant axis", () => {
    expect(swipeAxis(4, 3)).toBeNull();
    expect(swipeAxis(-30, 5)).toBe("x");
    expect(swipeAxis(30, 25)).toBe("y"); // diagonal: let the page scroll
    expect(swipeAxis(2, 40)).toBe("y");
  });

  it("dismisses after a third of the width, or a quick flick; otherwise the card springs back", () => {
    expect(swipeAway(150, 360, 1000)).toBe(true);
    expect(swipeAway(-150, 360, 1000)).toBe(true);
    expect(swipeAway(100, 360, 1000)).toBe(false);
    expect(swipeAway(80, 360, 100)).toBe(true); // a flick
    expect(swipeAway(30, 360, 20)).toBe(false); // too short to count, however fast
  });
});
