// v1.12 — 3D piece-style registry.
//
// Six alternative Staunton-style 3D renderings built on the SAME canonical
// LatheGeometry profile library (the Cburnett-equivalent silhouette vector
// stack used by Lichess/Chess.com). Each style tunes a different set of
// ornament parameters so the result reads as a distinct "set":
//
//   * classic  — DEFAULT. Marble-carved Staunton: smooth lathe (48 segs),
//                prominent cross/spikes/ball/merlons/muzzle, decorative
//                collar rings on the major pieces. The most ornate set.
//   * bold     — Tournament-felt Staunton: 36-segment chunky lathe, extra
//                thick ornaments, lower roughness for a polished-wood feel.
//   * outline  — Schematic-wood Staunton: same lathe, NO ornaments; reads
//                as unadorned turned forms. (Keeps the "essence" of chess
//                without the crests — for users who want the simplest
//                possible recognisable set.)
//   * filled   — Modernist Staunton: standard lathe + ornaments shrunk to
//                0.6× so they sit just inside the body silhouette. Reads
//                as a clean contemporary set with subtle crests.
//   * minimal  — Bare-Staunton: ornaments completely removed (outline
//                style's body lathe) — only the silhouettes and base
//                collars. Smooth turned-stone feel.
//   * ornate   — Gothic-Staunton: classic on every dimension PLUS extra
//                decorative finials — small spikes on the rook merlons,
//                a halo-ring around the king cross, a stacked twin ball
//                on the bishop, and a mane ridge on the knight.
//
// Architecture: Board3D holds a `pieceStyle` field; setPieceStyle(id) re-
// renders the scene by traversing every existing piece mesh and rebuilding
// each from the style-specific builder. Themes stay orthogonal to styles:
// the same warm ivory/ebony colors look great across all six sets.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { PieceSymbol, PieceStyleId } from "@/types";

type PieceKind = "p" | "n" | "b" | "r" | "q" | "k";
function pieceSymbolIsWhite(s: PieceSymbol): boolean { return s === s.toUpperCase(); }

// ---- v1.13 — MIT Staunton geometry loader ----
//
// Six STL files at /public/assets/3d-pieces/staunton/{King,Queen,Rook,Bishop,Knight,Pawn}.stl
// from clarkerubber/Staunton-Pieces (MIT license) form a real-geometry
// Staunton set. Each file loads once at mount() into a cached
// BufferGeometry; subsequent makePieceMesh() calls clone() that geometry
// so the per-color MeshPhysicalMaterial (white/black) can be attached
// without any vertex-color manipulation.
//
// Per-kind target heights match the procedural lathe's peak so the board
// layout stays consistent regardless of which style is selected.
const TARGET_HEIGHT_BY_KIND: Record<PieceKind, number> = {
  p: 0.70,
  n: 1.10,
  b: 1.05,
  r: 1.05,
  q: 1.20,
  k: 1.32,
};
const CHESS3D_TARGET_HEIGHT_BY_KIND: Record<PieceKind, number> = {
  p: 0.38,
  n: 0.58,
  b: 0.62,
  r: 0.54,
  q: 0.72,
  k: 0.78,
};
const CHESS3D_MAX_FOOTPRINT = 0.5 * 0.62;
const STL_URL_BY_KIND: Record<PieceKind, string> = {
  p: "/assets/3d-pieces/staunton/Pawn.stl",
  n: "/assets/3d-pieces/staunton/Knight.stl",
  b: "/assets/3d-pieces/staunton/Bishop.stl",
  r: "/assets/3d-pieces/staunton/Rook.stl",
  q: "/assets/3d-pieces/staunton/Queen.stl",
  k: "/assets/3d-pieces/staunton/King.stl",
};
const CHESS3D_URL_BY_KIND: Record<PieceKind, string> = {
  p: "/assets/3d-pieces/chess3d/pawn/scene.gltf",
  n: "/assets/3d-pieces/chess3d/knight/scene.gltf",
  b: "/assets/3d-pieces/chess3d/bishop/scene.gltf",
  r: "/assets/3d-pieces/chess3d/rook/scene.gltf",
  q: "/assets/3d-pieces/chess3d/queen/scene.gltf",
  k: "/assets/3d-pieces/chess3d/king/scene.gltf",
};
const CHESS3D_UPRIGHT_ROTATION_BY_KIND: Partial<Record<PieceKind, { x: number; y: number; z: number }>> = {
  // This source model is authored Z-up while the board scene is Y-up.
  n: { x: -Math.PI / 2, y: 0, z: 0 },
};

