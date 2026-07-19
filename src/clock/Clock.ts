// FIDE-style clock.
//   - Both sides tick downward in real-time.
//   - On a player's move, increment is added at the move's *end*.
//   - "Last 10 seconds" pulse fires a low-tick event for sound/UI emphasis.
//   - Server-anchorable via .setLast(serverTsMs) for online-play syncing.
//
// The clock never trusts local elapsed computation for the authoritative
// time when playing online; in that mode the server timestamps drive
// recomputation, but locally we still tick smoothly from performance.now().

export type SideT = "white" | "black";

export interface ClockSnapshot {
  whiteMs: number;
  blackMs: number;
  active: SideT | null; // null when paused
  lastTickAt: number;   // performance.now() ms when last ticked
  lastServerSync?: number; // server-supplied wallClock ms (optional)
  flagFall?: SideT;
}

export interface ClockListeners {
  onTick?: (snap: ClockSnapshot) => void;
  onLowTime?: (side: SideT) => void;
  onFlag?: (side: SideT) => void;
}

export class Clock {
  private whiteMs: number;
  private blackMs: number;
  private incrementMs: number;
  private active: SideT | null = null;
  private lastTickAt = 0;
  private rafHandle = 0;
  private listeners: ClockListeners = {};
  private lowTimeFired = { white: false, black: false };
  private flagFired = false;
  private frozen = false; // when game is over

  constructor(initialSeconds: number, incrementSeconds: number = 0, listeners: ClockListeners = {}) {
    this.whiteMs = initialSeconds * 1000;
    this.blackMs = initialSeconds * 1000;
    this.incrementMs = incrementSeconds * 1000;
    this.listeners = listeners;
  }

  start(initialSide: SideT): void {
    this.active = initialSide;
    this.lastTickAt = performance.now();
    this.scheduleTick();
  }

  pause(): void {
    if (this.active === null) return;
    this.tick(); // commit elapsed
    this.active = null;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.emit();
  }

  resume(side: SideT): void {
    this.active = side;
    this.lastTickAt = performance.now();
    this.scheduleTick();
  }

  setLowTimeListener(fn: (side: SideT) => void) { this.listeners.onLowTime = fn; }

  /** Apply increment to the side that just moved. */
  applyMove(side: SideT): void {
    this.tick(); // commit any partial elapsed
    if (side === "white") this.whiteMs += this.incrementMs;
    else                  this.blackMs += this.incrementMs;
    this.lowTimeFired[side] = false;
    this.active = side === "white" ? "black" : "white";
    this.lastTickAt = performance.now();
    if (!this.frozen) this.scheduleTick();
    this.emit();
  }

  /**
   * Reverse a single `applyMove` (mirror operation). Used by
   * `Game.undoPair()` to subtract the two increments that the move-pair
   * being undone added. Subtracting `incrementMs` and setting `active`
   * back to the undone side keeps the clock consistent with the engine
   * after each `engine.undo()` call.
   */
  unapplyMove(side: SideT): void {
    // On a frozen clock (e.g., game over from `finalize()`), an unapply is
    // a no-op so we don't silently mutate ms or restart active — the
    // frozen invariant should hold even if a take-back is requested
    // post-end. (Game.undoPair already refuses when status !== "playing",
    // so this guard is mostly defensive for direct callers / tests.)
    if (this.frozen) return;
    // Do NOT call `tick()` here: `applyMove(side)` flips `active` to the
    // OTHER side, so calling `tick()` inside `unapplyMove` would debit
    // that newly-active side for any elapsed since the apply. The undo
    // is meant to be instantaneous; the few ms pocketed by `applyMove`'s
    // tick are knowingly left as a tiny inaccuracy.
    if (side === "white") this.whiteMs -= this.incrementMs;
    else                  this.blackMs -= this.incrementMs;
    this.lowTimeFired[side] = false;
    // Return to the side whose move is being undone — that is the side
    // whose TURN it was BEFORE the apply, and which we want to restore
    // as the next-to-move.
    this.active = side;
    this.lastTickAt = performance.now();
    this.scheduleTick();
    this.emit();
  }

  /** Mark clock as finished (mate/stalemate/draw). */
  finalize(): void {
    this.frozen = true;
    this.active = null;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.emit();
  }

  setServerAnchor(serverTsMs: number): void {
    // Server anchors the wall-clock. We recompute elapsed = server - lastSync.
    // Caller is expected to compute new remaining times server-side and pass down
    // via update(), otherwise we trust the local tick.
    this.listeners.onTick?.(this.snapshot());
    void serverTsMs;
  }

  forceUpdate(whiteMs: number, blackMs: number, active: SideT | null): void {
    this.whiteMs = Math.max(0, whiteMs);
    this.blackMs = Math.max(0, blackMs);
    this.active = active;
    this.lastTickAt = performance.now();
    this.emit();
  }

  snapshot(): ClockSnapshot {
    return {
      whiteMs: this.whiteMs,
      blackMs: this.blackMs,
      active: this.active,
      lastTickAt: this.lastTickAt,
      flagFall: this.flagFired
        ? (this.whiteMs <= 0 ? "white" : this.blackMs <= 0 ? "black" : undefined)
        : undefined,
    };
  }

  private scheduleTick() {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    const loop = () => {
      this.tick();
      if (this.active !== null && !this.frozen) {
        this.rafHandle = requestAnimationFrame(loop);
      }
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  /** Test seam: synchronously run one tick step (mirrors the RAF-loop body). */
  _testTick(): void {
    this.tick();
  }

  private tick(): void {
    if (this.active === null || this.frozen) return;
    const now = performance.now();
    const dt = now - this.lastTickAt;
    this.lastTickAt = now;
    if (this.active === "white") this.whiteMs -= dt;
    else                          this.blackMs -= dt;

    // Low-time pulse (last 10s).
    const activeMs = this.active === "white" ? this.whiteMs : this.blackMs;
    if (activeMs <= 10_000 && activeMs > 0 && !this.lowTimeFired[this.active]) {
      this.lowTimeFired[this.active] = true;
      this.listeners.onLowTime?.(this.active);
    }

    // Flag fall.
    if (!this.flagFired && (this.whiteMs <= 0 || this.blackMs <= 0)) {
      this.flagFired = true;
      this.frozen = true;
      this.active = null;
      this.listeners.onFlag?.(this.whiteMs <= 0 ? "white" : "black");
    }

    this.emit();
  }

  private emit(): void {
    this.listeners.onTick?.(this.snapshot());
  }
}

export function formatMs(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}
