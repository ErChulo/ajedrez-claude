// Strict engine wrapper around chess.js v1.x.
// We never trust incoming moves without validating with chess.js,
// and we own the public surface so the engine can be swapped later.

import { Chess, type Move as ChessJsMove, type Square as CjsSquare } from "chess.js";
import type {
  ApplyMoveInput,
  Color,
  GameSnapshot,
  MoveRecord,
  PieceSymbol,
  Promotion,
  Side,
  Square,
} from "@/types";

function sideFromColor(c: Color): Side {
  return c === "w" ? "white" : "black";
}

function isPromotionSan(san: string): boolean {
  return /=/.test(san);
}

function promotionSymbolFor(k: Promotion, sideIsWhite: boolean): PieceSymbol {
  const capital = k.toUpperCase() as PieceSymbol;
  return sideIsWhite ? capital : capital.toLowerCase() as PieceSymbol;
}

export class EngineError extends Error {
  constructor(message: string, public code: "illegal" | "wrong-turn" | "invalid-input") {
    super(message);
  }
}

export class ChessEngine {
  private chess: Chess;

  constructor(fen?: string) {
    this.chess = new Chess(fen);
  }

  static standard(): ChessEngine {
    return new ChessEngine();
  }

  reset(fen?: string): void {
    this.chess = new Chess(fen);
  }

  fen(): string {
    return this.chess.fen();
  }

  pgn(): string {
    return this.chess.pgn();
  }

  turn(): Side {
    return sideFromColor(this.chess.turn());
  }

  /**
   * Apply a move. Always validated by chess.js; throws on illegal input.
   */
  apply(input: ApplyMoveInput, plyHint?: number): MoveRecord {
    const move = this.chess.move({
      from: input.from as CjsSquare,
      to: input.to as CjsSquare,
      promotion: (input.promotion ?? "q"),
    });
    if (!move) {
      throw new EngineError(`Illegal move: ${input.from}->${input.to}`, "illegal");
    }
    return this.toRecord(move, plyHint);
  }

  /** Apply by UCI string (e.g. "e2e4", "e7e8q"). Validated by chess.js. */
  applyUci(uci: string, plyHint?: number): MoveRecord {
    if (uci.length < 4 || uci.length > 5) {
      throw new EngineError(`Invalid UCI: ${uci}`, "invalid-input");
    }
    const from = uci.slice(0, 2) as Square;
    const to = uci.slice(2, 4) as Square;
    const promotion = (uci.length === 5 ? uci[4] : "q") as Promotion;
    return this.apply({ from, to, promotion }, plyHint);
  }

  /** Apply by SAN. */
  applySan(san: string, plyHint?: number): MoveRecord {
    const move = this.chess.move(san);
    if (!move) {
      throw new EngineError(`Illegal SAN: ${san}`, "illegal");
    }
    return this.toRecord(move, plyHint);
  }

  /** Validate-only: returns true if currently legal (does not mutate state). */
  isLegal(input: ApplyMoveInput): boolean {
    try {
      const test = new Chess(this.chess.fen());
      return Boolean(test.move({
        from: input.from as CjsSquare,
        to: input.to as CjsSquare,
        promotion: (input.promotion ?? "q"),
      }));
    } catch {
      return false;
    }
  }