let stlLoader: STLLoader | null = null;
function getLoader(): STLLoader {
  if (!stlLoader) stlLoader = new STLLoader();
  return stlLoader;
}
let gltfLoader: GLTFLoader | null = null;
function getGltfLoader(): GLTFLoader {
  if (!gltfLoader) gltfLoader = new GLTFLoader();
  return gltfLoader;
}
const kindGeometryCache = new Map<PieceKind, THREE.BufferGeometry>();
const kindLoadPromises = new Map<PieceKind, Promise<THREE.BufferGeometry>>();
const chess3dGroupCache = new Map<PieceKind, THREE.Group>();
const chess3dLoadPromises = new Map<PieceKind, Promise<THREE.Group>>();

async function loadKindGeometry(kind: PieceKind): Promise<THREE.BufferGeometry> {
  const cached = kindGeometryCache.get(kind);
  if (cached) return cached;
  const inflight = kindLoadPromises.get(kind);
  if (inflight) return inflight;
  const url = STL_URL_BY_KIND[kind];
  const promise = (async () => {
    const geom = await getLoader().loadAsync(url);
    geom.center();
    geom.computeVertexNormals();
    geom.computeBoundingBox();
    const bb = geom.boundingBox!;
    const height = bb.max.y - bb.min.y;
    const target = TARGET_HEIGHT_BY_KIND[kind];
    const s = height > 0 ? target / height : 1;
    geom.scale(s, s, s);
    geom.computeBoundingBox();
    const bb2 = geom.boundingBox!;
    geom.translate(0, -bb2.min.y, 0);
    geom.computeBoundingBox();
    kindGeometryCache.set(kind, geom);
    kindLoadPromises.delete(kind);
    return geom;
  })().catch((e) => {
    console.warn("[staunton] failed to load", kind, e);
    kindLoadPromises.delete(kind);
    throw e;
  });
  kindLoadPromises.set(kind, promise);
  return promise;
}

async function loadChess3dGroup(kind: PieceKind): Promise<THREE.Group> {
  const cached = chess3dGroupCache.get(kind);
  if (cached) return cached;
  const inflight = chess3dLoadPromises.get(kind);
  if (inflight) return inflight;
  const promise = (async () => {
    const gltf = await getGltfLoader().loadAsync(CHESS3D_URL_BY_KIND[kind]);
    const root = gltf.scene;
    applyChess3dUprightCorrection(kind, root);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const heightScale = size.y > 0 ? CHESS3D_TARGET_HEIGHT_BY_KIND[kind] / size.y : 1;
    const footprint = Math.max(size.x, size.z);
    const footprintScale = footprint > 0 ? CHESS3D_MAX_FOOTPRINT / footprint : 1;
    root.scale.setScalar(Math.min(heightScale, footprintScale));
    root.updateMatrixWorld(true);
    const normalized = new THREE.Box3().setFromObject(root);
    const center = normalized.getCenter(new THREE.Vector3());
    root.position.x -= center.x;
    root.position.y -= normalized.min.y;
    root.position.z -= center.z;
    root.updateMatrixWorld(true);
    chess3dGroupCache.set(kind, root);
    chess3dLoadPromises.delete(kind);
    return root;
  })().catch((e) => {
    console.warn("[chess3d] failed to load", kind, e);
    chess3dLoadPromises.delete(kind);
    throw e;
  });
  chess3dLoadPromises.set(kind, promise);
  return promise;
}

function applyChess3dUprightCorrection(kind: PieceKind, root: THREE.Group): void {
  const explicit = CHESS3D_UPRIGHT_ROTATION_BY_KIND[kind];
  if (explicit) {
    root.rotation.x += explicit.x;
    root.rotation.y += explicit.y;
    root.rotation.z += explicit.z;
    root.updateMatrixWorld(true);
    return;
  }

  root.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  if (size.z > size.y * 1.15 && size.z >= size.x) {
    root.rotation.x -= Math.PI / 2;
    root.updateMatrixWorld(true);
  } else if (size.x > size.y * 1.15 && size.x >= size.z) {
    root.rotation.z += Math.PI / 2;
    root.updateMatrixWorld(true);
  }
}

