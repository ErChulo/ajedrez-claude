// Lighting setup for the 3D board.
//
// Specification: "HDRI environment + key/fill, not a single flat light."
// Free CC0 HDRI files at polyhaven.com would normally be loaded via RGBELoader +
// PMREMGenerator. *However* this build environment cannot reliably fetch external
// assets at build time, so we substitute Three.js's `RoomEnvironment` rendered
// through PMREMGenerator — a procedural environment shipped with Three.js
// that gives realistic IBL reflections for PBR materials at zero network cost.
// To switch to a real HDRI later, see `swapToRealHDRI()` at the bottom.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export function setupLighting(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
  // Environment for reflections (IBL).
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new RoomEnvironment();
  const envTex = pmrem.fromScene(envScene, 0.04).texture;
  scene.environment = envTex;
  envScene.dispose?.();

  // Key light (directional, with shadows for piece silhouettes).
  // v1.15: intensity 2.2 → 2.6 so the top side of each piece carries a
  // brighter highlight rib (helps white pieces separate from light squares
  // without needing a stronger emissive, which would look painted).
  const key = new THREE.DirectionalLight(0xfff0d0, 2.15);
  key.position.set(5, 10, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 50;
  key.shadow.camera.left = -10;
  key.shadow.camera.right = 10;
  key.shadow.camera.top = 10;
  key.shadow.camera.bottom = -10;
  key.shadow.bias = -0.0005;
  // v1.15: normalBias 0.05 → 0.03 so the shadow projection sits closer to
  // the actual piece surface — gives a sharper silhouette edge that reads
  // clearly against both light and dark squares.
  key.shadow.normalBias = 0.03;
  scene.add(key);

  // Fill light (softer, opposite side).
  // v1.15: 0.4 → 0.6 (cooler tone kept) so the side facing away from the
  // key still has identifiable shading instead of falling into the dark
  // side of the rim light. Boost is small to avoid over-flattening the
  // piece profile.
  const fill = new THREE.DirectionalLight(0xd9e4ff, 0.48);
  fill.position.set(-6, 5, -4);
  scene.add(fill);

  // v1.15: rim light — NEW. Positioned BEHIND the camera (negative z) and
  // slightly above, this carves a thin bright edge along the back top of
  // every piece. Without it pieces against opposing-colour squares look
  // like blobs of colour with no defined silhouette; with it the piece's
  // "where it ends" cue is unambiguous to the eye. 1.1 intensity is
  // tuned below the key (2.6) so the rim stays a supporting cue rather
  // than a competing highlight, and warmer than the fill (0xffe9c2 vs
  // 0xc8d4ff) so the rim reads as sunlight glancing off the back edge
  // rather than another cool fill source.
  const rim = new THREE.DirectionalLight(0xffdfb0, 0.72);
  rim.position.set(0, 6, -10);
  scene.add(rim);

  scene.add(new THREE.HemisphereLight(0xfff5dc, 0x2c1a10, 0.32));
  scene.add(new THREE.AmbientLight(0xffffff, 0.05));
}

export function setupRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.96;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

// How to swap in a real HDRI:
//   import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
//   const hdr = await new RGBELoader().loadAsync("/hdri/studio_small_1k.hdr");
//   const envMap = pmrem.fromEquirectangular(hdr).texture;
//   scene.environment = envMap;
