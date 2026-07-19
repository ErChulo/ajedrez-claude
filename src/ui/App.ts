// App orchestrator — wires the TopBar, 2D/3D board, side panel, AI, clock,
// promotion picker, move list, game-over modal, and Supabase wiring.
//
// v1.2 (this iteration):
//   * Engine badge + side picker + Hint + Undo lifted into a slim status
//     strip below the top bar so the user can always see the engine kind
//     and reach the AI tools without hunting for them in the Settings card.
//   * The strip's side/hint/undo controls are hidden in Online mode (via
//     the .mode-only-ai-local + .status-strip.mode-online pairing) since
//     those concepts don't apply during a multiplayer match.
//
// v1.1 (previous iteration, kept):
//   * Engine-kind badge in the AI row — shows "Stockfish" or "⚠ Random".
//   * Hint button — calls Stockfish at "expert"; autohide 2.5s.
//   * Undo button — rewinds the last move-pair; refuses in Online mode.
//   * Eager AI probe — `await createAI()` runs BEFORE the first game so
//     the badge is honest on first paint.

import { THEMES } from "@/themes/themes";
import { saveTheme, getStoredTheme, savePieceStyle, getStoredPieceStyle } from "@/themes/persistence";
import { PIECE_STYLE_META } from "@/board2d/piece-styles";
import { DEFAULT_PIECE_STYLE, PIECE_STYLE_IDS, type PieceStyleId } from "@/types";
import { Game, type ChessView, type GameState } from "@/game/Game";
import { Board2D } from "@/board2d/Board2D";
import { Board3D } from "@/board3d/Board3D";
import { createAI, type AIAdapter } from "@/ai/stockfish";
import { sounds } from "@/audio/sounds";
import { PRESETS, DEFAULT_PRESET } from "@/clock/presets";
import { mountTopBar } from "./TopBar";
import { mountMoveList } from "./MoveList";
import { showGameOver } from "./GameOverModal";
import { isSupabaseConfigured, currentUserId, signInAnonymously } from "@/net/supabase";
import {
  createOnlineGame,
  joinOnlineGame,
  listWaitingGames,
  subscribeGame,
  abortOnlineGame,
  type OnlineGameMeta,
} from "@/net/online";
import { OnlineSink } from "@/game/OnlineSink";
import { mountOnlinePanel } from "./OnlinePanel";
import type { AIDifficulty, RenderMode, Side, Square, ThemeName } from "@/types";
import { formatMs } from "@/clock/Clock";

void signInAnonymously();

function defaultName(): string {
  return "Player " + String(Math.floor(Math.random() * 9000) + 1000);
}

