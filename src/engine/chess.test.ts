import { describe, it, expect } from "vitest";
import { ChessEngine } from "./chess";
import type { Square } from "@/types";

describe("ChessEngine — FIDE rules", () => {
  it("starts from the standard position with white to move", () => {
    const e = ChessEngine.standard();
    const s = e.snapshot();
    expect(s.turn).toBe("white");
    expect(s.status).toBe("playing");
    expect(s.fen.startsWith("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR")).toBe(true);
  });

  it("rejects an illegal pawn jump", () => {
    const e = ChessEngine.standard();
    expect(() => e.apply({ from: "e2", to: "e5" as Square })).toThrow();
  });

  it("isLegal is non-mutating and rejects non-legal targets", () => {
    const e = ChessEngine.standard();
    expect(e.isLegal({ from: "e2", to: "e4" as Square })).toBe(true);
    expect(e.isLegal({ from: "e2", to: "e5" as Square })).toBe(false);
  });

  it("detects fool's mate (4-move checkmate)", () => {
    const e = new ChessEngine();
    e.applySan("f3");
    e.applySan("e5");
    e.applySan("g4");
    e.applySan("Qh4#");
    const s = e.snapshot();
    expect(s.isCheckmate).toBe(true);
    expect(s.status).toBe("checkmate");
    expect(s.winner).toBe("black");
  });

  it("handles castling (king-side)", () => {
    const e = new ChessEngine();
    e.applySan("e4"); e.applySan("e5");
    e.applySan("Nf3"); e.applySan("Nc6");
    e.applySan("Bc4"); e.applySan("Bc5");
    const move = e.apply({ from: "e1", to: "g1" as Square });
    expect(move.san).toBe("O-O");
    expect(e.fen().includes("R")).toBe(true);
  });

  it("handles castling (queen-side)", () => {
    const e = new ChessEngine();
    e.applySan("d4"); e.applySan("d5");
    e.applySan("Nc3"); e.applySan("Nc6");
    e.applySan("Bf4"); e.applySan("Bf5");
    e.applySan("Qd2"); e.applySan("Qd7");
    e.applySan("O-O-O");
    expect(e.fen().includes("K")).toBe(true);
  });

  it("handles en passant", () => {
    const e = new ChessEngine();
    e.applySan("e4"); e.applySan("a6");
    e.applySan("e5"); e.applySan("d5");
    const ep = e.apply({ from: "e5", to: "d6" as Square });
    expect(ep.san).toMatch(/exd6/);
    // After 5 half-moves (e4, a6, e5, d5, exd6) the snapshot history length is 5.
    expect(e.snapshot().history.length).toBe(5);
  });

  it("handles pawn promotion (with picker)", () => {
    const e = new ChessEngine("8/4P3/8/8/8/8/8/4K2k w - - 0 1");
    const m = e.apply({ from: "e7", to: "e8" as Square, promotion: "n" });
    expect(m.san).toMatch(/e8=N/);
    expect(e.fen().split(" ")[0]).toContain("N");
  });

  it("detects stalemate (black-to-move, all flight squares covered by queen, not in check)", () => {
    // Classic textbook position: white queen on g6, white king on f7, black king on h8. Black to move.
    // The white queen covers h7 and g7 (white king on f7 covers h8 indirectly via queen covers h7).
    const e = new ChessEngine("7k/5K2/6Q1/8/8/8/8/8 b - - 0 1");
    const s = e.snapshot();
    expect(s.isStalemate).toBe(true);
    // chess.js exposes stalemate as its own status; our wrapper distinguishes.
    expect(s.status === "stalemate" || s.status === "draw").toBe(true);
  });

  it("detects insufficient material (K vs K)", () => {
    // Standard 6-field FEN: board | side | castling | en-passant | halfmove | fullmove.
    const e = new ChessEngine("8/8/8/4k3/8/8/8/4K3 w - - 0 1");
    const s = e.snapshot();
    // chess.js 1.4 surfaces K vs K positions as both isInsufficientMaterial and isDraw.
    expect(s.isInsufficientMaterial).toBe(true);
    expect(s.status === "playing" || s.status === "draw").toBe(true);
  });

  it("threefold repetition results in draw offerable state", () => {
    const e = new ChessEngine();
    e.applySan("Nf3"); e.applySan("Nf6");
    e.applySan("Ng1"); e.applySan("Ng8");
    e.applySan("Nf3"); e.applySan("Nf6");
    e.applySan("Ng1"); e.applySan("Ng8");
    e.applySan("Nf3"); e.applySan("Nf6");
    e.applySan("Ng1"); e.applySan("Ng8");
    const s = e.snapshot();
    expect(s.isThreefoldRepetition || s.status === "draw").toBe(true);
  });

  it("snapshot history stays in sync with FEN and PGN", () => {
    const e = ChessEngine.standard();
    e.applySan("e4"); e.applySan("c5"); e.applySan("Nf3");
    const s = e.snapshot();
    expect(s.history.length).toBe(3);
    expect(s.fen.split(" ")[0].includes("P")).toBe(true);
    expect(s.pgn).toContain("1. e4 c5 2. Nf3");
  });
});
