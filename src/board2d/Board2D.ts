// 2D board — DOM/CSS grid + inline SVG pieces + GSAP tweens + pointer events.
// Implements the ChessView contract used by Game.
//
// Public API:
//   mount(host), destroy()
//   setMoveAttemptHandler(fn) — called when the user signals a move.
//   setSelectHandler(fn) — called when a piece is selected.
//   setLegalTargetsProvider(fn) — lets the View ask the engine for legal targets when needed.
//
// Implementation:
//   - Drag-and-drop is via Pointer Events with a window-level pointerup/cancel.
//   - Promotion picker is overlaid on the destination square.

import gsap from "gsap";
import { tweenCapture, tweenAppear, tweenIllegalShake } from "@/anim/tween";
import { sounds } from "@/audio/sounds";
import { renderPieceSvg } from "./piece-styles";
import { DEFAULT_PIECE_STYLE, PIECE_STYLE_IDS, type PieceStyleId } from "@/types";
import type {
  ApplyMoveInput,
  MoveRecord,
  PieceSymbol,
  Promotion,
  Side,
  Square,
} from "@/types";

interface BoardState {
  history: MoveRecord[];
  selectable: Side | null;
  lastFrom?: Square;
  lastTo?: Square;
  inCheck?: Square;
}

function squareName(row: number, col: number): Square {
  return (`${"abcdefgh"[col]}${8 - row}`) as Square;
}

export class Board2D {
  private host: HTMLElement;
  private boardEl!: HTMLDivElement;
  private squares: Map<Square, HTMLDivElement> = new Map();
  private pieces: Map<Square, HTMLDivElement> = new Map();
  private state: BoardState = { history: [], selectable: "white" };

  private onMoveAttempt?: (input: ApplyMoveInput) => void;
  private onSelect?: (sq: Square) => void;
  private selectedSq: Square | null = null;
  private dragOrigin: Square | null = null;
  private ghostEl: HTMLDivElement | null = null;
  private ghostSym: PieceSymbol | null = null;
  // v1.12: piece-style registry id — drives which SVG envelope
  // renderPieceSvg() emits. Default "classic" matches pre-v1.12 look.
  public pieceStyle: PieceStyleId = DEFAULT_PIECE_STYLE;
  // v1.12.1: latest board snapshot so setPieceStyle() can re-emit EVERY
  // piece with the new style without flashing an empty board. The first
  // round of setPieceStyle (v1.12) called redraw({}) to wipe and rerendered
  // — but Game doesn't call redraw on a style swap, so users stared at
  // an EMPTY board for the rest of the session. This Map mirrors Board3D's
  // boardSnap; populated by redraw() so it's always-current.
  private boardSnap: Map<Square, PieceSymbol> = new Map();

  /**
   * v1.12.1 — Apply the user's selected piece style. Re-emits every piece
   * using the latest board snapshot, with the new style envelope. Tweens
   * on tracked .piece nodes are killed so a style swap mid-move doesn't
   * leave a stale animation callback re-appending an old node into a
   * detached parent.
   */
  setPieceStyle(id: PieceStyleId): void {
    if (!PIECE_STYLE_IDS.includes(id)) return;
    if (this.pieceStyle === id) return;
    this.pieceStyle = id;
    if (this.squares.size === 0 || this.boardSnap.size === 0) return;
    // v1.12.1 CRITICAL — drain pending Promise resolvers BEFORE killing
    // tweens. Board2D's animateMove / animateRookMove track their GSAP
    // tween's `done` callback in `this.resolvers` so destroy() can flush
    // them if teardown lands mid-animation. gsap.killTweensOf cancels
    // tweens WITHOUT firing onComplete, so those `done()` resolvers
    // would never fire — leaving any in-flight Game.executeMove await
    // hung forever (isProcessingMove=true wedges the game). Mirror
    // Board3D's setPieceStyle resolver-drain here. Without this, swapping
    // styles during a promotion or capture tween wedges the game.
    for (const r of this.resolvers) r();
    this.resolvers.clear();
    // Drop the old .piece nodes (kills in-flight GSAP tweens on them
    // first so onComplete can't re-attach detached DOM nodes).
    for (const [, el] of this.pieces.entries()) {
      gsap.killTweensOf(el);
      el.remove();
    }
    this.pieces.clear();
    // Re-emit each piece from the snapshot with the new style. Squares
    // (with .selected/.target/.last-from/.last-to/.in-check classes) are
    // untouched — the visual highlight layer persists across style swaps.
    for (const [sq, sym] of this.boardSnap.entries()) {
      const el = document.createElement("div");
      el.className = "piece";
      el.dataset.piece = sym;
      el.innerHTML = renderPieceSvg(sym, this.pieceStyle);
      const sqEl = this.squares.get(sq);
      if (!sqEl) continue;
      sqEl.appendChild(el);
      this.pieces.set(sq, el);
    }
  }

