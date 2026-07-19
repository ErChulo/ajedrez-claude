// Online side-panel UI. Owns no supabase dependency directly — receives
// a callback for create/join actions that App.ts implements. This keeps
// OnlinePanel testable in isolation (no real supabase in unit tests).

import { PRESETS, type Preset } from "@/clock/presets";
import type { OnlineGameMeta } from "@/net/online";

export type OnlinePanelState =
  | { kind: "idle" }
  | { kind: "lobby"; joinError: string | null; createError: string | null }
  | { kind: "waiting"; meta: OnlineGameMeta }
  | { kind: "error"; message: string };

export interface OnlinePanelHandlers {
  /** Submit create-game form. Return the created meta on success; throw on failure. */
  onCreate(preset: Preset, displayName: string): Promise<OnlineGameMeta>;
  /** Submit join-by-code. Return the joined meta on success; throw on failure. */
  onJoinByCode(code: string, displayName: string): Promise<OnlineGameMeta>;
  /** Cancel the in-flight "waiting for opponent" substate (creator only). */
  onCancelWaiting(): Promise<void>;
  /** Refresh the open-games list. */
  onRefreshLobby(): Promise<OnlineGameMeta[]>;
  /** Join an open game from the lobby list. */
  onJoinOpen(meta: OnlineGameMeta, displayName: string): Promise<OnlineGameMeta>;
  /** Display name bound from the host app. */
  displayName: string;
}

export function mountOnlinePanel(host: HTMLElement, h: OnlinePanelHandlers): {
  setState(state: OnlinePanelState): void;
  setDisplayName(name: string): void;
} {
  host.innerHTML = "";
  host.classList.add("online-panel");

  const root = document.createElement("div");
  root.className = "card online-card";
  host.appendChild(root);

  function setState(state: OnlinePanelState): void {
    root.innerHTML = "";
    if (state.kind === "idle") {
      render(formNode(h, (preset, name) => state.kind === "idle" && void h.onCreate(preset, name).catch((e) => alertJoinError(e))));
      renderLobbyList(root, h);
    } else if (state.kind === "lobby") {
      render(formNode(h, (preset, name) => h.onCreate(preset, name).catch((e) => setState({ kind: "lobby", createError: messageOf(e), joinError: state.joinError }))));
      renderJoinByCode(root, h, state.joinError, (err) => setState({ ...state, joinError: err }));
      renderLobbyList(root, h);
    } else if (state.kind === "waiting") {
      const heading = document.createElement("h3");
      heading.textContent = "Waiting for opponent…";
      root.appendChild(heading);
      const codeBig = document.createElement("div");
      codeBig.className = "join-code";
      codeBig.textContent = state.meta.joinCode;
      root.appendChild(codeBig);
      const copy = document.createElement("button");
      copy.className = "ghost";
      copy.textContent = "Copy code";
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(state.meta.joinCode);
      });
      root.appendChild(copy);
      const cancel = document.createElement("button");
      cancel.className = "danger";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => { void h.onCancelWaiting(); });
      root.appendChild(cancel);
    } else if (state.kind === "error") {
      const heading = document.createElement("h3");
      heading.textContent = "Online play";
      root.appendChild(heading);
      const msg = document.createElement("p");
      msg.className = "err";
      msg.textContent = state.message;
      root.appendChild(msg);
    }
  }

  function render(form: HTMLElement): void {
    const heading = document.createElement("h3");
    heading.textContent = "Online play";
    root.appendChild(heading);
    root.appendChild(form);
  }

  setState({ kind: "lobby", joinError: null, createError: null });

  // Set initial displayName into the bound inputs once the DOM exists.
  const dn = root.querySelector<HTMLInputElement>("input[name=displayName]");
  if (dn) dn.value = h.displayName;

  return {
    setState,
    setDisplayName(name) {
      const dn2 = root.querySelector<HTMLInputElement>("input[name=displayName]");
      if (dn2) dn2.value = name;
    },
  };
}