/** Eagerly loads the six MIT Staunton STLs. Resolves when ALL are done (or one fails). */
export function prefetchStauntonGeometries(): Promise<void> {
  const kinds: PieceKind[] = ["p", "n", "b", "r", "q", "k"];
  return Promise.all(
    kinds.map((k) => loadKindGeometry(k).catch(() => undefined)),
  ).then(() => undefined);
}

export function prefetchPieceStyleAssets(styleId: PieceStyleId): Promise<void> {
  if (styleId === "asset-pack") {
    const kinds: PieceKind[] = ["p", "n", "b", "r", "q", "k"];
    return Promise.all(kinds.map((k) => loadChess3dGroup(k).catch(() => undefined))).then(() => undefined);
  }
  if (styleId === "staunton") return prefetchStauntonGeometries();
  return Promise.resolve();
}

function buildStauntonMesh(kind: PieceKind, sym: PieceSymbol, material: THREE.Material): THREE.Mesh {
  const cached = kindGeometryCache.get(kind);
  if (!cached) {
    // Cache not ready yet — kick off load and return a tiny placeholder.
    void loadKindGeometry(kind);
    const placeholder = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.10, TARGET_HEIGHT_BY_KIND[kind], 16),
      material,
    );
    (placeholder.userData as { symbol: PieceSymbol }).symbol = sym;
    placeholder.castShadow = true;
    placeholder.receiveShadow = true;
    return placeholder;
  }
  const cloned = cached.clone();
  const mesh = new THREE.Mesh(cloned, material);
  (mesh.userData as { symbol: PieceSymbol }).symbol = sym;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildChess3dModel(kind: PieceKind, sym: PieceSymbol, material: THREE.Material): THREE.Object3D | null {
  const cached = chess3dGroupCache.get(kind);
  if (!cached) {
    void loadChess3dGroup(kind);
    return null;
  }
  const clone = cached.clone(true);
  clone.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry = mesh.geometry.clone();
    mesh.material = material;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    (mesh.userData as { symbol: PieceSymbol }).symbol = sym;
  });
  return clone;
}

type StyleCfg = {
  // Lathe tessellation. Higher = smoother silhouettes. v1.11 used 24
  // (visible polygonal seam on the lathe tip); 48 fixes that without a
  // meaningful perf hit since we only have 32 pieces.
  latheSegments: number;
  // Which ornaments to render. Each entry is a kind-list toggle.
  ornaments: {
    kingCross: boolean;          // + cross atop king
    queenSpikes: number;          // number of spikes around the coronet (0 = none)
    queenSpikeScale: number;      // scale factor for spike height + tip radius
    bishopBall: boolean;          // ball atop bishop body
    bishopFinial: boolean;        // tiny "berry" finial atop the ball
    rookMerlons: number;          // number of merlons (0 = none)
    rookMerlonScale: number;
    knightEars: boolean;          // ear cones atop knight
    knightMuzzle: boolean;        // forward-leaning muzzle wedge (the "snout")
    knightMane: boolean;          // small mane ridge ball for ornate
    // Optional decorative collar ring around the body's "shoulder" y=0.86.
    collarRing: boolean;
    // Optional extra: king cross halo, bishop double-ball, etc.
    kingCrossHalo: boolean;
    rookMerlonSpike: boolean;     // tiny spike atop each merlon
    queenHalo: boolean;           // ring of small dots around coronet
  };
  // Wedge between ornaments vs body — 1.0 means original size, 1.4 = 40% larger.
  ornamentScale: number;
  // EdgesGeometry overlay rendering — adds a thin black silhouette outline
  // around piece surfaces. Wireframe-like "etched" look. Only used by outline.
  edgeOverlay: boolean;
};

// ---- Lathe profile library (canonical Staunton silhouettes) ----
//
// Each profile is a Vector2[] defining a 2D outline rotated around the
// Y-axis. Y values are in board-units (1.0 board unit = one half-board-edge).
// Lathe resolution is per-style.