  constructor(host: HTMLElement) { this.host = host; }

  mount(): void {
    this.boardEl = document.createElement("div");
    this.boardEl.className = "board-2d";
    this.host.appendChild(this.boardEl);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = document.createElement("div");
        const isLight = (row + col) % 2 === 1;
        sq.className = `square ${isLight ? "light" : "dark"}`;
        sq.dataset.square = squareName(row, col);
        sq.addEventListener("click", (e) => this.onSquareClick(e));
        sq.addEventListener("pointerdown", (e) => this.onSquarePointerDown(e));
        this.boardEl.appendChild(sq);
        this.squares.set(sq.dataset.square as Square, sq);
      }
    }
    for (let c = 0; c < 8; c++) {
      const top = document.createElement("div");
      top.className = "file-rank file-top";
      top.style.left = `calc(${c} * var(--square) + 4px)`;
      top.textContent = "abcdefgh"[c];
      this.boardEl.appendChild(top);
      const bot = document.createElement("div");
      bot.className = "file-rank file-bot";
      bot.style.right = `calc(${7 - c} * var(--square) + 4px)`;
      bot.textContent = "abcdefgh"[c];
      this.boardEl.appendChild(bot);
    }
    for (let r = 0; r < 8; r++) {
      const left = document.createElement("div");
      left.className = "file-rank rank-left";
      left.style.top = `calc(${r} * var(--square) + 4px)`;
      left.textContent = String(8 - r);
      this.boardEl.appendChild(left);
      const right = document.createElement("div");
      right.className = "file-rank rank-right";
      right.style.bottom = `calc(${7 - r} * var(--square) + 4px)`;
      right.style.transform = "translateY(0)";
      right.textContent = String(8 - r);
      this.boardEl.appendChild(right);
    }
  }

  destroy(): void {
    // Cancel the autohide setTimeout first; otherwise it may fire against
    // a torn-down view's `squares` Map when the user toggles 2D↔3D while
    // a hint is currently visible (timer-handle leak + harmless mutation).
    if (this.hintTimer !== null) {
      window.clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    // Kill any in-flight GSAP tweens targeting our DOM nodes. Without
    // this, an in-flight move/capture tween's `onComplete` runs after the
    // view is torn down and re-appends moved DOM nodes onto a detached
    // parent (orphan nodes), and is also a memory leak.
    for (const el of this.pieces.values()) gsap.killTweensOf(el);
    for (const sq of this.squares.values()) {
      sq.querySelectorAll(".piece, .ghost").forEach((n) => gsap.killTweensOf(n));
    }
    // GSAP's killTweensOf cancels but does NOT fire onComplete. Any
    // in-flight `await new Promise(... done => gsap.to(..., { onComplete: () => done() }))`
    // in animateMove / animateRookMove would therefore hang forever if
    // we only killed tweens. Drain the resolvers set so every pending
    // Promise becomes no-op-resolved immediately, allowing Game.executeMove's
    // `finally` block (which sets `isProcessingMove = false`) to run
    // normally even when destroy lands mid-animation.
    for (const r of this.resolvers) r();
    this.resolvers.clear();
    this.host.removeChild(this.boardEl);
    this.squares.clear();
    this.pieces.clear();
  }

  setMoveAttemptHandler(fn: (input: ApplyMoveInput) => void): void { this.onMoveAttempt = fn; }
  setSelectHandler(fn: (sq: Square) => void): void { this.onSelect = fn; }

  /** Full redraw. */
  redraw(board: Record<Square, string | null> | Record<Square, PieceSymbol | null>): void {
    const prevRects = new Map<Square, DOMRect>();
    for (const [sq, p] of this.pieces.entries()) {
      // Kill any in-flight move tween on this DOM node. Without this, the
      // GSAP.onComplete would fire AFTER we remove the node, re-attaching
      // it to a detached parent and leaking.
      gsap.killTweensOf(p);
      prevRects.set(sq, p.getBoundingClientRect());
    }
    for (const sq of this.squares.values()) {
      sq.classList.remove("selected", "target", "last-from", "last-to", "in-check");
      const ring = sq.querySelector(".capture-target");
      if (ring) ring.remove();
      // Clear both live pieces AND any in-flight fading .ghost nodes from
      // a prior capture. Without the ghost sweep, a fading capture still
      // attached to a square would linger on top of the freshly-redrawn
      // piece and reproduce the overlap bug at redraw boundaries. We
      // also killTweensOf before remove so onComplete callbacks don't
      // touch the detached nodes.
      sq.querySelectorAll(".piece, .ghost").forEach((n) => {
        gsap.killTweensOf(n);
        n.remove();
      });
    }
    this.pieces.clear();
    this.boardSnap.clear();
    for (const [sq, piece] of Object.entries(board) as [Square, PieceSymbol | null][]) {
      if (!piece) continue;
      const el = document.createElement("div");
      el.className = "piece";
      el.dataset.piece = piece;
      el.innerHTML = renderPieceSvg(piece, this.pieceStyle);
      const sqEl = this.squares.get(sq);
      if (sqEl) {
        sqEl.appendChild(el);
        this.pieces.set(sq, el);
        this.boardSnap.set(sq, piece);
      }
    }
    requestAnimationFrame(() => {
      for (const [sq, el] of this.pieces.entries()) {
        const prev = prevRects.get(sq);
        if (!prev) continue;
        const next = el.getBoundingClientRect();
        if (prev.left !== next.left || prev.top !== next.top) {
          const dx = prev.left - next.left;
          const dy = prev.top - next.top;
          gsap.fromTo(el, { x: dx, y: dy }, { x: 0, y: 0, duration: 0.25, ease: "power2.out", clearProps: "x,y" });
        }
      }
    });
  }

  /**
   * Animate a single move. Captures and moves are SEQUENCED:
   *   1. If the destination holds a captured piece, lift its `.piece` class
   *      IMMEDIATELY (so subsequent querySelector calls skip the fading
   *      node) and animate it out with the capture tween.
   *   2. AWAIT the capture tween to complete (and remove) BEFORE starting
   *      the moving-piece slide. Without sequencing, the moving piece
   *      arrives in 0.25 s while the captured piece is still mid-fade
   *      (0.28 s) — both visually co-exist on the destination square for
   *      ~60 ms. That co-existence was the "pieces on top of one another"
   *      bug the user reported.
   *   3. AWAIT the move tween, then run any promotion transform.
   */
  async animateMove(rec: MoveRecord, animate: { kind: "move" | "capture" | "castle" | "enpassant" | "promote" }): Promise<void> {
    const fromEl = this.pieces.get(rec.from);
    const toEl = this.squares.get(rec.to);
    if (!fromEl || !toEl) return;
    const existingCaptured = toEl.querySelector(".piece") as HTMLDivElement | null;
    if (existingCaptured && animate.kind !== "castle") {
      // Mark the captured node as a ghost IMMEDIATELY so any later
      // querySelector(".piece") in this same frame, or in a redraw that
      // lands mid-tween, finds the real moving piece instead of the
      // ghost. Also disable pointer events so the ghost can't intercept
      // a click meant for the arriving piece.
      existingCaptured.classList.remove("piece");
      existingCaptured.classList.add("ghost");
      existingCaptured.style.pointerEvents = "none";
      const isCaptureKind = animate.kind === "capture" || animate.kind === "enpassant" || animate.kind === "promote";
      sounds.play(isCaptureKind ? "capture" : "move");
      if (isCaptureKind) {
        await new Promise<void>((done) => {
          // Track the resolver so destroy() can flush us if we land
          // mid-animation (otherwise gsap.killTweensOf cancels without
          // firing onComplete → done() never runs → the Promise hangs).
          this.resolvers.add(done);
          tweenCapture(existingCaptured, { onComplete: () => {
            this.resolvers.delete(done);
            existingCaptured.remove();
            done();
          } });
        });
      } else {
        existingCaptured.remove();
      }
    }
    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();
    const dx = toRect.left - fromRect.left;
    const dy = toRect.top - fromRect.top;
    fromEl.style.zIndex = "5";
    // The gsap.to onComplete callback is NOT async, so we cannot `await`
    // anything inside it. Keep the move-tween's `done()` strictly
    // synchronous, then run the promotion transform — which DOES need to
    // be awaited — in the outer async scope where await is legal.
    await new Promise<void>((done) => {
      // Track the resolver so destroy() can flush us if we land
      // mid-animation (otherwise gsap.killTweensOf cancels without
      // firing onComplete → done() never runs → the Promise hangs).
      this.resolvers.add(done);
      gsap.to(fromEl, {
        x: dx, y: dy, duration: 0.25, ease: "power2.out",
        onComplete: () => {
          this.resolvers.delete(done);
          fromEl.style.zIndex = "";
          fromEl.style.transform = "";
          toEl.appendChild(fromEl);
          this.pieces.delete(rec.from);
          this.pieces.set(rec.to, fromEl);
          if (animate.kind !== "capture" && animate.kind !== "enpassant" && animate.kind !== "promote") {
            if (animate.kind === "castle") sounds.play("castle");
            else sounds.play("move");
          }
          this.clearSelection();
          done();
        },
      });
    });
    // Promotion transform — runs in the outer async scope where `await` is
    // legal. Awaits the appear tween so Game.executeMove's `await
    // animateMove` doesn't return with isProcessingMove=false while the
    // promotion is still at scale ~0.4 — a fast follow-up click would
    // otherwise race with the still-running animation. We move the
    // promote-sound playback into the tween's onComplete so the audio
    // syncs with the visual appearance (the user hears the new queen
    // materialize at the same instant she sees it).
    if (animate.kind === "promote" && rec.promotion) {
      fromEl.innerHTML = renderPieceSvg(rec.promotion, this.pieceStyle);
      fromEl.dataset.piece = rec.promotion;
      await new Promise<void>((appeared) => {
        this.resolvers.add(appeared);
        tweenAppear(fromEl, { onComplete: () => {
          this.resolvers.delete(appeared);
          sounds.play("promote");
          appeared();
        } });
      });
    }
  }

  animateRookMove(from: Square, to: Square): Promise<void> {
    return new Promise((resolve) => {
      const el = this.pieces.get(from);
      const dst = this.squares.get(to);
      if (!el || !dst) return resolve();
      const fromRect = el.getBoundingClientRect();
      const toRect = dst.getBoundingClientRect();
      const dx = toRect.left - fromRect.left;
      const dy = toRect.top - fromRect.top;
      // Track the resolver so destroy() can flush us if we land
      // mid-animation (otherwise gsap.killTweensOf cancels without
      // firing onComplete → resolve never runs → the Promise hangs).
      this.resolvers.add(resolve);
      gsap.to(el, { x: dx, y: dy, duration: 0.3, ease: "power2.out",
        onComplete: () => {
          this.resolvers.delete(resolve);
          el.style.transform = "";
          dst.appendChild(el);
          this.pieces.delete(from);
          this.pieces.set(to, el);
          resolve();
        }
      });
    });
  }

  setSelectable(side: Side | null): void {
    this.state.selectable = side;
    this.clearSelection();
  }

  setLegalTargets(origin: Square, targets: Square[], captures: Square[]): void {
    this.clearSelection();
    this.selectedSq = origin;
    const sq = this.squares.get(origin);
    sq?.classList.add("selected");
    for (const t of targets) {
      const tEl = this.squares.get(t);
      if (!tEl) continue;
      tEl.classList.add("target");
      if (captures.includes(t)) {
        const ring = document.createElement("div");
        ring.className = "capture-target";
        tEl.appendChild(ring);
      }
    }
  }

  setLastMove(from: Square | undefined, to: Square | undefined): void {
    this.state.lastFrom = from;
    this.state.lastTo = to;
    for (const sq of this.squares.values()) sq.classList.remove("last-from", "last-to");
    if (from) this.squares.get(from)?.classList.add("last-from");
    if (to)   this.squares.get(to)?.classList.add("last-to");
  }

  setCheck(square: Square | null): void {
    this.state.inCheck = square ?? undefined;
    for (const sq of this.squares.values()) sq.classList.remove("in-check");
    if (square) this.squares.get(square)?.classList.add("in-check");
  }

  awaitPromotion(_from: Square, to: Square): Promise<Promotion | null> {
    // `from` retained in signature for API parity with the abstract ChessView;
    // picker is rendered on the destination square only.
    return new Promise((resolveOnce) => {
      let resolved = false;
      const resolve = (v: Promotion | null) => { if (!resolved) { resolved = true; resolveOnce(v); } };

      const hostSquare = this.squares.get(to);
      if (!hostSquare) return resolve(null);
      const picker = document.createElement("div");
      picker.className = "promo-picker";
      picker.style.position = "absolute";
      picker.style.inset = "0";
      picker.style.background = "rgba(0,0,0,0.7)";
      picker.style.borderRadius = "8px";
      picker.style.padding = "8px";
      picker.style.zIndex = "20";
      picker.style.cursor = "pointer";

      const options: Promotion[] = ["q", "r", "b", "n"];
      const symFor: Record<Promotion, PieceSymbol> = { q: "Q", r: "R", b: "B", n: "N" };
      const inPlaceOf: "white" | "black" = this.state.selectable ?? "white";

      options.forEach((p) => {
        const btn = document.createElement("button");
        btn.className = "promo-btn";
        btn.innerHTML = renderPieceSvg(inPlaceOf === "white" ? symFor[p] : symFor[p].toLowerCase() as PieceSymbol, this.pieceStyle);
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          picker.remove();
          resolve(p);
        });
        picker.appendChild(btn);
      });
      const cancel = document.createElement("button");
      cancel.className = "promo-btn ghost";
      cancel.textContent = "×";
      cancel.addEventListener("click", (e) => {
        e.stopPropagation();
        picker.remove();
        resolve(null);
      });
      picker.appendChild(cancel);

      // Click anywhere outside the picker cancels it (so the user can back out).
      const onDocClick = (e: MouseEvent) => {
        if (!picker.isConnected) return;
        if (!picker.contains(e.target as Node)) {
          picker.remove();
          document.removeEventListener("click", onDocClick);
          resolve(null);
        }
      };
      setTimeout(() => document.addEventListener("click", onDocClick), 0);

      hostSquare.appendChild(picker);
    });
  }

  flashIllegal(sq: Square): void {
    const el = this.squares.get(sq);
    if (!el) return;
    tweenIllegalShake(el);
    sounds.play("illegal");
  }

  clearSelection(): void {
    this.selectedSq = null;
    for (const sq of this.squares.values()) {
      sq.classList.remove("selected", "target");
      const ring = sq.querySelector(".capture-target");
      if (ring) ring.remove();
    }
  }

  highlightFromSquare(_sq: Square): void { /* currently unused; reserved */ }

  private hintTimer: number | null = null;
  /**
   * Set of pending Promise resolvers from in-flight animateMove /
   * animateRookMove awaits. drain in destroy() so any post-destroy
   * Promise resolves immediately instead of waiting on a GSAP tween
   * whose onComplete was cancelled by gsap.killTweensOf.
   */
  private resolvers: Set<() => void> = new Set();
  setHint(from: Square, to: Square): void {
    // Clear any prior hint first so successive calls don't accumulate.
    for (const sq of this.squares.values()) sq.classList.remove("hint-square");
    if (this.hintTimer !== null) {
      window.clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    this.squares.get(from)?.classList.add("hint-square");
    this.squares.get(to)?.classList.add("hint-square");
    // Auto-hide after 2.5s so old hints don't linger if the user forgets.
    this.hintTimer = window.setTimeout(() => {
      for (const sq of this.squares.values()) sq.classList.remove("hint-square");
      this.hintTimer = null;
    }, 2500);
  }

  private onSquareClick(e: MouseEvent): void {
    const target = e.currentTarget as HTMLDivElement;
    const sq = target.dataset.square as Square;
    if (this.dragOrigin) return; // a drag in flight will resolve on pointerup
    this.dispatchClickOrDrop(sq);
  }

  private onSquarePointerDown(e: PointerEvent): void {
    const target = e.currentTarget as HTMLDivElement;
    const sq = target.dataset.square as Square;
    if (!this.pieces.has(sq)) return;
    if (!this.canControlSide(sq)) {
      // still try to click-attempt a move (player clicked an opponent piece as a target).
      if (this.selectedSq) this.dispatchAttemptMove(this.selectedSq, sq);
      return;
    }
    e.preventDefault();
    this.dragOrigin = sq;
    const piece = this.pieces.get(sq)!;
    this.ghostSym = piece.dataset.piece as PieceSymbol;
    const rect = piece.getBoundingClientRect();
    const startX = rect.left;
    const startY = rect.top;

    this.ghostEl = document.createElement("div");
    this.ghostEl.className = "piece";
    this.ghostEl.innerHTML = renderPieceSvg(this.ghostSym, this.pieceStyle);
    this.ghostEl.style.position = "fixed";
    this.ghostEl.style.left = `${startX}px`;
    this.ghostEl.style.top = `${startY}px`;
    this.ghostEl.style.width = `${rect.width}px`;
    this.ghostEl.style.height = `${rect.height}px`;
    this.ghostEl.style.zIndex = "1000";
    this.ghostEl.style.pointerEvents = "none";
    this.ghostEl.style.filter = "drop-shadow(0 8px 14px rgba(0,0,0,0.4))";
    document.body.appendChild(this.ghostEl);

    const onMove = (ev: PointerEvent) => {
      if (!this.ghostEl) return;
      this.ghostEl.style.left = `${ev.clientX - rect.width / 2}px`;
      this.ghostEl.style.top = `${ev.clientY - rect.height / 2}px`;
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (this.ghostEl) { this.ghostEl.remove(); this.ghostEl = null; }
      this.dragOrigin = null;
    };
    const onUp = (ev: PointerEvent) => {
      cleanup();
      const dropEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const dropSq = dropEl?.closest?.(".square") as HTMLDivElement | null;
      const to = dropSq?.dataset.square as Square | undefined;
      if (this.dragOrigin && to) {
        if (this.dragOrigin === to) {
          this.dispatchClickOrDrop(this.dragOrigin);
        } else {
          this.dispatchAttemptMove(this.dragOrigin, to);
        }
      }
    };
    const onCancel = () => cleanup();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onCancel, { once: true });

    // Also select on pointerdown so click-to-move still works without dragging.
    this.dispatchClickOrDrop(sq);
  }

  private canControlSide(sq: Square): boolean {
    const sel = this.state.selectable;
    if (!sel) return false;
    const sym = this.pieces.get(sq)?.dataset.piece as PieceSymbol | undefined;
    if (!sym) return false;
    const isWhite = sym === sym.toUpperCase();
    return (sel === "white" && isWhite) || (sel === "black" && !isWhite);
  }

  private dispatchClickOrDrop(sq: Square): void {
    if (this.selectedSq && sq !== this.selectedSq) {
      this.dispatchAttemptMove(this.selectedSq, sq);
      return;
    }
    if (this.canControlSide(sq)) {
      this.onSelect?.(sq);
    } else if (this.selectedSq) {
      this.dispatchAttemptMove(this.selectedSq, sq);
    }
  }

  private dispatchAttemptMove(from: Square, to: Square): void {
    this.onMoveAttempt?.({ from, to });
  }
}

// (No trailing dead-code comment)
