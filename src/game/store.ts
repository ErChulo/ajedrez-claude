// Tiny typed pub/sub store used by the Game controller.
//   get()            — read latest snapshot
//   set(next)        — replace value; notifies all listeners synchronously
//   subscribe(fn)    — add a listener; returns an unsubscribe function

export type Listener<T> = (value: T) => void;

export class Store<T> {
  private value: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const l of this.listeners) {
      try { l(next); } catch (e) { console.error("Store listener threw", e); }
    }
  }

  subscribe(l: Listener<T>): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
}
