/**
 * Room for a menu below and above a control (dispatch 29): inside the window
 * and inside every ancestor that would clip it — the modal's scroll area, or
 * a form section still animating open. A dropdown or popover with too little
 * room below opens upward instead of disappearing past an edge.
 */
export function roomAround(el: HTMLElement): { below: number; above: number } {
  const box = el.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === "visible") continue;
    const clip = node.getBoundingClientRect();
    top = Math.max(top, clip.top);
    bottom = Math.min(bottom, clip.bottom);
  }
  return { below: bottom - box.bottom, above: box.top - top };
}