function pieceProfile(kind: PieceKind): THREE.Vector2[] {
  switch (kind) {
    case "p": return [
      new THREE.Vector2(0.00, 0.00), new THREE.Vector2(0.22, 0.00), new THREE.Vector2(0.22, 0.04),
      new THREE.Vector2(0.10, 0.06), new THREE.Vector2(0.10, 0.36), new THREE.Vector2(0.14, 0.40),
      new THREE.Vector2(0.14, 0.46), new THREE.Vector2(0.10, 0.50), new THREE.Vector2(0.13, 0.55),
      new THREE.Vector2(0.13, 0.62), new THREE.Vector2(0.00, 0.70),
    ];
    case "b": return [
      new THREE.Vector2(0.00, 0.00), new THREE.Vector2(0.24, 0.00), new THREE.Vector2(0.24, 0.05),
      new THREE.Vector2(0.10, 0.07), new THREE.Vector2(0.10, 0.55), new THREE.Vector2(0.16, 0.62),
      new THREE.Vector2(0.16, 0.74), new THREE.Vector2(0.13, 0.78), new THREE.Vector2(0.16, 0.84),
      new THREE.Vector2(0.13, 0.94), new THREE.Vector2(0.10, 0.96), new THREE.Vector2(0.00, 1.00),
    ];
    case "k": return [
      new THREE.Vector2(0.00, 0.00), new THREE.Vector2(0.26, 0.00), new THREE.Vector2(0.26, 0.05),
      new THREE.Vector2(0.11, 0.07), new THREE.Vector2(0.11, 0.78), new THREE.Vector2(0.16, 0.86),
      new THREE.Vector2(0.16, 0.95), new THREE.Vector2(0.13, 1.00), new THREE.Vector2(0.10, 1.04),
      new THREE.Vector2(0.00, 1.10),
    ];
    case "q": return [
      new THREE.Vector2(0.00, 0.00), new THREE.Vector2(0.26, 0.00), new THREE.Vector2(0.26, 0.05),
      new THREE.Vector2(0.11, 0.07), new THREE.Vector2(0.11, 0.70), new THREE.Vector2(0.18, 0.78),
      new THREE.Vector2(0.18, 0.92), new THREE.Vector2(0.13, 0.98), new THREE.Vector2(0.10, 1.02),
      new THREE.Vector2(0.00, 1.08),
    ];
    case "r": return [
      new THREE.Vector2(0.00, 0.00), new THREE.Vector2(0.26, 0.00), new THREE.Vector2(0.26, 0.05),
      new THREE.Vector2(0.11, 0.07), new THREE.Vector2(0.11, 0.66), new THREE.Vector2(0.18, 0.74),
      new THREE.Vector2(0.18, 0.84), new THREE.Vector2(0.13, 0.90), new THREE.Vector2(0.13, 1.00),
      new THREE.Vector2(0.00, 1.05),
    ];
    case "n": return [
      new THREE.Vector2(0.00, 0.00), new THREE.Vector2(0.24, 0.00), new THREE.Vector2(0.24, 0.05),
      new THREE.Vector2(0.10, 0.07), new THREE.Vector2(0.10, 0.55), new THREE.Vector2(0.16, 0.63),
      new THREE.Vector2(0.18, 0.72), new THREE.Vector2(0.16, 0.82), new THREE.Vector2(0.10, 0.90),
      new THREE.Vector2(0.00, 0.95),
    ];
  }
}

// ---- Per-style configurations ----

const FUlL_ORNAMENTS = {
  kingCross: true,
  queenSpikes: 7,            // v1.11 polish: 7 spikes avoid base overlap
  queenSpikeScale: 1.0,
  bishopBall: true,
  bishopFinial: true,
  rookMerlons: 4,
  rookMerlonScale: 1.0,
  knightEars: true,
  knightMuzzle: true,
  knightMane: false,
  collarRing: true,
  kingCrossHalo: false,
  rookMerlonSpike: false,
  queenHalo: false,
};

