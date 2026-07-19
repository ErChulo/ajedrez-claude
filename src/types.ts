// Shared types for the chess app.

export type Square = "a1" | "b1" | "c1" | "d1" | "e1" | "f1" | "g1" | "h1"
  | "a2" | "b2" | "c2" | "d2" | "e2" | "f2" | "g2" | "h2"
  | "a3" | "b3" | "c3" | "d3" | "e3" | "f3" | "g3" | "h3"
  | "a4" | "b4" | "c4" | "d4" | "e4" | "f4" | "g4" | "h4"
  | "a5" | "b5" | "c5" | "d5" | "e5" | "f5" | "g5" | "h5"
  | "a6" | "b6" | "c6" | "d6" | "e6" | "f6" | "g6" | "h6"
  | "a7" | "b7" | "c7" | "d7" | "e7" | "f7" | "g7" | "h7"
  | "a8" | "b8" | "c8" | "d8" | "e8" | "f8" | "g8" | "h8";

export type Color = "w" | "b";           // chess.js internal convention
export type Side = "white" | "black";    // UI-facing convention
export type PieceKind = "p" | "n" | "b" | "r" | "q" | "k";

export type PieceSymbol = "P" | "N" | "B" | "R" | "Q" | "K"; // uppercase = white
export type PieceGlyph   = "P" | "N" | "B" | "R" | "Q" | "K" | "p" | "n" | "b" | "r" | "q" | "k";

export type Promotion = "q" | "r" | "b" | "n";
export type PlayerId = "white" | "black" | "spectator";

export interface ApplyMoveInput {
  from: Square;
  to: Square;
  promotion?: Promotion;
}

export interface MoveRecord {
  from: Square;
  to: Square;
  piece: PieceSymbol;
  captured?: PieceSymbol;
  promotion?: PieceSymbol;
  san: string;
  lan: string;
  fen: string; // FEN after this move
  ply: number; // 1-based half-move number
}

export interface GameSnapshot {
  fen: string;
  pgn: string;
  turn: Side;
  history: MoveRecord[];
  inCheck: boolean;
  isCheckmate: boolean;
  isStalemate: boolean;
  isInsufficientMaterial: boolean;
  isThreefoldRepetition: boolean;
  is50MoveRule: boolean;
  canWhiteCastleKingside: boolean;
  canWhiteCastleQueenside: boolean;
  canBlackCastleKingside: boolean;
  canBlackCastleQueenside: boolean;
  status: "playing" | "checkmate" | "stalemate" | "draw" | "resigned" | "aborted";
  winner: Side | null;
}

export type RenderMode = "2d" | "3d";
export type ThemeName = "wood" | "green" | "neon";

// v1.12: piece style picker. Each entry is a coherent 2D + 3D rendering
// pipeline — the dropdown wires through to the active board view.
// v1.13: adds "staunton" — MIT-licensed real-geometry mesh pieces
// (Clark Rubber's Staunton-Pieces repo, /public/assets/3d-pieces/staunton/).
export type PieceStyleId = "classic" | "bold" | "outline" | "filled" | "minimal" | "ornate" | "staunton";
export const PIECE_STYLE_IDS: readonly PieceStyleId[] = ["classic", "bold", "outline", "filled", "minimal", "ornate", "staunton"];
// v1.18: default to the MIT-licensed real-geometry Staunton STL set
// (loaded from /public/assets/3d-pieces/staunton/{Kind}.stl). The
// procedural LatheGeometry fallback ("classic") is still selectable
// from the TopBar piece-style menu; this just changes what's painted
// on first mount so users immediately see carved Staunton pieces
// rather than the white-painted lathe silhouettes.
export const DEFAULT_PIECE_STYLE: PieceStyleId = "staunton";

export interface PieceStyleMeta {
  id: PieceStyleId;
  name: string;        // dropdown label
  blurb: string;       // tooltip / card description
}

export interface ThemeData {
  name: ThemeName;
  cssVars: Record<string, string>;
  three: {
    boardLight: number;
    boardDark: number;
    pieceWhite: { color: number; roughness: number; metalness: number; emissive?: number };
    pieceBlack: { color: number; roughness: number; metalness: number; emissive?: number };
    squareEmissive: number;
  };
}

export type AIDifficulty = "beginner" | "easy" | "intermediate" | "advanced" | "expert";

export interface ClockSettings {
  initialSeconds: number;
  incrementSeconds: number;
}
