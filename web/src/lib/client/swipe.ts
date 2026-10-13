"use client";

import { useRef } from "react";

/** How far a finger moves before we decide between a swipe and a scroll. */
const SLOP = 10;

/** Which way a gesture is going once it has moved past the slop: a sideways swipe, a scroll, or not yet known. */
export function swipeAxis(dx: number, dy: number): "x" | "y" | null {
  if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.5 ? "x" : "y";
}

/** Whether a released swipe throws the card away: dragged over a third of its width, or flicked fast. */
export function swipeAway(dx: number, width: number, ms: number): boolean {
  const d = Math.abs(dx);
  return d > width * 0.35 || (d > 48 && d / Math.max(ms, 1) > 0.6);
}

const SLIDE_MS = 180;
const COLLAPSE_MS = 160;

interface Gesture { id: number; x: number; y: number; t: number; axis: "x" | "y" | null; dx: number }

/**
 * Swipe a card left or right to throw it away, like an email app. Touch and pen only: a mouse drag selects text.
 * `wrap` holds the card and the hint behind it; `card` is what moves. A swipe never ends in a click, so a
 * finger that starts on a button and swipes away doesn't press it.
 */
export function useSwipeAway(onAway: () => void) {
  const wrap = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const g = useRef<Gesture | null>(null);
  const swiped = useRef(false);

  const move = (dx: number, animate: boolean) => {
    const el = card.current;
    if (!el) return;
    el.style.transition = animate ? `transform ${SLIDE_MS}ms var(--ease), opacity ${SLIDE_MS}ms var(--ease)` : "none";
    el.style.transform = dx ? `translateX(${dx}px)` : "";
    el.style.opacity = dx ? String(Math.max(0.3, 1 - Math.abs(dx) / el.offsetWidth)) : "";
    if (wrap.current) wrap.current.dataset.swipe = dx > 0 ? "right" : dx < 0 ? "left" : "";
  };

  const away = (dir: number) => {
    const w = wrap.current;
    move(dir * (card.current?.offsetWidth ?? 400) * 1.1, true);
    setTimeout(() => {
      if (w) {
        // Close the gap so the cards below slide up instead of jumping.
        w.style.height = `${w.offsetHeight}px`;
        requestAnimationFrame(() => {
          w.style.transition = `height ${COLLAPSE_MS}ms var(--ease), margin ${COLLAPSE_MS}ms var(--ease)`;
          w.style.height = "0";
          w.style.marginBottom = "0";
        });
      }
      setTimeout(onAway, COLLAPSE_MS);
    }, SLIDE_MS);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" || !e.isPrimary) return;
    g.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, axis: null, dx: 0 };
    swiped.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x;
    if (!s.axis) {
      s.axis = swipeAxis(dx, e.clientY - s.y);
      if (s.axis === "y") return void (g.current = null); // a scroll: leave it to the browser
      if (!s.axis) return;
      try {
        card.current?.setPointerCapture(e.pointerId); // keep the moves coming if the finger leaves the card
      } catch {}
    }
    s.dx = dx;
    move(dx, false);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = g.current;
    g.current = null;
    if (!s || s.axis !== "x" || e.pointerId !== s.id) return;
    swiped.current = true;
    if (swipeAway(s.dx, card.current?.offsetWidth ?? 400, e.timeStamp - s.t)) away(Math.sign(s.dx));
    else move(0, true);
  };
  const onPointerCancel = () => {
    if (g.current?.axis === "x") move(0, true);
    g.current = null;
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (!swiped.current) return;
    swiped.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return { wrap, card, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture } };
}