const STYLE_CFG: Record<PieceStyleId, StyleCfg> = {
  classic: {
    latheSegments: 48,         // smooth silhouette; no polygonal seam
    ornaments: { ...FUlL_ORNAMENTS },
    ornamentScale: 1.0,
    edgeOverlay: false,
  },
  bold: {
    latheSegments: 36,
    ornaments: { ...FUlL_ORNAMENTS, queenSpikeScale: 1.4, rookMerlonScale: 1.4 },
    ornamentScale: 1.25,        // ornaments 25% bigger across the board
    edgeOverlay: false,
  },
  outline: {
    latheSegments: 32,
    ornaments: {
      kingCross: false,
      queenSpikes: 0,
      queenSpikeScale: 0,
      bishopBall: false,
      bishopFinial: false,
      rookMerlons: 0,
      rookMerlonScale: 0,
      knightEars: false,
      knightMuzzle: false,
      knightMane: false,
      collarRing: false,
      kingCrossHalo: false,
      rookMerlonSpike: false,
      queenHalo: false,
    },
    ornamentScale: 0,
    edgeOverlay: true,          // etched-black silhouette outline
  },
  filled: {
    latheSegments: 48,
    ornaments: { ...FUlL_ORNAMENTS, queenSpikeScale: 0.7, rookMerlonScale: 0.7 },
    ornamentScale: 0.7,
    edgeOverlay: false,
  },
  minimal: {
    latheSegments: 48,
    ornaments: {
      ...FUlL_ORNAMENTS,
      kingCross: false,         // turn off most ornaments
      queenSpikes: 0,
      bishopBall: true,         // bishop ball retained — too iconic to drop
      bishopFinial: false,
      rookMerlons: 4,           // merlons retained — they're the rook's silhouette
      rookMerlonScale: 0.85,
      knightEars: false,
      knightMuzzle: true,       // muzzle retained — it's the knight's identity
      knightMane: false,
      collarRing: true,
      kingCrossHalo: false,
      rookMerlonSpike: false,
      queenHalo: false,
    },
    ornamentScale: 0.85,
    edgeOverlay: false,
  },
  ornate: {
    latheSegments: 64,         // very smooth
    ornaments: {
      ...FUlL_ORNAMENTS,
      knightMane: true,
      collarRing: true,
      kingCrossHalo: true,
      rookMerlonSpike: true,
      queenHalo: true,
    },
    ornamentScale: 1.10,
    edgeOverlay: false,
  },
  // v1.13 (revisited during v1.15 cleanup): the `staunton` entry is
  // REQUIRED by the `PieceStyleId` type union (added in v1.13) but
  // never reached at runtime — buildPieceGeometry's early return on
  // `styleId === "staunton"` dispatches to the MIT-licensed real-
  // geometry STL mesh BEFORE this lookup. Kept here for type
  // completeness with the same ornament config as `classic` so any
  // future code path that ever falls through (e.g. an STL loader
  // failure that the prefetch doesn't catch) renders a sensible
  // recognizable set instead of throwing.
  staunton: {
    latheSegments: 48,
    ornaments: { ...FUlL_ORNAMENTS },
    ornamentScale: 1.0,
    edgeOverlay: false,
  },
  "asset-pack": {
    latheSegments: 48,
    ornaments: { ...FUlL_ORNAMENTS },
    ornamentScale: 1.0,
    edgeOverlay: false,
  },
};

// ---- Base mesh helpers ----

