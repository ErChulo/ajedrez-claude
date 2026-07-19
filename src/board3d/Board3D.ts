// 3D board renderer (Three.js).
// Pieces use procedural Staunton-style geometry assembled from LatheGeometry,
// cylinders, boxes, and cones as the default — the "staunton" PieceStyle
// replaces this with MIT-licensed real-geometry STL meshes loaded once and
// cached per-kind. See ./piece-styles.ts for the loader.
//
// Interactivity (v1.13): the 3D view IS now playable. Pointer events on the
// renderer's canvas are read into NDC, fed to a Raycaster, and intersected
// against piece Groups + square meshes. Click vs camera-drag is gated by
// pointer movement distance and elapsed time (<5px, <400ms). User clicks
// invoke the Game-attached select / move-attempt handlers exactly like the
// 2D view's pointer events do.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import gsap from "gsap";
import { setupLighting, setupRenderer } from "./lighting";
import { buildPieceMaterial, buildBoardMaterial } from "./materials";
import { buildPieceGeometry, prefetchStauntonGeometries } from "./piece-styles";
import { DEFAULT_PIECE_STYLE, PIECE_STYLE_IDS, type PieceStyleId } from "@/types";
import type { MoveRecord, PieceSymbol, Side, Square, ThemeData } from "@/types";

const BOARD = { size: 4.0, squareSize: 0.5, height: 0.1, baseY: 0 };
// v1.15: visual scale-up applied to every piece group (after geometry
// construction) so pieces fill their squares more dominantly on screen.
// 1.18× keeps the largest piece base radius (~0.40u, the king) at ~0.47u
// — still inside the 0.5u square footprint so adjacent pieces don't
// visually collide. The constant is reused in animateMove's promotion
// grow-in so the new piece settles at exactly the same final scale as
// the other pieces (otherwise the promotion pop would visibly undershoot).
const PIECE_VISUAL_SCALE = 1.18;
type MoveKind = "move" | "capture" | "castle" | "enpassant" | "promote";
type PieceKind = "p" | "n" | "b" | "r" | "q" | "k";
type HighlightKind = "select" | "legal" | "capture" | "last" | "check";

const HIGHLIGHT_COLORS: Record<HighlightKind, number> = {
  select:  0xffeb78,
  legal:   0x78eb82,
  capture: 0xeb7878,
  last:    0x50a0ff,
  check:   0xff5a5a,
};
// Distinct color for the engine-recommended hint — picked to be visually
// different from "select" (yellow) and "legal" (green) so users can tell
// these apart at a glance.
const HINT_COLOR = 0x65d6a8;

function fileIndex(sq: Square): number { return "abcdefgh".indexOf(sq[0]); }
function rankIndex(sq: Square): number { return 8 - parseInt(sq[1], 10); }
function worldX(sq: Square): number { return (fileIndex(sq) - 3.5) * BOARD.squareSize; }
function worldZ(sq: Square): number { return (rankIndex(sq) - 3.5) * BOARD.squareSize; }
function pieceSymbolIsWhite(s: PieceSymbol): boolean { return s === s.toUpperCase(); }
function toPieceKind(s: PieceSymbol): PieceKind { return s.toLowerCase() as PieceKind; }