function formNode(h: OnlinePanelHandlers, onSubmit: (preset: Preset, name: string) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "online-form";

  const presetRow = document.createElement("div");
  presetRow.className = "row";
  const presetLabel = document.createElement("label");
  presetLabel.textContent = "Time control";
  const presetSelect = document.createElement("select");
  for (const p of PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    presetSelect.appendChild(opt);
  }
  presetRow.append(presetLabel, presetSelect);
  wrap.appendChild(presetRow);

  const nameRow = document.createElement("div");
  nameRow.className = "row";
  nameRow.style.marginTop = "8px";
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Your name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.name = "displayName";
  nameInput.maxLength = 20;
  nameInput.value = h.displayName;
  nameRow.append(nameLabel, nameInput);
  wrap.appendChild(nameRow);

  const createBtn = document.createElement("button");
  createBtn.className = "primary";
  createBtn.textContent = "Create game";
  createBtn.style.marginTop = "8px";
  createBtn.addEventListener("click", () => {
    const preset = PRESETS.find(p => p.id === presetSelect.value) ?? PRESETS[0];
    const name = (nameInput.value || "").trim() || ("Player " + (Math.floor(Math.random() * 9000) + 1000));
    onSubmit(preset, name);
  });
  wrap.appendChild(createBtn);
  return wrap;
}

function renderJoinByCode(root: HTMLElement, h: OnlinePanelHandlers, joinError: string | null, setJoinError: (s: string | null) => void): void {
  const sep = document.createElement("div");
  sep.className = "divider";
  sep.textContent = "— or —";
  root.appendChild(sep);

  const row = document.createElement("div");
  row.className = "row";
  row.style.marginTop = "8px";
  const codeLabel = document.createElement("label");
  codeLabel.textContent = "Code";
  const codeInput = document.createElement("input");
  codeInput.type = "text";
  codeInput.placeholder = "ABC123";
  codeInput.maxLength = 8;
  row.append(codeLabel, codeInput);
  root.appendChild(row);

  const dn = root.querySelector<HTMLInputElement>("input[name=displayName]");
  const joinBtn = document.createElement("button");
  joinBtn.className = "primary";
  joinBtn.textContent = "Join";
  joinBtn.addEventListener("click", async () => {
    setJoinError(null);
    const code = codeInput.value.trim().toUpperCase();
    const name = (dn?.value || "").trim() || ("Player " + (Math.floor(Math.random() * 9000) + 1000));
    try {
      await h.onJoinByCode(code, name);
    } catch (e) {
      setJoinError(messageOf(e));
    }
  });
  root.appendChild(joinBtn);

  if (joinError) {
    const err = document.createElement("p");
    err.className = "err";
    err.textContent = joinError;
    root.appendChild(err);
  }
}

async function renderLobbyList(root: HTMLElement, h: OnlinePanelHandlers): Promise<void> {
  const heading = document.createElement("h4");
  heading.textContent = "Open games";
  heading.style.marginTop = "12px";
  root.appendChild(heading);

  const list = document.createElement("div");
  list.className = "lobby-list";
  root.appendChild(list);

  let games: OnlineGameMeta[] = [];
  try {
    games = await h.onRefreshLobby();
  } catch {
    // Suppress: surface as empty lobby.
  }
  if (games.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No open games. Create one above.";
    list.appendChild(empty);
    return;
  }
  const dn = root.querySelector<HTMLInputElement>("input[name=displayName]");
  for (const meta of games) {
    const row = document.createElement("div");
    row.className = "lobby-row";
    const code = document.createElement("strong");
    code.textContent = meta.joinCode;
    const name = document.createElement("span");
    name.textContent = meta.whiteDisplayName;
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.textContent = "Join";
    btn.addEventListener("click", async () => {
      const displayName = (dn?.value || "").trim() || ("Player " + (Math.floor(Math.random() * 9000) + 1000));
      try { await h.onJoinOpen(meta, displayName); } catch (e) { alertJoinError(e); }
    });
    row.append(code, name, btn);
    list.appendChild(row);
  }
}

function alertJoinError(e: unknown): void {
  // Tiny ephemeral toast — kept inside the panel to avoid coupling to the
  // rest of the doc's modals.
  const t = document.createElement("div");
  t.className = "toast err";
  t.textContent = messageOf(e);
  t.style.position = "fixed";
  t.style.bottom = "16px";
  t.style.right = "16px";
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

/**
 * Coerce any thrown value to a human-readable string. `e` may be:
 *   - {message:string} (e.g. Supabase PostgrestError)
 *   - Error instance
 *   - a plain string
 *   - undefined / null
 * Avoids the brittle `(e as { message?: string })?.message` cast which
 * doesn't survive strict TS noImplicitAny & noUncheckedIndexedAccess.
 */
function messageOf(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}
