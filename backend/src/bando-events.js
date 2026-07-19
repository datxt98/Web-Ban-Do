const listeners = new Set();

export function subscribeBandoEvents(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitBandoEvent(type, payload = {}) {
  const event = {
    type,
    payload,
    createdAt: new Date().toISOString(),
  };

  for (const listener of listeners) {
    Promise.resolve()
      .then(() => listener(event))
      .catch((error) => {
        console.error("[bando:event] listener error:", error instanceof Error ? error.message : error);
      });
  }
}