export class Board3D {
  private host: HTMLElement;
  private renderer?: THREE.WebGLRenderer;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private controls?: OrbitControls;
  private pieceMeshes: Map<Square, THREE.Group> = new Map();
  private squares: Map<Square, THREE.Mesh> = new Map();
  private highlights: THREE.Mesh[] = [];
  private pieceMaterials: THREE.Material[] = [];
  private boardMaterials: THREE.Material[] = [];
  private frameMaterial?: THREE.Material;
  private theme: ThemeData;
  private rafHandle = 0;
  private resizeObs?: ResizeObserver;
  private selectable: Side | null = null;
  // v1.12: piece-style registry id (matches Board2D). Drives which
  // geometry buildPieceGeometry() emits. Default "classic" matches
  // the v1.11 look.
  public pieceStyle: PieceStyleId = DEFAULT_PIECE_STYLE;
  // v1.12: snapshot of the latest board state so setPieceStyle() can
  // re-render every piece after a style swap. Updated in redraw().
  private boardSnap: Map<Square, PieceSymbol> = new Map();
  // v1.13: 3D interactivity state — mirrors Game's "currentSelectedSquare"
  // so we can decide whether a user click becomes a select or a moveAttempt.
  // Game is the authority; we sync from its setLegalTargets/origin calls
  // and reset to null when Game calls clearSelection or when a moveAttempt
  // fires (the move will re-set it via setLegalTargets if the move was legal).
  private selectedSq: Square | null = null;
  private onMoveAttempt?: (from: Square, to: Square) => void;
  private onSelect?: (sq: Square) => void;
  private raycaster = new THREE.Raycaster();
  private pointerNDC = new THREE.Vector2();
  // Pointerdown position + time — used to disambiguate a real click from an
  // OrbitControls drag (which fires pointerup too).
  private pointerDown: { x: number; y: number; t: number } | null = null;
  /** Bound handlers so we can remove them in destroy(). */
  private readonly handlePointerDown = (e: PointerEvent): void => { this.onPointerDown(e); };
  private readonly handlePointerUp = (e: PointerEvent): void => { this.onPointerUp(e); };

  /**
   * v1.12 — Apply the user's selected piece style. Triggers a full
   * scene rebuild so every piece is regenerated with the new ornaments.
   * The Game controller is style-agnostic; App.ts cascades down via
   * this call, then redraw() iterates the existing pieceMeshes map.
   *
   * Geometry disposal: each piece's `lathe` geometry + ornament children
   * geometries are disposed in the rebuild loop. Materials are SHARED
   * across pieces (see applyTheme comment) so they go through the
   * pieceMaterials array dispose path.
   */
  setPieceStyle(id: PieceStyleId): void {
    if (!PIECE_STYLE_IDS.includes(id)) return;
    if (this.pieceStyle === id) return;
    this.pieceStyle = id;
    if (!this.scene || this.pieceMeshes.size === 0) return;
    // Dispose geometries of every existing piece (materials are shared).
    for (const [, g] of this.pieceMeshes) {
      g.traverse((c) => {
        const node = c as THREE.Mesh;
        if (node.geometry) node.geometry.dispose();
      });
      this.scene.remove(g);
    }
    this.pieceMeshes.clear();
    // Re-emit every square using the last-known board state and the
    // new style. boardSnap was filled by redraw() so it's current.
    for (const [sq, sym] of this.boardSnap.entries()) {
      const group = this.makePieceMesh(sym);
      (group.userData as { square: Square }).square = sq;
      group.position.set(worldX(sq), BOARD.baseY + BOARD.height, worldZ(sq));
      group.castShadow = true;
      group.receiveShadow = true;
      this.scene.add(group);
      this.pieceMeshes.set(sq, group);
    }
  }

  constructor(host: HTMLElement) {
    this.host = host;
    this.theme = defaultTheme();
    // Palette is set here so makePieceMesh() and applyTheme() can rely on
    // pieceMaterials being a valid [white, black] pair before mount(). The
    // frame's own material is tracked separately (see `frameMaterial`) and
    // is NOT part of the palette — keeping it that way prevents theme switches
    // from disposing the frame's still-in-use material.
    this.pieceMaterials = pieceMaterialPalette(this.theme);
  }

  mount(theme: ThemeData): void {
    this.theme = theme;
    const width = this.host.clientWidth || 800;
    const height = this.host.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    setupRenderer(this.renderer);
    this.host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    setupLighting(this.scene, this.renderer);

    // v1.11: camera lowered + pulled back (was 0, 6, 6) — the high
    // top-down angle hid piece silhouettes; the lower (0, 4.5, 7.5)
    // angle shows more of the side profile so king crosses, queen
    // coronets, bishop mitres, rook merlons, and knight muzzles read
    // at a glance. Pulled back along z so the larger ornaments don't
    // crowd the right/left edges when 32 pieces are all on-screen.
    //
    // v1.15: aspect is locked to 1:1 at mount (the prior width/height
    // aspect matched only when the .board-3d-host box resolved to a
    // square — which was the common case but not guaranteed across
    // every browser/layout edge case, especially on iOS where the URL
    // bar collapse can land mid-mount). Camera moved slightly closer
    // (4.5, 7.5) → (3.6, 6.0) so the board fills more of the canvas
    // vertically; combined with PIECE_VISUAL_SCALE in makePieceMesh
    // this gives a noticeably larger, more dominant 3D view.
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(0, 3.6, 6.0);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = 3.5;
    this.controls.maxDistance = 14;
    this.controls.maxPolarAngle = Math.PI / 2.1;

    this.buildBoard();
    this.startLoop();

    // v1.13: kick off the MIT-Staunton STL pre-load so by the time a user
    // selects the "staunton" style (or redraws after switching render modes),
    // all 6 cached BufferGeometries are ready. If the user picked a different
    // style on first paint, the load still completes silently — no-op.
    void prefetchStauntonGeometries();

    // v1.13: pointer events drive the click → select / moveAttempt chain.
    // Listen on the renderer's <canvas>, NOT this.host, so clicks bubble up
    // only when they hit Three.js scene-space and not the surrounding UI.
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointerup", this.handlePointerUp);

    this.resizeObs = new ResizeObserver(() => this.handleResize());
    this.resizeObs.observe(this.host);
  }

