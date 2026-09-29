// Rates use real elapsed time. Pending obligations are a current count, not a rate.
export function sampleSimulationThroughput(previous, status, nowMs) {
  const events = status.events_count ?? 0;
  const next = {
    startMs: previous.startMs ?? nowMs,
    lastMs: nowMs,
    lastEvents: events,
  };
  if (previous.lastMs == null) return { next, sample: null };
  const seconds = (nowMs - previous.lastMs) / 1000;
  // Ignore too-close or stale responses rather than manufacture a rate spike.
  if (seconds < 0.25 || events < previous.lastEvents) return { next: previous, sample: null };
  return {
    next,
    sample: {
      t: (nowMs - next.startMs) / 1000,
      ev: (events - previous.lastEvents) / seconds,
      pending: Number.isFinite(status.total_obligations) ? status.total_obligations : null,
      cum: events,
    },
  };
}
