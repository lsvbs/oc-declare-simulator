import React from 'react';

export function SimulationElapsedTime({ seconds, limit, unit = 'days' }) {
  let elapsed = 'starting…';
  if (seconds != null) {
    const s = Math.max(0, seconds);
    elapsed = s < 60 ? `${Math.floor(s)}s`
      : s < 3600 ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
      : s < 86400 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
      : `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  }
  const cap = limit !== '' && limit != null ? ` / ${limit} ${unit}` : '';
  return <p className="sim-progress-elapsed" title="Time elapsed in the simulated process">
    Simulated time: <span className="sim-step-counter">{elapsed}{cap}</span>
  </p>;
}

// Blue: completed events / real second. Red: current pending obligations.
// Grey cumulative events use the independent right-hand scale.
export function SimThroughputChart({ samples }) {
  if (!samples || samples.length < 2) {
    return <div className="tp-chart tp-chart--empty">
      <span className="tp-dev">[DEV]</span>
      Collecting throughput… (first points appear after ~2s)
    </div>;
  }
  const W = 600, H = 190;
  const P = { t: 27, r: 78, b: 29, l: 58 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const stride = Math.max(1, Math.ceil(samples.length / 240));
  const pts = samples.filter((_, i) => i % stride === 0 || i === samples.length - 1);
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const span = Math.max(t1 - t0, 1e-6);
  const rateMax = Math.max(1, ...pts.map(p => Math.max(p.ev, p.pending ?? 0)));
  // Whole-number quarter ticks, including runs with fewer than four events.
  const cumMax = Math.max(4, Math.ceil(Math.max(...pts.map(p => p.cum)) / 4) * 4);
  const x = p => P.l + ((p.t - t0) / span) * iw;
  const yR = v => P.t + ih - (v / rateMax) * ih;
  const yC = v => P.t + ih - (v / cumMax) * ih;
  const line = (axis, select) => {
    let connected = false;
    return pts.map(p => {
      const value = select(p);
      if (!Number.isFinite(value)) { connected = false; return ''; }
      const segment = `${connected ? 'L' : 'M'}${x(p).toFixed(1)},${axis(value).toFixed(1)}`;
      connected = true;
      return segment;
    }).join(' ');
  };
  const area = `M${x(pts[0]).toFixed(1)},${P.t + ih} ` +
    pts.map(p => `L${x(p).toFixed(1)},${yC(p.cum).toFixed(1)}`).join(' ') +
    ` L${x(pts[pts.length - 1]).toFixed(1)},${P.t + ih} Z`;
  const last = samples[samples.length - 1];
  const fmtRate = v => v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  const fmtDuration = s => s < 60 ? `${Math.floor(s)}s`
    : s < 3600 ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
    : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  const pending = last.pending == null ? '—' : last.pending.toLocaleString();
  return <div className="tp-chart">
    <div className="tp-dev">[DEV]</div>
    <div className="tp-legend">
      <span className="tp-key tp-key--pending"><i />pending obligations <b>{pending}</b></span>
      <span className="tp-key tp-key--ev"><i />events/s <b>{fmtRate(last.ev)}</b></span>
      <span className="tp-key tp-key--cum"><i />total events <b>{last.cum.toLocaleString()}</b></span>
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} className="tp-svg" role="img"
      aria-label={`Simulation chart: ${pending} pending obligations, ${fmtRate(last.ev)} events per second, ${last.cum} total events on the right axis`}>
      <title>Pending obligations, event throughput and cumulative events</title>
      <desc>Pending obligations are sampled counts, not a per-second rate. The blue rate and red count share the left numeric scale. Grey cumulative events use the right scale.</desc>
      <text className="tp-axis-label" x={P.l} y="12">Events/s · pending count</text>
      <text className="tp-axis-label tp-axis-label--cum" x={P.l + iw} y="12" textAnchor="end">Total events</text>
      {[0, .25, .5, .75, 1].map(f => <line key={f} className="tp-grid"
        x1={P.l} x2={P.l + iw} y1={yR(rateMax * f)} y2={yR(rateMax * f)} />)}
      <path className="tp-area" d={area} />
      <path className="tp-line tp-line--cum" d={line(yC, p => p.cum)} />
      <path className="tp-line tp-line--pending" d={line(yR, p => p.pending)} />
      <path className="tp-line tp-line--ev" d={line(yR, p => p.ev)} />
      <line className="tp-axis" x1={P.l} x2={P.l} y1={P.t} y2={P.t + ih} />
      <line className="tp-axis" x1={P.l + iw} x2={P.l + iw} y1={P.t} y2={P.t + ih} />
      {[0, .25, .5, .75, 1].map(f => <g key={f}>
        <text className="tp-tick" x={P.l - 7} y={yR(rateMax * f) + 3} textAnchor="end">{f === 0 ? '0' : fmtRate(rateMax * f)}</text>
        <line className="tp-axis" x1={P.l + iw} x2={P.l + iw + 4} y1={yC(cumMax * f)} y2={yC(cumMax * f)} />
        <text className="tp-tick tp-tick--cum" x={P.l + iw + 7} y={yC(cumMax * f) + 3}>{Math.round(cumMax * f).toLocaleString()}</text>
      </g>)}
      <text className="tp-tick" x={P.l} y={H - 7}>{fmtDuration(t0)}</text>
      <text className="tp-tick" x={P.l + iw} y={H - 7} textAnchor="end">{fmtDuration(t1)}</text>
    </svg>
    <div className="tp-note">Sampled each second of real time. Red shows the current pending count.</div>
  </div>;
}
