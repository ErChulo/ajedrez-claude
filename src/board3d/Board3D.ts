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
import { buildPieceGeometry, prefetchPieceStyleAssets } from "./piece-styles";
import { DEFAULT_PIECE_STYLE, PIECE_STYLE_IDS, type PieceStyleId } from "@/types";
import type { ApplyMoveInput, MoveRecord, PieceSymbol, Side, Square, ThemeData } from "@/types";

const BOARD = { size: 4.0, squareSize: 0.5, height: 0.1, baseY: 0 };
// v1.15: visual scale-up applied to every piece group (after geometry
// construction) so pieces fill their squares more dominantly on screen.
// 1.18× keeps the largest piece base radius (~0.40u, the king) at ~0.47u
// — still inside the 0.5u square footprint so adjacent pieces don't
// visually collide. The constant is reused in animateMove's promotion
// grow-in so the new piece settles at exactly the same final scale as
// the other pieces (otherwise the promotion pop would visibly undershoot).
const PIECE_VISUAL_SCALE = 1.08;
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
  private initTimer: number | null = null;
  private flipped = false;
  // Unit vector from the orbit target back toward the default camera
  // position, computed at mount. Kept here so applyZoomLimits can frame
  // the board along the same view direction the user starts on (and that
  // setFlipped mirrors to the opposite side).
  private mountBaseDir = new THREE.Vector3(0, 0.565, 0.825);
  private resizeObs?: ResizeObserver;
  private disposed = false;
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
  private onMoveAttempt?: (input: ApplyMoveInput) => void;
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
    this.host.dataset.pieceStyle = id;
    this.host.dataset.pieceAssets = id === "asset-pack" || id === "staunton" ? "loading" : "ready";
    this.rebuildPiecesFromSnapshot();
    void prefetchPieceStyleAssets(id).then(() => {
      if (!this.disposed && this.pieceStyle === id) this.host.dataset.pieceAssets = "ready";
      if (!this.disposed && this.pieceStyle === id && this.boardSnap.size > 0) {
        this.rebuildPiecesFromSnapshot();
      }
    });
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

  setFlipped(flipped: boolean): void {
    this.flipped = flipped;
    if (!this.camera || !this.controls) return;
    // Mirror the default view to the opposite side, sitting at the
    // current fit distance so the whole board stays in frame.
    this.mountBaseDir.set(0, 0.565, flipped ? -0.825 : 0.825).normalize();
    const dir = this.mountBaseDir.clone();
    const dist = this.computeFitDistance() * 1.12;
    this.controls.target.set(0, 0.12, 0);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  mount(theme: ThemeData): void {
    this.disposed = false;
    this.theme = theme;
    const statusBanner = document.createElement("div");
    statusBanner.className = "three-fallback";
    statusBanner.dataset.state = "loading";
    statusBanner.textContent = "Loading 3D board…";
    this.host.appendChild(statusBanner);
    this.host.setAttribute("data-3d-state", "loading");
    this.host.dataset.pieceStyle = this.pieceStyle;
    this.host.dataset.pieceAssets = this.pieceStyle === "asset-pack" || this.pieceStyle === "staunton" ? "loading" : "ready";
    // The host .board-3d-host now fills the whole .board-host area (not a
    // 1:1 square — see style.css), so size the WebGL drawing buffer to
    // the actual host width × height. updateStyle=true also drives the
    // canvas's CSS dimensions; without it browsers leave the canvas at
    // its default 300×150 CSS box regardless of the drawing buffer.
    const initW = this.host.clientWidth || 800;
    const initH = this.host.clientHeight || 600;

    this.initTimer = window.setTimeout(() => {
      this.initTimer = null;
      if (this.disposed) return;
      try {
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(initW, initH, true);
        setupRenderer(this.renderer);
        this.host.appendChild(this.renderer.domElement);
        statusBanner.remove();
        // v1.18: tag the host so smoke.spec.ts can wait for either the
        // canvas OR a WebGL-fallback marker — see the `else` branch below
        // for why the fallback exists at all.
        this.host.setAttribute("data-3d-state", "webgl");
      } catch (e) {
      // v1.18: WebGL is unavailable in this browser / GPU context. This
      // happens for example on headless Firefox on Ubuntu CI, where
      // SwiftShader-based CPU WebGL can fail to create a context inside
      // the headless-window initialisation timing budget. Without a
      // fallback, the user (or CI) sees a blank .board-3d-host with
      // NO canvas, which is worse than a graceful "3D mode unavailable"
      // message. The fallback DOM marker is checked by smoke.spec.ts
      // as an alternative success signal.
      console.warn("[Board3D] WebGL unavailable, mounting 3D-fallback banner:", e);
      statusBanner.dataset.state = "webgl-unavailable";
      statusBanner.textContent = "3D mode unavailable in this browser environment";
      if (!statusBanner.isConnected) this.host.appendChild(statusBanner);
      this.host.setAttribute("data-3d-state", "webgl-unavailable");
      // v1.18: tell App.ts we want to auto-flip back to 2D so the user
      // sees a playable board instead of a stuck 3D-mode fallback
      // banner. The event name is namespaced (`ajedrez:…`) so external
      // tooling can't accidentally collide with it. App.ts listens
      // once at app-mount time and clicks the 2D topbar toggle.
      queueMicrotask(() => document.dispatchEvent(new CustomEvent("ajedrez:webgl-fallback")));
      // Early return so the rest of mount() (scene/camera/controls/
      // buildBoard/startLoop/listeners/resizeObs) only runs on the
      // WebGL success path. TS narrows `this.renderer` from optional
      // to defined after the early return in catch.
      return;
    }

    this.scene = new THREE.Scene();
    setupLighting(this.scene, this.renderer);

    // The 3D canvas now fills the whole .board-host (non-square), so the
    // projection aspect must match the host width/height — otherwise the
    // scene stretches. The default view sits at the "everything fits"
    // distance for the current aspect with a comfortable margin, and
    // controls.minDistance stops the user from zooming in past the point
    // where board corners leave the frustum (the old hard-coded 4.6 let
    // the near edge drop below the frame).
    const mountAspect = initW / initH;
    this.camera = new THREE.PerspectiveCamera(40, mountAspect, 0.1, 100);
    const dirY = 4.15;
    const dirZ = this.flipped ? -6.75 : 6.75;
    this.mountBaseDir = new THREE.Vector3(0, dirY, dirZ).normalize();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0.12, 0);
    // Frame the camera at the old default along mountBaseDir first so
    // computeFitDistance has a sane live direction, then place it at the
    // exact "everything fits" distance for the current aspect.
    this.camera.position.copy(this.controls.target).addScaledVector(this.mountBaseDir, Math.hypot(dirY, dirZ));
    this.camera.lookAt(this.controls.target);
    const fitDist = this.computeFitDistance();
    const defaultDist = fitDist * 1.12;
    this.camera.position.copy(this.controls.target).addScaledVector(this.mountBaseDir, defaultDist);
    this.camera.lookAt(this.controls.target);
    this.controls.maxDistance = 16;
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.applyZoomLimits();

    this.buildBoard();
    if (this.boardSnap.size > 0) this.rebuildPiecesFromSnapshot();
    this.startLoop();

    // v1.13: kick off the MIT-Staunton STL pre-load so by the time a user
    // selects the "staunton" style (or redraws after switching render modes),
    // all 6 cached BufferGeometries are ready. If the user picked a different
    // style on first paint, the load still completes silently — no-op.
    void prefetchPieceStyleAssets(this.pieceStyle).then(() => {
      if (!this.disposed) this.host.dataset.pieceAssets = "ready";
      if (!this.disposed && this.boardSnap.size > 0) {
        this.rebuildPiecesFromSnapshot();
      }
    });

    // v1.13: pointer events drive the click → select / moveAttempt chain.
    // Listen on the renderer's <canvas>, NOT this.host, so clicks bubble up
    // only when they hit Three.js scene-space and not the surrounding UI.
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointerup", this.handlePointerUp);

    this.resizeObs = new ResizeObserver(() => this.handleResize());
    this.resizeObs.observe(this.host);
    }, 750);
  }

  destroy(): void {
    this.disposed = true;
    if (this.initTimer !== null) {
      window.clearTimeout(this.initTimer);
      this.initTimer = null;
    }
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
    for (const [, g] of this.pieceMeshes) this.disposePieceGroup(g);
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.scene = undefined;
    this.camera = undefined;
    this.renderer = undefined;
  }

  // v1.13: select + move handlers ARE now wired for the 3D view. App.ts
  // already invokes these (defensively via `typeof anyView.setMoveAttemptHandler
  // === "function"` on the abstract ChessView).
  setMoveAttemptHandler(fn: (input: ApplyMoveInput) => void): void { this.onMoveAttempt = fn; }
  setSelectHandler(fn: (sq: Square) => void): void { this.onSelect = fn; }

  redraw(board: Record<Square, PieceSymbol | null>): void {
    // v1.12: snapshot latest board state for setPieceStyle() rebuild.
    this.boardSnap.clear();
    for (const [sq, sym] of Object.entries(board) as [Square, PieceSymbol | null][]) {
      if (!sym) continue;
      this.boardSnap.set(sq, sym);
    }
    if (!this.scene) return;
    for (const [, g] of this.pieceMeshes) {
      this.disposePieceGroup(g);
      this.scene.remove(g);
    }
    this.pieceMeshes.clear();
    for (const [sq, sym] of this.boardSnap.entries()) {
      const group = this.makePieceMesh(sym);
      (group.userData as { square: Square }).square = sq;
      group.position.set(worldX(sq), BOARD.baseY + BOARD.height, worldZ(sq));
      group.castShadow = true;
      group.receiveShadow = true;
      this.scene.add(group);
      this.pieceMeshes.set(sq, group);
    }
    this.updateFootprintMetric();
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
      //
      // v1.19.1: keep boardSnap in sync even when the scene isn't ready yet.
      // If the AI replies inside the 750 ms init window, the engine advances
      // but this view can't animate — without syncing boardSnap here,
      // rebuildPiecesFromSnapshot() at init time would paint a stale position.
      // The move is applied to the snapshot so the rendered board matches
      // the engine once the renderer is live.
      if (!this.scene) {
        this.applyMoveToSnapshot(rec, kind.kind);
        this.resolvers.delete(resolve);
        return resolve();
      }
      const group = this.pieceMeshes.get(rec.from);
      if (!group) { this.resolvers.delete(resolve); return resolve(); }
      const isCapture = kind.kind === "capture" || kind.kind === "enpassant" || kind.kind === "promote";
      if (isCapture) {
        const capturedSq =
          kind.kind === "enpassant"
            ? (rec.to[0] + rec.from[1]) as Square
            : rec.to;
        const captured = this.pieceMeshes.get(capturedSq);
        if (captured) {
          this.disposePieceGroup(captured);
          this.pieceMeshes.delete(capturedSq);
        }
      }
      group.position.x = worldX(rec.to);
      group.position.z = worldZ(rec.to);
      (group.userData as { square: Square }).square = rec.to; // v1.13: keep raycast data current after a move.
      this.pieceMeshes.delete(rec.from);
      this.pieceMeshes.set(rec.to, group);
      if (kind.kind === "promote") {
        const replacement = this.makePieceMesh(rec.promotion ?? rec.piece);
        (replacement.userData as { square: Square }).square = rec.to;
        replacement.position.set(worldX(rec.to), BOARD.baseY + BOARD.height, worldZ(rec.to));
        const visualScale = this.pieceStyle === "asset-pack" ? 1 : PIECE_VISUAL_SCALE;
        // v1.15: scale-up baseline matches PIECE_VISUAL_SCALE so the
        // promotion grow-in lands at the same final visual size as
        // every other piece (otherwise it would visibly undershoot).
        replacement.scale.set(0.001 * visualScale, 0.001 * visualScale, 0.001 * visualScale);
        this.scene.remove(group);
        this.scene.add(replacement);
        this.pieceMeshes.set(rec.to, replacement);
        this.updateFootprintMetric();
        // AWAIT the promotion grow-in. Previously fire-and-forget, which
        // let Game.executeMove return while the new piece was still at
        // scale ~0.001 — a fast follow-up click could collide. Resolve
        // inside the tween's onComplete so Game waits for the grow.
        gsap.to(replacement.scale, {
          x: visualScale,
          y: visualScale,
          z: visualScale,
          duration: 0.5,
          ease: "back.out(2)",
          onComplete: () => {
            this.resolvers.delete(resolve);
            this.updateFootprintMetric();
            resolve();
          },
        });
      } else {
        this.resolvers.delete(resolve);
        this.updateFootprintMetric();
        resolve();
      }
    });
  }

  animateRookMove(from: Square, to: Square): Promise<void> {
    return new Promise((resolve) => {
      const mesh = this.pieceMeshes.get(from);
      if (!mesh) {
        if (this.boardSnap.has(from)) {
          const rook = this.boardSnap.get(from)!;
          this.boardSnap.delete(from);
          this.boardSnap.set(to, rook);
        }
        return resolve();
      }
      this.pieceMeshes.delete(from);
      mesh.position.x = worldX(to);
      mesh.position.z = worldZ(to);
      this.pieceMeshes.set(to, mesh);
      this.updateFootprintMetric();
      resolve();
    });
  }

  setSelectable(side: Side | null): void {
    this.selectable = side;
    this.host.dataset.selectableSide = side ?? "none";
  }

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
      color: 0x6a3d1f,
      roughness: 0.74,
      metalness: 0.0,
      clearcoat: 0.16,
      clearcoatRoughness: 0.62,
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
    const visualScale = this.pieceStyle === "asset-pack" ? 1 : PIECE_VISUAL_SCALE;
    group.scale.set(visualScale, visualScale, visualScale);
    return group;
  }

  private applyMoveToSnapshot(rec: MoveRecord, kind: MoveKind): void {
    this.boardSnap.delete(rec.from);
    const piece = rec.promotion ?? rec.piece;
    this.boardSnap.set(rec.to, piece);
    if (kind === "enpassant") {
      const capturedSq = (rec.to[0] + rec.from[1]) as Square;
      this.boardSnap.delete(capturedSq);
    }
    if (kind === "castle") {
      const rookFrom = rec.to === "g1" ? "h1" : rec.to === "c1" ? "a1" : rec.to === "g8" ? "h8" : "a8";
      const rookTo = rec.to === "g1" ? "f1" : rec.to === "c1" ? "d1" : rec.to === "g8" ? "f8" : "d8";
      const rookPiece = this.boardSnap.get(rookFrom);
      if (rookPiece) {
        this.boardSnap.delete(rookFrom);
        this.boardSnap.set(rookTo, rookPiece);
      }
    }
  }

  private rebuildPiecesFromSnapshot(): void {
    if (!this.scene) return;
    for (const [, g] of this.pieceMeshes) {
      this.disposePieceGroup(g);
      this.scene.remove(g);
    }
    this.pieceMeshes.clear();
    for (const [sq, sym] of this.boardSnap.entries()) {
      const group = this.makePieceMesh(sym);
      (group.userData as { square: Square }).square = sq;
      group.position.set(worldX(sq), BOARD.baseY + BOARD.height, worldZ(sq));
      group.castShadow = true;
      group.receiveShadow = true;
      this.scene.add(group);
      this.pieceMeshes.set(sq, group);
    }
    this.updateFootprintMetric();
  }

  private updateFootprintMetric(): void {
    let maxRatio = 0;
    let minUprightRatio = Number.POSITIVE_INFINITY;
    for (const [, group] of this.pieceMeshes) {
      const box = new THREE.Box3().setFromObject(group);
      const size = box.getSize(new THREE.Vector3());
      const footprint = Math.max(size.x, size.z);
      maxRatio = Math.max(maxRatio, footprint / BOARD.squareSize);
      if (footprint > 0) minUprightRatio = Math.min(minUprightRatio, size.y / footprint);
    }
    this.host.dataset.maxPieceFootprintRatio = maxRatio.toFixed(3);
    this.host.dataset.minPieceUprightRatio = Number.isFinite(minUprightRatio) ? minUprightRatio.toFixed(3) : "0.000";
  }

  private disposePieceGroup(group: THREE.Group): void {
    this.scene?.remove(group);
    group.traverse((c) => {
      const node = c as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      node.geometry?.dispose();
      const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
      for (const material of materials) {
        if (!this.pieceMaterials.includes(material)) material.dispose();
      }
    });
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
    const h = this.host.clientHeight || 600;
    // The 3D canvas now fills the whole .board-host real estate (not a
    // forced 1:1 square), so size the drawing buffer to the host width ×
    // height and keep the projection aspect in lockstep. updateStyle=true
    // also drives the canvas's CSS dimensions (without it browsers leave
    // the canvas at its default 300×150 CSS box regardless of the buffer).
    // The CSS rule `.board-3d-host canvas { width: 100%; height: 100% }`
    // is belt-and-suspenders for that.
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Refresh pixel ratio in case the window moved between displays
    // with different DPRs (dragging a browser window from a MacBook
    // screen onto an external 4K monitor triggers this on macOS).
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // The board fit depends on the new aspect ratio, so recompute zoom
    // limits and push the camera back out if the user was zoomed inside
    // the new "always whole board" floor.
    this.applyZoomLimits();
  }

  /**
   * Smallest camera distance (from the orbit target) at which all four
   * board corners (±size/2 on x and z, sitting in the y=0 plane) still
   * project inside the frustum, for the CURRENT camera aspect + tilt.
   * Binary-searched because the corners are off-axis (camera is tilted
   * down), so neither the horizontal nor vertical half-FOV alone gives
   * the boundary — projecting the actual corners does. Handles aspect
   * ratio and the flipped side automatically because it uses the live
   * camera matrix.
   */
  private computeFitDistance(): number {
    if (!this.camera || !this.controls) return 7;
    const half = BOARD.size / 2;
    const target = this.controls.target;
    const dir = new THREE.Vector3().subVectors(this.camera.position, target).normalize();
    if (dir.lengthSq() < 1e-6) dir.copy(this.mountBaseDir);
    const cam = this.camera;
    const tmp = new THREE.Vector3();
    const fits = (d: number): boolean => {
      cam.position.copy(target).addScaledVector(dir, d);
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
      for (const zs of [-half, half]) for (const xs of [-half, half]) {
        tmp.set(xs, 0, zs);
        tmp.project(cam);
        if (tmp.x < -1 || tmp.x > 1 || tmp.y < -1 || tmp.y > 1) return false;
      }
      return true;
    };
    let lo = 1;
    let hi = 40;
    // At lo most of the board is outside; at hi all of it is inside.
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid; else lo = mid;
    }
    return hi;
  }

  /**
   * Frame the whole board at the default view and clamp zoom-in so the
   * board never gets clipped. minDistance is set to the fit floor (with
   * a small margin); if the user is currently inside that floor (e.g.
   * after a resize shrinks the view), the camera is pushed back out to
   * it rather than leaving them looking at a cropped board.
   */
  private applyZoomLimits(): void {
    if (!this.camera || !this.controls) return;
    const fit = this.computeFitDistance();
    const minDist = fit * 1.06;
    this.controls.minDistance = minDist;
    // computeFitDistance() moved the camera around along the view
    // direction; restore it to the live direction at the live distance,
    // but never closer than the new floor (stops a resize from leaving
    // the user looking at a cropped board).
    const target = this.controls.target;
    const dir = new THREE.Vector3().subVectors(this.camera.position, target);
    const cur = dir.length();
    const wantDir = dir.lengthSq() > 1e-6 ? dir.normalize() : this.mountBaseDir.clone();
    const dist = Math.max(cur, minDist);
    this.camera.position.copy(target).addScaledVector(wantDir, dist);
    this.camera.lookAt(target);
    this.controls.update();
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

  private raycastSquare(e: PointerEvent): Square | null {
    const canvas = this.renderer!.domElement;
    const rect = canvas.getBoundingClientRect();
    this.pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNDC, this.camera!);

    const squareTargets: THREE.Object3D[] = [];
    for (const [, s] of this.squares) squareTargets.push(s);
    const squareHits = this.raycaster.intersectObjects(squareTargets, true);
    if (squareHits.length > 0) {
      for (const h of squareHits) {
        let obj: THREE.Object3D | null = h.object;
        while (obj) {
          const ud = obj.userData as { square?: Square } | undefined;
          if (ud && typeof ud.square === "string") return ud.square as Square;
          obj = obj.parent;
        }
      }
    }

    const pieceTargets: THREE.Object3D[] = [];
    for (const [, g] of this.pieceMeshes) pieceTargets.push(g);
    const pieceHits = this.raycaster.intersectObjects(pieceTargets, true);
    if (pieceHits.length === 0) return null;
    for (const h of pieceHits) {
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
    if (this.selectedSq === null || this.selectedSq === sq || this.canControlSide(sq)) {
      this.onSelect?.(sq);
      return;
    }
    const from = this.selectedSq;
    this.onMoveAttempt?.({ from, to: sq });
  }

  private canControlSide(sq: Square): boolean {
    const sel = this.selectable;
    if (!sel) return false;
    const group = this.pieceMeshes.get(sq);
    if (!group) return false;
    let symbol: PieceSymbol | undefined;
    group.traverse((c) => {
      if (symbol) return;
      const next = (c.userData as { symbol?: PieceSymbol }).symbol;
      if (next) symbol = next;
    });
    if (!symbol) return false;
    const isWhite = symbol === symbol.toUpperCase();
    return (sel === "white" && isWhite) || (sel === "black" && !isWhite);
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