  destroy(): void {
    // Cancel the autohide setTimeout first so it can't fire against a
    // torn-down view's `squares` / `highlights` collections.
    if (this.hintTimer !== null) {
      window.clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    // Kill any in-flight GSAP tweens (square flash-shake from
    // flashIllegal(), promotion grow-in). Without this, an active tween's
    // onComplete can run after dispose and touch detached Three.js objects.
    for (const [, mesh] of this.squares) gsap.killTweensOf(mesh.scale);
    for (const [, g] of this.pieceMeshes) {
      g.traverse((c) => {
        const node = c as THREE.Object3D;
        if (node.scale) gsap.killTweensOf(node.scale);
      });
    }
    // GSAP's killTweensOf cancels but does NOT fire onComplete. Drain
    // any in-flight Promise resolvers from animateMove so the awaits
    // in Game.executeMove resolve immediately instead of hanging on a
    // killed tween's onComplete. Without this, render-mode toggles
    // during an in-progress promotion wedge the game permanently.
    for (const r of this.resolvers) r();
    this.resolvers.clear();
    this.resizeObs?.disconnect();
    this.controls?.dispose();
    // v1.13: detach pointer listeners so a re-mount doesn't double-bind.
    this.renderer?.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer?.domElement.removeEventListener("pointerup", this.handlePointerUp);
    for (const m of this.pieceMaterials) m.dispose();
    for (const m of this.boardMaterials) m.dispose();
    this.frameMaterial?.dispose();
    for (const [, mesh] of this.squares) mesh.geometry.dispose();
    for (const [, g] of this.pieceMeshes) {
      g.traverse((c) => {
        const node = c as THREE.Mesh;
        if (node.geometry) node.geometry.dispose();
        // Materials are *shared references* across the lathe + the
        // ~16 ornaments (rook merlons, queen spikes, bishop ball,
        // king cross beams, knight ears). They're disposed by the
        // `for (const m of this.pieceMaterials) m.dispose()` above,
        // which only needs to call dispose() twice (once per side)
        // instead of ~544 (32 pieces × ~17 mesh refs). Re-introducing
        // a per-mesh material.dispose() here would silently multiply
        // teardown work without changing correctness — Three.js
        // handles redundant dispose() calls but it still fires
        // dispose events on the GPU resource manager.
      });
    }
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }

  // v1.13: select + move handlers ARE now wired for the 3D view. App.ts
  // already invokes these (defensively via `typeof anyView.setMoveAttemptHandler
  // === "function"` on the abstract ChessView).
  setMoveAttemptHandler(fn: (from: Square, to: Square) => void): void { this.onMoveAttempt = fn; }
  setSelectHandler(fn: (sq: Square) => void): void { this.onSelect = fn; }

  redraw(board: Record<Square, PieceSymbol | null>): void {
    if (!this.scene) return;
    for (const [, g] of this.pieceMeshes) this.scene.remove(g);
    this.pieceMeshes.clear();
    // v1.12: snapshot latest board state for setPieceStyle() rebuild.
    this.boardSnap.clear();
    for (const [sq, sym] of Object.entries(board) as [Square, PieceSymbol | null][]) {
      if (!sym) continue;
      const group = this.makePieceMesh(sym);
      (group.userData as { square: Square }).square = sq;
      group.position.set(worldX(sq), BOARD.baseY + BOARD.height, worldZ(sq));
      group.castShadow = true;
      group.receiveShadow = true;
      this.scene.add(group);
      this.pieceMeshes.set(sq, group);
      this.boardSnap.set(sq, sym);
    }
  }

  animateMove(rec: MoveRecord, kind: { kind: MoveKind }): Promise<void> {
    return new Promise((resolve) => {
      // Track the resolver so destroy() can flush us if we land
      // mid-animation (otherwise gsap.killTweensOf cancels without
      // firing onComplete → resolve never runs → Game.executeMove's
      // finally block never clears isProcessingMove, wedging the game).
      this.resolvers.add(resolve);
      // Mirror redraw(): bail if the view isn't mounted (e.g. mid-destroy or
      // before mount). Without this, `this.scene.remove/add` would crash if
      // something during teardown fires a stale move animation.
      if (!this.scene) { this.resolvers.delete(resolve); return resolve(); }
      const group = this.pieceMeshes.get(rec.from);
      if (!group) { this.resolvers.delete(resolve); return resolve(); }
      group.position.x = worldX(rec.to);
      group.position.z = worldZ(rec.to);
      (group.userData as { square: Square }).square = rec.to; // v1.13: keep raycast data current after a move.
      this.pieceMeshes.delete(rec.from);
      this.pieceMeshes.set(rec.to, group);
      if (kind.kind === "promote") {
        const replacement = this.makePieceMesh(rec.promotion ?? rec.piece);
        (replacement.userData as { square: Square }).square = rec.to;
        replacement.position.set(worldX(rec.to), BOARD.baseY + BOARD.height, worldZ(rec.to));
        // v1.15: scale-up baseline matches PIECE_VISUAL_SCALE so the
        // promotion grow-in lands at the same final visual size as
        // every other piece (otherwise it would visibly undershoot).
        replacement.scale.set(0.001 * PIECE_VISUAL_SCALE, 0.001 * PIECE_VISUAL_SCALE, 0.001 * PIECE_VISUAL_SCALE);
        this.scene.remove(group);
        this.scene.add(replacement);
        this.pieceMeshes.set(rec.to, replacement);
        // AWAIT the promotion grow-in. Previously fire-and-forget, which
        // let Game.executeMove return while the new piece was still at
        // scale ~0.001 — a fast follow-up click could collide. Resolve
        // inside the tween's onComplete so Game waits for the grow.
        gsap.to(replacement.scale, {
          x: PIECE_VISUAL_SCALE,
          y: PIECE_VISUAL_SCALE,
          z: PIECE_VISUAL_SCALE,
          duration: 0.5,
          ease: "back.out(2)",
          onComplete: () => {
            this.resolvers.delete(resolve);
            resolve();
          },
        });
      } else {
        this.resolvers.delete(resolve);
        resolve();
      }
    });
  }

  animateRookMove(from: Square, to: Square): Promise<void> {
    return new Promise((resolve) => {
      const mesh = this.pieceMeshes.get(from);
      if (!mesh) return resolve();
      this.pieceMeshes.delete(from);
      mesh.position.x = worldX(to);
      mesh.position.z = worldZ(to);
      this.pieceMeshes.set(to, mesh);
      resolve();
    });
  }

  setSelectable(side: Side | null): void { this.selectable = side; }

  setLegalTargets(origin: Square, targets: Square[], captures: Square[]): void {
    this.clearSelection();
    // `this.selectable` gates interactivity — only render outcomes if a side is actively playable.
    if (this.selectable === null) return;
    this.selectedSq = origin; // v1.13: sync shadow selection from Game's authoritative call.
    this.highlightSquare(origin, "select");
    for (const t of targets) this.highlightSquare(t, captures.includes(t) ? "capture" : "legal");
  }
  setLastMove(from: Square | undefined, to: Square | undefined): void {
    this.clearHighlightByName("last");
    if (from) this.highlightSquare(from, "last");
    if (to)   this.highlightSquare(to, "last");
  }
  setCheck(square: Square | null): void {
    this.clearHighlightByName("check");
    if (square) this.highlightSquare(square, "check");
  }
  clearSelection(): void {
    this.selectedSq = null; // v1.13: drop shadow selection when Game clears it.
    this.clearHighlightByName("legal");
    this.clearHighlightByName("select");
    this.clearHighlightByName("capture");
  }
  highlightFromSquare(sq: Square): void {
    this.clearHighlightByName("select");
    this.highlightSquare(sq, "select");
  }
  private hintTimer: number | null = null;
  /**
   * Set of pending Promise resolvers from in-flight animateMove awaits.
   * drain in destroy() so any post-destroy Promise resolves immediately
   * instead of waiting on a GSAP tween whose onComplete was cancelled
   * by gsap.killTweensOf. Without this, render-mode toggles during
   * an in-progress promotion wedge the game permanently.
   */
  private resolvers: Set<() => void> = new Set();
  setHint(from: Square, to: Square): void {
    this.clearHighlightByName("hint");
    if (this.hintTimer !== null) {
      window.clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    const f = this.squares.get(from);
    const t = this.squares.get(to);
    if (f) {
      const overlay = new THREE.Mesh(
        new THREE.PlaneGeometry(BOARD.squareSize * 0.92, BOARD.squareSize * 0.92),
        new THREE.MeshBasicMaterial({ color: HINT_COLOR, transparent: true, opacity: 0.55, depthWrite: false }),
      );
      overlay.rotation.x = -Math.PI / 2;
      overlay.position.set(f.position.x, BOARD.baseY + BOARD.height / 2 + 0.015, f.position.z);
      (overlay.userData as { tag: string }).tag = "highlight-hint";
      this.scene?.add(overlay);
      this.highlights.push(overlay);
    }
    if (t) {
      const overlay = new THREE.Mesh(
        new THREE.PlaneGeometry(BOARD.squareSize * 0.92, BOARD.squareSize * 0.92),
        new THREE.MeshBasicMaterial({ color: HINT_COLOR, transparent: true, opacity: 0.55, depthWrite: false }),
      );
      overlay.rotation.x = -Math.PI / 2;
      overlay.position.set(t.position.x, BOARD.baseY + BOARD.height / 2 + 0.015, t.position.z);
      (overlay.userData as { tag: string }).tag = "highlight-hint";
      this.scene?.add(overlay);
      this.highlights.push(overlay);
    }
    // Auto-hide after 2.5s.
    this.hintTimer = window.setTimeout(() => {
      this.clearHighlightByName("hint");
      this.hintTimer = null;
    }, 2500);
  }
  awaitPromotion(from: Square, to: Square): Promise<"q" | "r" | "b" | "n" | null> {
    void from; void to;
    return Promise.resolve("q"); // 3D-mode auto-promotes until a 3D picker is built
  }
  flashIllegal(sq: Square): void {
    const sqMesh = this.squares.get(sq);
    if (!sqMesh) return;
    gsap.fromTo(sqMesh.scale, { x: 1, z: 1 }, { x: 1.06, z: 1.06, duration: 0.08, yoyo: true, repeat: 3 });
  }

  applyTheme(theme: ThemeData): void {
    this.theme = theme;
    for (const m of this.pieceMaterials) m.dispose();
    this.pieceMaterials = pieceMaterialPalette(theme);
    // pieceMaterialPalette() is a pure helper that always returns [white, black],
    // so the non-null assertions below are sound. The frame has its own
    // material (see `frameMaterial`) and is intentionally NOT re-themed here —
    // it's the static wood tray around the board, separate from the variable
    // piece/board palette.
    const whiteMat = this.pieceMaterials[0]!;
    const blackMat = this.pieceMaterials[1]!;
    for (const [, mesh] of this.pieceMeshes) {
      mesh.traverse((c) => {
        const node = c as THREE.Mesh;
        const symbol = (node.userData as { symbol?: PieceSymbol }).symbol;
        if (symbol) {
          node.material = pieceSymbolIsWhite(symbol) ? whiteMat : blackMat;
        }
      });
    }
    for (const m of this.boardMaterials) m.dispose();
    this.boardMaterials = buildBoardMaterial(theme);
    const light = this.boardMaterials[0]!;
    const dark = this.boardMaterials[1]!;
    let i = 0;
    for (const [, sq] of this.squares) {
      sq.material = i % 2 === 0 ? light : dark;
      i++;
    }
  }

  // -------- internals --------

  private buildBoard(): void {
    if (!this.scene) return;
    const geo = new THREE.BoxGeometry(BOARD.size + 0.6, BOARD.height, BOARD.size + 0.6);
    const frameMat = new THREE.MeshPhysicalMaterial({
      color: 0x402613, roughness: 0.7, metalness: 0.0, clearcoat: 0.1,
    });
    // Frame material is tracked separately from the [white, black] piece
    // palette so a theme switch doesn't dispose the frame's still-in-use
    // material via pieceMaterials.forEach(m.dispose).
    this.frameMaterial = frameMat;
    const frame = new THREE.Mesh(geo, frameMat);
    frame.position.y = BOARD.baseY - BOARD.height / 2;
    frame.receiveShadow = true;
    this.scene.add(frame);

    this.boardMaterials = buildBoardMaterial(this.theme);
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const mat = this.boardMaterials[(r + f) % this.boardMaterials.length];
        const sqMesh = new THREE.Mesh(
          new THREE.BoxGeometry(BOARD.squareSize, BOARD.height, BOARD.squareSize),
          mat,
        );
        sqMesh.position.set((f - 3.5) * BOARD.squareSize, BOARD.baseY, (r - 3.5) * BOARD.squareSize);
        sqMesh.receiveShadow = true;
        this.scene.add(sqMesh);
        const sq = (`${"abcdefgh"[f]}${8 - r}`) as Square;
        (sqMesh.userData as { square: Square }).square = sq; // v1.13: raycaster reads userData.square to map hit → square.
        this.squares.set(sq, sqMesh);
      }
    }
  }

