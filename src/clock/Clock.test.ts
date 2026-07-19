import { describe, it, expect } from "vitest";
import { Clock, formatMs } from "./Clock";

describe("Clock — FIDE rules", () => {
  it("formatMs pads correctly", () => {
    expect(formatMs(0)).toBe("00:00");
    expect(formatMs(9_500)).toBe("00:10");
    expect(formatMs(60_000)).toBe("01:00");
    expect(formatMs(3_661_000)).toBe("01:01:01");
  });

  it("applies increment to the side that just moved", () => {
    const clock = new Clock(60, 5, { onTick: () => {} });
    clock.start("white");
    clock.applyMove("white");
    const snap = clock.snapshot();
    // Tick happens synchronously inside applyMove, so a fraction of a ms may
    // be debited; we use a 100ms tolerance.
    expect(Math.abs(snap.whiteMs - 65_000)).toBeLessThan(100);
    expect(snap.active).toBe("black");
  });

  it("emits low-time event when a side dips below 10s", () => {
    const fires: ("white"|"black")[] = [];
    const clock = new Clock(60, 0, { onLowTime: (s) => fires.push(s) });
    clock.start("white");
    clock.forceUpdate(8_000, 60_000, "white");
    clock._testTick();
    expect(fires).toContain("white");
  });

  it("fires onFlag when time runs out", () => {
    let fell: "white"|"black"|null = null;
    const clock = new Clock(60, 0, { onFlag: (s) => { fell = s; } });
    clock.start("white");
    clock.forceUpdate(-1, 60_000, "white");
    clock._testTick();
    expect(fell === "white" || fell === "black").toBeTruthy();
  });

  it("finalize stops ticking", () => {
    const clock = new Clock(60, 0, { onTick: () => {} });
    clock.start("white");
    clock.finalize();
    expect(clock.snapshot().active).toBeNull();
  });
});

describe("Clock.unapplyMove parity (mirror of applyMove)", () => {
  // v1.2 polish: Game.undoPair() depends on unapplyMove being the exact
  // inverse of applyMove. If parity ever drifts the engine and clock fall
  // out of sync after a take-back, so these tests lay down the contract.

  it("applyMove(side) then unapplyMove(side) restores exact ms and active state", () => {
    const clock = new Clock(60, 5, { onTick: () => {} });
    clock.start("white");
    const before = clock.snapshot();
    clock.applyMove("white");
    clock.unapplyMove("white");
    const after = clock.snapshot();
    expect(Math.abs(after.whiteMs - before.whiteMs)).toBeLessThan(2);
    expect(Math.abs(after.blackMs - before.blackMs)).toBeLessThan(2);
    expect(after.active).toBe(before.active);
  });

  it("applyMove adds +increment_ms; unapplyMove removes it cleanly", () => {
    const clock = new Clock(60, 5, { onTick: () => {} });
    clock.start("white");
    clock.forceUpdate(60_000, 60_000, "white");
    clock.applyMove("white");
    const afterApply = clock.snapshot();
    expect(Math.abs(afterApply.whiteMs - 65_000)).toBeLessThan(2);
    expect(afterApply.active).toBe("black");
    clock.unapplyMove("white");
    const afterUnapply = clock.snapshot();
    expect(Math.abs(afterUnapply.whiteMs - 60_000)).toBeLessThan(2);
    expect(afterUnapply.active).toBe("white");
  });

  it("unapplyMove doesn't disturb the side that wasn't active", () => {
    const clock = new Clock(60, 0, { onTick: () => {} });
    clock.start("white");
    clock.applyMove("white");
    const blackAfterApply = clock.snapshot().blackMs;
    clock.unapplyMove("white");
    expect(Math.abs(clock.snapshot().blackMs - blackAfterApply)).toBeLessThan(2);
  });

  it("apply → unapply round-trips cleanly across the canonical 2-ply sequence", () => {
    // This mirrors Game.undoPair()'s actual call ordering: it plays two
    // plies (one human, one AI), then undoes them in REVERSE order with
    // `engine.undo()` interleaved between the unapplyMove calls. The
    // invariants below are what Game.undoPair relies on.
    const clock = new Clock(60, 5, { onTick: () => {} });
    clock.start("white");
    const before = clock.snapshot();
    // Play the canonical 2-ply sequence: human move, AI move.
    clock.applyMove("white");
    clock.applyMove("black");
    // After 2 plies, it's white's turn again.
    expect(clock.snapshot().active).toBe("white");
    // Undo in REVERSE order: last move first.
    clock.unapplyMove("black");
    clock.unapplyMove("white");
    const back = clock.snapshot();
    expect(back.active).toBe(before.active);
    expect(Math.abs(back.whiteMs - before.whiteMs)).toBeLessThan(2);
    expect(Math.abs(back.blackMs - before.blackMs)).toBeLessThan(2);
  });

  it("unapplyMove on a frozen clock is a safe no-op (finalize wins)", () => {
    const clock = new Clock(60, 5, { onTick: () => {} });
    clock.start("white");
    clock.finalize();
    const frozen = clock.snapshot();
    clock.unapplyMove("white"); // implicit no-op because frozen
    expect(clock.snapshot().active).toBeNull();
    expect(clock.snapshot().whiteMs).toBe(frozen.whiteMs);
  });
});