function buildLathe(kind: PieceKind, sym: PieceSymbol, material: THREE.Material, segs: number): THREE.Mesh {
  const profile = pieceProfile(kind);
  const lathe = new THREE.LatheGeometry(profile, segs);
  const mesh = new THREE.Mesh(lathe, material);
  (mesh.userData as { symbol: PieceSymbol }).symbol = sym;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addCollarRing(host: THREE.Object3D, kind: PieceKind, sym: PieceSymbol, material: THREE.Material): void {
  // Decorative ring around the "shoulder" of the major pieces. Y=0.86 sits
  // right at the collar band (the second-tallest inflection point of each
  // lathe profile for king/queen/rook/bishop). Adds a real sense of "this is
  // a carved chess piece" — the band reads as the upper/lower molding join.
  if (kind !== "k" && kind !== "q" && kind !== "r" && kind !== "b") return;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(kind === "r" ? 0.18 : 0.16, 0.025, 10, 32),
    material,
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.86;
  ring.castShadow = true;
  (ring.userData as { symbol: PieceSymbol }).symbol = sym;
  host.add(ring);
}

// ---- Per-piece-style detail builders ----
//
// Each takes the lathe Mesh `host`, the kind, the symbol, and the material —
// then adds ornaments onto `host.children`. All ornaments carry `userData.symbol`
// so the Board3D.applyTheme() traverser in the parent class re-themes them.

function applyOrnaments(host: THREE.Mesh, kind: PieceKind, sym: PieceSymbol, material: THREE.Material, cfg: StyleCfg): void {
  if (cfg.ornamentScale === 0) return;
  const sc = cfg.ornamentScale;
  const orn = cfg.ornaments;

  if (kind === "k" && orn.kingCross) {
    // Tall, prominent cross even at sc=1.0. Scale the FULL proportions, not
    // just the positions, so larger scales also fatten the cross.
    const v = new THREE.Mesh(
      new THREE.BoxGeometry(0.06 * sc, 0.30 * sc, 0.06 * sc),
      material,
    );
    v.position.y = 1.32;
    v.castShadow = true;
    (v.userData as { symbol: PieceSymbol }).symbol = sym;
    host.add(v);
    const h = new THREE.Mesh(
      new THREE.BoxGeometry(0.18 * sc, 0.05 * sc, 0.05 * sc),
      material,
    );
    h.position.y = 1.27;
    h.castShadow = true;
    (h.userData as { symbol: PieceSymbol }).symbol = sym;
    host.add(h);
    if (orn.kingCrossHalo) {
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.13, 0.012, 8, 28),
        material,
      );
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 1.21;
      (halo.userData as { symbol: PieceSymbol }).symbol = sym;
      host.add(halo);
    }
  }

  if (kind === "q" && orn.queenSpikes > 0) {
    const n = orn.queenSpikes;
    const spikeScale = orn.queenSpikeScale * sc;
    const ringR = 0.16;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const spike = new THREE.Mesh(
        new THREE.ConeGeometry(0.055 * spikeScale, 0.20 * spikeScale, 8),
        material,
      );
      spike.position.set(Math.cos(a) * ringR, 0.96, Math.sin(a) * ringR);
      spike.castShadow = true;
      (spike.userData as { symbol: PieceSymbol }).symbol = sym;
      host.add(spike);
      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.045 * spikeScale, 12, 8),
        material,
      );
      tip.position.set(Math.cos(a) * ringR, 1.10, Math.sin(a) * ringR);
      (tip.userData as { symbol: PieceSymbol }).symbol = sym;
      host.add(tip);
    }
    if (orn.queenHalo) {
      // 12 small dots between spikes
      const innerN = 12;
      for (let i = 0; i < innerN; i++) {
        const a = ((i + 0.5) / innerN) * Math.PI * 2;
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.025 * sc, 8, 6),
          material,
        );
        dot.position.set(Math.cos(a) * (ringR + 0.02), 0.84, Math.sin(a) * (ringR + 0.02));
        (dot.userData as { symbol: PieceSymbol }).symbol = sym;
        host.add(dot);
      }
    }
  }

  if (kind === "b" && orn.bishopBall) {
    const ballR = 0.10 * sc;
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(ballR, 16, 12),
      material,
    );
    ball.position.y = 0.94;
    ball.castShadow = true;
    (ball.userData as { symbol: PieceSymbol }).symbol = sym;
    host.add(ball);
    if (orn.bishopFinial) {
      const finial = new THREE.Mesh(
        new THREE.SphereGeometry(0.05 * sc, 12, 8),
        material,
      );
      finial.position.y = 1.10;
      (finial.userData as { symbol: PieceSymbol }).symbol = sym;
      host.add(finial);
    }
  }

  if (kind === "r" && orn.rookMerlons > 0) {
    const n = orn.rookMerlons;
    const merlonScale = orn.rookMerlonScale * sc;
    for (let i = 0; i < n; i++) {
      const a = (i * Math.PI * 2) / n + Math.PI / n;
      const c = new THREE.Mesh(
        new THREE.BoxGeometry(0.10 * merlonScale, 0.13 * merlonScale, 0.10 * merlonScale),
        material,
      );
      c.position.set(Math.cos(a) * 0.16, 0.96, Math.sin(a) * 0.16);
      c.castShadow = true;
      (c.userData as { symbol: PieceSymbol }).symbol = sym;
      host.add(c);
      if (orn.rookMerlonSpike) {
        const sp = new THREE.Mesh(
          new THREE.ConeGeometry(0.025 * sc, 0.10 * sc, 6),
          material,
        );
        sp.position.set(Math.cos(a) * 0.16, 1.10, Math.sin(a) * 0.16);
        (sp.userData as { symbol: PieceSymbol }).symbol = sym;
        host.add(sp);
      }
    }
  }

  if (kind === "n" && (orn.knightEars || orn.knightMuzzle)) {
    if (orn.knightEars) {
      const ear1 = new THREE.Mesh(
        new THREE.ConeGeometry(0.07 * sc, 0.18 * sc, 8),
        material,
      );
      ear1.position.set(0.05, 1.05, 0.0);
      ear1.rotation.z = -Math.PI / 6;
      ear1.castShadow = true;
      (ear1.userData as { symbol: PieceSymbol }).symbol = sym;
      host.add(ear1);
      const ear2 = new THREE.Mesh(
        new THREE.ConeGeometry(0.06 * sc, 0.16 * sc, 8),
        material,
      );
      ear2.position.set(-0.07, 1.02, 0.0);
      ear2.rotation.z = Math.PI / 5;
      ear2.castShadow = true;
      (ear2.userData as { symbol: PieceSymbol }).symbol = sym;
      host.add(ear2);
    }
    if (orn.knightMuzzle) {
      const muzzle = new THREE.Mesh(
        new THREE.BoxGeometry(0.22 * sc, 0.10 * sc, 0.10 * sc),
        material,
      );
      muzzle.position.set(0.10 * sc, 0.85, 0.0);
      muzzle.rotation.z = Math.PI / 12;
      muzzle.castShadow = true;
      (muzzle.userData as { symbol: PieceSymbol }).symbol = sym;
      host.add(muzzle);
    }
    if (orn.knightMane) {
      // Two small spheres behind the head — the "mane knots" for ornate.
      const mane1 = new THREE.Mesh(
        new THREE.SphereGeometry(0.04 * sc, 10, 8),
        material,
      );
      mane1.position.set(-0.10 * sc, 1.00, 0.0);
      (mane1.userData as { symbol: PieceSymbol }).symbol = sym;
      host.add(mane1);
      const mane2 = new THREE.Mesh(
        new THREE.SphereGeometry(0.03 * sc, 8, 6),
        material,
      );
      mane2.position.set(-0.13 * sc, 0.92, 0.0);
      (mane2.userData as { symbol: PieceSymbol }).symbol = sym;
      host.add(mane2);
    }
  }

  if (orn.collarRing) addCollarRing(host, kind, sym, material);
}

