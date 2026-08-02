import { describe, it, expect, beforeEach, vi } from "vitest";
import { Board2D } from "@/board2d/Board2D";
import { sounds } from "@/audio/sounds";
import type { MoveRecord, PieceSymbol, Square } from "@/types";

// Deterministic, timer-free rendering: make every GSAP tween fire its
// onComplete synchronously so animateMove resolves without real rAF/timers
// (jsdom has no real animation loop).
vi.mock("gsap", () => ({
  default: {
    to: (_el: any, opts: any) => { opts?.onComplete?.(); return _el; },
    fromTo: (_el: any, _from: any, to: any) => { to?.onComplete?.(); return _el; },
    killTweensOf: vi.fn(),
  },
}));

function mountBoard(board: Partial<Record<Square, PieceSymbol>>): Board2D {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const b = new Board2D(host);
  b.mount();
  const full: Record<Square, PieceSymbol | null> = {} as Record<Square, PieceSymbol | null>;
  for (const sq of b["squares"].keys()) full[sq] = null;
  for (const [sq, sym] of Object.entries(board) as [Square, PieceSymbol][]) full[sq] = sym;
  b.redraw(full);
  return b;
}

const PROMO: MoveRecord = {
  from: "e7", to: "e8", piece: "P", promotion: "Q",
  san: "e8=Q", lan: "e7e8q", fen: "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", ply: 1,
};

describe("Board2D promotion (2D render bug)", () => {
  beforeEach(() => {
    sounds.setMuted(true);
    document.body.innerHTML = "";
  });

  it("renders the queen at the destination (not a lingering pawn)", async () => {
    const b = mountBoard({ e7: "P" });
    await b.animateMove(PROMO, { kind: "promote" });
    await Promise.resolve();

    const e8 = b["squares"].get("e8")!;
    const e7 = b["squares"].get("e7")!;
    const piece8 = e8.querySelector(".piece") as HTMLElement | null;
    expect(piece8).not.toBeNull();
    expect(piece8!.dataset.piece).toBe("Q");
    expect(piece8!.innerHTML).toContain("w_Queen");
    expect(e7.querySelector(".piece")).toBeNull();
  });

  it("keeps the queen rendered after a piece-style swap (boardSnap must stay current)", async () => {
    const b = mountBoard({ e7: "P" });
    await b.animateMove(PROMO, { kind: "promote" });
    await Promise.resolve();
    // e8 queen present before the style swap.
    expect((b["squares"].get("e8")!.querySelector(".piece") as HTMLElement).dataset.piece).toBe("Q");

    b.setPieceStyle("bold");

    const e8 = b["squares"].get("e8")!;
    const piece8 = e8.querySelector(".piece") as HTMLElement | null;
    expect(piece8).not.toBeNull();
    expect(piece8!.dataset.piece).toBe("Q");
    const e7 = b["squares"].get("e7")!;
    expect(e7.querySelector(".piece")).toBeNull();
  });
});
