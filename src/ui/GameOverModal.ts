// Modal shown when a game ends.

import type { GameSnapshot, Side } from "@/types";

export interface GameOverModalHandlers {
  onNewGame(): void;
  onClose(): void;
}

export function showGameOver(host: HTMLElement, snap: GameSnapshot, handlers: GameOverModalHandlers): () => void {
  const scrim = document.createElement("div");
  scrim.className = "modal-scrim";
  scrim.addEventListener("click", (e) => { if (e.target === scrim) { dismiss(); handlers.onClose(); } });

  const modal = document.createElement("div");
  modal.className = "modal";
  scrim.appendChild(modal);

  const title = document.createElement("h2");
  title.style.marginTop = "0";
  title.textContent = headlineFor(snap);
  modal.appendChild(title);

  const sub = document.createElement("p");
  sub.style.color = "var(--text-dim)";
  sub.textContent = subFor(snap);
  modal.appendChild(sub);

  const moves = document.createElement("div");
  moves.className = "move-list";
  for (let i = 0; i < snap.history.length; i += 2) {
    const w = snap.history[i];
    const b = snap.history[i + 1];
    const idx = document.createElement("div");
    idx.className = "idx";
    idx.textContent = `${i / 2 + 1}.`;
    moves.appendChild(idx);
    const wMove = document.createElement("div");
    wMove.className = "ply";
    wMove.textContent = w?.san ?? "";
    moves.appendChild(wMove);
    const bMove = document.createElement("div");
    bMove.className = "ply";
    bMove.textContent = b?.san ?? "";
    moves.appendChild(bMove);
  }
  if (snap.history.length > 0) {
    const h3 = document.createElement("h3");
    h3.textContent = "Moves";
    modal.appendChild(h3);
    modal.appendChild(moves);
  }

  const pgn = document.createElement("details");
  pgn.style.marginTop = "10px";
  const sum = document.createElement("summary");
  sum.textContent = "PGN";
  sum.style.cursor = "pointer";
  const pre = document.createElement("pre");
  pre.style.whiteSpace = "pre-wrap";
  pre.style.fontSize = "12px";
  pre.style.background = "var(--panel-2)";
  pre.style.padding = "10px";
  pre.style.borderRadius = "8px";
  pre.textContent = snap.pgn || "(no moves)";
  pgn.appendChild(sum);
  pgn.appendChild(pre);
  modal.appendChild(pgn);

  const cta = document.createElement("div");
  cta.className = "row";
  cta.style.marginTop = "14px";
  cta.style.justifyContent = "flex-end";
  const closeBtn = document.createElement("button");
  closeBtn.className = "ghost";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => { dismiss(); handlers.onClose(); });
  const again = document.createElement("button");
  again.className = "primary";
  again.textContent = "New game";
  again.addEventListener("click", () => { dismiss(); handlers.onNewGame(); });
  cta.appendChild(closeBtn);
  cta.appendChild(again);
  modal.appendChild(cta);

  host.appendChild(scrim);
  function dismiss() { scrim.remove(); }
  return dismiss;
}

function headlineFor(snap: GameSnapshot): string {
  if (snap.status === "checkmate") return winnerText(snap.winner) + " wins by checkmate";
  if (snap.status === "stalemate") return "Stalemate — draw";
  if (snap.status === "draw") {
    if (snap.isInsufficientMaterial) return "Draw — insufficient material";
    if (snap.isThreefoldRepetition) return "Draw — threefold repetition";
    if (snap.is50MoveRule) return "Draw — fifty-move rule";
    return "Draw";
  }
  if (snap.status === "resigned") return winnerText(snap.winner) + " wins by resignation";
  if (snap.status === "aborted") return "Game aborted";
  return "Game over";
}
function subFor(snap: GameSnapshot): string {
  if (snap.history.length === 0) return "No moves were played.";
  return `${snap.history.length} half-moves played.`;
}
function winnerText(winner: Side | null): string {
  return winner === "white" ? "White" : winner === "black" ? "Black" : "—";
}