export async function mountApp(root: HTMLElement, _opts: { initialTheme: ThemeName }): Promise<void> {
  root.innerHTML = "";

  const appbar = document.createElement("div");
  root.appendChild(appbar);

  // ----- v1.2: status strip below top bar -----
  // Hosts engine-badge (always visible) + side picker + Hint + Undo (visible
  // only in AI / Local mode via .mode-only-ai-local).
  const statusStrip = document.createElement("div");
  statusStrip.id = "status-strip";
  statusStrip.className = "status-strip";
  // Insert immediately after appbar but before main game-shell.
  root.appendChild(statusStrip);

  const main = document.createElement("div");
  main.className = "game-shell";
  root.appendChild(main);

  const boardHost = document.createElement("div");
  boardHost.className = "board-host";
  main.appendChild(boardHost);

  const side = document.createElement("div");
  side.className = "sidepanel";
  main.appendChild(side);

  // ----- Status strip contents (engineBadge + side + tools) -----
  const engineBadge = document.createElement("span");
  engineBadge.id = "engine-badge";
  engineBadge.className = "badge engine-badge";
  engineBadge.dataset.engine = "probing";
  engineBadge.textContent = "Probing…";
  statusStrip.appendChild(engineBadge);

  const stripDivider1 = document.createElement("div");
  stripDivider1.className = "status-strip-divider mode-only-ai-local";
  statusStrip.appendChild(stripDivider1);

  const sideLabel = document.createElement("label");
  sideLabel.textContent = "Side";
  sideLabel.htmlFor = "human-side-select";
  sideLabel.className = "mode-only-ai-local";
  const sideSelect = document.createElement("select");
  sideSelect.id = "human-side-select";
  sideSelect.className = "mode-only-ai-local";
  for (const s of ["white","black"] as Side[]) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s === "white" ? "White" : "Black";
    if (s === "white") o.selected = true;
    sideSelect.appendChild(o);
  }
  sideSelect.addEventListener("change", () => newGame(sideSelect.value as Side));
  statusStrip.append(sideLabel, sideSelect);

  const stripDivider2 = document.createElement("div");
  stripDivider2.className = "status-strip-divider mode-only-ai-local";
  statusStrip.appendChild(stripDivider2);

  const hintBtn = document.createElement("button");
  hintBtn.id = "hint-btn";
  hintBtn.className = "ghost mode-only-ai-local";
  hintBtn.textContent = "Hint";
  hintBtn.title = "Ask Stockfish for the best move (disabled when fallback engine is active)";
  hintBtn.addEventListener("click", () => { void game?.hint(); });
  const undoBtn = document.createElement("button");
  undoBtn.id = "undo-btn";
  undoBtn.className = "ghost mode-only-ai-local";
  undoBtn.textContent = "Undo";
  undoBtn.title = "Take back the last move-pair (you + AI reply)";
  undoBtn.addEventListener("click", () => { game?.undoPair(); });
  hintBtn.disabled = true;
  undoBtn.disabled = true;
  statusStrip.append(hintBtn, undoBtn);

  // ----- Side panel cards -----
  let presetSelect: HTMLSelectElement;
  let aiSelect: HTMLSelectElement;
  let settingsCard: HTMLDivElement;
  let onlineCard: HTMLDivElement;
  let notice: HTMLDivElement;

  const clockCard = document.createElement("div");
  clockCard.className = "card";
  const clockHeading = document.createElement("h3");
  clockHeading.textContent = "Clock";
  clockCard.appendChild(clockHeading);
  const whiteClock = document.createElement("div");
  whiteClock.className = "kv";
  const whiteRow = document.createElement("span"); whiteRow.textContent = "White";
  const whiteTime = document.createElement("span"); whiteTime.dataset.role = "white-time"; whiteTime.textContent = "—";
  const whiteBadge = document.createElement("span"); whiteBadge.className = "badge"; whiteBadge.dataset.role = "white-active";
  whiteClock.append(whiteRow, whiteTime, whiteBadge);
  const blackClock = document.createElement("div");
  blackClock.className = "kv";
  const blackRow = document.createElement("span"); blackRow.textContent = "Black";
  const blackTime = document.createElement("span"); blackTime.dataset.role = "black-time"; blackTime.textContent = "—";
  const blackBadge = document.createElement("span"); blackBadge.className = "badge"; blackBadge.dataset.role = "black-active";
  blackClock.append(blackRow, blackTime, blackBadge);
  clockCard.append(whiteClock, blackClock);
  side.appendChild(clockCard);

  settingsCard = document.createElement("div");
  settingsCard.className = "card";
  const settingsHeading = document.createElement("h3");
  settingsHeading.textContent = "Settings";
  settingsCard.appendChild(settingsHeading);

  // Time control (always visible in AI / Local mode)
  const presetRow = document.createElement("div");
  presetRow.className = "row";
  const presetLabel = document.createElement("label");
  presetLabel.textContent = "Time control";
  presetSelect = document.createElement("select");
  for (const p of PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    if (p.id === DEFAULT_PRESET.id) opt.selected = true;
    presetSelect.appendChild(opt);
  }
  presetRow.append(presetLabel, presetSelect);
  settingsCard.appendChild(presetRow);

  // AI difficulty (kept in Settings; the user-facing engine badge lives in the strip)
  const aiRow = document.createElement("div");
  aiRow.className = "row";
  aiRow.style.marginTop = "8px";
  const aiLabel = document.createElement("label");
  aiLabel.textContent = "AI";
  aiSelect = document.createElement("select");
  for (const d of ["beginner","easy","intermediate","advanced","expert"] as AIDifficulty[]) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d.charAt(0).toUpperCase() + d.slice(1);
    if (d === "intermediate") opt.selected = true;
    aiSelect.appendChild(opt);
  }
  aiRow.append(aiLabel, aiSelect);
  settingsCard.appendChild(aiRow);

  // v1.12: piece-style picker (Settings card; orthogonal to theme/side).
  // Each option drives a different 2D SVG envelope + a different 3D
  // ornament configuration in src/board{2,3}d/piece-styles.ts. The
  // picker's change handler cascades the new id down to whichever view
  // is currently mounted (Board2D or Board3D) and persists it.
  const styleRow = document.createElement("div");
  styleRow.className = "row";
  styleRow.style.marginTop = "8px";
  const styleLabel = document.createElement("label");
  styleLabel.textContent = "Piece style";
  styleLabel.htmlFor = "piece-style-select";
  const styleSelect = document.createElement("select");
  styleSelect.id = "piece-style-select";
  for (const id of PIECE_STYLE_IDS) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = PIECE_STYLE_META[id].name;
    opt.title = PIECE_STYLE_META[id].blurb;
    if (id === DEFAULT_PIECE_STYLE) opt.selected = true;
    styleSelect.appendChild(opt);
  }
  // Cascade to whichever view is mounted; persist in localStorage.
  styleSelect.addEventListener("change", () => {
    const id = styleSelect.value as PieceStyleId;
    const view = currentBoard?.view as { setPieceStyle?: (id: PieceStyleId) => void } | null;
    view?.setPieceStyle?.(id);
    savePieceStyle(id);
  });
  styleRow.append(styleLabel, styleSelect);
  settingsCard.appendChild(styleRow);

  // Hydrate the picker from localStorage on initial mount so the board
  // and the dropdown agree on the saved style from paint #1.
  const storedStyle = getStoredPieceStyle();
  styleSelect.value = storedStyle;

  notice = document.createElement("div");
  notice.className = "kv";
  notice.style.marginTop = "8px";
  notice.id = "supabase-notice";
  refreshNotice(notice);
  settingsCard.appendChild(notice);

  side.appendChild(settingsCard);

  onlineCard = document.createElement("div");
  onlineCard.className = "card online-card";
  onlineCard.style.display = "none";
  side.appendChild(onlineCard);

  const moveCard = document.createElement("div");
  moveCard.className = "card";
  const moveList = mountMoveList(moveCard);
  side.appendChild(moveCard);

  // ----- State -----
  let aiAdapter: AIAdapter | undefined;
  let game: Game | undefined;
  let currentBoard: { view: ChessView; destroy: () => void; type: "2d" | "3d" } | null = null;
  let unsubscribeGame: (() => void) | null = null;
  let modalShown = false;

  function mountBoard(type: RenderMode): ChessView {
    if (currentBoard) { currentBoard.destroy(); currentBoard = null; }
    boardHost.innerHTML = "";
    if (type === "2d") {
      const b = new Board2D(boardHost);
      b.mount();
      // v1.12: hydrate from persisted choice so first paint matches user pref.
      b.setPieceStyle(storedStyle);
      currentBoard = { view: b, destroy: () => b.destroy(), type: "2d" };
      return b;
    }
    const theme = THEMES[getStoredTheme()] ?? THEMES.wood;
    const b = new Board3D(boardHost);
    b.mount(theme);
    // v1.12: apply the persisted piece-style up-front so the first frame
    // already reflects the user's saved preference (otherwise the view
    // would default to "classic" until the user manually changed the
    // dropdown).
    b.setPieceStyle(storedStyle);
    currentBoard = { view: b, destroy: () => b.destroy(), type: "3d" };
    return b;
  }

  function hookView(view: ChessView): void {
    const anyView = view as any;
    if (typeof anyView.setMoveAttemptHandler === "function") {
      anyView.setMoveAttemptHandler((input: ApplyMoveInputLike) => {
        void game?.attemptMove({ from: input.from, to: input.to, promotion: input.promotion });
      });
    }
    if (typeof anyView.setSelectHandler === "function") {
      anyView.setSelectHandler((sq: Square) => { game?.selectSquare(sq); });
    }
  }

  function newGame(humanSide: Side) {
    if (game) {
      game.shutdown();
      unsubscribeGame?.();
      unsubscribeGame = null;
    }
    if (!currentBoard) return;
    game = new Game(currentBoard.view, {
      humanSide,
      aiDifficulty: (aiSelect.value as AIDifficulty),
      ai: aiAdapter,
      initialSeconds: PRESETS.find(p => p.id === presetSelect.value)?.initialSeconds ?? 600,
      incrementSeconds: PRESETS.find(p => p.id === presetSelect.value)?.incrementSeconds ?? 0,
    });
    hookView(currentBoard.view);
    unsubscribeGame = game.subscribe((s) => onGameState(s));
    game.start();
    moveList.setState((game as any).store.get());
  }

  function onGameState(s: GameState): void {
    moveList.setState(s);
    // Sync the engine-kind badge with the live adapter.
    if (game) {
      const aiKind = game.ai?.kind ?? "fallback";
      if (engineBadge.dataset.engine !== aiKind) {
        engineBadge.textContent = aiKind === "stockfish" ? "Stockfish" : "⚠ Random";
        engineBadge.dataset.engine = aiKind;
      }
      hintBtn.disabled = aiKind !== "stockfish" || s.isAiThinking || s.status !== "playing";
      undoBtn.disabled = s.isAiThinking || s.status !== "playing" || s.history.length < 2;
    }
    if (s.status !== "playing" && !s.isAiThinking && s.history.length > 0 && !modalShown) {
      modalShown = true;
      showGameOver(document.body, s, {
        onNewGame: () => { newGame("white"); },
        onClose: () => { modalShown = false; },
      });
    } else if (s.status === "playing" && modalShown) {
      modalShown = false;
    }
  }

  function paintClocks(): void {
    if (!game) return;
    const cs = game.clockSnapshot();
    whiteTime.textContent = formatMs(cs.whiteMs);
    blackTime.textContent = formatMs(cs.blackMs);
    whiteBadge.textContent = cs.active === "white" ? "active" : "";
    blackBadge.textContent = cs.active === "black" ? "active" : "";
    whiteBadge.className = cs.active === "white" ? "badge lowtime" : "badge";
    blackBadge.className = cs.active === "black" ? "badge lowtime" : "badge";
  }

  let rafHandle = 0;
  let clockLoop: () => void = () => {
    paintClocks();
    if (currentBoard) rafHandle = requestAnimationFrame(clockLoop);
  };

  // ----- Top bar -----
  let whiteName = defaultName();
  let blackName = "Stockfish AI";
  function showOnlinePanel(): void { onlineCard.style.display = ""; }
  function hideOnlinePanel(): void { onlineCard.style.display = "none"; }
  function showSettingsCard(): void { settingsCard.style.display = ""; }
  function hideSettingsCard(): void { settingsCard.style.display = "none"; }
  // Toggles which sub-elements of the status strip are visible. In Online
  // mode only the engine-badge stays (so the user still knows what's behind
  // the AI choice); side + hint + undo are hidden because those don't
  // apply to multiplayer.
  function setStatusStripMode(mode: "ai" | "local" | "online"): void {
    statusStrip.classList.toggle("mode-online", mode === "online");
  }

  // Track the in-flight creator-waits-for-opponent subscription so cancel works.
  let creatorSubscription: { unsubscribe: () => void } | null = null;
  let creatorGameId: string | null = null;

  let onlinePanel = mountOnlinePanel(onlineCard, {
    get displayName() { return whiteName; },
    async onCreate(preset, name) {
      whiteName = name;
      const meta = await createOnlineGame({
        whiteDisplayName: name,
        initialSeconds: preset.initialSeconds,
        incrementSeconds: preset.incrementSeconds,
      });
      creatorGameId = meta.id;
      creatorSubscription = subscribeGame(meta.id, (row) => {
        if (row.status === "active") {
          creatorSubscription?.unsubscribe();
          creatorSubscription = null;
          creatorGameId = null;
          void startOnlineGame(row);
        }
      });
      onlinePanel.setState({ kind: "waiting", meta });
      return meta;
    },
    async onJoinByCode(code, name) {
      whiteName = name;
      const meta = await joinOnlineGame({ joinCode: code, blackDisplayName: name });
      void startOnlineGame(meta);
      return meta;
    },
    async onRefreshLobby() {
      return listWaitingGames();
    },
    async onJoinOpen(meta, name) {
      whiteName = name;
      const fresh = await joinOnlineGame({ joinCode: meta.joinCode, blackDisplayName: name });
      void startOnlineGame(fresh);
      return fresh;
    },
    async onCancelWaiting() {
      if (creatorSubscription && creatorGameId) {
        creatorSubscription.unsubscribe();
        creatorSubscription = null;
        await abortOnlineGame(creatorGameId);
        creatorGameId = null;
      }
      onlinePanel.setState({ kind: "lobby", joinError: null, createError: null });
    },
  });

  async function startOnlineGame(meta: OnlineGameMeta): Promise<void> {
    if (!currentBoard) return;
    const uid = await currentUserId();
    if (!uid) return;
    const seated: Side = meta.whitePlayerId === uid ? "white" : "black";
    if (game) {
      game.shutdown();
      unsubscribeGame?.();
      unsubscribeGame = null;
    }
    game = new Game(currentBoard.view, {
      humanSide: seated,
      aiDifficulty: "intermediate",
      initialSeconds: meta.initialSeconds,
      incrementSeconds: meta.incrementSeconds,
      sink: new OnlineSink({
        gameId: meta.id,
        seated,
        initialMeta: meta,
        // When the realtime UPDATE flips the server game to a terminal
        // status (resigned / draw / aborted), settle the local store so
        // onGameState picks up `status !== "playing"` and renders the
        // GameOverModal. The opponent's identity (and therefore the
        // winner) is implicit: in any of these terminal states on a
        // 2-player game, *I* am the survivor because `game.sink` would
        // have unset status otherwise.
        onGameEnd: (terminalStatus) => {
          if (!game) return;
          const current = (game as any).store.get() as GameState;
          (game as any).store.set({ ...current, status: terminalStatus, winner: seated });
        },
      }),
    });
    game.loadFEN(meta.fen);
    (game.sink as OnlineSink).bind(game);
    hookView(currentBoard.view);
    unsubscribeGame = game.subscribe((s) => onGameState(s));
    game.start();
    moveList.setState((game as { store: { get: () => GameState } }).store.get());
    hideOnlinePanel();
    showSettingsCard();
    notice.innerHTML = `<span>Online</span><span style="color:var(--accent-2)">vs ${meta.whitePlayerId === uid ? meta.blackDisplayName ?? "?" : meta.whiteDisplayName}</span>`;
  }

  mountTopBar(appbar, {
    whiteName,
    blackName,
    onMode(m) {
      setStatusStripMode(m);
      if (m === "online" && !isSupabaseConfigured()) {
        notice.innerHTML = `<span>Online mode</span><span style="color:var(--text-dim)">Not configured — see SETUP.md</span>`;
        showSettingsCard();
        hideOnlinePanel();
        return;
      }
      if (m === "online") {
        showOnlinePanel();
        hideSettingsCard();
        onlinePanel.setState({ kind: "lobby", joinError: null, createError: null });
        notice.innerHTML = `<span>Online</span><span style="color:var(--accent-2)">Configured</span>`;
        return;
      }
      showSettingsCard();
      hideOnlinePanel();
      notice.innerHTML = `<span>Mode</span><span>${m === "ai" ? "AI" : "Local"}</span>`;
    },
    onRender(m) {
      unsubscribeGame?.();
      unsubscribeGame = null;
      if (rafHandle) cancelAnimationFrame(rafHandle);
      rafHandle = 0;
      const view = mountBoard(m);
      hookView(view);
      if (game) {
        // Hand Game the NEW view BEFORE re-subscribing so subsequent
        // attemptMove / selectSquare / executeMove calls animate on
        // the live view, not the destroyed Board2D we originally
        // constructed Game with. setView also re-syncs board pieces +
        // last-move + check + selection state in one call.
        game.setView(view);
        unsubscribeGame = game.subscribe((s) => onGameState(s));
      }
      rafHandle = requestAnimationFrame(clockLoop);
    },
    onTheme(name) { saveTheme(name); currentBoard && (currentBoard.view as any).applyTheme?.(THEMES[name]); },
    onSoundToggle(muted) { sounds.setMuted(muted); },
    onResign() { void game?.resign(); },
    onNewGame() { newGame((sideSelect?.value as Side) ?? "white"); },
    onNameChange(side, name) { if (side === "white") whiteName = name; else blackName = name; },
  });

  // ----- First mount -----
  const view = mountBoard("2d");
  hookView(view);
  rafHandle = requestAnimationFrame(clockLoop);

  // Eagerly probe the AI engine so the badge is honest on first paint.
  try {
    aiAdapter = await createAI();
    engineBadge.textContent = aiAdapter.kind === "stockfish" ? "Stockfish" : "⚠ Random";
    engineBadge.dataset.engine = aiAdapter.kind;
  } catch {
    engineBadge.textContent = "⚠ Random";
    engineBadge.dataset.engine = "fallback";
    aiAdapter = undefined;
  }
  newGame((sideSelect.value as Side) ?? "white");

  void root;
}

interface ApplyMoveInputLike { from: Square; to: Square; promotion?: "q" | "r" | "b" | "n"; }

function refreshNotice(node: HTMLElement) {
  if (!isSupabaseConfigured()) {
    node.innerHTML = `<span>Online mode</span><span style="color:var(--text-dim)">Not configured</span>`;
  } else {
    node.innerHTML = `<span>Online mode</span><span style="color:var(--accent-2)">Configured</span>`;
  }
}