  /** Returns FEN-decoded occupancy of the requested square, or null if empty. */
  // Exposed for callers that need the piece symbol on a square (used by Game too).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  pieceAt(sq: Square): PieceSymbol | null {
    const fenBoard = this.chess.fen().split(" ")[0];
    const ranks = fenBoard.split("/");
    const file = "abcdefgh".indexOf(sq[0]);
    const rank = 8 - parseInt(sq[1], 10);
    if (rank < 0 || rank > 7 || file < 0 || file > 7) return null;
    let col = 0;
    for (const ch of ranks[rank]) {
      if (/[1-8]/.test(ch)) { col += parseInt(ch, 10); continue; }
      if (col === file) return ch as PieceSymbol; // FEN uses uppercase=white
      col++;
    }
    return null;
  }

  legalMovesFrom(square: Square): { to: Square; promotion?: Promotion }[] {
    const verbose = this.chess.moves({ square: square as CjsSquare, verbose: true }) as ChessJsMove[];
    return verbose.map((m) => ({
      to: m.to as Square,
      promotion: isPromotionSan(m.san) ? promotionFromMove(m) : undefined,
    }));
  }

  legalMovesAll(): ApplyMoveInput[] {
    const verbose = this.chess.moves({ verbose: true }) as ChessJsMove[];
    return verbose.map((m) => {
      const out: ApplyMoveInput = { from: m.from as Square, to: m.to as Square };
      if (isPromotionSan(m.san)) {
        const p = promotionFromMove(m);
        if (p) out.promotion = p;
      }
      return out;
    });
  }

  undo(): MoveRecord | null {
    const undone = this.chess.undo();
    if (!undone) return null;
    return this.toRecord(undone, undefined);
  }

  snapshot(): GameSnapshot {
    const history: MoveRecord[] = this.chess.history({ verbose: true }).map((m, i) => this.toRecord(m, i + 1));
    const rights = (side: Color) => this.chess.getCastlingRights(side);
    const w = rights("w");
    const b = rights("b");
    return {
      fen: this.chess.fen(),
      pgn: this.chess.pgn(),
      turn: this.turn(),
      history,
      inCheck: this.chess.inCheck(),
      isCheckmate: this.chess.isCheckmate(),
      isStalemate: this.chess.isStalemate(),
      isInsufficientMaterial: this.chess.isInsufficientMaterial(),
      isThreefoldRepetition: this.chess.isThreefoldRepetition(),
      // chess.js doesn't expose "is50MoveRule"; we approximate from the halfmove clock
      // — halfmove ≥ 100 with no other draw reason means 50-move rule applies.
      is50MoveRule: this.isHalfMoveAt50(),
      canWhiteCastleKingside: w.k,
      canWhiteCastleQueenside: w.q,
      canBlackCastleKingside: b.k,
      canBlackCastleQueenside: b.q,
      status: this.status(),
      winner: this.winner(),
    };
  }

  status(): GameSnapshot["status"] {
    if (this.chess.isCheckmate()) return "checkmate";
    if (this.chess.isStalemate()) return "stalemate";
    if (this.chess.isDraw()) return "draw";
    return "playing";
  }

  winner(): Side | null {
    if (!this.chess.isCheckmate()) return null;
    return this.turn() === "white" ? "black" : "white";
  }

  private isHalfMoveAt50(): boolean {
    const halfMoves = parseInt(this.chess.fen().split(" ")[4] ?? "0", 10);
    return Number.isFinite(halfMoves) && halfMoves >= 100 && this.chess.isDraw()
        && !this.chess.isInsufficientMaterial() && !this.chess.isStalemate() && !this.chess.isThreefoldRepetition();
  }

  private toRecord(m: ChessJsMove, plyHint?: number): MoveRecord {
    return {
      from: m.from as Square,
      to: m.to as Square,
      piece: m.piece.toUpperCase() as PieceSymbol,
      captured: m.captured ? (m.captured.toUpperCase() as PieceSymbol) : undefined,
      promotion: m.promotion ? (promotionSymbolFor(promotionFromMove(m)!, m.color === "w")) : undefined,
      san: m.san,
      lan: `${m.from}${m.to}${m.promotion ?? ""}`,
      fen: m.after,
      ply: plyHint ?? this.chess.history().length,
    };
  }
}

function promotionFromMove(m: ChessJsMove): Promotion | undefined {
  if (!m.promotion) return undefined;
  const p = m.promotion.toLowerCase();
  if (p === "q" || p === "r" || p === "b" || p === "n") return p;
  return undefined;
}
