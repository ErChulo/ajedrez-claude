// GSAP animation helpers.
//   - Tweens for 2D pieces (position via transform).
//   - Move, capture, castle, en passant, promotion all funnel here with
//     distinct durations/eases so the visual language is consistent.
//   - Honors a "reduced motion" preference (set on html by accessibility hook).

import gsap from "gsap";

export interface TweenOptions {
  /** delay in seconds before starting */
  delay?: number;
  /** override duration */
  duration?: number;
  /** override ease */
  ease?: string;
  /** callback on complete */
  onComplete?: () => void;
}

const DURATION = {
  move: 0.22,
  capture: 0.28,
  castle: 0.32,
  promote: 0.4,
  illegal: 0.08,
};

function reduced(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function pick<T>(normal: T, alt: T): T {
  return reduced() ? alt : normal;
}

export function tweenMove(el: HTMLElement, to: { x: number; y: number; scale?: number }, o: TweenOptions = {}) {
  return gsap.to(el, {
    x: to.x,
    y: to.y,
    scale: to.scale ?? 1,
    duration: pick(o.duration ?? DURATION.move, 0.05),
    ease: o.ease ?? "power2.out",
    delay: o.delay ?? 0,
    onComplete: o.onComplete,
  });
}

export function tweenCapture(el: HTMLElement, o: TweenOptions = {}) {
  return gsap.to(el, {
    opacity: 0,
    scale: 0.6,
    duration: pick(o.duration ?? DURATION.capture, 0.04),
    ease: "power2.in",
    delay: o.delay ?? 0,
    onComplete: o.onComplete,
  });
}

export function tweenAppear(el: HTMLElement, o: TweenOptions = {}) {
  return gsap.fromTo(el,
    { opacity: 0, scale: 0.4 },
    { opacity: 1, scale: 1, duration: pick(o.duration ?? DURATION.promote, 0.06), ease: "back.out(1.6)", onComplete: o.onComplete, delay: o.delay ?? 0 }
  );
}

export function tweenIllegalShake(el: HTMLElement) {
  return gsap.fromTo(el,
    { x: -2 },
    { x: 0, duration: pick(DURATION.illegal, 0.02), ease: "power2.inOut", yoyo: true, repeat: 3 }
  );
}

export function tweenLowTimePulse(el: HTMLElement) {
  return gsap.to(el, { scale: 1.06, duration: 0.4, ease: "sine.inOut", yoyo: true, repeat: -1 });
}

export function killTweensOf(target: gsap.TweenTarget) {
  gsap.killTweensOf(target);
}