  private makePieceMesh(sym: PieceSymbol): THREE.Group {
    const group = new THREE.Group();
    const lower = toPieceKind(sym);
    const isWhite = pieceSymbolIsWhite(sym);
    // Build the material FIRST and pass it into makePieceGeometry so
    // the Staunton ornaments (rook merlons, queen spikes, bishop
    // ball, king cross, knight ears) share the piece's PBR material.
    // Previously the ornaments were MeshBasicMaterial({ visible:
    // false }) — invisible — so the 3D set rendered as bare lathe
    // cylinders. Re-enabling them with a shared material is what
    // turns the bare rotations into recognizable Staunton pieces.
    const material = isWhite ? this.pieceMaterials[0]! : this.pieceMaterials[1]!;
    const mesh = buildPieceGeometry(lower, sym, material, this.pieceStyle);
    group.add(mesh);
    // v1.15: visual scale-up — see PIECE_VISUAL_SCALE at the top of
    // this file. With 1.18× the largest piece base radius stretches
    // from ~0.40u to ~0.47u, maxing out the 0.5u square footprint
    // (it visibly fills more screen real estate without ever
    // colliding with neighbour centres that sit 0.5u apart).
    group.scale.set(PIECE_VISUAL_SCALE, PIECE_VISUAL_SCALE, PIECE_VISUAL_SCALE);
    return group;
  }

