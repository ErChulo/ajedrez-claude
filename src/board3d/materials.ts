// PBR material presets per theme. Resolved at runtime by Board3D.

import * as THREE from "three";
import type { ThemeData } from "@/types";

const woodTextureCache: Partial<Record<"white" | "black", THREE.CanvasTexture>> = {};

function makeWoodTexture(color: "white" | "black"): THREE.CanvasTexture {
  const cached = woodTextureCache[color];
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const light = color === "white";
  const base = light ? "#d8b77e" : "#4a2714";
  const mid = light ? "#f0d59f" : "#6b3b1f";
  const dark = light ? "#a9783f" : "#221008";
  const gradient = ctx.createLinearGradient(0, 0, 256, 256);
  gradient.addColorStop(0, dark);
  gradient.addColorStop(0.18, base);
  gradient.addColorStop(0.42, mid);
  gradient.addColorStop(0.68, base);
  gradient.addColorStop(1, dark);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);

  for (let y = 0; y < 256; y++) {
    const wave = Math.sin(y * 0.08) * 10 + Math.sin(y * 0.021) * 22;
    const alpha = light ? 0.1 : 0.16;
    ctx.strokeStyle = `rgba(${light ? "88,48,16" : "220,150,80"},${alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + wave * 0.05);
    for (let x = 0; x <= 256; x += 16) {
      const drift = Math.sin((x + y) * 0.035) * 5 + wave;
      ctx.lineTo(x, y + drift * 0.08);
    }
    ctx.stroke();
  }

  for (let i = 0; i < 18; i++) {
    const x = (i * 47) % 256;
    const y = (i * 89) % 256;
    const rx = 18 + (i % 5) * 5;
    const ry = 5 + (i % 3) * 3;
    ctx.strokeStyle = light ? "rgba(95,54,18,0.12)" : "rgba(230,160,90,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, (i % 7) * 0.35, 0, Math.PI * 2);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.8, 1.8);
  woodTextureCache[color] = texture;
  return texture;
}

export function buildPieceMaterial(color: "white" | "black", theme: ThemeData): THREE.Material {
  const spec = color === "white" ? theme.three.pieceWhite : theme.three.pieceBlack;
  const texture = makeWoodTexture(color);
  const params: THREE.MeshPhysicalMaterialParameters = {
    color: new THREE.Color(spec.color).lerp(new THREE.Color(color === "white" ? 0xf5d9a5 : 0x6d3b1f), 0.68),
    map: texture,
    bumpMap: texture,
    bumpScale: color === "white" ? 0.012 : 0.018,
    roughness: Math.max(spec.roughness, color === "white" ? 0.72 : 0.78),
    metalness: 0,
    clearcoat: 0.14,
    clearcoatRoughness: 0.72,
  };
  params.emissive = new THREE.Color(color === "white" ? 0x2f1b08 : 0x120804);
  params.emissiveIntensity = color === "white" ? 0.025 : 0.015;
  return new THREE.MeshPhysicalMaterial(params);
}

export function buildBoardMaterial(theme: ThemeData): THREE.Material[] {
  const matLight = new THREE.MeshPhysicalMaterial({
    color: theme.three.boardLight,
    roughness: 0.68,
    metalness: 0.02,
    clearcoat: 0.1,
    clearcoatRoughness: 0.62,
  });
  const matDark = new THREE.MeshPhysicalMaterial({
    color: theme.three.boardDark,
    roughness: 0.7,
    metalness: 0.02,
    clearcoat: 0.1,
    clearcoatRoughness: 0.64,
  });
  return [matLight, matDark];
}