// ---- Public builder ----

export function buildPieceGeometry(kind: PieceKind, sym: PieceSymbol, material: THREE.Material, styleId: PieceStyleId): THREE.Object3D {
  if (styleId === "asset-pack") {
    const model = buildChess3dModel(kind, sym, material);
    if (model) return model;
  }
  // v1.13: "staunton" dispatches to MIT-licensed real-geometry mesh.
  // Falls back to procedural classic if cache hasn't loaded yet — the cache
  // pre-loads at Board3D.mount() so this branch is rarely hit in practice.
  if (styleId === "staunton") {
    const cached = kindGeometryCache.get(kind);
    if (cached) return buildStauntonMesh(kind, sym, material);
    // Kick off load so the next redraw gets the right silhouette.
    void loadKindGeometry(kind);
  }
  const cfg = STYLE_CFG[styleId] ?? STYLE_CFG.classic;
  const host = buildLathe(kind, sym, material, cfg.latheSegments);
  applyOrnaments(host, kind, sym, material, cfg);
  if (cfg.edgeOverlay) {
    const edges = new THREE.EdgesGeometry(host.geometry as THREE.BufferGeometry, 12);
    const lineMat = new THREE.LineBasicMaterial({
      color: pieceSymbolIsWhite(sym) ? 0x1a1005 : 0xe3c193,
      transparent: true,
      opacity: 0.85,
    });
    const lines = new THREE.LineSegments(edges, lineMat);
    (lines.userData as { symbol: PieceSymbol }).symbol = sym;
    host.add(lines);
  }
  return host;
}