  private highlightSquare(sq: Square, kind: HighlightKind): void {
    if (!this.scene) return;
    const sqMesh = this.squares.get(sq);
    if (!sqMesh) return;
    const color = HIGHLIGHT_COLORS[kind];
    const overlay = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD.squareSize * 0.92, BOARD.squareSize * 0.92),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    overlay.rotation.x = -Math.PI / 2;
    overlay.position.set(sqMesh.position.x, BOARD.baseY + BOARD.height / 2 + 0.01, sqMesh.position.z);
    (overlay.userData as { tag: string }).tag = `highlight-${kind}`;
    this.scene.add(overlay);
    this.highlights.push(overlay);
  }

  private clearHighlightByName(name: string): void {
    if (!this.scene) return;
    this.highlights = this.highlights.filter((h) => {
      const tag = (h.userData as { tag: string }).tag;
      if (tag.includes(name)) {
        this.scene!.remove(h);
        h.geometry.dispose();
        (h.material as THREE.Material).dispose();
        return false;
      }
      return true;
    });
  }

  private startLoop(): void {
    const tick = () => {
      this.controls?.update();
      const scene = this.scene;
      const camera = this.camera;
      const renderer = this.renderer;
      if (scene && camera && renderer) renderer.render(scene, camera);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private handleResize(): void {
    if (!this.renderer || !this.camera) return;
    const w = this.host.clientWidth || 800;
    const h = this.host.clientHeight || 800;
    // v1.15: ALWAYS render the 3D board as a perfect 1:1 square. The
    // .board-3d-host CSS rule has `aspect-ratio: 1/1`, which makes the
    // host box square on every layout — but if a parent layout edge
    // case (e.g. an iOS URL bar transition rounding error) ever
    // resolves a non-square host, we'd otherwise stretch the board
    // horizontally or vertically. Picking min(w,h) for both axes
    // guarantees a square canvas AND guarantees we never overflow
    // either dimension. camera.aspect=1 then keeps the projection
    // matrix in lockstep with the renderer.
    const size = Math.max(1, Math.min(w, h));
    this.renderer.setSize(size, size, false);
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
  }

  // ---- v1.13: pointer / raycaster click chain ----

  private onPointerDown(e: PointerEvent): void {
    // Record the down position + time so onPointerUp can decide if this is
    // a single-click (move <5px, <400ms) or an OrbitControls drag that
    // happens to end on the canvas. The 400ms ceiling is generous — the
    // typical flick-drag-snap is 80–150ms; a deliberate click on a piece
    // is 30–80ms on press + 30–80ms on release.
    this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
  }

  private onPointerUp(e: PointerEvent): void {
    const pd = this.pointerDown;
    this.pointerDown = null;
    if (!pd) return;
    const dist = Math.hypot(e.clientX - pd.x, e.clientY - pd.y);
    if (dist > 5) return;          // it was an OrbitControls drag → ignore
    if (performance.now() - pd.t > 400) return; // too slow for a confident click
    if (!this.scene || !this.camera || !this.renderer) return;
    if (this.selectable === null) return;  // not a playable side yet
    const sq = this.raycastSquare(e);
    if (!sq) return;
    this.handleSquareClick(sq, e);
  }

  /**
   * Raycast the pointer against piece Groups + square meshes. Walks the
   * parent chain on each hit so any child mesh (e.g. ornament child meshes)
   * can be attributed to the parent Group's `userData.square`. Returns the
   * nearest hit's square, or null if no hit.
   */
  private raycastSquare(e: PointerEvent): Square | null {
    const canvas = this.renderer!.domElement;
    const rect = canvas.getBoundingClientRect();
    this.pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNDC, this.camera!);
    const targets: THREE.Object3D[] = [];
    for (const [, g] of this.pieceMeshes) targets.push(g);
    for (const [, s] of this.squares) targets.push(s);
    const hits = this.raycaster.intersectObjects(targets, true);
    if (hits.length === 0) return null;
    for (const h of hits) {
      let obj: THREE.Object3D | null = h.object;
      while (obj) {
        const ud = obj.userData as { square?: Square } | undefined;
        if (ud && typeof ud.square === "string") return ud.square as Square;
        obj = obj.parent;
      }
    }
    return null;
  }

  private handleSquareClick(sq: Square, _e: PointerEvent): void {
    // No selection — first click is "select this square" (Game decides if
    // legal via selectSquare; flashes illegal if not).
    if (this.selectedSq === null) {
      this.onSelect?.(sq);
      return;
    }
    // Already selected — treat as a move attempt from selection → clicked sq.
    const from = this.selectedSq;
    // Don't optimistically clear `selectedSq` here: Game.attemptMove() may
    // re-call setLegalTargets() with a new origin (reselect) or
    // clearSelection() on illegal moves. Trust Game to own the truth.
    this.onMoveAttempt?.(from, sq);
  }
}

function pieceMaterialPalette(theme: ThemeData): THREE.Material[] {
  return [buildPieceMaterial("white", theme), buildPieceMaterial("black", theme)];
}

function defaultTheme(): ThemeData {
  return {
    name: "wood",
    cssVars: {},
    three: {
      boardLight: 0xead2a8,
      boardDark: 0xa37049,
      pieceWhite: { color: 0xf2e8d2, roughness: 0.55, metalness: 0.05 },
      pieceBlack: { color: 0x2a1f12, roughness: 0.55, metalness: 0.05 },
      squareEmissive: 0x000000,
    },
  };
}

