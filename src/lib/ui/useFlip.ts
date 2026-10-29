"use client";

import { useLayoutEffect, useRef } from "react";

type Point = { x: number; y: number };

/**
 * FLIP reordering for keyed list items: after the order changes, each item
 * animates from its previous slot to its new one (transform only); new items
 * fade in. Positions are measured relative to the list element, so page scroll
 * or content inserted above the list never produces false movement.
 * Skipped entirely under prefers-reduced-motion.
 */
export function useFlip(order: string[]) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const slots = useRef(new Map<string, Point>());
  const key = order.join("|");

  useLayoutEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, Point>();
    for (const [id, el] of nodes.current) {
      const parent = el.parentElement?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      next.set(id, { x: r.left - (parent?.left ?? 0), y: r.top - (parent?.top ?? 0) });
    }
    if (!reduce && slots.current.size) {
      for (const [id, el] of nodes.current) {
        const before = slots.current.get(id);
        const after = next.get(id)!;
        if (!before) {
          el.animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], {
            duration: 460,
            easing: "cubic-bezier(.2,.7,.2,1)",
          });
          continue;
        }
        const dx = before.x - after.x;
        const dy = before.y - after.y;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
            duration: 560,
            easing: "cubic-bezier(.2,.7,.2,1)",
          });
        }
      }
    }
    slots.current = next;
  }, [key]);

  return (id: string) => (el: HTMLElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  };
}
