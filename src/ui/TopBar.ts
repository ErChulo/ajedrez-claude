// Top app bar:
//   - Title at the left.
//   - Mode tabs (vs AI / vs Human local / Online).
//   - 2D/3D toggle.
//   - Theme picker.
//   - Sound toggle.
//   - Resign / new game.

import { THEME_NAMES } from "@/themes/themes";
import { saveTheme, getStoredTheme } from "@/themes/persistence";
import type { ThemeName } from "@/types";

export interface TopBarHandlers {
  onMode(mode: "ai" | "local" | "online"): void;
  onRender(mode: "2d" | "3d"): void;
  onTheme(name: ThemeName): void;
  onSoundToggle(mute: boolean): void;
  onResign(): void;
  onNewGame(): void;
  onNameChange(side: "white" | "black", name: string): void;
  whiteName: string;
  blackName: string;
}

export function mountTopBar(host: HTMLElement, h: TopBarHandlers): { updateNames(w: string, b: string): void; setSoundMuted(m: boolean): void; setTheme(name: ThemeName): void } {
  host.innerHTML = "";
  host.className = "appbar";

  const title = el("div", { class: "title" }, "Ajedrez");
  title.appendChild(el("span", { class: "dot" }, "♞"));
  host.appendChild(title);

  // Mode group
  const modeGroup = mountToggleGroup(["AI", "Local", "Online"], (i) => {
    h.onMode(["ai", "local", "online"][i] as any);
  }, 0);
  modeGroup.classList.add("mode-toggle");
  host.appendChild(modeGroup);

  // Render toggle (2D/3D)
  const renderGroup = mountToggleGroup(["2D", "3D"], (i) => h.onRender(i === 0 ? "2d" : "3d"), 0);
  renderGroup.classList.add("render-toggle");
  host.appendChild(renderGroup);

  host.appendChild(el("div", { class: "divider" }));

  // Theme picker
  const themeSelect = el("select", {
    class: "theme-select",
    onchange: (e: Event) => {
      const v = (e.currentTarget as HTMLSelectElement).value as ThemeName;
      h.onTheme(v);
      saveTheme(v);
    },
  });
  for (const t of THEME_NAMES) {
    const opt = el("option", { value: t }, capitalize(t));
    if (t === getStoredTheme()) opt.setAttribute("selected", "true");
    themeSelect.appendChild(opt);
  }
  host.appendChild(themeSelect);

  // Sound toggle
  const soundBtn = el("button", { class: "ghost sound-toggle", title: "Mute / unmute" }, "🔊");
  let muted = false;
  soundBtn.addEventListener("click", () => {
    muted = !muted;
    soundBtn.textContent = muted ? "🔇" : "🔊";
    h.onSoundToggle(muted);
  });
  host.appendChild(soundBtn);

  host.appendChild(el("div", { class: "spacer" }));

  // Name entries
  const wrap = el("div", { class: "row name-row" });
  const wName = el("input", { type: "text", placeholder: "White name", maxlength: 20 });
  wName.value = h.whiteName;
  wName.addEventListener("input", () => h.onNameChange("white", wName.value));
  const bName = el("input", { type: "text", placeholder: "Black name", maxlength: 20 });
  bName.value = h.blackName;
  bName.addEventListener("input", () => h.onNameChange("black", bName.value));
  wrap.appendChild(wName);
  wrap.appendChild(bName);
  host.appendChild(wrap);

  // New game + resign
  const newBtn = el("button", { class: "primary new-game-btn" }, "New game");
  newBtn.addEventListener("click", () => h.onNewGame());
  host.appendChild(newBtn);

  const resignBtn = el("button", { class: "danger resign-btn" }, "Resign");
  resignBtn.addEventListener("click", () => h.onResign());
  host.appendChild(resignBtn);

  return {
    updateNames(w, b) { wName.value = w; bName.value = b; },
    setSoundMuted(m) { muted = m; soundBtn.textContent = m ? "🔇" : "🔊"; },
    setTheme(name) { themeSelect.value = name; },
  };
}

// helpers
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | number | ((e: Event) => void)>, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v as string;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "value") (node as HTMLInputElement).value = v as string;
    else if (k === "type") (node as HTMLInputElement).type = v as string;
    else if (k === "maxlength") (node as HTMLInputElement).maxLength = v as number;
    else if (k === "placeholder") (node as HTMLInputElement).placeholder = v as string;
    else node.setAttribute(k, v as string);
  }
  node.textContent = text;
  return node;
}
function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
function mountToggleGroup(labels: string[], onSelect: (i: number) => void, initial = 0): HTMLElement {
  const grp = el("div", { class: "toggle-group" });
  labels.forEach((label, i) => {
    const b = el("button", { type: "button" }, label);
    if (i === initial) b.classList.add("active");
    b.addEventListener("click", () => {
      grp.querySelectorAll("button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      onSelect(i);
    });
    grp.appendChild(b);
  });
  return grp;
}
