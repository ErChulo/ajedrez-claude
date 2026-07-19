// Type stub for stockfish.wasm (which ships without .d.ts).
// We never *type*-check against its API directly; the worker (engine.worker.ts)
// uses dynamic import + postMessage. So an opaque `any` shape is fine.
declare module "stockfish.wasm" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const value: any;
  export default value;
}
