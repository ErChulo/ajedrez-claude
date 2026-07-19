// PBR material presets per theme. Resolved at runtime by Board3D.

import * as THREE from "three";
import type { ThemeData } from "@/types";

export function buildPieceMaterial(color: "white" | "black", theme: ThemeData): THREE.Material {
  const spec = color === "white" ? theme.three.pieceWhite : theme.three.pieceBlack;
  // v1.15: clearer piece identity on the 3D view. White pieces previously
  // blended into light squares at glancing camera angles (their clearcoat
  // was 0.4 with a relatively rough 0.15 — which lifted the specular
  // highlight and read as 'shiny white blob'); black pieces lacked a
  // defined silhouette against dark squares when the EBL reflections
  // were strong. New clearcoat + clearcoatRoughness per color give each
  // side a distinct surface treatment, and a small color-matched emissive
  // lift on white pieces (the ivory glow they already had at the pawn
  // stage) keeps the brightness constant across every camera angle.
  const params: THREE.MeshPhysicalMaterialParameters = {
    color: spec.color,
    roughness: spec.roughness,
    metalness: spec.metalness,
    clearcoat: color === "white" ? 0.65 : 0.4,
    clearcoatRoughness: color === "white" ? 0.08 : 0.2,
  };
  // v1.18: stronger piece-vs-board distinguishability. White pieces
  // get a larger colour-matched emissive lift (0.18 → 0.45) so the
  // ivory silhouette carries constant brightness across every camera
  // angle and never fades into the equally-tan light squares. Black
  // pieces get a small colour-matched emissive lift (0.20) so the dark
  // carved-Staunton silhouette doesn't merge into the dark squares at
  // glancing angles. Per-theme emissive (e.g. neon) still wins when
  // the theme author set one — that's intentional so neon can stay
  // vivid.
  if (color === "white") {
    params.emissive = new THREE.Color(spec.color);
    params.emissiveIntensity = 0.45;
  } else if (spec.emissive !== undefined) {
    params.emissive = new THREE.Color(spec.emissive);
    params.emissiveIntensity = 0.35;
  } else {
    params.emissive = new THREE.Color(spec.color);
    params.emissiveIntensity = 0.20;
  }
  return new THREE.MeshPhysicalMaterial(params);
}

export function buildBoardMaterial(theme: ThemeData): THREE.Material[] {
  const matLight = new THREE.MeshPhysicalMaterial({
    color: theme.three.boardLight,
    roughness: 0.55,
    metalness: 0.02,
    clearcoat: 0.2,
    clearcoatRoughness: 0.4,
  });
  const matDark = new THREE.MeshPhysicalMaterial({
    color: theme.three.boardDark,
    roughness: 0.55,
    metalness: 0.02,
    clearcoat: 0.2,
    clearcoatRoughness: 0.4,
  });
  return [matLight, matDark];
}
