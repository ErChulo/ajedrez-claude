// Move list card — pairs SAN moves neatly into a wide-grid layout.
// Re-renders from the latest GameState.

import type { GameState } from "@/game/Game";

export interface MoveListRefs {
  setState(s: GameState): void;
}

export function mountMoveList(host: HTMLElement): MoveListRefs {
  host.innerHTML = "";
  const card = document.createElement("div");
  card.className = "card";
  const h3 = document.createElement("h3");
  h3.textContent = "Move list";
  card.appendChild(h3);

  const list = document.createElement("div");
  list.className = "move-list";
  card.appendChild(list);

  host.appendChild(card);

  return {
    setState(s: GameState) {
      list.innerHTML = "";
      for (let i = 0; i < s.history.length; i += 2) {
        const w = s.history[i];
        const b = s.history[i + 1];
        list.appendChild(span("idx", `${Math.floor(i / 2) + 1}.`));
        list.appendChild(span("ply", w ? w.san : ""));
        list.appendChild(span("ply", b ? b.san : ""));
      }
    },
  };
}

function span(cls: string, text: string): HTMLSpanElement {
  const e = document.createElement("span");
  e.className = cls;
  e.textContent = text;
  return e;
}
