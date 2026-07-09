import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import './App.css';
import FlowChart from './FlowChart';
import ModelEditor from './ModelEditor';

// ── TransitionFlowChart ───────────────────────────────────────────────────────
const TFC_R = 22;
const TFC_HGAP = 80;
const TFC_PAD  = 44;

function tfc_layout(matrix, threshold, startSet, endSet, tracePosition) {
  // ── Edges ──────────────────────────────────────────────────────────────────
  const edges = [];
  Object.entries(matrix).forEach(([src, tgts]) => {
    Object.entries(tgts)
      .filter(([tgt, p]) => tgt !== src && p >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([tgt, p]) => edges.push({ src, tgt, p }));
  });

  const nodeSet = new Set(Object.keys(matrix));
  edges.forEach(e => { nodeSet.add(e.src); nodeSet.add(e.tgt); });
  const nodes = [...nodeSet];

  // ── Rank assignment (longest-path, cycle-safe) ────────────────────────────
  // ── Rank assignment ───────────────────────────────────────────────────────
  // When trace positions are available, bucket each activity into a rank column
  // proportional to its mean normalised position (0=first, 1=last in traces).
  // This gives columns that reflect the actual process timeline.
  // Without positions, fall back to longest-path from start nodes.
  const rankOf = {};
  const hasPositions = tracePosition && Object.keys(tracePosition).length > 0;

  if (hasPositions) {
    // Determine number of columns: use enough buckets to spread nodes without
    // crowding. Aim for at most ~4 nodes per column on average.
    const numBuckets = Math.max(3, Math.ceil(nodes.length / 3));
    nodes.forEach(n => {
      const p = tracePosition[n];
      if (p === undefined) {
        // Unknown position: place in middle
        rankOf[n] = Math.floor(numBuckets / 2);
      } else {
        // Bucket: position 0 → rank 0, position 1 → rank numBuckets-1
        rankOf[n] = Math.min(numBuckets - 1, Math.floor(p * numBuckets));
      }
    });
  } else {
    // Fallback: longest-path from start nodes
    nodes.forEach(n => { rankOf[n] = startSet.has(n) ? 0 : -1; });
    if (![...startSet].some(n => nodes.includes(n))) {
      const hasIn = new Set(edges.map(e => e.tgt));
      nodes.forEach(n => { if (!hasIn.has(n)) rankOf[n] = 0; });
    }
    nodes.forEach(n => { if (rankOf[n] < 0) rankOf[n] = 0; });
    for (let pass = 0; pass < nodes.length * 2; pass++) {
      let changed = false;
      edges.forEach(({ src, tgt }) => {
        if (endSet.has(src)) return;
        if (!startSet.has(tgt) && rankOf[src] + 1 > rankOf[tgt]) {
          rankOf[tgt] = rankOf[src] + 1; changed = true;
        }
      });
      if (!changed) break;
    }
    endSet.forEach(n => {
      const preds = edges.filter(e => e.tgt === n && !endSet.has(e.src));
      rankOf[n] = preds.length ? Math.max(...preds.map(e => rankOf[e.src])) + 1 : rankOf[n];
    });
  }

  // ── Enforce "best outgoing edge always goes right" ────────────────────────
  // Regardless of how ranks were assigned, the highest-probability outgoing
  // edge from each node must point strictly rightward. Cascade until stable.
  for (let pass = 0; pass < nodes.length * 2; pass++) {
    let changed = false;
    nodes.forEach(src => {
      if (endSet.has(src)) return;
      const outgoing = edges.filter(e => e.src === src).sort((a, b) => b.p - a.p);
      if (!outgoing.length) return;
      const tgt = outgoing[0].tgt;
      if (startSet.has(tgt)) return;
      if (rankOf[tgt] <= rankOf[src]) {
        rankOf[tgt] = rankOf[src] + 1;
        changed = true;
      }
    });
    if (!changed) break;
  }

  const distinctRanks = [...new Set(Object.values(rankOf))].sort((a, b) => a - b);
  const rankMap = {};
  distinctRanks.forEach((r, i) => { rankMap[r] = i; });
  nodes.forEach(n => { rankOf[n] = rankMap[rankOf[n]]; });
  const numRanks = Math.max(...Object.values(rankOf)) + 1;

  const byRank = Array.from({ length: numRanks }, () => []);
  nodes.forEach(n => byRank[rankOf[n]].push(n));

  // ── Trace the highest-probability spine ───────────────────────────────────
  const spineSet = new Set();
  const seeds = [...startSet].filter(n => nodes.includes(n));
  if (!seeds.length) seeds.push(...(byRank[0] || []));

  seeds.forEach(start => {
    spineSet.add(start);
    let cur = start;
    for (let r = rankOf[start]; r < numRanks - 1; r++) {
      const fwd = edges.filter(e => e.src === cur && rankOf[e.tgt] === r + 1)
                       .sort((a, b) => b.p - a.p);
      if (!fwd.length) break;
      cur = fwd[0].tgt;
      spineSet.add(cur);
    }
  });

  // For each branch node: also apply the same rule recursively
  // (each branch node's best forward edge goes to a node at rank+1)
  // This is already guaranteed by the rank assignment — nothing extra needed.

  // ── Build best-incoming-prob index ───────────────────────────────────────
  const bestIn = {};
  edges.forEach(({ tgt, p }) => { if (!bestIn[tgt] || p > bestIn[tgt]) bestIn[tgt] = p; });

  // ── Adaptive pitch based on tallest column ────────────────────────────────
  // Target: comfortable vertical spread. Formula scales down for large graphs.
  const maxColSize = Math.max(...byRank.map(l => l.length), 1);
  // pitch = distance between node centres (diameter + gap)
  // Small graphs: generous spacing. Large graphs: compact but readable.
  const adaptiveGap = Math.max(14, Math.round(120 / Math.max(maxColSize, 1)));
  const pitch = TFC_R * 2 + adaptiveGap;

  // ── Column-by-column Y placement ─────────────────────────────────────────
  // Spine node → midY (shared across all columns so the spine is horizontal).
  // Other nodes → alternate above/below in order of bestIn probability,
  // so the highest-probability branch is closest to the spine.
  const midY = TFC_PAD + TFC_R + Math.floor((maxColSize - 1) / 2) * pitch;

  const pos = {};
  byRank.forEach((layer, r) => {
    const x = TFC_PAD + TFC_R + r * (TFC_R * 2 + TFC_HGAP);

    // Find the spine node for this column (prefer explicit spine, else highest bestIn)
    const spineNode = layer.find(n => spineSet.has(n))
      || layer.sort((a, b) => (bestIn[b] || 0) - (bestIn[a] || 0))[0];

    // Sort non-spine nodes by bestIn prob desc so highest branch is nearest spine
    const others = layer.filter(n => n !== spineNode)
      .sort((a, b) => (bestIn[b] || 0) - (bestIn[a] || 0));

    // Build ordered placement: interleave above/below
    // [above2, above1, spine, below1, below2, ...]
    const above = [], below = [];
    others.forEach((n, i) => { if (i % 2 === 0) above.unshift(n); else below.push(n); });
    const ordered = [...above, spineNode, ...below];

    const spineIdx = ordered.indexOf(spineNode);
    ordered.forEach((n, i) => {
      pos[n] = {
        x,
        y: midY + (i - spineIdx) * pitch,
        rank: r,
        order: i,
        isSpine: spineSet.has(n),
      };
    });
  });

  // ── Barycenter crossing reduction (2 passes after spine placement) ────────
  // Operates only on non-spine nodes within each column to reduce edge crossings
  // without disturbing the spine's horizontal alignment.
  const posInLayer = {};
  byRank.forEach(layer => layer.forEach((n, i) => { posInLayer[n] = i; }));

  for (let pass = 0; pass < 2; pass++) {
    for (let r = 1; r < numRanks; r++) {
      const free = byRank[r].filter(n => !spineSet.has(n) && !startSet.has(n) && !endSet.has(n));
      if (!free.length) continue;
      const bcs = free.map(n => {
        const nbrs = edges.filter(e => e.tgt === n && rankOf[e.src] < r)
                          .map(e => ({ pos: posInLayer[e.src], w: e.p }));
        if (!nbrs.length) return { n, bc: posInLayer[n] };
        const wSum = nbrs.reduce((s, x) => s + x.w, 0);
        return { n, bc: nbrs.reduce((s, x) => s + x.pos * x.w, 0) / wSum };
      });
      bcs.sort((a, b) => a.bc - b.bc);
      // Re-place around spine: top-half get above, bottom-half below
      const spineNode = byRank[r].find(n => spineSet.has(n));
      const spineIdx = spineNode ? byRank[r].indexOf(spineNode) : Math.floor(byRank[r].length / 2);
      const freeAbove = bcs.slice(0, Math.ceil(bcs.length / 2)).reverse();
      const freeBelow = bcs.slice(Math.ceil(bcs.length / 2));
      const layer = byRank[r].filter(n => spineSet.has(n) || startSet.has(n) || endSet.has(n));
      // Reinsert free nodes
      freeAbove.forEach(({ n }) => layer.unshift(n));
      freeBelow.forEach(({ n }) => layer.push(n));
      byRank[r] = layer;
      byRank[r].forEach((n, i) => { posInLayer[n] = i; });

      // Update pixel positions for this column
      const spN = byRank[r].find(n => spineSet.has(n)) || byRank[r][0];
      const spI = byRank[r].indexOf(spN);
      byRank[r].forEach((n, i) => {
        if (pos[n]) pos[n].y = midY + (i - spI) * pitch;
      });
    }
  }

  const allY = Object.values(pos).map(p => p.y);
  const minY = Math.min(...allY) - TFC_R - TFC_PAD;
  const dy = minY < 0 ? -minY : 0;
  if (dy > 0) Object.values(pos).forEach(p => { p.y += dy; });

  const maxX = Math.max(...Object.values(pos).map(p => p.x)) + TFC_R + TFC_PAD;
  const maxY = Math.max(...Object.values(pos).map(p => p.y)) + TFC_R + 24 + TFC_PAD;
  return { pos, edges, width: maxX, height: maxY };
}

function TransitionFlowChart({ matrix, activityCounts, startActivities, traceEndProb, likelyEndActivities, tracePosition }) {
  const [threshold, setThreshold] = useState(0.05);

  const { startNodes, endNodes } = useMemo(() => {
    const starts = new Set((startActivities || []).slice(0, 3));
    // End nodes: provided likely-end list, or nodes with high trace-end probability, or true sinks
    const ends = new Set(likelyEndActivities || []);
    if (!ends.size && traceEndProb) {
      Object.entries(traceEndProb).forEach(([act, p]) => { if (p >= 0.5) ends.add(act); });
    }
    if (!ends.size) {
      const hasOut = new Set();
      Object.entries(matrix).forEach(([src, tgts]) =>
        Object.entries(tgts).forEach(([tgt, p]) => { if (tgt !== src && p >= threshold) hasOut.add(src); })
      );
      new Set(Object.keys(matrix)).forEach(n => { if (!hasOut.has(n)) ends.add(n); });
    }
    return { startNodes: starts, endNodes: ends };
  }, [matrix, startActivities, likelyEndActivities, traceEndProb, threshold]);

  const { pos: layoutPos, edges, width: layoutW, height: layoutH } = useMemo(
    () => tfc_layout(matrix, threshold, startNodes, endNodes, tracePosition || {}),
    [matrix, threshold, startNodes, endNodes, tracePosition]
  );

  // ── Draggable positions ───────────────────────────────────────────────────
  const [nodeOverrides, setNodeOverrides] = useState({});
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef({ type: null });
  const svgRef = useRef(null);

  const pos = useMemo(() => {
    const m = {};
    Object.entries(layoutPos).forEach(([n, p]) => { m[n] = nodeOverrides[n] ? { ...p, ...nodeOverrides[n] } : p; });
    return m;
  }, [layoutPos, nodeOverrides]);

  const { svgW, svgH } = useMemo(() => {
    const xs = Object.values(pos).map(p => p.x), ys = Object.values(pos).map(p => p.y);
    return { svgW: Math.max(layoutW, xs.length ? Math.max(...xs) + TFC_R + TFC_PAD : layoutW),
             svgH: Math.max(layoutH, ys.length ? Math.max(...ys) + TFC_R + TFC_PAD : layoutH) };
  }, [pos, layoutW, layoutH]);

  const maxProb = useMemo(() => Math.max(...edges.map(e => e.p), 0.01), [edges]);

  if (!Object.keys(matrix).length) return null;

  function getSVGPoint(e) {
    const svg = svgRef.current; if (!svg) return { x: e.clientX, y: e.clientY };
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const ctm = svg.getScreenCTM(); if (!ctm) return { x: e.clientX, y: e.clientY };
    const tp = pt.matrixTransform(ctm.inverse());
    return { x: tp.x - pan.x, y: tp.y - pan.y };
  }
  function onNodeMouseDown(e, name) {
    e.stopPropagation();
    const { x, y } = getSVGPoint(e);
    const cur = pos[name];
    dragRef.current = { type: 'node', name, startX: x, startY: y, origX: cur.x, origY: cur.y };
  }
  function onSVGMouseDown(e) {
    if (dragRef.current.type) return;
    dragRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY, origPanX: pan.x, origPanY: pan.y };
  }
  function onMouseMove(e) {
    const d = dragRef.current; if (!d.type) return;
    if (d.type === 'node') {
      const { x, y } = getSVGPoint(e);
      setNodeOverrides(prev => ({ ...prev, [d.name]: { x: d.origX + x - d.startX, y: d.origY + y - d.startY } }));
    } else {
      setPan({ x: d.origPanX + e.clientX - d.startX, y: d.origPanY + e.clientY - d.startY });
    }
  }
  function onMouseUp() { dragRef.current = { type: null }; }

  // Edge path
  function edgePath(src, tgt, idx, total) {
    const s = pos[src], t = pos[tgt]; if (!s || !t) return { d: '', lx: 0, ly: 0 };
    const dx = t.x - s.x, dy = t.y - s.y, dist = Math.sqrt(dx*dx+dy*dy) || 1;
    const ux = dx/dist, uy = dy/dist, px = -uy, py = ux;
    const spread = (idx - (total-1)/2) * 7;
    const ox = px*spread, oy = py*spread;
    const sx = s.x + ux*TFC_R + ox, sy = s.y + uy*TFC_R + oy;
    const ex = t.x - ux*TFC_R + ox, ey = t.y - uy*TFC_R + oy;
    if (t.x < s.x || (t.x === s.x && (t.rank??0) <= (s.rank??0))) {
      const bow = 55 + Math.abs(s.y-t.y)*0.35 + Math.abs(s.x-t.x)*0.25;
      return { d: `M ${sx} ${sy} C ${sx} ${sy-bow} ${ex} ${ey-bow} ${ex} ${ey}`,
               lx: (sx+ex)/2, ly: Math.min(sy,ey)-bow*0.55 };
    }
    const bendMag = Math.abs(dy)*0.18 + spread*0.4;
    const midX = (sx+ex)/2 + px*bendMag, midY = (sy+ey)/2 + py*bendMag;
    const t1 = 0.4;
    return { d: `M ${sx} ${sy} Q ${midX} ${midY} ${ex} ${ey}`,
             lx: (1-t1)*(1-t1)*sx + 2*(1-t1)*t1*midX + t1*t1*ex,
             ly: (1-t1)*(1-t1)*sy + 2*(1-t1)*t1*midY + t1*t1*ey - 5 };
  }

  const pairGroups = {};
  edges.forEach(e => { const k=`${e.src}||${e.tgt}`; (pairGroups[k]=pairGroups[k]||[]).push(e); });

  function nodeLabel(name, cx, cy) {
    const words = name.split(/\s+/), MAX = TFC_R*1.7;
    if (words.join('').length * 5 <= MAX * 1.3 && name.length <= 12)
      return <text x={cx} y={cy+3.5} textAnchor="middle" fontSize={8.5} fill="#111"
        style={{pointerEvents:'none',userSelect:'none'}}>{name}</text>;
    let best=1, bestDiff=Infinity;
    for (let i=1;i<words.length;i++) {
      const d=Math.abs(words.slice(0,i).join(' ').length-words.slice(i).join(' ').length);
      if(d<bestDiff){bestDiff=d;best=i;}
    }
    const trunc = s => s.length*5>MAX ? s.slice(0,Math.floor(MAX/5)-1)+'…' : s;
    return (<>
      <text x={cx} y={cy-3} textAnchor="middle" fontSize={8.5} fill="#111"
        style={{pointerEvents:'none',userSelect:'none'}}>{trunc(words.slice(0,best).join(' '))}</text>
      <text x={cx} y={cy+8} textAnchor="middle" fontSize={8.5} fill="#111"
        style={{pointerEvents:'none',userSelect:'none'}}>{trunc(words.slice(best).join(' '))}</text>
    </>);
  }

  return (
    <div className="tfc-wrap">
      <div className="tfc-controls">
        <label className="tfc-threshold-label">
          Min prob
          <input type="range" min={0.02} max={0.5} step={0.01} value={threshold}
            onChange={e => setThreshold(parseFloat(e.target.value))} className="tfc-slider" />
          <span className="tfc-threshold-val">{(threshold*100).toFixed(0)}%</span>
        </label>
        <span className="tfc-edge-count">{edges.length} transitions</span>
        <button className="tfc-reset-btn" onClick={() => { setNodeOverrides({}); setPan({x:0,y:0}); }}>↺ Reset</button>
        <span className="tfc-legend">
          <span style={{color:'#16a34a',fontWeight:700}}>◎</span> start &nbsp;
          <span style={{color:'#dc2626',fontWeight:700}}>◎</span> end
        </span>
      </div>
      <div className="tfc-scroll" onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
        <svg ref={svgRef} width={svgW} height={svgH} className="tfc-svg"
          onMouseDown={onSVGMouseDown} style={{cursor: dragRef.current?.type==='pan' ? 'grabbing' : 'grab'}}>
          <defs>
            <marker id="tfc-arr" markerWidth="7" markerHeight="7" refX="6.5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill="#333" />
            </marker>
          </defs>
          <g transform={`translate(${pan.x},${pan.y})`}>
            {/* Edges */}
            {edges.map(({ src, tgt, p }) => {
              const key = `${src}||${tgt}`;
              const group = pairGroups[key] || [{ p }];
              const idx = group.findIndex(e => e.p === p);
              const { d, lx, ly } = edgePath(src, tgt, idx, group.length);
              const sw = 0.6 + (p / maxProb) * 3.0;
              return (
                <g key={`${src}->${tgt}`}>
                  <path d={d} fill="none" stroke="#333" strokeWidth={sw} markerEnd="url(#tfc-arr)" />
                  <rect x={lx-10} y={ly-8} width={20} height={11} rx={2} fill="white" opacity={0.85} />
                  <text x={lx} y={ly} textAnchor="middle" fontSize={8.5} fill="#333"
                    style={{pointerEvents:'none',userSelect:'none'}}>{p.toFixed(2)}</text>
                </g>
              );
            })}
            {/* Nodes */}
            {Object.entries(pos).map(([name, { x, y }]) => {
              const isStart = startNodes.has(name), isEnd = endNodes.has(name);
              const ep = traceEndProb?.[name] || 0;
              return (
                <g key={name} style={{cursor:'grab'}} onMouseDown={e => onNodeMouseDown(e, name)}>
                  {(isStart || isEnd) && (
                    <circle cx={x} cy={y} r={TFC_R+5} fill="none"
                      stroke={isStart ? '#16a34a' : '#dc2626'} strokeWidth={1.5} />
                  )}
                  <circle cx={x} cy={y} r={TFC_R} fill="white" stroke="#333" strokeWidth={1.5} />
                  {ep > 0 && (
                    <text x={x} y={y+TFC_R+11} textAnchor="middle" fontSize={8}
                      fill={ep>=0.7?'#dc2626':ep>=0.3?'#d97706':'#64748b'}
                      style={{pointerEvents:'none',userSelect:'none'}}>
                      end {(ep*100).toFixed(0)}%
                    </text>
                  )}
                  {nodeLabel(name, x, y)}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}


// ── HelpTip (shared with ModelEditor — CSS lives in ModelEditor.css which is
//    bundled together, so the same class names work here too) ──────────────────
function HelpTip({ text }) {
  const [visible, setVisible] = React.useState(false);
  return (
    <span className="help-tip" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
      <span className="help-tip-icon">?</span>
      {visible && <span className="help-tip-popup">{text}</span>}
    </span>
  );
}

// ── Collapsible (reusable foldable section) ───────────────────────────────────
// Keeps the outer `className` so existing CSS selectors (e.g. `.object-types ul`)
// keep matching. The header gets both the caller's look (via the wrapper class)
// and the shared `.collapsible-header` behaviour.
function Collapsible({ title, badge, defaultOpen = false, className = '', children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <h4 className="collapsible-header" onClick={() => setOpen(o => !o)}>
        <span className="collapsible-caret">{open ? '▼' : '▶'}</span>
        <span className="collapsible-title">{title}</span>
        {badge != null && <span className="collapsible-badge">{badge}</span>}
      </h4>
      {open && (typeof children === 'function' ? children() : children)}
    </div>
  );
}

// ── ObjectTracer ──────────────────────────────────────────────────────────────
// Builds a forest from object-to-object links and shows, for each seed object
// (one never appearing as a link target), the chain of objects connected to it.
const TRACER_TYPE_COLORS = [
  '#667eea', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#14b8a6',
];

function _fmtChainTime(s) {
  if (s == null) return '—';
  if (s < 3600) return `${(s / 60).toFixed(0)}min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function ObjectTracer({ links = [], typesMap = {}, objectMetrics = {}, resourceTypes = [] }) {
  const resourceSet = React.useMemo(() => new Set(resourceTypes), [resourceTypes]);

  const { childrenOf, roots, typeColor } = React.useMemo(() => {
    const childrenOf = {};
    const sources = new Set();
    const targets = new Set();
    links.forEach(({ source, target }) => {
      (childrenOf[source] = childrenOf[source] || []).push(target);
      sources.add(source);
      targets.add(target);
    });
    let roots = [...sources].filter(s => !targets.has(s));
    if (roots.length === 0) roots = [...sources];
    roots.sort();

    const orderedTypes = [...new Set(Object.values(typesMap))].sort();
    const colorIdx = {};
    orderedTypes.forEach((t, i) => { colorIdx[t] = i; });
    const typeColor = t => TRACER_TYPE_COLORS[(colorIdx[t] ?? 0) % TRACER_TYPE_COLORS.length];

    return { childrenOf, roots, typeColor };
  }, [links, typesMap]);

  // Collect all object ids in a chain rooted at `id` (BFS, cycle-safe)
  const collectChain = (id) => {
    const visited = new Set();
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      (childrenOf[cur] || []).forEach(kid => queue.push(kid));
    }
    return visited;
  };

  // Compute chain timing from objectMetrics — resource objects excluded from
  // timing so they don't span the entire simulation and inflate the numbers.
  const chainTiming = React.useMemo(() => {
    if (!objectMetrics || !Object.keys(objectMetrics).length) return {};
    const result = {};
    roots.forEach(rootId => {
      const ids = collectChain(rootId);
      let minFirst = null, maxLast = null, totalServiceS = 0, caseCount = 0;
      ids.forEach(oid => {
        const otype = typesMap[oid];
        const isResource = resourceSet.has(otype);
        const m = objectMetrics[oid];
        if (!m) return;
        // Only case objects count towards timing
        if (!isResource) {
          if (m.first_event_time) {
            const t = new Date(m.first_event_time).getTime();
            if (minFirst === null || t < minFirst) minFirst = t;
          }
          if (m.last_event_time) {
            const t = new Date(m.last_event_time).getTime();
            if (maxLast === null || t > maxLast) maxLast = t;
          }
          if (m.lifetime_s != null) totalServiceS += m.lifetime_s;
          caseCount++;
        }
      });
      const elapsedS = (minFirst !== null && maxLast !== null)
        ? (maxLast - minFirst) / 1000
        : null;
      result[rootId] = {
        elapsedS,
        totalServiceS: totalServiceS > 0 ? totalServiceS : null,
        objectCount: ids.size,
        caseCount,
      };
    });
    return result;
  }, [roots, objectMetrics, resourceSet, typesMap]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (!links.length) {
    return <p className="tracer-empty">No object-to-object connections were created in this run.</p>;
  }

  const Node = ({ id, depth, seen }) => {
    const kids = childrenOf[id] || [];
    const otype = typesMap[id] || '?';
    const isResource = resourceSet.has(otype);
    const om = objectMetrics[id];
    const lifetime = om?.lifetime_s;
    const nextSeen = new Set(seen); nextSeen.add(id);
    return (
      <div className="tracer-node" style={{ marginLeft: depth === 0 ? 0 : 16 }}>
        <span className="tracer-obj">
          <span className="tracer-type-chip" style={{ background: typeColor(otype) }}>{otype}</span>
          <span className="tracer-id">{id}</span>
          {isResource && <span className="tracer-resource-badge" title="Resource object — excluded from chain timing">resource</span>}
          {!isResource && lifetime != null && (
            <span className="tracer-obj-lifetime" title="Service time: first to last event on this object">
              ⚙ {_fmtChainTime(lifetime)}
            </span>
          )}
          {kids.length > 0 && <span className="tracer-fanout">→ {kids.length}</span>}
        </span>
        {kids.map((kid, i) => {
          if (seen.has(kid)) {
            return (
              <div key={`${id}-${kid}-${i}`} className="tracer-node" style={{ marginLeft: 16 }}>
                <span className="tracer-obj tracer-cycle">↺ {kid} (already shown)</span>
              </div>
            );
          }
          return <Node key={`${id}-${kid}-${i}`} id={kid} depth={depth + 1} seen={nextSeen} />;
        })}
      </div>
    );
  };

  return (
    <div className="tracer-forest">
      {roots.map(rootId => {
        const ct = chainTiming[rootId] || {};
        return (
          <Collapsible
            key={rootId}
            className="tracer-root"
            defaultOpen={false}
            title={
              <span className="tracer-root-title">
                <span className="tracer-type-chip" style={{ background: typeColor(typesMap[rootId] || '?') }}>
                  {typesMap[rootId] || '?'}
                </span>
                {rootId}
                {(ct.elapsedS != null || ct.totalServiceS != null) && (
                  <span className="tracer-chain-timing">
                    {ct.elapsedS != null && (
                      <span className="tracer-timing-chip tracer-timing-elapsed" title="Total elapsed time: from first object entering to last object's final event">
                        ⏱ {_fmtChainTime(ct.elapsedS)} elapsed
                      </span>
                    )}
                    {ct.totalServiceS != null && (
                      <span className="tracer-timing-chip tracer-timing-service" title="Total service time: sum of individual object lifetimes across the chain">
                        ⚙ {_fmtChainTime(ct.totalServiceS)} service
                      </span>
                    )}
                  </span>
                )}
              </span>
            }
            badge={`${(childrenOf[rootId] || []).length} direct · ${ct.caseCount ?? ct.objectCount ?? 0} case objects`}
          >
            <div className="tracer-tree">
              {(childrenOf[rootId] || []).length === 0
                ? <p className="tracer-leaf-note">No linked objects.</p>
                : (childrenOf[rootId] || []).map((kid, i) => (
                    <Node key={`${rootId}-${kid}-${i}`} id={kid} depth={1} seen={new Set([rootId])} />
                  ))
              }
            </div>
          </Collapsible>
        );
      })}
    </div>
  );
}


// ── TimingDiscoveryPanel ──────────────────────────────────────────────────────
const EMPTY_ANCHOR = { mean_seconds: '', std_seconds: '', min_seconds: '0', max_seconds: '' };
const TIMING_FIELDS = [
  { key: 'mean_seconds', label: 'Mean (s)', placeholder: '3600', required: true },
  { key: 'std_seconds',  label: 'Std (s)',  placeholder: '600',  required: false },
  { key: 'min_seconds',  label: 'Min (s)',  placeholder: '0',    required: false },
  { key: 'max_seconds',  label: 'Max (s)',  placeholder: '∞',    required: false },
];

function AnchorInputs({ anchor, onChange }) {
  return (
    <div className="timing-anchor-inputs">
      {TIMING_FIELDS.map(({ key, label, placeholder }) => (
        <label key={key} className="timing-anchor-field">
          {label}
          <input
            type="number" min={0} step={1}
            className="timing-anchor-num"
            value={anchor[key] ?? ''}
            placeholder={placeholder}
            onChange={e => onChange(key, e.target.value === '' ? '' : parseFloat(e.target.value))}
          />
        </label>
      ))}
    </div>
  );
}

function TimingDiscoveryPanel({
  activities, eventLogFile,
  isDiscovering, result, error,
  onDiscover, timingAnchors, setTimingAnchors,
}) {
  const [mode, setMode] = useState('single'); // 'single' | 'multi'
  const [singleActivity, setSingleActivity] = useState('');

  const singleAnchor = timingAnchors[singleActivity] || { ...EMPTY_ANCHOR };

  const updateSingle = (field, val) => {
    if (!singleActivity) return;
    setTimingAnchors(prev => ({
      ...prev,
      [singleActivity]: { ...(prev[singleActivity] || EMPTY_ANCHOR), [field]: val },
    }));
  };

  const addMultiAnchor = (actName) => {
    if (!actName || timingAnchors[actName]) return;
    setTimingAnchors(prev => ({ ...prev, [actName]: { ...EMPTY_ANCHOR } }));
  };

  const removeMultiAnchor = (actName) => {
    setTimingAnchors(prev => { const n = { ...prev }; delete n[actName]; return n; });
  };

  const updateMulti = (actName, field, val) => {
    setTimingAnchors(prev => ({
      ...prev,
      [actName]: { ...(prev[actName] || EMPTY_ANCHOR), [field]: val },
    }));
  };

  const canDiscover = eventLogFile && (
    mode === 'single'
      ? singleActivity && (timingAnchors[singleActivity]?.mean_seconds !== '' && timingAnchors[singleActivity]?.mean_seconds != null)
      : Object.keys(timingAnchors).length > 0
  );

  // Build effective anchor list before calling onDiscover
  const handleDiscover = () => {
    if (mode === 'single' && singleActivity && !timingAnchors[singleActivity]?.mean_seconds) return;
    onDiscover();
  };

  const multiUnused = activities.filter(a => !timingAnchors[a]);
  const [multiAddSel, setMultiAddSel] = useState('');

  return (
    <div className="timing-discovery-section">
      <div className="section-header">
        <h2>Step 2.5: Discover Time Distributions</h2>
        <p>
          Provide known service-time parameters for one or more <strong>anchor activities</strong>.
          All other activity times are derived from OCEL event timestamps using the OCPA framework
          (Sojourn, Sync, Flow, Pooling, Lagging). Results are pre-filled in the Model Editor → Timing tab.
        </p>
      </div>

      {/* Mode toggle */}
      <div className="timing-mode-toggle">
        <button
          className={`timing-mode-btn ${mode === 'single' ? 'active' : ''}`}
          onClick={() => { setMode('single'); setTimingAnchors({}); }}
        >
          Single anchor
        </button>
        <button
          className={`timing-mode-btn ${mode === 'multi' ? 'active' : ''}`}
          onClick={() => { setMode('multi'); setTimingAnchors({}); }}
        >
          Multiple anchors
        </button>
        <span className="timing-mode-hint">
          {mode === 'single'
            ? 'Choose one activity whose service time you know.'
            : 'Add several activities as anchors for more accurate Waiting time estimates.'}
        </span>
      </div>

      {/* ── Single mode ── */}
      {mode === 'single' && (
        <div className="timing-single-block">
          <label className="timing-anchor-field" style={{ marginBottom: '0.75rem' }}>
            Anchor activity
            <select
              className="timing-anchor-select"
              value={singleActivity}
              onChange={e => { setSingleActivity(e.target.value); setTimingAnchors({}); }}
            >
              <option value="">— choose activity —</option>
              {activities.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          {singleActivity && (
            <AnchorInputs anchor={singleAnchor} onChange={updateSingle} />
          )}
        </div>
      )}

      {/* ── Multi mode ── */}
      {mode === 'multi' && (
        <div className="timing-multi-block">
          {/* Add row */}
          <div className="timing-multi-add">
            <select
              className="timing-anchor-select"
              value={multiAddSel}
              onChange={e => setMultiAddSel(e.target.value)}
            >
              <option value="">— add activity —</option>
              {multiUnused.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <button
              className="timing-multi-add-btn"
              disabled={!multiAddSel}
              onClick={() => { addMultiAnchor(multiAddSel); setMultiAddSel(''); }}
            >
              + Add
            </button>
          </div>

          {/* Anchor rows */}
          {Object.keys(timingAnchors).length === 0 && (
            <p className="timing-empty-hint">No anchors added yet. Add at least one activity above.</p>
          )}
          {Object.entries(timingAnchors).map(([actName, anc]) => (
            <div key={actName} className="timing-anchor-row active">
              <div className="timing-anchor-row-header">
                <span className="timing-anchor-act-label">{actName}</span>
                <button className="timing-anchor-remove" onClick={() => removeMultiAnchor(actName)}>✕</button>
              </div>
              <AnchorInputs
                anchor={anc}
                onChange={(field, val) => updateMulti(actName, field, val)}
              />
            </div>
          ))}
        </div>
      )}

      <button
        className="timing-discover-btn"
        onClick={handleDiscover}
        disabled={isDiscovering || !canDiscover}
        style={{ marginTop: '1rem' }}
      >
        {isDiscovering ? 'Discovering…' : '⏱ Discover Time Distributions'}
      </button>

      {error && <div className="error-box" style={{ marginTop: '0.75rem' }}><p>{error}</p></div>}

      {result && Object.keys(result).length > 0 && (
        <Collapsible
          className="timing-results-table"
          title="Discovered Metrics (seconds)"
          badge={`${Object.keys(result).length} activities`}
        >
          <table>
            <thead>
              <tr>
                <th>Activity</th><th>Service (mean)</th><th>Sojourn</th>
                <th>Waiting</th><th>Sync</th><th>Flow</th><th>Pooling</th><th>n</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(result).map(([act, m]) => (
                <tr key={act}>
                  <td>{act}</td>
                  <td>{m.service_mean != null ? Math.round(m.service_mean) : '—'}</td>
                  <td>{m.sojourn_mean != null ? Math.round(m.sojourn_mean) : '—'}</td>
                  <td>{m.waiting_mean != null ? Math.round(m.waiting_mean) : '—'}</td>
                  <td>{m.sync_mean    != null ? Math.round(m.sync_mean)    : '—'}</td>
                  <td>{m.flow_mean    != null ? Math.round(m.flow_mean)    : '—'}</td>
                  <td>{m.pooling_mean != null ? Math.round(m.pooling_mean) : '—'}</td>
                  <td>{m.sample_count ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="timing-results-note">
            ✓ Model Editor → Timing tab has been pre-filled. Review and edit values there before simulating.
          </p>
          {/* Duplicate time bounds warning inside the results collapsible */}
          {(() => {
            const zeroMin = [], zeroMax = [];
            Object.entries(result).forEach(([act, m]) => {
              if (m.min_seconds === 0 || m.min_seconds == null) zeroMin.push(act);
              if (m.max_seconds === 0 || m.max_seconds == null) zeroMax.push(act);
            });
            if (!zeroMin.length && !zeroMax.length) return null;
            return (
              <div className="timing-warning-box" style={{ marginTop: '0.75rem' }}>
                <div className="timing-warning-title">⚠ Discovered time bounds to review</div>
                {zeroMin.length > 0 && (
                  <div className="timing-warning-group">
                    <div className="timing-warning-label">Min = 0 s</div>
                    <ul className="timing-warning-list">{zeroMin.map(a => <li key={a}>{a}</li>)}</ul>
                  </div>
                )}
                {zeroMax.length > 0 && (
                  <div className="timing-warning-group">
                    <div className="timing-warning-label">Max = 0 / unbounded</div>
                    <ul className="timing-warning-list">{zeroMax.map(a => <li key={a}>{a}</li>)}</ul>
                  </div>
                )}
                <p className="timing-warning-hint">Review in Model Editor → Timing tab.</p>
              </div>
            );
          })()}
        </Collapsible>
      )}
    </div>
  );
}

// ── WorkflowTopBar ───────────────────────────────────────────────────────────
function WorkflowTopBar({ discoveryConfig, config, discoveryResults,
  ocdeclareDiscoveryResults, activeModel, modelEdited,
  timingDiscoveryResult, results, workflowMode }) {

  const steps = [
    { key: 'ocel',    label: 'OCEL',        done: !!discoveryConfig.eventLogFile },
    { key: 'prob',    label: 'Probability',  done: !!discoveryResults },
    { key: 'lc',      label: 'Lifecycle',
      done: !!ocdeclareDiscoveryResults || (!!activeModel && !Array.isArray(activeModel) && modelEdited) },
    { key: 'time',    label: 'Timing',       done: !!timingDiscoveryResult },
    { key: 'model',   label: 'Model ready',  done: !!activeModel && !Array.isArray(activeModel) },
    { key: 'sim',     label: 'Simulated',    done: !!results },
  ];

  const ocelFile     = discoveryConfig.eventLogFile || null;
  const ocdeclFile   = config.ocdeclareFile || null;
  const modeLabel    = workflowMode === 'internal'       ? 'Internal'
                     : workflowMode === 'external-ocel'  ? 'External + OCEL'
                     : workflowMode === 'external-empty' ? 'External (no files)'
                     : null;

  return (
    <div className="workflow-topbar">
      <div className="topbar-files">
        {modeLabel && <span className="topbar-mode-badge">{modeLabel}</span>}
        <span className={`topbar-file-pill ${ocelFile ? 'loaded' : ''}`}>
          📄 {ocelFile || 'No OCEL loaded'}
        </span>
        {workflowMode !== 'external-empty' && (
          <span className={`topbar-file-pill ${ocdeclFile ? 'loaded' : ''}`}>
            📋 {ocdeclFile || 'No OC-Declare loaded'}
          </span>
        )}
      </div>
      <div className="topbar-steps">
        {steps.map(s => (
          <span key={s.key} className={`topbar-step ${s.done ? 'done' : ''}`}>
            {s.done ? '✓ ' : ''}{s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── LifecycleDerivationPanel ──────────────────────────────────────────────────
function LifecycleDerivationPanel({ sourceFile, eventLogFile, activeModel, onModelChange }) {
  const [isDerivng, setIsDerivng] = React.useState(false);
  const [result,    setResult]    = React.useState(null); // null | {summary, method, error}

  const run = async () => {
    setIsDerivng(true);
    setResult(null);
    try {
      const payload = { ocdeclareFile: sourceFile };
      if (eventLogFile) payload.eventLogFile = eventLogFile;
      const res = await axios.post('/api/derive-lifecycle', payload);
      if (res.data.success) {
        onModelChange({
          ...(activeModel || {}),
          activities: res.data.model.activities,
          o2o_rules: res.data.model.o2o_rules?.length ? res.data.model.o2o_rules : ((activeModel || {}).o2o_rules || []),
        });
        setResult({ summary: res.data.summary, method: res.data.method });
      } else {
        setResult({ error: res.data.error });
      }
    } catch (e) {
      setResult({ error: e.response?.data?.error || e.message });
    } finally {
      setIsDerivng(false);
    }
  };

  return (
    <div className="timing-discovery-section">
      <div className="section-header">
        <h2>Lifecycle Derivation</h2>
        <p>
          Infer <code>creates</code> and <code>deactivates</code> flags for each activity binding.
          {eventLogFile
            ? <> Uses the loaded OCEL log <strong>{eventLogFile}</strong> for accurate first/last-event analysis.</>
            : <> No OCEL log loaded — falls back to arc-direction heuristic.</>}
        </p>
      </div>
      <button
        className="timing-discover-btn"
        onClick={run}
        disabled={isDerivng || !sourceFile}
      >
        {isDerivng ? 'Deriving…' : `↻ Derive lifecycle${eventLogFile ? ' (OCEL)' : ' (heuristic)'}`}
      </button>
      {result?.error && (
        <div className="error-box" style={{ marginTop: '0.75rem' }}><p>{result.error}</p></div>
      )}
      {result && !result.error && (
        <div style={{ marginTop: '0.75rem' }}>
          <span style={{
            fontSize: '0.7rem', fontWeight: 700, padding: '0.1rem 0.4rem',
            borderRadius: '4px', marginRight: '0.5rem',
            background: result.method === 'ocel' ? '#dcfce7' : '#fef3c7',
            color: result.method === 'ocel' ? '#166534' : '#92400e',
          }}>
            {result.method === 'ocel' ? '✓ OCEL log' : '⚠ arc heuristic'}
          </span>
          <span style={{ fontSize: '0.82rem', color: '#166534', fontWeight: 600 }}>Lifecycle applied</span>
          <ul style={{ marginTop: '0.4rem', fontSize: '0.78rem', color: '#475569', paddingLeft: '1.25rem' }}>
            {(result.summary || []).slice(1).map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── O2ODiscoveryPanel ─────────────────────────────────────────────────────────
function O2ODiscoveryPanel({ eventLogFile, activeModel, onModelChange }) {
  const [isDiscovering, setIsDiscovering] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState(null);

  const run = async () => {
    setIsDiscovering(true);
    setError(null);
    setResult(null);
    try {
      const res = await axios.post('/api/discover-o2o', { eventLogFile });
      if (res.data.success) {
        onModelChange({ ...activeModel, o2o_rules: res.data.o2o_rules });
        setResult(res.data.count);
      } else {
        setError(res.data.error || 'Discovery failed');
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setIsDiscovering(false);
    }
  };

  return (
    <div className="o2o-discover-bar">
      <div className="o2o-discover-left">
        <span className="o2o-discover-label">Object-to-Object relationships</span>
        {result !== null && (
          <span className="o2o-discover-result">✓ {result} rule{result !== 1 ? 's' : ''} applied to model</span>
        )}
        {error && <span className="o2o-discover-error">{error}</span>}
      </div>
      <button className="start-prob-btn" disabled={isDiscovering} onClick={run}>
        {isDiscovering ? 'Discovering…' : 'Discover O2O relationships'}
      </button>
    </div>
  );
}

function App() {
  // Available files from backend
  const [ocdeclareFiles, setOcdeclareFiles] = useState([]);
  const [eventLogFiles, setEventLogFiles] = useState([]);
  const [parameterFiles, setParameterFiles] = useState([]);
  
  // Discovery state
  const [discoveryConfig, setDiscoveryConfig] = useState({
    eventLogFile: '',
  });
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryResults, setDiscoveryResults] = useState(null);
  const [discoveryError, setDiscoveryError] = useState(null);
  const [discoveryLogs, setDiscoveryLogs] = useState([]);
  
  // OC-Declare Discovery state
  const [ocdeclareDiscoveryConfig, setOcdeclareDiscoveryConfig] = useState({
    eventLogFile: '',
    lifecycleThreshold: 0.5,
    resourceThreshold: 50,
    constraintTypes: {
      precedence: true,
      response: true,
      not_coexistence: false,
      chain_precedence: false,
      chain_response: false,
      coexistence: false,
      absence: false
    },
    // Per-constraint-type thresholds. Chain types default to higher bars.
    constraintParams: {
      precedence:      { minSupport: 0.7,  minConfidence: 0.85, noiseThreshold: 0.15 },
      response:        { minSupport: 0.7,  minConfidence: 0.85, noiseThreshold: 0.15 },
      not_coexistence: { minSupport: 0.7,  minConfidence: 0.85, noiseThreshold: 0.15 },
      chain_precedence:{ minSupport: 0.8,  minConfidence: 0.95, noiseThreshold: 0.05 },
      chain_response:  { minSupport: 0.8,  minConfidence: 0.95, noiseThreshold: 0.05 },
    }
  });
  const [isOcdeclareDiscovering, setIsOcdeclareDiscovering] = useState(false);
  const [ocdeclareDiscoveryResults, setOcdeclareDiscoveryResults] = useState(null);
  const [ocdeclareDiscoveryError, setOcdeclareDiscoveryError] = useState(null);
  
  // Simulation state
  const [availableActivities, setAvailableActivities] = useState([]);
  const [startActivityCandidates, setStartActivityCandidates] = useState([]);
  const [config, setConfig] = useState({
    ocdeclareFile: '',
    maxSteps: 200,
    seed: 42,
    startActivities: [],
  });
  const [isSimulating, setIsSimulating] = useState(false);
  const [liveStepCount, setLiveStepCount] = useState(null); // step counter during run
  const [activeRunId,   setActiveRunId]   = useState(null); // run_id for status/stop polling
  const pollIntervalRef = useRef(null);
  const [results, setResults] = useState(null);
  const [healthResult, setHealthResult] = useState(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);
  const [iterationLogs, setIterationLogs] = useState([]);
  const [iterationLogsOpen, setIterationLogsOpen] = useState(false);
  const iterationStepCount = useMemo(
    () => iterationLogs.filter(e => e.event === 'candidates').length,
    [iterationLogs]
  );
  const [error, setError] = useState(null);

  // ── On-demand object metrics — declared here so memos below can reference it ──
  const [objectMetricsData,   setObjectMetricsData]   = useState(null);
  const [isLoadingObjMetrics, setIsLoadingObjMetrics] = useState(false);
  const [logs, setLogs] = useState([]);

  // ── Expensive derived data for simulation results ─────────────────────────
  // Pre-compute per-activity object counts from on-demand object metrics.
  const simActivityObjectCounts = useMemo(() => {
    if (!objectMetricsData) return {};
    const counts = {};
    Object.values(objectMetricsData).forEach(m => {
      const seen = new Set(m.activities || []);
      seen.forEach(act => { counts[act] = (counts[act] || 0) + 1; });
    });
    return counts;
  }, [objectMetricsData]);

  // Group object metrics by type for the Object Lifetimes panel.
  const objectMetricsByType = useMemo(() => {
    if (!objectMetricsData) return [];
    const byType = {};
    Object.entries(objectMetricsData).forEach(([oid, m]) => {
      (byType[m.object_type] = byType[m.object_type] || []).push([oid, m]);
    });
    return Object.entries(byType).sort();
  }, [objectMetricsData]);

  // ── Model editor state ────────────────────────────────────────────────────
  // Holds the actively-edited model dict and normalised probability matrix.
  // Populated on OC-Declare discovery or when the user picks an existing file.
  const [activeModel,      setActiveModel]      = useState(null);
  const [activeProbMatrix, setActiveProbMatrix] = useState(null);
  // Tracks whether the user changed the model via the Model Editor since it was
  // last loaded. Used to label a simulation run as using custom inputs.
  const [modelEdited,      setModelEdited]      = useState(false);

  // ── Session history (current session, not persisted) ─────────────────────
  const [sessionHistory, setSessionHistory] = useState([]);
  // ── Persisted run history (loaded from server) ────────────────────────────
  const [runHistory,     setRunHistory]     = useState([]);
  const [expandedRunId,  setExpandedRunId]  = useState(null);
  const [runMetrics,     setRunMetrics]     = useState({});  // run_id -> metrics obj

  // Reset object metrics whenever a new simulation result arrives
  React.useEffect(() => { setObjectMetricsData(null); }, [results]);

  const loadObjectMetrics = useCallback(async () => {
    const metricsFile = results?.metrics_file;
    if (!metricsFile) return;
    setIsLoadingObjMetrics(true);
    try {
      // Use the run id (= metrics filename stem) to fetch just object_metrics
      const runId = metricsFile.replace(/^metrics_/, 'log_');
      const r = await axios.get(`/api/run-history/${encodeURIComponent(runId)}/metrics?section=object`);
      setObjectMetricsData(r.data.object_metrics || {});
    } catch {
      setObjectMetricsData({});
    } finally {
      setIsLoadingObjMetrics(false);
    }
  }, [results]);

  // ── Model warnings (activities with no bindings) ──────────────────────────
  const bindingWarnings = activeModel
    ? (activeModel.activities || []).filter(a => !(a.bindings?.length))
    : [];
  const hasModelWarnings = bindingWarnings.length > 0;

  // ── Step 2.5: Timing discovery state ─────────────────────────────────────
  const [timingAnchors,       setTimingAnchors]       = useState({}); // actName → {mean_seconds,std_seconds,min_seconds,max_seconds}
  const [isDiscoveringTiming, setIsDiscoveringTiming] = useState(false);
  const [timingDiscoveryResult, setTimingDiscoveryResult] = useState(null);
  const [timingDiscoveryFile,   setTimingDiscoveryFile]   = useState(null);
  const [timingError,           setTimingError]           = useState(null);

  // ── Workflow mode ─────────────────────────────────────────────────────────
  const [workflowMode, setWorkflowMode] = useState(null);
  // null = not chosen yet | 'internal' | 'external-ocel' | 'external-empty'
  const [paramDiscoveryEnabled, setParamDiscoveryEnabled] = useState({
    probability: true, lifecycle: true, time: true,
  });

  // ── Automated post-processing state ───────────────────────────────────────
  const [autoConfig, setAutoConfig] = useState({
    cycleEnabled:            true,
    cycleNminThreshold:      1,
    weakEnabled:             true,
    weakThreshold:           25,
    chainEnabled:            true,
    chainBlockThreshold:     5,
    o2oEnabled:              true,
    nmaxEnabled:             true,   // raise nmax caps that are hit
    createsMissingEnabled:   true,   // suggest creates=True for never-attempted activities
    startRecEnabled:         true,   // recommend start activities when pool empty at step 0
    redundantEnabled:        true,   // remove weaker of duplicate/implied constraints
    unconstrainedEnabled:    true,   // suggest predecessor for activities with no input arcs
    noInputBindingEnabled:   true,   // suggest adding an object binding to activities with no non-creating input
  });
  const [autoConfigOpen, setAutoConfigOpen] = useState(false);
  const [autoSuggestions, setAutoSuggestions] = useState([]);
  const [autoSelected,    setAutoSelected]    = useState(new Set());
  // For "add constraint" suggestions: stores chosen predecessor per suggestion id
  const [autoConstraintPreds, setAutoConstraintPreds] = useState({});
  // For "add binding" suggestions: stores chosen object type per suggestion id
  const [autoBindingTypes, setAutoBindingTypes] = useState({});

  // Load available files on component mount
  useEffect(() => {
    loadAvailableFiles();
    // Load persisted run history from server
    axios.get('/api/run-history').then(r => setRunHistory(r.data.runs || [])).catch(() => {});
  }, []);

  const loadAvailableFiles = async ({ preserveSelections = false } = {}) => {
    try {
      const response = await axios.get('/api/files');
      const ocdeclareFiles = (response.data.ocdeclare_files || []).slice().reverse();
      const eventLogFiles  = (response.data.event_log_files  || []).slice().reverse();
      const parameterFiles = (response.data.parameter_files  || []).slice().reverse();
      setOcdeclareFiles(ocdeclareFiles);
      setEventLogFiles(eventLogFiles);
      setParameterFiles(parameterFiles);

      // Only set defaults when not preserving current selections
      if (!preserveSelections) {
        if (ocdeclareFiles.length > 0) {
          setConfig(prev => ({ ...prev, ocdeclareFile: ocdeclareFiles[0] }));
        }
        if (eventLogFiles.length > 0) {
          setDiscoveryConfig(prev => ({ ...prev, eventLogFile: eventLogFiles[0] }));
        }
      }
    } catch (err) {
      setDiscoveryError('Failed to load available files. Make sure the backend server is running.');
      console.error('Error loading files:', err);
    }
  };

  const runDiscovery = async () => {
    setIsDiscovering(true);
    setDiscoveryError(null);
    setDiscoveryResults(null);
    setDiscoveryLogs([]);
    setResults(null); // Clear previous simulation results
    setError(null);

    try {
      const response = await axios.post('/api/discover', discoveryConfig);
      
      if (response.data.success) {
        setDiscoveryResults(response.data.results);
        setDiscoveryLogs(response.data.logs || []);
        setAvailableActivities(response.data.results.activities || []);
        
        // Prefer the chronologically first activity from the log as start activity
        const firstActivity = response.data.results.first_activity
          || response.data.results.activities?.[0];
        if (firstActivity) {
          setConfig(prev => ({ ...prev, startActivities: [firstActivity] }));
        }
        // Build unranked candidates from all activities (no pct info at this stage)
        setStartActivityCandidates(
          (response.data.results.activities || []).map(a => ({ activity: a, count: null, pct: null }))
        );
      } else {
        setDiscoveryError(response.data.error || 'Discovery failed');
      }
    } catch (err) {
      setDiscoveryError(err.response?.data?.error || err.message || 'Failed to run discovery');
      console.error('Discovery error:', err);
    } finally {
      setIsDiscovering(false);
    }
  };

  const handleDiscoveryConfigChange = (field, value) => {
    setDiscoveryConfig(prev => ({ ...prev, [field]: value }));
    // Reset discovery results when config changes
    setDiscoveryResults(null);
    setAvailableActivities([]);
  };

  const handleOcdeclareDiscoveryConfigChange = (field, value) => {
    setOcdeclareDiscoveryConfig(prev => ({ ...prev, [field]: value }));
    // Keep Step 1 event log in sync so the probability cache is for the same file
    if (field === 'eventLogFile') {
      setDiscoveryConfig(prev => ({ ...prev, eventLogFile: value }));
    }
    // Reset discovery results when config changes
    setOcdeclareDiscoveryResults(null);
    setOcdeclareDiscoveryError(null);
  };

  const handleConstraintTypeChange = (constraintType, checked) => {
    setOcdeclareDiscoveryConfig(prev => ({
      ...prev,
      constraintTypes: { ...prev.constraintTypes, [constraintType]: checked }
    }));
  };

  const handleConstraintParamChange = (constraintType, field, value) => {
    setOcdeclareDiscoveryConfig(prev => ({
      ...prev,
      constraintParams: {
        ...prev.constraintParams,
        [constraintType]: {
          ...prev.constraintParams[constraintType],
          [field]: value,
        }
      }
    }));
  };

  // Fetch model + normalised prob matrix from the backend and push into editor state
  const loadModelState = useCallback(async (ocdeclareFile, eventLogFile) => {
    if (!ocdeclareFile) return;
    try {
      const params = new URLSearchParams({ ocdeclareFile });
      if (eventLogFile) params.set('eventLogFile', eventLogFile);
      const res = await axios.get(`/api/model-state?${params}`);
      if (res.data.success) {
        const model = res.data.model;
        if (model && !Array.isArray(model)) {
          setActiveModel(model);
          setModelEdited(false);
        }
        if (res.data.probMatrix && Object.keys(res.data.probMatrix).length > 0) {
          setActiveProbMatrix(res.data.probMatrix);
        }
      }
    } catch (err) {
      console.warn('Could not load model state:', err.message);
    }
  }, []);

  // Keep editor/timing data available whenever a simulation model is selected,
  // even if Step 1 discovery was not run immediately beforehand.
  useEffect(() => {
    if (config.ocdeclareFile) {
      loadModelState(config.ocdeclareFile, discoveryConfig.eventLogFile);
    }
  }, [config.ocdeclareFile, discoveryConfig.eventLogFile, loadModelState]);

  const runOcdeclareDiscovery = async () => {
    setIsOcdeclareDiscovering(true);
    setOcdeclareDiscoveryError(null);
    setOcdeclareDiscoveryResults(null);

    try {
      const response = await axios.post('/api/discover-ocdeclare', ocdeclareDiscoveryConfig);
      
      if (response.data.success) {
        setOcdeclareDiscoveryResults(response.data);

        // Populate editor with the freshly discovered model immediately
        if (response.data.model && !Array.isArray(response.data.model)) {
          setActiveModel(response.data.model);
          // Freshly discovered model → not yet edited by the user.
          setModelEdited(false);
        }
        
        // Populate activities + ranked start candidates from the discovered model
        const modelActivities = (response.data.model?.activities || []).map(a => a.name);
        const ranked = response.data.start_activities_ranked || [];
        setStartActivityCandidates(ranked.length > 0
          ? ranked
          : modelActivities.map(a => ({ activity: a, count: null, pct: null }))
        );
        const topStart = ranked[0]?.activity || modelActivities[0];
        if (modelActivities.length > 0) {
          setAvailableActivities(modelActivities);
          setConfig(prev => ({ ...prev, startActivities: topStart ? [topStart] : [] }));
        }

        // Reload available files (preserve current selections to avoid overwrite)
        await loadAvailableFiles({ preserveSelections: true });
        
        // Select the newly discovered model in the simulation config
        if (response.data.filename) {
          setConfig(prev => ({ ...prev, ocdeclareFile: response.data.filename }));
        }

        // Automatically run probability discovery on the same event log so the
        // simulation can proceed without requiring the user to run Step 1 manually.
        try {
          const discResponse = await axios.post('/api/discover', {
            eventLogFile: ocdeclareDiscoveryConfig.eventLogFile
          });
          if (discResponse.data.success) {
            setDiscoveryResults(discResponse.data.results);
            setDiscoveryLogs(discResponse.data.logs || []);
            // Update available activities from prob-discovery result;
            // only reset start selection if we don't already have ranked candidates
            const discActivities = discResponse.data.results.activities || [];
            if (discActivities.length > 0) {
              setAvailableActivities(discActivities);
            }
            if (startActivityCandidates.length === 0) {
              const firstActivity = discResponse.data.results.first_activity || discActivities[0];
              if (firstActivity) {
                setConfig(prev => ({ ...prev, startActivities: [firstActivity] }));
              }
            }
            // Sync the Step 1 event log selector to match
            setDiscoveryConfig(prev => ({
              ...prev,
              eventLogFile: ocdeclareDiscoveryConfig.eventLogFile
            }));
            // Load normalised probability matrix for the new model file
            if (response.data.filename) {
              loadModelState(response.data.filename, ocdeclareDiscoveryConfig.eventLogFile);
            }
          } else {
            setOcdeclareDiscoveryError(
              `OC-Declare model was discovered, but automatic parameter discovery failed: ${discResponse.data.error || 'Unknown error'}. Please run Step 1 manually with the same event log to unlock simulation.`
            );
          }
        } catch (discErr) {
          const reason = discErr.response?.data?.error || discErr.message || 'Unknown error';
          setOcdeclareDiscoveryError(
            `OC-Declare model was discovered, but automatic parameter discovery failed: ${reason}. Please run Step 1 manually with the same event log to unlock simulation.`
          );
        }
      } else {
        setOcdeclareDiscoveryError(response.data.error || 'OC-Declare discovery failed');
      }
    } catch (err) {
      setOcdeclareDiscoveryError(err.response?.data?.error || err.message || 'Failed to run OC-Declare discovery');
      console.error('OC-Declare discovery error:', err);
    } finally {
      setIsOcdeclareDiscovering(false);
    }
  };

  const handleConfigChange = (field, value) => {
    setConfig(prev => ({ ...prev, [field]: value }));
    if (field === 'ocdeclareFile' && value) {
      loadModelState(value, discoveryConfig.eventLogFile);
    }
  };

  const runTimingDiscovery = async () => {
    setIsDiscoveringTiming(true);
    setTimingError(null);
    setTimingDiscoveryResult(null);
    try {
      const anchors = Object.entries(timingAnchors)
        .filter(([, v]) => v.mean_seconds)
        .map(([name, v]) => ({ name, ...v }));
      const resp = await axios.post('/api/discover-timing', {
        eventLogFile: discoveryConfig.eventLogFile,
        anchorActivities: anchors,
      });
      const metrics = resp.data.metrics || {};
      setTimingDiscoveryResult(metrics);
      setTimingDiscoveryFile(discoveryConfig.eventLogFile);

      if (Object.keys(metrics).length === 0) {
        setTimingError(
          'No timing metrics were discovered. The event log may lack timestamps, or activity names ' +
          'in the model do not match those in the log. Make sure the selected event log matches the model.'
        );
        return;
      }

      // Merge into activeModel.activity_durations so the Timing tab is pre-filled.
      // Match metric keys (from the log) to model activity names case-insensitively
      // so minor casing differences still populate the editor.
      if (activeModel && !Array.isArray(activeModel)) {
        const existing = activeModel.activity_durations || {};
        const modelActs = (activeModel.activities || []).map(a => a.name);
        const lowerToModel = {};
        modelActs.forEach(n => { lowerToModel[n.toLowerCase()] = n; });

        const merged = { ...existing };
        Object.entries(metrics).forEach(([metricKey, val]) => {
          // Prefer exact model-name match; else case-insensitive; else keep metric key
          const targetName = modelActs.includes(metricKey)
            ? metricKey
            : (lowerToModel[metricKey.toLowerCase()] || metricKey);
          // User-edited entries take priority — don't clobber existing
          if (!(targetName in existing)) merged[targetName] = val;
        });
        setActiveModel(prev => ({ ...prev, activity_durations: merged }));
      }
    } catch (e) {
      setTimingError(e.response?.data?.error || e.message);
    } finally {
      setIsDiscoveringTiming(false);
    }
  };

  const stopSimulation = useCallback(async () => {
    if (!activeRunId) return;
    try { await axios.post(`/api/simulate/stop/${activeRunId}`); } catch {}
  }, [activeRunId]);

  const runSimulation = async () => {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setIsSimulating(true);
    setLiveStepCount(0);
    setActiveRunId(runId);
    setError(null);
    setResults(null);
    setLogs([]);
    setIterationLogs([]);
    setIterationLogsOpen(false);

    // Start polling the live step counter every second
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(async () => {
      try {
        const r = await axios.get(`/api/simulate/status/${runId}`);
        setLiveStepCount(r.data.step_count ?? 0);
        if (r.data.done) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      } catch {}
    }, 1000);

    try {
      const simulationData = {
        ...config,
        runId,
        eventLogFile: discoveryConfig.eventLogFile,
        // Send editor overrides so the server uses the edited model/probs
        ...(activeModel      ? { modelOverride:       activeModel }      : {}),
        ...(activeProbMatrix ? { probMatrixOverride: activeProbMatrix } : {}),
      };

      const response = await axios.post('/api/simulate', simulationData);

      setResults(response.data.results);
      setLogs(response.data.logs || []);
      setIterationLogs(response.data.iteration_logs || []);

      // Push a snapshot to session history for replay
      if (response.data.success !== false) {
        setSessionHistory(prev => [...prev, {
          id:           Date.now(),
          timestamp:    new Date().toISOString(),
          label:        `Run #${prev.length + 1} — ${config.ocdeclareFile || 'edited model'}`,
          model:        activeModel      ? JSON.parse(JSON.stringify(activeModel))      : null,
          probMatrix:   activeProbMatrix ? JSON.parse(JSON.stringify(activeProbMatrix)) : null,
          config:       { ...config },
          stepsExecuted: response.data.results?.steps_executed,
          edited:        modelEdited,
        }]);
        // Refresh persisted run history
        axios.get('/api/run-history').then(r => setRunHistory(r.data.runs || [])).catch(() => {});
      }

      if (response.data.error) {
        setError(response.data.error);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Simulation failed. Check console for details.');
      console.error('Simulation error:', err);
    } finally {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
      setIsSimulating(false);
      setActiveRunId(null);
    }
  };

  const runHealthCheck = async () => {
    setIsCheckingHealth(true);
    setHealthResult(null);
    try {
      const payload = {
        ...config,
        eventLogFile: discoveryConfig.eventLogFile,
        ...(activeModel ? { modelOverride: activeModel } : {}),
      };
      const res = await axios.post('/api/constraint-health', payload);
      setHealthResult(res.data);
    } catch (err) {
      setHealthResult({ error: err.response?.data?.error || 'Health check failed.' });
    } finally {
      setIsCheckingHealth(false);
    }
  };

  const restoreFromHistory = useCallback((entry) => {
    if (entry.model)      setActiveModel(entry.model);
    if (entry.probMatrix) setActiveProbMatrix(entry.probMatrix);
    setConfig(prev => ({ ...prev, ...entry.config }));
    setModelEdited(entry.edited || false);
  }, []);

  const loadRunMetrics = useCallback(async (runId) => {
    if (runMetrics[runId]) {
      // toggle off if already loaded
      setExpandedRunId(prev => prev === runId ? null : runId);
      return;
    }
    try {
      const r = await axios.get(`/api/run-history/${encodeURIComponent(runId)}/metrics`);
      setRunMetrics(prev => ({ ...prev, [runId]: r.data }));
      setExpandedRunId(runId);
    } catch {
      setExpandedRunId(prev => prev === runId ? null : runId);
    }
  }, [runMetrics]);

  const reRunFromHistory = useCallback((entry) => {
    // Restore config from the persisted entry and trigger simulation
    if (entry.ocdeclare_file && entry.ocdeclare_file !== '(editor override)') {
      setConfig(prev => ({
        ...prev,
        ocdeclareFile:   entry.ocdeclare_file,
        maxSteps:        entry.max_steps,
        seed:            entry.seed,
        startActivities: entry.start_activities || [],
      }));
    }
    if (entry.model_override)      setActiveModel(entry.model_override);
    if (entry.prob_matrix_override) setActiveProbMatrix(entry.prob_matrix_override);
  }, []);

  // Wraps setActiveModel so any change made through the Model Editor flags the
  // model as user-edited (timing auto-discovery uses setActiveModel directly and
  // therefore does NOT mark the model as custom).
  const handleModelEdit = useCallback((updatedModel) => {
    setActiveModel(updatedModel);
    setModelEdited(true);
  }, []);

  // Load a saved parameter file (from IO/input/parameters) into the editor.
  const handleLoadParameters = useCallback(async (filename) => {
    if (!filename) return;
    try {
      const res = await axios.get(`/api/parameters/${encodeURIComponent(filename)}`);
      if (res.data.success && res.data.model && !Array.isArray(res.data.model)) {
        setActiveModel(res.data.model);
        if (res.data.probMatrix && Object.keys(res.data.probMatrix).length > 0) {
          setActiveProbMatrix(res.data.probMatrix);
        }
        // Loaded custom parameters → treat as user-edited so they take effect.
        setModelEdited(true);
      }
    } catch (err) {
      console.error('Could not load parameters:', err.response?.data?.error || err.message);
      alert(`Failed to load parameters: ${err.response?.data?.error || err.message}`);
    }
  }, []);

  // Persist the editor's current parameters into IO/input/parameters so they
  // appear in the "Load parameters" list and survive a reload.
  const handleSaveParameters = useCallback(async (filename, params) => {
    try {
      const res = await axios.post('/api/save-parameters', { filename, params });
      if (res.data.success) {
        await loadAvailableFiles({ preserveSelections: true });
        return res.data.filename;
      }
    } catch (err) {
      console.error('Could not save parameters:', err.response?.data?.error || err.message);
    }
    return null;
  }, []);

  // ── Automated post-processing helpers ─────────────────────────────────────

  // Parse a constraint label like "chain_response(A→B) each T nmin=1"
  // back into its components for matching against activeModel.constraints.
  const parseConstraintLabel = (label) => {
    if (!label) return null;
    const typeMatch = label.match(/^([a-z_]+)\(/);
    const actMatch  = label.match(/\(([^→)]+)→([^)]+)\)/);
    const scopeMatch = label.match(/each\s+(\S+)/);
    if (!typeMatch || !actMatch) return null;
    return {
      constraint_type: typeMatch[1],
      source_activity: actMatch[1].trim(),
      target_activity: actMatch[2].trim(),
      scope_type:      scopeMatch ? scopeMatch[1] : null,
    };
  };

  // Find a constraint in the model matching parsed label fields.
  const findConstraint = (model, parsed) => {
    if (!parsed || !model?.constraints) return null;
    return model.constraints.find(c =>
      c.constraint_type === parsed.constraint_type &&
      (c.source_activity || c.source) === parsed.source_activity &&
      (c.target_activity || c.target) === parsed.target_activity &&
      (!parsed.scope_type || (c.scope?.object_type || '') === parsed.scope_type)
    ) || null;
  };

  // Generate the full suggestion list from health report + config.
  // Returns [{id, type, badgeLabel, label, desc, action}]
  const generateSuggestions = (hr, model, cfg) => {
    if (!hr || !model) return [];
    const suggestions = [];
    let id = 0;

    // ── Rule 1: Cycle removal ──────────────────────────────────────────────
    const cycleConstraints = [];
    if (cfg.cycleEnabled) {
    (hr.cycles || []).forEach(cy => {
      // Each consecutive pair in the path is a constraint edge
      const path = cy.path || [];
      for (let i = 0; i < path.length - 1; i++) {
        const src = path[i], tgt = path[i + 1];
        // Find constraint in model (precedence or chain_precedence src→tgt)
        const c = model.constraints?.find(con =>
          (con.source_activity || con.source) === src &&
          (con.target_activity || con.target) === tgt &&
          ['precedence','chain_precedence'].includes(con.constraint_type)
        );
        if (c && (c.nmin || 1) <= cfg.cycleNminThreshold) {
          const alreadyAdded = cycleConstraints.some(x => x === c);
          if (!alreadyAdded) {
            cycleConstraints.push(c);
            const lbl = `${c.constraint_type}(${src}→${tgt})${c.scope?.object_type ? ' each ' + c.scope.object_type : ''} nmin=${c.nmin ?? 1}`;
            suggestions.push({
              id: id++, type: 'CYCLE',
              badgeLabel: `CYCLE nmin=${c.nmin ?? 1}`,
              label: `Remove ${lbl}`,
              desc: `Breaks cycle: ${cy.description}`,
              action: m => ({ ...m, constraints: (m.constraints || []).filter(x => x !== c) }),
            });
          }
        }
      }
    });
    // Sort cycle suggestions by nmin ascending (lowest first)
    const cycleStart = suggestions.length - cycleConstraints.length;
    suggestions.splice(cycleStart, cycleConstraints.length,
      ...suggestions.slice(cycleStart).sort((a, b) => {
        const na = parseInt(a.badgeLabel.match(/nmin=(\d+)/)?.[1] || '1');
        const nb = parseInt(b.badgeLabel.match(/nmin=(\d+)/)?.[1] || '1');
        return na - nb;
      })
    );
    } // end if cycleEnabled

    // ── Rule 2: Permanently blocked — top blocker removal ─────────────────
    (hr.permanently_blocked || []).forEach(b => {
      if (!b.top_blocker || b.top_blocker === 'never attempted') return;
      if (b.top_blocker === 'O2O_rule_violation') {
        // Handled in Rule 5
        return;
      }
      const parsed = parseConstraintLabel(b.top_blocker);
      const c = findConstraint(model, parsed);
      if (!c) return;
      suggestions.push({
        id: id++, type: 'BLOCKED',
        badgeLabel: 'BLOCKED',
        label: `Remove ${b.top_blocker}`,
        desc: `Unblocks activity "${b.activity}"`,
        action: m => ({ ...m, constraints: (m.constraints || []).filter(x => x !== c) }),
      });
      if ((c.nmin || 1) > 0) {
        suggestions.push({
          id: id++, type: 'BLOCKED',
          badgeLabel: 'BLOCKED→soft',
          label: `Soften to nmin=0: ${b.top_blocker}`,
          desc: `Makes "${b.activity}" optional (nmin=0) instead of removing`,
          action: m => ({ ...m, constraints: (m.constraints || []).map(x => x === c ? { ...x, nmin: 0 } : x) }),
        });
      }
    });

    // ── Rule 3: Weak precedences ──────────────────────────────────────────
    if (cfg.weakEnabled) {
      (hr.weak_precedences || []).forEach(wp => {
        if (wp.co_occurrence_pct >= cfg.weakThreshold) return;
        const c = model.constraints?.find(con =>
          con.constraint_type === 'precedence' &&
          (con.source_activity || con.source) === wp.source &&
          (con.target_activity || con.target) === wp.target &&
          (con.scope?.object_type || '') === (wp.scope_type || '')
        );
        if (!c) return;
        const lbl = `precedence(${wp.source}→${wp.target}) each ${wp.scope_type}`;
        suggestions.push({
          id: id++, type: 'WEAK',
          badgeLabel: `WEAK ${wp.co_occurrence_pct.toFixed(1)}%`,
          label: `Remove ${lbl}`,
          desc: `Only ${wp.co_occurrence_pct.toFixed(1)}% of ${wp.scope_type} traces contain both activities (threshold: ${cfg.weakThreshold}%)`,
          action: m => ({ ...m, constraints: (m.constraints || []).filter(x => x !== c) }),
        });
        suggestions.push({
          id: id++, type: 'WEAK',
          badgeLabel: `WEAK→soft`,
          label: `Soften to nmin=0: ${lbl}`,
          desc: `Makes the constraint optional — won't block if source hasn't fired`,
          action: m => ({ ...m, constraints: (m.constraints || []).map(x => x === c ? { ...x, nmin: 0 } : x) }),
        });
      });
    }

    // ── Rule 4: Chain constraint downgrade ───────────────────────────────
    if (cfg.chainEnabled) {
      (hr.top_blocking_constraints || []).filter(tc => tc.is_chain && tc.count >= cfg.chainBlockThreshold).forEach(tc => {
        const parsed = parseConstraintLabel(tc.label);
        const c = findConstraint(model, parsed);
        if (!c) return;
        const downgraded = c.constraint_type === 'chain_precedence' ? 'precedence' : 'response';
        suggestions.push({
          id: id++, type: 'CHAIN',
          badgeLabel: `CHAIN ${tc.count}×`,
          label: `Downgrade ${c.constraint_type}(${parsed.source_activity}→${parsed.target_activity}) → ${downgraded}`,
          desc: `Blocked ${tc.count} times. Affects: ${tc.blocks.join(', ')}`,
          action: m => ({ ...m, constraints: (m.constraints || []).map(x => x === c ? { ...x, constraint_type: downgraded } : x) }),
        });
      });
    }

    // ── Rule 5: O2O max_links relaxation ─────────────────────────────────
    if (cfg.o2oEnabled) {
      // Collect activities that were blocked by O2O violations —
      // either as top_blocker on permanently_blocked entries,
      // or as an entry in top_blocking_constraints with label "O2O_rule_violation".
      const o2oBlockedActivities = new Set();
      (hr.permanently_blocked || []).forEach(b => {
        if (b.top_blocker === 'O2O_rule_violation') o2oBlockedActivities.add(b.activity);
      });
      (hr.top_blocking_constraints || []).forEach(tc => {
        if (tc.label === 'O2O_rule_violation') {
          (tc.blocks || []).forEach(act => o2oBlockedActivities.add(act));
        }
      });

      const seenRules = new Set();
      o2oBlockedActivities.forEach(actName => {
        const act = model.activities?.find(a => a.name === actName);
        if (!act) return;
        const boundTypes = new Set((act.bindings || []).map(bd => bd.object_type));
        (model.o2o_rules || []).forEach(rule => {
          if (!boundTypes.has(rule.source_type) && !boundTypes.has(rule.target_type)) return;
          if (rule.max_links === null || rule.max_links === undefined) return;
          const ruleKey = `${rule.source_type}↔${rule.target_type}`;
          if (seenRules.has(ruleKey)) return;
          seenRules.add(ruleKey);
          const newMax = rule.max_links * 2;
          suggestions.push({
            id: id++, type: 'O2O',
            badgeLabel: `O2O max=${rule.max_links}`,
            label: `Increase ${ruleKey} max_links: ${rule.max_links} → ${newMax}`,
            desc: `O2O cap was blocking "${actName}"`,
            action: m => ({ ...m, o2o_rules: (m.o2o_rules || []).map(r => r === rule ? { ...r, max_links: newMax } : r) }),
          });
          suggestions.push({
            id: id++, type: 'O2O',
            badgeLabel: `O2O→∞`,
            label: `Remove cap: ${ruleKey} max_links → unlimited`,
            desc: `Removes the O2O link limit entirely`,
            action: m => ({ ...m, o2o_rules: (m.o2o_rules || []).map(r => r === rule ? { ...r, max_links: null } : r) }),
          });
        });
      });
    } // end if o2oEnabled

    // ── Rule 6: nmax cap suggestions ─────────────────────────────────────
    // If a blocked activity has a response(A→B) nmax constraint and it was
    // rejected because the cap was reached, suggest raising or removing nmax.
    if (cfg.nmaxEnabled) {
      (hr.permanently_blocked || []).forEach(b => {
        const parsed = parseConstraintLabel(b.top_blocker);
        if (!parsed) return;
        const c = findConstraint(model, parsed);
        if (!c || c.nmax === null || c.nmax === undefined) return;
        if (c.constraint_type !== 'response' && c.constraint_type !== 'precedence') return;
        const newMax = (c.nmax || 1) * 2;
        suggestions.push({
          id: id++, type: 'NMAX',
          badgeLabel: `NMAX cap=${c.nmax}`,
          label: `Raise nmax: ${b.top_blocker} → nmax=${newMax}`,
          desc: `"${b.activity}" was blocked because the nmax cap was reached`,
          action: m => ({ ...m, constraints: (m.constraints || []).map(x => x === c ? { ...x, nmax: newMax } : x) }),
        });
        suggestions.push({
          id: id++, type: 'NMAX',
          badgeLabel: `NMAX→∞`,
          label: `Remove nmax cap: ${b.top_blocker}`,
          desc: `Removes the upper bound entirely`,
          action: m => ({ ...m, constraints: (m.constraints || []).map(x => x === c ? { ...x, nmax: null } : x) }),
        });
      });
    }

    // ── Rule 7: Missing creates=True ─────────────────────────────────────
    // Activities listed as "never attempted" (block_count=0) likely have a
    // binding to an object type that nothing ever creates.
    if (cfg.createsMissingEnabled) {
      const creatingTypes = new Set();
      (model.activities || []).forEach(a => {
        (a.bindings || []).forEach(b => { if (b.creates) creatingTypes.add(b.object_type); });
      });
      (model.activities || []).forEach(a => {
        if (a.name === (model.start_activities || []).find(x => x === a.name)) return;
        (a.bindings || []).forEach(b => {
          if (!b.creates && !creatingTypes.has(b.object_type)) {
            // Check if this activity is permanently blocked with "never attempted"
            const blocked = (hr.permanently_blocked || []).find(pb =>
              pb.activity === a.name && pb.top_blocker === 'never attempted'
            );
            if (!blocked) return;
            suggestions.push({
              id: id++, type: 'CREATES',
              badgeLabel: 'CREATES',
              label: `Set creates=true on ${a.name} binding for ${b.object_type}`,
              desc: `No activity currently creates ${b.object_type} — "${a.name}" never enters the candidate pool`,
              action: m => ({
                ...m,
                activities: (m.activities || []).map(act => act.name !== a.name ? act : {
                  ...act,
                  bindings: (act.bindings || []).map(bd =>
                    bd.object_type === b.object_type ? { ...bd, creates: true } : bd
                  ),
                }),
              }),
            });
          }
        });
      });
    }

    // ── Rule 8: Start activity recommendation ────────────────────────────
    // If the permanently_blocked list includes ALL activities (empty pool at
    // step 0), the start activities are likely misconfigured.
    if (cfg.startRecEnabled) {
      const allBlocked = (hr.permanently_blocked || []).map(b => b.activity);
      const allActNames = (model.activities || []).map(a => a.name);
      const allBlockedSet = new Set(allBlocked);
      const everythingBlocked = allActNames.length > 0 &&
        allActNames.every(n => allBlockedSet.has(n));
      if (everythingBlocked) {
        // Find activities that have creates=True bindings — these are natural starts
        const naturalStarts = (model.activities || []).filter(a =>
          (a.bindings || []).some(b => b.creates)
        );
        if (naturalStarts.length > 0) {
          suggestions.push({
            id: id++, type: 'START',
            badgeLabel: 'START',
            label: `Tip: set start activities to ${naturalStarts.map(a => a.name).join(', ')}`,
            desc: `All activities were blocked — the simulation has no entry point. These activities create objects and are natural candidates for start activities. Set them in the Run Simulation section.`,
            action: m => m, // no model change — this is informational
          });
        }
      }
    }

    // ── Rule 9: Redundant constraint detection ───────────────────────────
    // A constraint C1 is redundant if a stronger constraint C2 already implies it.
    // Specifically: if chain_precedence(A→B) exists, precedence(A→B) same scope is redundant.
    // If chain_response(A→B) exists, response(A→B) same scope is redundant.
    if (cfg.redundantEnabled) {
      const constraints = model.constraints || [];
      constraints.forEach(c1 => {
        let strongerType = null;
        if (c1.constraint_type === 'precedence') strongerType = 'chain_precedence';
        else if (c1.constraint_type === 'response') strongerType = 'chain_response';
        if (!strongerType) return;
        const stronger = constraints.find(c2 =>
          c2.constraint_type === strongerType &&
          (c2.source_activity || c2.source) === (c1.source_activity || c1.source) &&
          (c2.target_activity || c2.target) === (c1.target_activity || c1.target) &&
          (c2.scope?.object_type || '') === (c1.scope?.object_type || '')
        );
        if (!stronger) return;
        const lbl = `${c1.constraint_type}(${c1.source_activity || c1.source}→${c1.target_activity || c1.target})${c1.scope?.object_type ? ' each ' + c1.scope.object_type : ''}`;
        suggestions.push({
          id: id++, type: 'REDUNDANT',
          badgeLabel: 'REDUNDANT',
          label: `Remove redundant ${lbl}`,
          desc: `Already implied by ${stronger.constraint_type}(…) with the same scope`,
          action: m => ({ ...m, constraints: (m.constraints || []).filter(x => x !== c1) }),
        });
      });
    }

    // ── Rule 10: Add constraint for unconstrained activities ──────────────
    // Non-start activities with no input constraints (no constraint where they
    // are the target) can fire freely. Flag them; user picks a predecessor.
    // The actual action requires the user to select a predecessor in the UI,
    // so we store type='ADD_CONSTRAINT' and the action is set later via
    // autoConstraintPreds state in the component.
    if (cfg.unconstrainedEnabled) {
      // A true "start activity" is one that ONLY creates objects and has no input bindings.
      // Activities with both creates=true and creates=false bindings are mid-process
      // and should still be checked for missing input constraints.
      const startActNames = new Set(
        (model.activities || [])
          .filter(a => (a.bindings || []).length > 0 && (a.bindings || []).every(b => b.creates))
          .map(a => a.name)
      );
      const hasIncoming = new Set((model.constraints || []).map(c => c.target_activity || c.target));
      (model.activities || []).forEach(a => {
        if (startActNames.has(a.name)) return;
        if (hasIncoming.has(a.name)) return;
        const scopeType = (a.bindings || []).find(b => !b.creates)?.object_type || '';
        suggestions.push({
          id: id++, type: 'ADD_CONSTRAINT',
          badgeLabel: 'NO INPUT',
          label: `"${a.name}" has no input constraints`,
          desc: `Select a predecessor activity to auto-create precedence + response constraints`,
          targetActivity: a.name,
          scopeType,
          // action is a factory — takes predActivity string and returns the actual action
          actionFactory: (predActivity) => (m) => {
            if (!predActivity) return m;
            const newConstraints = [
              ...m.constraints,
              { constraint_type: 'precedence', source_activity: predActivity, target_activity: a.name,
                scope: { kind: scopeType ? 'each' : 'global', object_type: scopeType }, nmin: 1, nmax: null },
              { constraint_type: 'response',   source_activity: predActivity, target_activity: a.name,
                scope: { kind: scopeType ? 'each' : 'global', object_type: scopeType }, nmin: 0, nmax: null },
            ];
            return { ...m, constraints: newConstraints };
          },
          action: m => m, // placeholder until user picks predecessor
        });
      });
    }

    // ── Rule 11: Activities with no non-creating object binding ────────────
    // An activity that only creates objects (or has no bindings at all) never
    // reads/consumes an existing object — it can fire without any inflow.
    // Suggest adding a binding to an object type that is deactivated elsewhere
    // (meaning it travels through the process and could naturally arrive here).
    // The user picks which object type to bind; we also add a precedence from
    // the type's creator activity so the object exists before it arrives here.
    if (cfg.noInputBindingEnabled) {
      // Collect types that are deactivated somewhere in the model
      const deactivatedTypes = new Set();
      const typeCreatorActivity = {}; // type → activity name that creates it (last creator wins)
      (model.activities || []).forEach(a => {
        (a.bindings || []).forEach(b => {
          if (b.deactivates) deactivatedTypes.add(b.object_type);
          if (b.creates)     typeCreatorActivity[b.object_type] = a.name;
        });
      });

      (model.activities || []).forEach(a => {
        const nonCreatingBindings = (a.bindings || []).filter(b => !b.creates);
        if (nonCreatingBindings.length > 0) return; // already has input bindings
        // Skip pure-creator activities (only creates bindings) if they also have constraints targeting them
        const hasIncoming = (model.constraints || []).some(
          c => (c.target_activity || c.target) === a.name
        );
        // Candidate types: deactivated types not already bound to this activity
        const alreadyBound = new Set((a.bindings || []).map(b => b.object_type));
        const candidateTypes = [...deactivatedTypes].filter(t => !alreadyBound.has(t));
        if (candidateTypes.length === 0) return;

        suggestions.push({
          id: id++, type: 'ADD_BINDING',
          badgeLabel: 'NO INPUT',
          label: `"${a.name}" has no input object binding`,
          desc: `Add a non-creating binding so the activity receives an object. Choose an object type whose lifecycle flows through this activity.`,
          targetActivity: a.name,
          candidateTypes,
          typeCreatorActivity,
          // actionFactory takes the chosen objectType and returns model → model
          actionFactory: (objectType) => (m) => {
            if (!objectType) return m;
            // Add binding (min=1, max=1, no creates/deactivates)
            const updatedActivities = m.activities.map(act => {
              if (act.name !== a.name) return act;
              const newBinding = { object_type: objectType, min_count: 1, max_count: 1, creates: false, deactivates: false };
              return { ...act, bindings: [...(act.bindings || []), newBinding] };
            });
            // Add precedence from creator activity if one exists and isn't already there
            const creatorAct = typeCreatorActivity[objectType];
            let updatedConstraints = m.constraints || [];
            if (creatorAct && creatorAct !== a.name) {
              const alreadyLinked = updatedConstraints.some(
                c => c.source_activity === creatorAct && (c.target_activity || c.target) === a.name
              );
              if (!alreadyLinked) {
                updatedConstraints = [...updatedConstraints, {
                  constraint_type: 'precedence',
                  source_activity: creatorAct,
                  target_activity: a.name,
                  scope: { kind: 'each', object_type: objectType },
                  nmin: 1, nmax: null,
                }];
              }
            }
            return { ...m, activities: updatedActivities, constraints: updatedConstraints };
          },
          action: m => m,
        });
      });
    }

    return suggestions;
  };

  const downloadEventLog = () => {
    if (!results?.output_file) return;
    window.open(`/api/download/${results.output_file}`, '_blank');
  };

  const downloadMetrics = () => {
    if (!results?.metrics_file) return;
    window.open(`/api/download-metrics/${results.metrics_file}`, '_blank');
  };

  // ── Format seconds into a human-readable string ────────────────────────────
  const fmtSeconds = (s) => {
    if (s == null) return '—';
    if (s < 60) return `${s.toFixed(1)}s`;
    if (s < 3600) return `${(s / 60).toFixed(1)}min`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
  };

  return (
    <div className="app">
      <WorkflowTopBar
        discoveryConfig={discoveryConfig}
        config={config}
        discoveryResults={discoveryResults}
        ocdeclareDiscoveryResults={ocdeclareDiscoveryResults}
        activeModel={activeModel}
        modelEdited={modelEdited}
        timingDiscoveryResult={timingDiscoveryResult}
        results={results}
        workflowMode={workflowMode}
      />

      <header className="header">
        <h1>Declarative OC Simulator</h1>
        <p>Object-centric declarative process simulation</p>
      </header>

      {/* ── Mode selector ── */}
      {!workflowMode && (
        <div className="mode-selector">
          <h2 className="mode-selector-title">Choose your workflow</h2>
          <div className="mode-cards">
            <div className="mode-card" onClick={() => setWorkflowMode('internal')}>
              <div className="mode-card-icon">🔍</div>
              <div className="mode-card-label">Internal Discovery</div>
              <div className="mode-card-desc">Load an OCEL log and discover everything — constraints, probabilities, and timing — from scratch.</div>
            </div>
            <div className="mode-card" onClick={() => setWorkflowMode('external-ocel')}>
              <div className="mode-card-icon">📂</div>
              <div className="mode-card-label">External OC-Declare + OCEL</div>
              <div className="mode-card-desc">Bring your own OC-Declare constraint file and an OCEL log for parameter discovery.</div>
            </div>
            <div className="mode-card" onClick={() => setWorkflowMode('external-empty')}>
              <div className="mode-card-icon">✏️</div>
              <div className="mode-card-label">Manual / No Files</div>
              <div className="mode-card-desc">Build the model entirely in the editor. Discovery features unavailable without an OCEL log.</div>
            </div>
          </div>
          {/* Small link to switch later */}
          <p className="mode-selector-hint">You can change mode at any time using the button below.</p>
        </div>
      )}

      {workflowMode && (
        <div className="mode-switch-bar">
          <span className="mode-current-label">
            Mode: <strong>{workflowMode === 'internal' ? 'Internal Discovery' : workflowMode === 'external-ocel' ? 'External OC-Declare + OCEL' : 'Manual / No Files'}</strong>
          </span>
          <button className="mode-switch-btn" onClick={() => setWorkflowMode(null)}>
            ↩ Change mode
          </button>
        </div>
      )}

      <div className="workflow-container" style={!workflowMode ? {display:'none'} : {}}>
        {/* ── STEP 1: Parameter Discovery (internal + external-ocel modes) ── */}
        {(workflowMode === 'internal' || workflowMode === 'external-ocel') && (
        <div className="discovery-section">
          <div className="section-header">
            <h2>Step 1: Parameter Discovery</h2>
            <p>Discover transition probabilities and time distributions from event log</p>
          </div>

          <div className="discovery-config">
            <div className="form-group">
              <label>Event Log File</label>
              <select 
                value={discoveryConfig.eventLogFile}
                onChange={(e) => handleDiscoveryConfigChange('eventLogFile', e.target.value)}
                disabled={isDiscovering}
              >
                <option value="">Select event log...</option>
                {eventLogFiles.map(file => (
                  <option key={file} value={file}>{file}</option>
                ))}
              </select>
            </div>

            <button 
              className="discovery-button"
              onClick={runDiscovery}
              disabled={isDiscovering || !discoveryConfig.eventLogFile}
            >
              {isDiscovering ? 'Discovering...' : 'Run Discovery'}
            </button>
          </div>

          {/* Discovery Results */}
          {discoveryError && (
            <div className="error-box">
              <h3>Discovery Error</h3>
              <p>{discoveryError}</p>
            </div>
          )}

          {isDiscovering && (
            <div className="loading-box">
              <div className="spinner"></div>
              <p>Running parameter discovery...</p>
            </div>
          )}

          {discoveryResults && !isDiscovering && (
            <div className="discovery-results">
              <h3>Discovery Complete</h3>
              
              <div className="stat-grid">
                <div className="stat-card">
                  <div className="stat-value">{discoveryResults.activity_count}</div>
                  <div className="stat-label">Activities Found</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{discoveryResults.total_events}</div>
                  <div className="stat-label">Events Analyzed</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{discoveryResults.transition_count}</div>
                  <div className="stat-label">Transitions</div>
                </div>
              </div>

              {discoveryResults.activities && discoveryResults.activities.length > 0 && (
                <Collapsible
                  className="activities-list"
                  title="Discovered Activities"
                  badge={discoveryResults.activities.length}
                >
                  {discoveryResults.activity_counts
                    ? (
                      <>
                      {discoveryResults.activity_nmax_suggestions && Object.keys(discoveryResults.activity_nmax_suggestions).length > 0 && (
                        <div className="nmax-hint-bar">
                          <span>Suggested <code>max consec/obj</code> values from log (p95 repeats per object).</span>
                          <button
                            className="nmax-apply-btn"
                            title="Apply all p95 suggestions as max_consecutive_per_object in the Model Editor"
                            onClick={() => {
                              if (!activeModel || Array.isArray(activeModel)) return;
                              const suggestions = discoveryResults.activity_nmax_suggestions;
                              const cur = activeModel.max_consecutive_per_object || {};
                              const updated = { ...cur };
                              Object.entries(suggestions).forEach(([act, s]) => {
                                if (s.suggested > 1) updated[act] = s.suggested;
                              });
                              handleModelEdit({ ...activeModel, max_consecutive_per_object: updated });
                            }}
                          >
                            ⬆ Apply all to Model Editor
                          </button>
                        </div>
                      )}
                      <table className="activity-count-table">
                        <thead>
                          <tr>
                            <th>Activity</th>
                            <th>Occurrences</th>
                            {discoveryResults.trace_end_prob && <th title="Probability this activity is last in an object trace (higher = more likely end)">P(end)</th>}
                            {discoveryResults.activity_consec_stats && (
                              <>
                                <th title="Shortest consecutive run of this activity in the log">Min consec</th>
                                <th title="Average consecutive run length in the log — use as guide for max consecutive setting">Mean consec</th>
                                <th title="Longest consecutive run of this activity in the log">Max consec</th>
                              </>
                            )}
                            {discoveryResults.activity_repeat_stats && (
                              <>
                                <th title="Fewest times this activity fired on a single object">Min /obj</th>
                                <th title="Average times this activity fired per object">Mean /obj</th>
                                <th title="Most times this activity fired on a single object">Max /obj</th>
                              </>
                            )}
                            {discoveryResults.activity_nmax_suggestions && (
                              <th title="Suggested max_consecutive_per_object (95th percentile repeats per object in the log). Click ⬆ to apply to the Model Editor.">Sugg. max/obj (p95)</th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {discoveryResults.activities
                            .slice()
                            .sort((a, b) => (discoveryResults.activity_counts[b] || 0) - (discoveryResults.activity_counts[a] || 0))
                            .map(activity => {
                              const cs = discoveryResults.activity_consec_stats?.[activity];
                              const rs = discoveryResults.activity_repeat_stats?.[activity];
                              const ns = discoveryResults.activity_nmax_suggestions?.[activity];
                              const isLikelyStart = discoveryResults.likely_start_activities?.slice(0,3).includes(activity);
                              const isLikelyEnd   = discoveryResults.likely_end_activities?.includes(activity);
                              const endProb       = discoveryResults.trace_end_prob?.[activity];
                              const modelConstraints = activeModel?.constraints || [];
                              const hasIn  = modelConstraints.some(c => (c.target_activity || c.target) === activity);
                              const hasOut = modelConstraints.some(c => (c.source_activity || c.source) === activity);
                              const noneAtAll = !hasIn && !hasOut;
                              const noInput   = !hasIn && hasOut;
                              return (
                                <tr key={activity} className={noneAtAll ? 'activity-row-no-constraint' : noInput ? 'activity-row-no-input' : ''}>
                                  <td>
                                    {isLikelyStart && <span className="act-marker act-marker-start" title="Likely start activity">▶</span>}
                                    {isLikelyEnd   && <span className="act-marker act-marker-end"   title={`Likely end activity — ends ${(endProb*100).toFixed(0)}% of traces it appears in`}>◼</span>}
                                    {activity}{noneAtAll ? <span className="act-no-constraint-label"> / no constraints</span> : ''}
                                  </td>
                                  <td className="activity-count-num">{discoveryResults.activity_counts[activity] ?? 0}</td>
                                  {discoveryResults.trace_end_prob && (
                                    <td className="activity-count-num">
                                      {endProb ? (
                                        <span className={`end-prob-cell ${endProb >= 0.7 ? 'high' : endProb >= 0.3 ? 'mid' : 'low'}`}>
                                          {(endProb * 100).toFixed(0)}%
                                        </span>
                                      ) : '—'}
                                    </td>
                                  )}
                                  {discoveryResults.activity_consec_stats && (
                                    <>
                                      <td className="activity-count-num">{cs ? cs.min : '—'}</td>
                                      <td className="activity-count-num">{cs ? cs.mean : '—'}</td>
                                      <td className="activity-count-num">{cs ? cs.max : '—'}</td>
                                    </>
                                  )}
                                  {discoveryResults.activity_repeat_stats && (
                                    <>
                                      <td className="activity-count-num">{rs ? rs.min : '—'}</td>
                                      <td className="activity-count-num">{rs ? rs.mean : '—'}</td>
                                      <td className="activity-count-num">{rs ? rs.max : '—'}</td>
                                    </>
                                  )}
                                  {discoveryResults.activity_nmax_suggestions && (
                                    <td className="activity-count-num">
                                      {ns && ns.suggested > 1 ? (
                                        <button
                                          className="nmax-cell-btn"
                                          title={`p50=${ns.p50}  p95=${ns.p95} — click to set in Model Editor`}
                                          onClick={() => {
                                            if (!activeModel || Array.isArray(activeModel)) return;
                                            const cur = activeModel.max_consecutive_per_object || {};
                                            handleModelEdit({ ...activeModel, max_consecutive_per_object: { ...cur, [activity]: ns.suggested } });
                                          }}
                                        >
                                          {ns.suggested}
                                        </button>
                                      ) : '—'}
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                      </>
                    )
                    : (
                      <div className="activity-badges">
                        {discoveryResults.activities.map((activity, idx) => {
                          const constraints = activeModel?.constraints || [];
                          const hasIn  = constraints.some(c => (c.target_activity || c.target) === activity);
                          const hasOut = constraints.some(c => (c.source_activity || c.source) === activity);
                          const noneAtAll = !hasIn && !hasOut;
                          const noInput   = !hasIn && hasOut;
                          return (
                            <span key={idx}
                              className={`activity-badge${noneAtAll ? ' activity-badge-no-constraint' : noInput ? ' activity-badge-no-input' : ''}`}
                              title={noneAtAll ? 'No constraints at all' : noInput ? 'No input constraints' : ''}>
                              {activity}{noneAtAll ? ' / no constraints' : ''}
                            </span>
                          );
                        })}
                      </div>
                    )
                  }
                </Collapsible>
              )}

              {discoveryResults.prob_matrix && Object.keys(discoveryResults.prob_matrix).length > 0 && (
                <Collapsible
                  title="Transition Flow Chart"
                  badge={`${Object.keys(discoveryResults.prob_matrix).length} activities`}
                  defaultOpen={false}
                  className="discovery-transition-collapsible"
                >
                  <TransitionFlowChart
                    matrix={discoveryResults.prob_matrix}
                    activityCounts={discoveryResults.activity_counts || {}}
                    startActivities={discoveryResults.likely_start_activities || config.startActivities || []}
                    traceEndProb={discoveryResults.trace_end_prob || {}}
                    likelyEndActivities={discoveryResults.likely_end_activities || []}
                    tracePosition={discoveryResults.trace_position || {}}
                  />
                </Collapsible>
              )}

              {discoveryResults.object_type_stats && Object.keys(discoveryResults.object_type_stats).length > 0 && (
                <Collapsible
                  title="Discovered Objects"
                  badge={`${Object.keys(discoveryResults.object_type_stats).length} types`}
                  defaultOpen={false}
                  className="discovery-transition-collapsible"
                >
                  <table className="object-type-stats-table">
                    <thead>
                      <tr>
                        <th>Object Type</th>
                        <th className="octs-num">Instances</th>
                        <th className="octs-num">Max reuse</th>
                        <th>Attributes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(discoveryResults.object_type_stats).map(([type, info]) => (
                        <tr key={type}>
                          <td className="octs-type">{type}</td>
                          <td className="octs-num">{info.count.toLocaleString()}</td>
                          <td className="octs-num" title={info.mean_max_reuse != null ? `Mean max reuse per object: ${info.mean_max_reuse}` : undefined}>
                            {info.max_reuse != null ? info.max_reuse : '—'}
                          </td>
                          <td className="octs-attrs">
                            {info.attributes.length > 0
                              ? info.attributes.map(a => (
                                  <span key={a} className="octs-attr-badge">{a}</span>
                                ))
                              : <span className="octs-no-attrs">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Collapsible>
              )}
            </div>
          )}

          {discoveryLogs.length > 0 && (
            <div className="logs-box">
              <h4>Discovery Logs</h4>
              <div className="logs-content">
                {discoveryLogs.map((log, idx) => (
                  <div key={idx} className="log-entry">{log}</div>
                ))}
              </div>
            </div>
          )}

        </div>

        )}

        {/* ── OC-Declare Discovery (internal only) ── */}
        {workflowMode === 'internal' && (
        <div className="ocdeclare-discovery-section">
          <div className="section-header">
            <h2>OC-Declare Model Discovery</h2>
            <p>Discover declarative constraints from OCEL 2.0 event logs</p>
          </div>

          <div className="ocdeclare-discovery-config">
            <div className="form-group">
              <label>Event Log File (OCEL 2.0)</label>
              <select 
                value={ocdeclareDiscoveryConfig.eventLogFile}
                onChange={(e) => handleOcdeclareDiscoveryConfigChange('eventLogFile', e.target.value)}
                disabled={isOcdeclareDiscovering}
              >
                <option value="">Select event log...</option>
                {eventLogFiles.map(file => (
                  <option key={file} value={file}>{file}</option>
                ))}
              </select>
            </div>

            <div className="parameters-section">
              <h4>Discovery Parameters</h4>

              {/* ── Legend ───────────────────────────────────────────────── */}
              <div className="param-legend">
                <span className="param-legend-item">
                  <strong>Support</strong>
                  <HelpTip text={'How often the activity pair must co-occur across all object instances of the scope type.\n\nHigh → fewer, more reliable constraints.\nLow → more constraints, more noise.'} />
                </span>
                <span className="param-legend-sep">·</span>
                <span className="param-legend-item">
                  <strong>Confidence</strong>
                  <HelpTip text={'Given that the activating event occurred, how often must the constraint hold?\n\nHigh → strict, clean rules.\nLow → many weak rules.'} />
                </span>
                <span className="param-legend-sep">·</span>
                <span className="param-legend-item">
                  <strong>Noise</strong>
                  <HelpTip text={'Fraction of violations tolerated as data noise. Subtracted from Confidence: effective threshold = Confidence − Noise.\n\nHigh → more constraints survive.\nLow → near-perfect compliance required.'} />
                </span>
              </div>

              {/* ── Global (non-constraint) parameters ───────────────────── */}
              <div className="form-row global-params-row">
                <div className="form-group">
                  <label>
                    Lifecycle Threshold
                    <HelpTip text={'Controls which activity is labelled as the creator or deactivator of an object type.\n\nHigh (e.g. 0.9): conservative — must almost always be first/last.\nLow (e.g. 0.2): more assignments, riskier for variant-heavy logs.\n\nDefault: 0.5'} />
                    <span className="help-text">fraction of instances to count as creates/deactivates</span>
                  </label>
                  <input
                    type="number"
                    value={ocdeclareDiscoveryConfig.lifecycleThreshold}
                    onChange={(e) => handleOcdeclareDiscoveryConfigChange('lifecycleThreshold', parseFloat(e.target.value))}
                    min="0" max="1" step="0.05"
                    disabled={isOcdeclareDiscovering}
                  />
                </div>
                <div className="form-group">
                  <label>
                    Resource Threshold
                    <HelpTip text={'Object types whose average events/instance exceeds this are treated as reusable resources and never deactivated.\n\nHigh → almost nothing classified as resource.\nLow → many types become resources.\n\nDefault: 50'} />
                    <span className="help-text">avg events/instance above which type is a resource</span>
                  </label>
                  <input
                    type="number"
                    value={ocdeclareDiscoveryConfig.resourceThreshold}
                    onChange={(e) => handleOcdeclareDiscoveryConfigChange('resourceThreshold', parseFloat(e.target.value))}
                    min="1" step="5"
                    disabled={isOcdeclareDiscovering}
                  />
                </div>
              </div>

              {/* ── Constraint types + per-type parameters ───────────────── */}
              <div className="constraint-types">
                <label>Constraint Types to Discover:</label>
                <div className="checkbox-group">
                  {[
                    { key: 'precedence',       label: 'Precedence',        tip: 'Whenever B occurs for an object, A must have occurred earlier for the same object. Enforced in simulation: B is blocked until A has fired first (requires nmin ≥ 1 in the Model Editor).' },
                    { key: 'response',         label: 'Response',          tip: 'Whenever A occurs for an object, B must eventually follow for the same object. Softly enforced in simulation; use a response constraint with n≤ in the Model Editor to cap total repetitions.' },
                    { key: 'not_coexistence',  label: 'Not Co-Existence',  tip: 'A and B never both occur on the same object. Enforced in simulation: once either fires on an object, the other is permanently blocked for that object.' },
                    { key: 'chain_precedence', label: 'Chain Precedence',  tip: 'B is always immediately preceded by A on the same object — no other event for that object may appear between A and B. Not suitable for batch/synchronising activities.' },
                    { key: 'chain_response',   label: 'Chain Response',    tip: 'Once A fires, all other activities are blocked for that object until B fires next. Strictly enforced and may cause deadlocks if B cannot be scheduled.' },
                  ].map(({ key, label, tip }) => {
                    const checked = ocdeclareDiscoveryConfig.constraintTypes[key];
                    const p = ocdeclareDiscoveryConfig.constraintParams[key] || {};
                    return (
                      <div key={key} className={`constraint-param-block${checked ? ' active' : ''}`}>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => handleConstraintTypeChange(key, e.target.checked)}
                            disabled={isOcdeclareDiscovering}
                          />
                          {label} <HelpTip text={tip} />
                        </label>
                        {checked && (
                          <div className="inline-param-row">
                            <label className="inline-param-label">
                              Support
                              <input
                                className="inline-param-input"
                                type="number" min="0" max="1" step="0.05"
                                value={p.minSupport ?? 0.7}
                                onChange={(e) => handleConstraintParamChange(key, 'minSupport', parseFloat(e.target.value))}
                                disabled={isOcdeclareDiscovering}
                              />
                            </label>
                            <label className="inline-param-label">
                              Confidence
                              <input
                                className="inline-param-input"
                                type="number" min="0" max="1" step="0.05"
                                value={p.minConfidence ?? 0.85}
                                onChange={(e) => handleConstraintParamChange(key, 'minConfidence', parseFloat(e.target.value))}
                                disabled={isOcdeclareDiscovering}
                              />
                            </label>
                            <label className="inline-param-label">
                              Noise
                              <input
                                className="inline-param-input"
                                type="number" min="0" max="1" step="0.05"
                                value={p.noiseThreshold ?? 0.15}
                                onChange={(e) => handleConstraintParamChange(key, 'noiseThreshold', parseFloat(e.target.value))}
                                disabled={isOcdeclareDiscovering}
                              />
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {/*
                    Hidden: Co-existence and Absence have no discovery miner or
                    simulation enforcement yet. Kept in constraintTypes state so
                    they can be re-enabled later.
                  */}
                </div>
              </div>
            </div>

            <button 
              className="discovery-button"
              onClick={runOcdeclareDiscovery}
              disabled={isOcdeclareDiscovering || !ocdeclareDiscoveryConfig.eventLogFile}
            >
              {isOcdeclareDiscovering ? 'Discovering...' : 'Discover OC-Declare Model'}
            </button>
          </div>

          {/* OC-Declare Discovery Results */}
          {ocdeclareDiscoveryError && (
            <div className="error-box">
              <h3>Discovery Error</h3>
              <p>{ocdeclareDiscoveryError}</p>
            </div>
          )}

          {isOcdeclareDiscovering && (
            <div className="loading-box">
              <div className="spinner"></div>
              <p>Discovering OC-Declare model from event log...</p>
            </div>
          )}

          {ocdeclareDiscoveryResults && !isOcdeclareDiscovering && (
            <div className="ocdeclare-discovery-results">
              <h3>Model Discovered: {ocdeclareDiscoveryResults.filename}</h3>
              
              <div className="stat-grid">
                <div className="stat-card">
                  <div className="stat-value">{ocdeclareDiscoveryResults.stats.num_object_types}</div>
                  <div className="stat-label">Object Types</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{ocdeclareDiscoveryResults.stats.num_activities}</div>
                  <div className="stat-label">Activities</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{ocdeclareDiscoveryResults.stats.num_constraints}</div>
                  <div className="stat-label">Constraints</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{ocdeclareDiscoveryResults.stats.num_o2o_rules}</div>
                  <div className="stat-label">O2O Rules</div>
                </div>
              </div>

              {ocdeclareDiscoveryResults.stats.constraint_breakdown && (
                <div className="constraint-breakdown">
                  <h4>Constraint Breakdown:</h4>
                  <ul>
                    {Object.entries(ocdeclareDiscoveryResults.stats.constraint_breakdown).map(([type, count]) => (
                      <li key={type}>
                        <span className="type-name">{type}</span>
                        <span className="type-count">{count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {ocdeclareDiscoveryResults.stats.avg_support > 0 && (
                <div className="quality-metrics">
                  <h4>Quality Metrics:</h4>
                  <p>Average Support: {(ocdeclareDiscoveryResults.stats.avg_support * 100).toFixed(1)}%</p>
                  <p>Average Confidence: {(ocdeclareDiscoveryResults.stats.avg_confidence * 100).toFixed(1)}%</p>
                </div>
              )}

              {ocdeclareDiscoveryResults.model.constraints && ocdeclareDiscoveryResults.model.constraints.length > 0 && (
                <div className="constraints-preview">
                  <h4>Discovered Constraints (showing first 10):</h4>
                  <div className="constraints-list">
                    {ocdeclareDiscoveryResults.model.constraints.slice(0, 10).map((constraint, idx) => (
                      <div key={idx} className="constraint-item">
                        <span className="constraint-type">{constraint.type}</span>
                        <span className="constraint-detail">
                          {constraint.source} → {constraint.target}
                        </span>
                        <span className="constraint-scope">
                          (scope: {constraint.scope.kind} {constraint.scope.object_type})
                        </span>
                        <span className="constraint-metrics">
                          [support: {(constraint.support * 100).toFixed(0)}%, 
                           confidence: {(constraint.confidence * 100).toFixed(0)}%]
                        </span>
                      </div>
                    ))}
                    {ocdeclareDiscoveryResults.model.constraints.length > 10 && (
                      <p className="more-notice">
                        ... and {ocdeclareDiscoveryResults.model.constraints.length - 10} more constraints
                      </p>
                    )}
                  </div>
                </div>
              )}

            </div>
          )}
        </div>

        )}

        {/* ── External empty: capability notice ── */}
        {workflowMode === 'external-empty' && (
          <div className="capability-notice">
            <strong>⚠ No OCEL log loaded — limited functionality</strong>
            <ul>
              <li>Probability discovery is <strong>not available</strong></li>
              <li>Time distribution discovery is <strong>not available</strong></li>
              <li>OC-Declare constraint discovery is <strong>not available</strong></li>
            </ul>
            <p>You can still build a model manually in the editor below.
               Load a parameters file via the Model Editor → Load parameters dropdown, or
               load an external OC-Declare file and use <em>↻ Derive lifecycle</em> to infer bindings.
               The simulation can run without discovery.</p>
          </div>
        )}

        {/* ── Model Selection ── */}
        <div className="model-selection-section">
          <div className="section-header">
            <h2>Select Model to Simulate</h2>
            <p>Choose a discovered OC-Declare model to load into the editor below</p>
          </div>
          <div className="form-group">
            <label>OC-Declare Model</label>
            <select
              value={config.ocdeclareFile}
              onChange={(e) => handleConfigChange('ocdeclareFile', e.target.value)}
              disabled={isSimulating}
            >
              <option value="">Select model...</option>
              {ocdeclareFiles.map(file => {
                const isInternal = file.startsWith('discovered_');
                return (
                  <option key={file} value={file}>
                    {isInternal ? '' : '[external] '}{file}
                  </option>
                );
              })}
            </select>
            {(() => {
              if (!config.ocdeclareFile) return null;
              const isInternal = config.ocdeclareFile.startsWith('discovered_');
              const matchesSession = discoveryResults && (
                config.ocdeclareFile === discoveryResults.ocdeclare_file ||
                config.ocdeclareFile === (ocdeclareDiscoveryResults?.filename)
              );
              if (!isInternal) {
                return (
                  <div className="ocdeclare-source-notice ocdeclare-external">
                    <span className="ocdeclare-source-badge external">external</span>
                    This file was created by an external tool. Run Step 1 with a matching event log to enable timing discovery and probability matrix. The Model Editor works immediately after loading a parameters file.
                  </div>
                );
              }
              if (!discoveryResults) {
                return (
                  <div className="ocdeclare-source-notice ocdeclare-not-discovered">
                    <span className="ocdeclare-source-badge not-discovered">not discovered</span>
                    This model file exists but Step 1 has not been run in this session. Run Step 1 with a matching event log to enable probability matrix, activity stats, and timing discovery.
                  </div>
                );
              }
              return (
                <div className="ocdeclare-source-notice ocdeclare-discovered">
                  <span className="ocdeclare-source-badge discovered">✓ discovered</span>
                  Matches the current discovery session.
                </div>
              );
            })()}
          </div>

        </div>

        {/* ── Session History ── */}
        {sessionHistory.length > 0 && (
          <div className="session-history-panel">
            <h3>🕘 Session History</h3>
            <div className="history-list">
              {[...sessionHistory].reverse().map(entry => (
                <div key={entry.id} className="history-entry">
                  <span className="history-label">
                    {entry.label}
                    {entry.edited && (
                      <span className="history-edited-badge" title="This run used custom Model Editor inputs">
                        ✎ custom inputs
                      </span>
                    )}
                  </span>
                  <span className="history-meta">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                    {entry.stepsExecuted != null && ` · ${entry.stepsExecuted} steps`}
                  </span>
                  <button
                    className="history-restore-btn"
                    onClick={() => restoreFromHistory(entry)}
                    title="Restore this model + config into the editor"
                  >
                    ↩ Restore
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Post-Processing section ── */}
        <div className="post-processing-section">
          <div className="section-header">
            <h2>Post-Processing</h2>
            <p>Edit the model, review constraints, and configure simulation parameters</p>
          </div>

        {/* Model Editor */}
        {activeModel && !Array.isArray(activeModel) && (
          <div className="model-editor-row">
            <div className="model-editor-col">
              <ModelEditor
                model={activeModel}
                probMatrix={activeProbMatrix || {}}
                onModelChange={handleModelEdit}
                onProbMatrixChange={setActiveProbMatrix}
                sourceFile={config.ocdeclareFile}
                parameterFiles={parameterFiles}
                onLoadParameters={handleLoadParameters}
                onSaveParameters={handleSaveParameters}
                nmaxSuggestions={discoveryResults?.activity_nmax_suggestions || {}}
                eventLogFile={discoveryConfig.eventLogFile || ''}
              />
            </div>
            <div className="model-editor-warnings-col">
              {timingDiscoveryResult && (() => {
                const zeroMin = [], zeroMax = [];
                Object.entries(timingDiscoveryResult).forEach(([act, m]) => {
                  if (m.min_seconds === 0 || m.min_seconds == null) zeroMin.push(act);
                  if (m.max_seconds === 0 || m.max_seconds == null) zeroMax.push(act);
                });
                if (!zeroMin.length && !zeroMax.length) return null;
                return (
                  <div className="timing-warning-box">
                    <div className="timing-warning-title">
                      ⚠ Discovered time bounds
                      {timingDiscoveryFile && (
                        <span className="timing-warning-file"> for {timingDiscoveryFile}</span>
                      )}
                    </div>
                    {zeroMin.length > 0 && (
                      <div className="timing-warning-group">
                        <div className="timing-warning-label">Min = 0 s</div>
                        <ul className="timing-warning-list">
                          {zeroMin.map(a => <li key={a}>{a}</li>)}
                        </ul>
                      </div>
                    )}
                    {zeroMax.length > 0 && (
                      <div className="timing-warning-group">
                        <div className="timing-warning-label">Max = 0 / unbounded</div>
                        <ul className="timing-warning-list">
                          {zeroMax.map(a => <li key={a}>{a}</li>)}
                        </ul>
                      </div>
                    )}
                    <p className="timing-warning-hint">
                      Review these in the Model Editor → Timing tab and set explicit bounds if needed.
                    </p>
                  </div>
                );
              })()}
              {(() => {
                const actNames = (activeModel.activities || []).map(a => a.name);
                const constraints = activeModel.constraints || [];
                const hasIncoming = new Set(constraints.map(c => c.target_activity || c.target));
                const hasOutgoing = new Set(constraints.map(c => c.source_activity || c.source));
                const noIncoming   = actNames.filter(a => !hasIncoming.has(a));
                const noConstraints = actNames.filter(a => !hasIncoming.has(a) && !hasOutgoing.has(a));
                if (!noIncoming.length) return null;
                return (
                  <div className="timing-warning-box">
                    <div className="timing-warning-title">⚠ No input constraints</div>
                    <p className="timing-warning-hint" style={{ marginTop: 0, marginBottom: '0.55rem' }}>
                      These activities have no constraint where they are the target — nothing prevents them from firing repeatedly without limit.
                    </p>
                    <ul className="timing-warning-list">
                      {noIncoming.map(a => (
                        <li key={a} style={noConstraints.includes(a) ? { background: '#fee2e2', color: '#991b1b', fontWeight: 600 } : {}}>
                          {a}{noConstraints.includes(a) ? ' / no constraints' : ''}
                        </li>
                      ))}
                    </ul>
                    <p className="timing-warning-hint">
                      Add a precedence or chain_response constraint in the Constraints tab to control when each can fire.
                    </p>
                  </div>
                );
              })()}
              {(() => {
                const activities = activeModel.activities || [];
                const objectTypes = (activeModel.object_types || []).map(t => typeof t === 'string' ? t : t.name);
                const resourceTypes = new Set(activeModel.resource_types || []);

                // Types deactivated by at least one activity
                const deactivatedTypes = new Set();
                for (const act of activities) {
                  for (const b of (act.bindings || [])) {
                    if (b.deactivates || b.consumes) deactivatedTypes.add(b.object_type);
                  }
                }

                const resources = objectTypes.filter(t => resourceTypes.has(t));
                const neverDeactivated = objectTypes.filter(t => !resourceTypes.has(t) && !deactivatedTypes.has(t));

                if (!objectTypes.length) return null;
                return (
                  <div className="object-info-box">
                    <div className="object-info-title">ℹ Object Lifecycle</div>
                    {resources.length > 0 && (
                      <div className="object-info-group">
                        <div className="object-info-label">Resources (always active)</div>
                        <ul className="object-info-list">
                          {resources.map(t => <li key={t}>{t}</li>)}
                        </ul>
                      </div>
                    )}
                    {neverDeactivated.length > 0 && (
                      <div className="object-info-group">
                        <div className="object-info-label">Never deactivated</div>
                        <ul className="object-info-list">
                          {neverDeactivated.map(t => <li key={t}>{t}</li>)}
                        </ul>
                      </div>
                    )}
                    {resources.length === 0 && neverDeactivated.length === 0 && (
                      <p className="object-info-hint" style={{ marginTop: 0 }}>All object types are deactivated by at least one activity.</p>
                    )}
                    <p className="object-info-hint">
                      Never-deactivated types accumulate instances over time. Consider adding a deactivates binding in the Activities tab.
                    </p>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Timing Discovery + Lifecycle Derivation — side by side after Model Editor */}
        {(() => {
          const timingActivities = discoveryResults?.activities?.length
            ? discoveryResults.activities
            : (!Array.isArray(activeModel) ? (activeModel?.activities || []).map(a => a.name) : []);
          const showTiming = !!(discoveryConfig.eventLogFile && timingActivities.length);
          const showLifecycle = !!(config.ocdeclareFile);
          if (!showTiming && !showLifecycle) return null;
          return (
            <div className="timing-discovery-row">
              {showTiming && (
                <TimingDiscoveryPanel
                  activities={timingActivities}
                  eventLogFile={discoveryConfig.eventLogFile}
                  isDiscovering={isDiscoveringTiming}
                  result={timingDiscoveryResult}
                  error={timingError}
                  onDiscover={runTimingDiscovery}
                  timingAnchors={timingAnchors}
                  setTimingAnchors={setTimingAnchors}
                />
              )}
              {showLifecycle && (
                <LifecycleDerivationPanel
                  sourceFile={config.ocdeclareFile}
                  eventLogFile={discoveryConfig.eventLogFile}
                  activeModel={activeModel}
                  onModelChange={handleModelEdit}
                />
              )}
            </div>
          );
        })()}

        {/* ── O2O discovery — external-ocel mode only ────────────────────── */}
        {workflowMode === 'external-ocel' && discoveryConfig.eventLogFile && activeModel && !Array.isArray(activeModel) && (
          <O2ODiscoveryPanel
            eventLogFile={discoveryConfig.eventLogFile}
            activeModel={activeModel}
            onModelChange={handleModelEdit}
          />
        )}
        {discoveryResults?.activity_counts && discoveryResults.likely_start_activities?.length > 0 && activeProbMatrix && (
          (() => {
            const startCandidates = [
              ...discoveryResults.likely_start_activities,
              ...Object.keys(discoveryResults.activity_counts)
                .filter(a => !discoveryResults.likely_start_activities.includes(a))
                .sort((a, b) => (discoveryResults.activity_counts[b] || 0) - (discoveryResults.activity_counts[a] || 0)),
            ];
            const countTotal = Object.values(discoveryResults.activity_counts).reduce((s, v) => s + v, 0);
            const selected = new Set(discoveryConfig.startActivityProbSelected ?? [startCandidates[0]]);
            const toggle = (a) => {
              const next = new Set(selected);
              next.has(a) ? next.delete(a) : next.add(a);
              setDiscoveryConfig(p => ({ ...p, startActivityProbSelected: [...next] }));
            };
            return (
              <div className="start-prob-bar">
                <span className="start-prob-label">Start activity probability</span>
                <div className="start-prob-checklist">
                  {startCandidates.map((a, i) => (
                    <label key={a} className={`start-prob-check-item${selected.has(a) ? ' spc-checked' : ''}`}>
                      <input type="checkbox" checked={selected.has(a)} onChange={() => toggle(a)} />
                      {i === 0 && <span className="sa-top-badge">★</span>}
                      <span className="spc-name">{a}</span>
                      <span className="spc-pct">{((discoveryResults.activity_counts[a] || 0) / countTotal * 100).toFixed(1)}%</span>
                    </label>
                  ))}
                </div>
                <button
                  className="start-prob-btn"
                  disabled={selected.size === 0}
                  title="Inject selected activities' log frequencies as transition target probabilities from every source, preserving relative ratios between existing targets"
                  onClick={() => {
                    const counts = discoveryResults.activity_counts;
                    if (!countTotal || selected.size === 0) return;
                    // Combined probability reserved for all selected start activities
                    const combinedProb = [...selected].reduce((s, a) => s + (counts[a] || 0), 0) / countTotal;
                    // Each selected activity's share within the combined block
                    const selectedCountSum = [...selected].reduce((s, a) => s + (counts[a] || 0), 0);
                    const newMatrix = {};
                    Object.entries(activeProbMatrix).forEach(([src, targets]) => {
                      const tgts = { ...targets };
                      // Remove all selected activities from existing targets
                      selected.forEach(a => delete tgts[a]);
                      const existingSum = Object.values(tgts).reduce((s, v) => s + v, 0);
                      const scale = existingSum > 0 ? (1 - combinedProb) / existingSum : 0;
                      const scaled = {};
                      Object.entries(tgts).forEach(([t, v]) => {
                        scaled[t] = Math.round(v * scale * 10000) / 10000;
                      });
                      // Distribute combined block proportionally among selected activities
                      selected.forEach(a => {
                        const share = selectedCountSum > 0
                          ? combinedProb * (counts[a] || 0) / selectedCountSum
                          : combinedProb / selected.size;
                        scaled[a] = Math.round(share * 10000) / 10000;
                      });
                      newMatrix[src] = scaled;
                    });
                    setActiveProbMatrix(newMatrix);
                  }}
                >
                  Apply to probability matrix
                </button>
              </div>
            );
          })()
        )}

        </div>{/* end post-processing-section */}

        {/* ── Post-Processing Result section ── */}
        <div className="postprocessing-result-section">
          <div className="section-header">
            <h2>Post-Processing Result</h2>
            <p>Review the constraint health before running the simulation</p>
          </div>

          <button
            className="health-check-button"
            onClick={runHealthCheck}
            disabled={isCheckingHealth || isSimulating || !config.ocdeclareFile || config.startActivities.length === 0}
          >
            {isCheckingHealth ? '⏳ Checking...' : '🩺 Run Health Check'}
          </button>

          {healthResult && !healthResult.error && (() => {
            const s = healthResult.summary || {};
            const hasErrors   = s.errors > 0;
            const hasWarnings = s.warnings > 0;
            const badge = `${s.errors} error${s.errors !== 1 ? 's' : ''}, ${s.warnings} warning${s.warnings !== 1 ? 's' : ''}`;
            const titleClass = hasErrors ? 'health-title-error' : hasWarnings ? 'health-title-warn' : 'health-title-ok';
            return (
              <Collapsible
                className="health-report-box"
                title={<span className={titleClass}>🩺 Constraint Health Report</span>}
                badge={badge}
                defaultOpen={hasErrors || hasWarnings}
              >
                {healthResult.no_input_activities?.length > 0 && (
                  <Collapsible
                    className="health-section health-warn"
                    title={<span className="health-section-title">⚠ Activities with no input constraints</span>}
                    badge={healthResult.no_input_activities.length}
                    defaultOpen={false}
                  >
                    {healthResult.no_input_activities.map((a, i) => (
                      <div key={i} className="health-item health-no-input-item">
                        <span className={`health-badge-${a.is_pure_start ? 'error' : 'warn'}`}>
                          {a.is_pure_start ? 'START' : 'NO INPUT'}
                        </span>
                        <strong>{a.activity}</strong>
                        {a.input_bindings.length > 0 ? (
                          <ul className="health-no-input-bindings">
                            {a.input_bindings.map((b, j) => (
                              <li key={j}>
                                <code>{b.object_type}</code>
                                {b.is_resource && <span className="health-excl-hint"> (resource)</span>}
                                {b.created_by.length > 0 && (
                                  <span className="health-excl-hint"> — created by: <em>{b.created_by.join(', ')}</em></span>
                                )}
                                {b.deactivated_by.length > 0 && (
                                  <span className="health-excl-hint"> · deactivated by: <em>{b.deactivated_by.join(', ')}</em></span>
                                )}
                                {b.created_by.length === 0 && !b.is_resource && (
                                  <span className="health-excl-hint" style={{color:'#b91c1c'}}> — no activity creates this type</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="health-reason"> — no input bindings (pure start activity)</span>
                        )}
                      </div>
                    ))}
                  </Collapsible>
                )}
                {healthResult.cycles?.length > 0 && (
                  <Collapsible
                    className="health-section health-error"
                    title={<span className="health-section-title">🔴 Dependency cycles (deadlock)</span>}
                    badge={healthResult.cycles.length}
                    defaultOpen={false}
                  >
                    {healthResult.cycles.map((cy, i) => (
                      <div key={i} className="health-item"><span className="health-badge-error">CYCLE</span>{cy.description}</div>
                    ))}
                  </Collapsible>
                )}
                {healthResult.permanently_blocked?.length > 0 && (
                  <Collapsible
                    className="health-section health-error"
                    title={<span className="health-section-title">🔴 Activities never reaching the pool</span>}
                    badge={healthResult.permanently_blocked.length}
                    defaultOpen={false}
                  >
                    {healthResult.permanently_blocked.map((b, i) => (
                      <div key={i} className="health-item">
                        <span className="health-badge-error">BLOCKED</span>
                        <strong>{b.activity}</strong>
                        {b.exclusion_reason === 'no_objects' && b.exclusion_detail?.[0] && (
                          <span className="health-reason health-excl-reason">
                            {' '}← no active <code>{b.exclusion_detail[0].binding_type}</code> objects
                            {(() => {
                              const det = b.exclusion_detail[0];
                              const creators    = det.created_by    || [];
                              const deactivators = det.deactivated_by || [];
                              if (!creators.length && !deactivators.length)
                                return <span className="health-excl-hint"> (no activity creates this type or all were deactivated)</span>;
                              return (
                                <span className="health-excl-hint">
                                  {' '}(
                                  {creators.length > 0 && <>created by: <em>{creators.join(', ')}</em></>}
                                  {creators.length > 0 && deactivators.length > 0 && ' · '}
                                  {deactivators.length > 0 && <>deactivated by: <em>{deactivators.join(', ')}</em></>}
                                  )
                                </span>
                              );
                            })()}
                          </span>
                        )}
                        {b.exclusion_reason === 'guard_filtered' && b.exclusion_detail?.[0] && (
                          <span className="health-reason health-excl-reason">
                            {' '}← attribute guard filtered all <code>{b.exclusion_detail[0].binding_type}</code> objects
                            <span className="health-excl-hint"> (no object satisfies the guard condition)</span>
                          </span>
                        )}
                        {!b.exclusion_reason && b.top_blocker && b.top_blocker !== 'never attempted' && (
                          <span className="health-reason"> ← {b.top_blocker}</span>
                        )}
                        {!b.exclusion_reason && (!b.top_blocker || b.top_blocker === 'never attempted') && (
                          <span className="health-reason health-never-attempted"> — never attempted (check start activities)</span>
                        )}
                      </div>
                    ))}
                  </Collapsible>
                )}
                {healthResult.top_blocking_constraints?.filter(c => c.is_chain).length > 0 && (
                  <Collapsible
                    className="health-section health-warn"
                    title={<span className="health-section-title">⚠ Chain constraints (common deadlock source)</span>}
                    badge={healthResult.top_blocking_constraints.filter(c => c.is_chain).length}
                    defaultOpen={false}
                  >
                    {healthResult.top_blocking_constraints.filter(c => c.is_chain).map((c, i) => (
                      <div key={i} className="health-item">
                        <span className="health-badge-warn">{c.count}×</span>
                        <code className="health-constraint-label">{c.label}</code>
                        <span className="health-reason"> blocks: {c.blocks.join(', ')}</span>
                      </div>
                    ))}
                  </Collapsible>
                )}
                {healthResult.weak_precedences?.length > 0 && (
                  <Collapsible
                    className="health-section health-warn"
                    title={<span className="health-section-title">⚠ Weak precedences (alternative paths in log)</span>}
                    badge={healthResult.weak_precedences.length}
                    defaultOpen={false}
                  >
                    {healthResult.weak_precedences.map((wp, i) => (
                      <div key={i} className="health-item">
                        <span className="health-badge-warn">{wp.co_occurrence_pct}%</span>
                        <code className="health-constraint-label">precedence({wp.source}→{wp.target}) each {wp.scope_type}</code>
                        <span className="health-reason"> {wp.message}</span>
                      </div>
                    ))}
                  </Collapsible>
                )}
                {healthResult.top_blocking_constraints?.filter(c => !c.is_chain).length > 0 && (
                  <Collapsible
                    className="health-section health-info"
                    title={<span className="health-section-title">ℹ Top non-chain blocking constraints</span>}
                    badge={healthResult.top_blocking_constraints.filter(c => !c.is_chain).length}
                    defaultOpen={false}
                  >
                    {healthResult.top_blocking_constraints.filter(c => !c.is_chain).slice(0, 8).map((c, i) => (
                      <div key={i} className="health-item">
                        <span className="health-badge-info">{c.count}×</span>
                        <code className="health-constraint-label">{c.label}</code>
                      </div>
                    ))}
                  </Collapsible>
                )}
                {!hasErrors && !hasWarnings && (
                  <div className="health-ok-msg">✓ No issues detected — model looks healthy.</div>
                )}
              </Collapsible>
            );
          })()}

          {healthResult?.error && (
            <div className="error-box" style={{ marginTop: '0.5rem' }}>
              <p>Health check error: {healthResult.error}</p>
            </div>
          )}

          {/* ── Automated Post-Processing ── */}
          <div className="automation-section">
            <div className="section-header">
              <h2>Automated Post-Processing</h2>
              <p>Configure thresholds, generate suggestions from the health check, then selectively apply fixes.</p>
            </div>

            {/* Configuration — collapsible */}
            <div className="auto-config-collapsible">
              <button className="auto-config-toggle" onClick={() => setAutoConfigOpen(o => !o)}>
                <span>{autoConfigOpen ? '▼' : '▶'}</span> Configuration
                <span className="auto-config-toggle-hint">
                  {[
                    autoConfig.cycleEnabled && 'cycles',
                    autoConfig.weakEnabled && 'weak',
                    autoConfig.chainEnabled && 'chain',
                    autoConfig.o2oEnabled && 'O2O',
                    autoConfig.nmaxEnabled && 'nmax',
                    autoConfig.createsMissingEnabled && 'creates',
                    autoConfig.startRecEnabled && 'start',
                    autoConfig.redundantEnabled && 'redundant',
                    autoConfig.unconstrainedEnabled && 'unconstrained',
                    autoConfig.noInputBindingEnabled && 'no-binding',
                  ].filter(Boolean).join(' · ')}
                </span>
              </button>
              {autoConfigOpen && (
              <div className="auto-config-panel">
                <div className="auto-config-row">
                  <label className="auto-config-label">
                    <input type="checkbox" checked={autoConfig.cycleEnabled}
                      onChange={e => setAutoConfig(p => ({ ...p, cycleEnabled: e.target.checked }))} />
                    {' '}Cycle removal — remove constraints with nmin ≤
                  </label>
                  <input type="number" min={0} max={10} className="auto-config-input"
                    value={autoConfig.cycleNminThreshold}
                    disabled={!autoConfig.cycleEnabled}
                    onChange={e => setAutoConfig(p => ({ ...p, cycleNminThreshold: parseInt(e.target.value) || 0 }))}
                  />
                </div>
                <div className="auto-config-row">
                  <label className="auto-config-label">
                    <input type="checkbox" checked={autoConfig.weakEnabled}
                      onChange={e => setAutoConfig(p => ({ ...p, weakEnabled: e.target.checked }))} />
                    {' '}Weak precedences — flag if co-occurrence below
                  </label>
                  <input type="number" min={0} max={100} className="auto-config-input"
                    value={autoConfig.weakThreshold}
                    disabled={!autoConfig.weakEnabled}
                    onChange={e => setAutoConfig(p => ({ ...p, weakThreshold: parseInt(e.target.value) || 0 }))}
                  />
                  <span className="auto-config-unit">%</span>
                </div>
                <div className="auto-config-row">
                  <label className="auto-config-label">
                    <input type="checkbox" checked={autoConfig.chainEnabled}
                      onChange={e => setAutoConfig(p => ({ ...p, chainEnabled: e.target.checked }))} />
                    {' '}Chain constraints — downgrade if rejection count ≥
                  </label>
                  <input type="number" min={1} max={999} className="auto-config-input"
                    value={autoConfig.chainBlockThreshold}
                    disabled={!autoConfig.chainEnabled}
                    onChange={e => setAutoConfig(p => ({ ...p, chainBlockThreshold: parseInt(e.target.value) || 1 }))}
                  />
                </div>
                <div className="auto-config-row">
                  <label className="auto-config-label">
                    <input type="checkbox" checked={autoConfig.o2oEnabled}
                      onChange={e => setAutoConfig(p => ({ ...p, o2oEnabled: e.target.checked }))} />
                    {' '}O2O max_links relaxation — suggest fixes when O2O caps block activities
                  </label>
                </div>
                <div className="auto-config-row">
                  <label className="auto-config-label">
                    <input type="checkbox" checked={autoConfig.nmaxEnabled}
                      onChange={e => setAutoConfig(p => ({ ...p, nmaxEnabled: e.target.checked }))} />
                    {' '}nmax cap — raise/remove response nmax when cap is hit
                  </label>
                </div>
                <div className="auto-config-row">
                  <label className="auto-config-label">
                    <input type="checkbox" checked={autoConfig.createsMissingEnabled}
                      onChange={e => setAutoConfig(p => ({ ...p, createsMissingEnabled: e.target.checked }))} />
                    {' '}Missing creates — suggest creates=true when no activity creates a required type
                  </label>
                </div>
                <div className="auto-config-row">
                  <label className="auto-config-label">
                    <input type="checkbox" checked={autoConfig.startRecEnabled}
                      onChange={e => setAutoConfig(p => ({ ...p, startRecEnabled: e.target.checked }))} />
                    {' '}Start activity recommendation — suggest when all activities are blocked at step 0
                  </label>
                </div>
                <div className="auto-config-row">
                  <label className="auto-config-label">
                    <input type="checkbox" checked={autoConfig.redundantEnabled}
                      onChange={e => setAutoConfig(p => ({ ...p, redundantEnabled: e.target.checked }))} />
                    {' '}Redundant constraints — remove weaker constraints implied by stronger ones
                  </label>
                </div>
                <div className="auto-config-row">
                  <label className="auto-config-label">
                    <input type="checkbox" checked={autoConfig.unconstrainedEnabled}
                      onChange={e => setAutoConfig(p => ({ ...p, unconstrainedEnabled: e.target.checked }))} />
                    {' '}Unconstrained activities — suggest predecessor constraints for activities with no input arcs
                  </label>
                </div>
                <div className="auto-config-row">
                  <label className="auto-config-label">
                    <input type="checkbox" checked={autoConfig.noInputBindingEnabled}
                      onChange={e => setAutoConfig(p => ({ ...p, noInputBindingEnabled: e.target.checked }))} />
                    {' '}No input binding — suggest adding an object binding to activities that only create objects
                  </label>
                </div>
              </div>
              )}
            </div>

            {/* Generate button */}
            <button
              className="auto-generate-btn"
              disabled={!healthResult || !!healthResult.error || !activeModel}
              onClick={() => {
                const suggs = generateSuggestions(healthResult, activeModel, autoConfig);
                setAutoSuggestions(suggs);
                setAutoSelected(new Set(suggs.map((_, i) => i))); // select all by default
              }}
            >
              {!healthResult || healthResult.error
                ? '▶ Run health check first'
                : `▶ Generate Suggestions`}
            </button>

            {/* Suggestion list */}
            {autoSuggestions.length > 0 && (
              <div className="auto-suggestions">
                <div className="auto-suggestions-header">
                  <span className="auto-suggestions-count">{autoSuggestions.length} suggestion{autoSuggestions.length !== 1 ? 's' : ''}</span>
                  <button className="auto-sel-btn" onClick={() => setAutoSelected(new Set(autoSuggestions.map((_, i) => i)))}>Select all</button>
                  <button className="auto-sel-btn" onClick={() => setAutoSelected(new Set())}>Select none</button>
                </div>
                <ul className="auto-suggestion-list">
                  {autoSuggestions.map((s, i) => (
                    <li key={s.id} className={`auto-suggestion-item ${autoSelected.has(i) ? 'selected' : ''}`}>
                      <label className="auto-suggestion-check">
                        <input type="checkbox"
                          checked={autoSelected.has(i)}
                          onChange={e => {
                            const next = new Set(autoSelected);
                            e.target.checked ? next.add(i) : next.delete(i);
                            setAutoSelected(next);
                          }}
                        />
                        <span className={`auto-badge auto-badge-${s.type.toLowerCase()}`}>{s.badgeLabel}</span>
                        <span className="auto-suggestion-label">{s.label}</span>
                      </label>
                      <span className="auto-suggestion-desc">{s.desc}</span>
                      {s.type === 'ADD_CONSTRAINT' && s.actionFactory && (
                        <div className="auto-pred-row">
                          <label className="auto-pred-label">Predecessor activity:</label>
                          <select className="auto-pred-select"
                            value={autoConstraintPreds[s.id] || ''}
                            onChange={e => setAutoConstraintPreds(p => ({ ...p, [s.id]: e.target.value }))}>
                            <option value="">— choose —</option>
                            {(activeModel?.activities || [])
                              .filter(a => a.name !== s.targetActivity)
                              .map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
                          </select>
                          <span className="auto-pred-hint">→ creates precedence + response</span>
                        </div>
                      )}
                      {s.type === 'ADD_BINDING' && s.actionFactory && (
                        <div className="auto-pred-row">
                          <label className="auto-pred-label">Object type to bind:</label>
                          <select className="auto-pred-select"
                            value={autoBindingTypes[s.id] || ''}
                            onChange={e => setAutoBindingTypes(p => ({ ...p, [s.id]: e.target.value }))}>
                            <option value="">— choose —</option>
                            {(s.candidateTypes || []).map(t => {
                              const creator = s.typeCreatorActivity?.[t];
                              return <option key={t} value={t}>{t}{creator ? ` (created by: ${creator})` : ''}</option>;
                            })}
                          </select>
                          <span className="auto-pred-hint">→ adds binding + precedence from creator</span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <button
                  className="auto-apply-btn"
                  disabled={autoSelected.size === 0}
                  onClick={() => {
                    let model = { ...activeModel };
                    autoSuggestions.forEach((s, i) => {
                      if (!autoSelected.has(i)) return;
                      if (s.type === 'ADD_CONSTRAINT' && s.actionFactory) {
                        const pred = autoConstraintPreds[s.id] || '';
                        model = s.actionFactory(pred)(model);
                      } else if (s.type === 'ADD_BINDING' && s.actionFactory) {
                        const otype = autoBindingTypes[s.id] || '';
                        model = s.actionFactory(otype)(model);
                      } else {
                        model = s.action(model);
                      }
                    });
                    handleModelEdit(model);
                    setAutoSuggestions([]);
                    setAutoSelected(new Set());
                    setAutoConstraintPreds({});
                    setAutoBindingTypes({});
                  }}
                >
                  ✓ Apply {autoSelected.size} selected change{autoSelected.size !== 1 ? 's' : ''}
                </button>
              </div>
            )}

            {autoSuggestions.length === 0 && healthResult && !healthResult.error && (
              <p className="auto-no-suggestions">No suggestions — adjust thresholds or review the health report above.</p>
            )}
          </div>
        </div>{/* end postprocessing-result-section */}

        {/* ── Run Simulation section ── */}
        <div className={`simulation-section ${(workflowMode !== 'external-empty' && !discoveryResults) ? 'disabled' : ''}`}>
          <div className="section-header">
            <h2>Run Simulation</h2>
            <p>Configure and run the object-centric simulation</p>
            {workflowMode !== 'external-empty' && !discoveryResults && (
              <div className="disabled-notice">
                Complete parameter discovery first
              </div>
            )}
          </div>

          <div className="simulation-config">
            <div className="form-group">
              <label>
                Start Activities
                <span className="start-activity-hint"> — which activities can initiate new cases</span>
              </label>
              {(() => {
                const disabled = isSimulating || !discoveryResults;
                const displayCandidates = startActivityCandidates.length > 0
                  ? startActivityCandidates
                  : availableActivities.map(a => ({ activity: a, count: null, pct: null }));
                if (displayCandidates.length === 0) {
                  return <p className="start-activity-empty">Run discovery to see candidates</p>;
                }
                const toggle = (act, on) => setConfig(prev => ({
                  ...prev,
                  startActivities: on
                    ? [...prev.startActivities, act]
                    : prev.startActivities.filter(a => a !== act)
                }));
                return (
                  <div className={`start-activity-list ${disabled ? 'sa-disabled' : ''}`}>
                    <div className="start-activity-controls">
                      <button className="sa-ctrl-btn" disabled={disabled}
                        onClick={() => setConfig(prev => ({ ...prev, startActivities: displayCandidates.map(c => c.activity) }))}>
                        All
                      </button>
                      <button className="sa-ctrl-btn" disabled={disabled}
                        onClick={() => setConfig(prev => ({ ...prev, startActivities: [] }))}>
                        None
                      </button>
                      <span className="sa-selection-count">
                        {config.startActivities.length} selected
                      </span>
                    </div>
                    <div className="start-activity-items">
                      {displayCandidates.map((c, i) => {
                        const checked = config.startActivities.includes(c.activity);
                        const isTop = i === 0 && c.pct !== null;
                        return (
                          <label key={c.activity} className={`start-activity-item${checked ? ' sa-checked' : ''}`}>
                            <input type="checkbox" checked={checked} disabled={disabled}
                              onChange={e => toggle(c.activity, e.target.checked)} />
                            <span className="sa-name">{c.activity}</span>
                            {isTop && <span className="sa-top-badge">★ top</span>}
                            {c.pct !== null && <span className="sa-pct">{c.pct}%</span>}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Max Steps</label>
                <input 
                  type="number" 
                  value={config.maxSteps}
                  onChange={(e) => handleConfigChange('maxSteps', parseInt(e.target.value))}
                  min="1"
                  max="1000"
                  disabled={isSimulating || (workflowMode !== 'external-empty' && !discoveryResults)}
                />
              </div>

              <div className="form-group">
                <label>Random Seed</label>
                <input 
                  type="number" 
                  value={config.seed}
                  onChange={(e) => handleConfigChange('seed', parseInt(e.target.value))}
                  disabled={isSimulating || (workflowMode !== 'external-empty' && !discoveryResults)}
                />
              </div>
            </div>


            <button
              className="simulate-button"
              onClick={runSimulation}
              disabled={isSimulating || (workflowMode !== 'external-empty' && !discoveryResults) || !config.ocdeclareFile || config.startActivities.length === 0 || hasModelWarnings}
            >
              {isSimulating ? 'Simulating...' : 'Run Simulation'}
            </button>
            {hasModelWarnings && (
              <div className="model-warnings-notice">
                ⚠ Simulation blocked — {bindingWarnings.length} activit{bindingWarnings.length === 1 ? 'y has' : 'ies have'} no object bindings:{' '}
                <strong>{bindingWarnings.map(a => a.name).join(', ')}</strong>.
                Open the Model Editor → Activities tab to fix.
              </div>
            )}
          </div>

          {/* Simulation Results */}
          {error && (
            <div className="error-box">
              <h3>Simulation Error</h3>
              <p>{error}</p>
            </div>
          )}

          {isSimulating && (
            <div className="loading-box">
              <div className="spinner"></div>
              <p>
                Running simulation…{' '}
                <span className="sim-step-counter">
                  step {liveStepCount ?? 0} / {config.maxSteps}
                </span>
              </p>
              <button className="sim-stop-btn" onClick={stopSimulation}>
                ⏹ Stop
              </button>
            </div>
          )}

          {results && !isSimulating && (
            <div className="results-box">
              <h3>Simulation Complete</h3>

              {(() => {
                const firedTypes = results.activity_sequence
                  ? [...new Set(results.activity_sequence)]
                  : (results.metrics?.activity_metrics ? Object.keys(results.metrics.activity_metrics) : []);
                const discoveredTypes = discoveryResults?.activities || [];
                const missingTypes = discoveredTypes.filter(a => !firedTypes.includes(a));
                const totalEvents = results.events_count;
                const coverage = discoveredTypes.length > 0
                  ? firedTypes.filter(a => discoveredTypes.includes(a)).length
                  : firedTypes.length;

                return (
                  <>
                    <div className="stat-grid">
                      <div className="stat-card">
                        <div className="stat-value">{results.steps_executed}</div>
                        <div className="stat-label">Steps Executed</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-value">{totalEvents}</div>
                        <div className="stat-label">Events Fired</div>
                      </div>
                      <div className={`stat-card ${missingTypes.length > 0 ? 'stat-card-warn' : 'stat-card-ok'}`}>
                        <div className="stat-value">
                          {coverage}
                          {discoveredTypes.length > 0 && <span className="stat-value-denom"> / {discoveredTypes.length}</span>}
                        </div>
                        <div className="stat-label">Activity Types Fired</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-value">{results.objects_count}</div>
                        <div className="stat-label">Objects Created</div>
                      </div>
                    </div>
                    {missingTypes.length > 0 && (
                      <Collapsible
                        className="sim-coverage-warning"
                        title={<span className="sim-coverage-warning-title">⚠ {missingTypes.length} activity type{missingTypes.length > 1 ? 's' : ''} never fired</span>}
                        badge={null}
                        defaultOpen={false}
                      >
                        <ul className="sim-coverage-missing-list">
                          {missingTypes.map(a => {
                            const reasons = results.audit?.activity_participation_audit?.[a]?.issues || [];
                            return (
                              <li key={a}>
                                <span className="sim-coverage-missing-name">{a}</span>
                                {reasons.length > 0 && (
                                  <ul className="sim-coverage-missing-reasons">
                                    {reasons.map((r, i) => <li key={i}>{r}</li>)}
                                  </ul>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </Collapsible>
                    )}
                  </>
                );
              })()}


              {results.object_types && (
                <Collapsible
                  className="object-types"
                  title="Object Type Breakdown"
                  badge={Object.keys(results.object_types).length}
                >
                  {(() => {
                    const logStats = discoveryResults?.object_type_stats || {};
                    const hasLogData = Object.keys(logStats).length > 0;
                    const allTypes = new Set([
                      ...Object.keys(results.object_types),
                      ...Object.keys(logStats),
                    ]);
                    return (
                      <table className="object-type-stats-table">
                        <thead>
                          <tr>
                            <th>Object Type</th>
                            <th className="octs-num">Simulated</th>
                            {hasLogData && <th className="octs-num">In Log</th>}
                            {hasLogData && <th className="octs-num" title="Simulated ÷ Log instances">Ratio</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {[...allTypes].sort().map(type => {
                            const simCount = results.object_types[type] || 0;
                            const logCount = logStats[type]?.count || 0;
                            const ratio    = logCount > 0 ? simCount / logCount : null;
                            const ratioClass = ratio === null ? '' :
                              ratio > 1.5 ? 'ratio-high' : ratio < 0.5 ? 'ratio-low' : 'ratio-ok';
                            return (
                              <tr key={type}>
                                <td className="octs-type">{type}</td>
                                <td className="octs-num">{simCount.toLocaleString()}</td>
                                {hasLogData && <td className="octs-num">{logCount ? logCount.toLocaleString() : '—'}</td>}
                                {hasLogData && (
                                  <td className="octs-num">
                                    {ratio !== null
                                      ? <span className={`obj-ratio ${ratioClass}`}>{ratio.toFixed(2)}×</span>
                                      : '—'}
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    );
                  })()}
                </Collapsible>
              )}

              {/* ── Object Lifecycle Audit ── */}
              {results.audit?.object_lifecycle_audit && Object.keys(results.audit.object_lifecycle_audit).length > 0 && (
                <Collapsible
                  className="logs-box"
                  title="🔬 Object Lifecycle Audit"
                  badge={(() => {
                    const a = results.audit.object_lifecycle_audit;
                    const issues = Object.values(a).filter(v => v.classification !== 'healthy').length;
                    return issues > 0 ? `${issues} issue${issues !== 1 ? 's' : ''}` : 'healthy';
                  })()}
                  defaultOpen={false}
                >
                  <table className="audit-table">
                    <thead>
                      <tr>
                        <th>Object Type</th>
                        <th className="audit-num">Created</th>
                        <th className="audit-num">Active</th>
                        <th className="audit-num">Deactivated</th>
                        <th className="audit-num">Zero-event</th>
                        <th className="audit-num">Events/instance</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(results.audit.object_lifecycle_audit).map(([otype, a]) => (
                        <tr key={otype} className={`audit-row-${a.classification}`}>
                          <td className="audit-type">{otype}</td>
                          <td className="audit-num">{a.instance_count}</td>
                          <td className="audit-num">{a.active_count}</td>
                          <td className="audit-num">{a.deactivated_count}</td>
                          <td className="audit-num">{a.zero_event_count > 0 ? <span className="audit-warn">{a.zero_event_count}</span> : '0'}</td>
                          <td className="audit-num">{a.event_count_stats.min}–{a.event_count_stats.max} (avg {a.event_count_stats.mean})</td>
                          <td>
                            <span className={`audit-badge audit-badge-${a.classification}`}>
                              {a.classification.replace(/_/g, ' ')}
                            </span>
                            {a.issues.map((iss, i) => (
                              <div key={i} className="audit-issue">{iss}</div>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Collapsible>
              )}

              {/* ── Activity Participation Audit ── */}
              {results.audit?.activity_participation_audit && Object.keys(results.audit.activity_participation_audit).length > 0 && (
                <Collapsible
                  className="logs-box"
                  title="🎯 Activity Participation Audit"
                  badge={(() => {
                    const a = results.audit.activity_participation_audit;
                    const issues = Object.values(a).filter(v => v.classification !== 'healthy' && v.classification !== 'never_fired').length;
                    const neverFired = Object.values(a).filter(v => v.classification === 'never_fired').length;
                    const parts = [];
                    if (issues > 0) parts.push(`${issues} issue${issues !== 1 ? 's' : ''}`);
                    if (neverFired > 0) parts.push(`${neverFired} never fired`);
                    return parts.length ? parts.join(', ') : 'healthy';
                  })()}
                  defaultOpen={false}
                >
                  <table className="audit-table">
                    <thead>
                      <tr>
                        <th>Activity</th>
                        <th className="audit-num">Firings</th>
                        <th className="audit-num">Unique objects</th>
                        <th className="audit-num">Obj/firing</th>
                        <th className="audit-num">Reuse rate</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(results.audit.activity_participation_audit).map(([act, a]) => (
                        <tr key={act} className={`audit-row-${a.classification}`}>
                          <td className="audit-type">{act}</td>
                          <td className="audit-num">{a.execution_count}</td>
                          <td className="audit-num">{a.unique_objects ?? '—'}</td>
                          <td className="audit-num">
                            {a.objects_per_firing
                              ? `${a.objects_per_firing.min}–${a.objects_per_firing.max}`
                              : '—'}
                          </td>
                          <td className="audit-num">
                            {a.reuse_rate != null
                              ? <span className={a.reuse_rate > 0.8 ? 'audit-warn' : ''}>{(a.reuse_rate * 100).toFixed(0)}%</span>
                              : '—'}
                          </td>
                          <td>
                            <span className={`audit-badge audit-badge-${a.classification}`}>
                              {a.classification.replace(/_/g, ' ')}
                            </span>
                            {a.dominant_object && (
                              <div className="audit-issue">
                                Dominated by <code>{a.dominant_object.object_id}</code> ({a.dominant_object.pct}% of firings)
                              </div>
                            )}
                            {a.issues.map((iss, i) => (
                              <div key={i} className="audit-issue">{iss}</div>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Collapsible>
              )}

              {/* ── Activity distribution comparison: simulation vs log ── */}
              {results.metrics?.activity_metrics && discoveryResults?.activity_counts && (
                <Collapsible
                  className="logs-box sim-compare-box"
                  title="📊 Activity Distribution vs Log"
                  badge={null}
                  defaultOpen={false}
                >
                  {() => {
                    const simMetrics = results.metrics.activity_metrics;
                    const logCounts = discoveryResults.activity_counts || {};
                    const logRepeat = discoveryResults.activity_repeat_stats || {};
                    const simTotal = Object.values(simMetrics).reduce((s, m) => s + (m.execution_count || 0), 0);
                    const logTotal = Object.values(logCounts).reduce((s, v) => s + v, 0);

                    // Replicate FlowChart rank assignment so rows appear in the
                    // same left-to-right column order as the DFG.
                    const actSeq = results.activity_sequence
                      ? [...new Set(results.activity_sequence)]
                      : Object.keys(simMetrics);
                    const idxOf = {};
                    actSeq.forEach((n, i) => { idxOf[n] = i; });
                    // Build transition counts from object traces (same source as FlowChart)
                    const trans = {};
                    Object.values(results.object_traces || {}).forEach(seq => {
                      seq.forEach((name, i) => {
                        if (i < seq.length - 1) {
                          const key = `${name} → ${seq[i + 1]}`;
                          trans[key] = (trans[key] || 0) + 1;
                        }
                      });
                    });
                    // Forward predecessors only
                    const preds = {};
                    actSeq.forEach(n => { preds[n] = []; });
                    Object.keys(trans).forEach(key => {
                      const [f, t] = key.split(' → ');
                      if (f === t || idxOf[f] === undefined || idxOf[t] === undefined) return;
                      if (idxOf[f] < idxOf[t]) preds[t].push(f);
                    });
                    // rank = longest forward path ending at node
                    const flowRank = {};
                    actSeq.forEach(n => {
                      flowRank[n] = preds[n].length ? Math.max(...preds[n].map(p => flowRank[p] + 1)) : 0;
                    });

                    const allActs = [...new Set([...Object.keys(simMetrics), ...Object.keys(logCounts)])]
                      .sort((a, b) => {
                        const ra = a in flowRank ? flowRank[a] : 999999;
                        const rb = b in flowRank ? flowRank[b] : 999999;
                        return ra !== rb ? ra - rb : a.localeCompare(b);
                      });
                    return (
                      <>
                        <p className="sim-compare-hint">
                          Proportional share of total events (simulation vs log). Identical proportions would mean
                          perfect routing fidelity. Difference column shows sim − log in percentage points.
                        </p>
                        <table className="metrics-table sim-compare-table">
                          <thead>
                            <tr>
                              <th>Activity</th>
                              <th title="Times fired in this simulation run">Sim count</th>
                              <th title="Times fired in the input event log">Log count</th>
                              <th title="Share of all simulated events">Sim %</th>
                              <th title="Share of all log events">Log %</th>
                              <th title="Sim % minus Log % — positive means over-represented in simulation">Diff</th>
                              <th title="Average times this activity fired per object in the log (from discovery)">Log mean /obj</th>
                              <th title="Average times this activity fired per object in the simulation">Sim mean /obj</th>
                            </tr>
                          </thead>
                          <tbody>
                            {allActs.map(act => {
                              const simCount = simMetrics[act]?.execution_count ?? 0;
                              const logCount = logCounts[act] ?? 0;
                              const simPct = simTotal > 0 ? (simCount / simTotal * 100) : 0;
                              const logPct = logTotal > 0 ? (logCount / logTotal * 100) : 0;
                              const diff = simPct - logPct;
                              const logMeanObj = logRepeat[act]?.mean ?? null;
                              const simObjEvents = simActivityObjectCounts[act] ?? null;
                              const simMeanObj = simObjEvents > 0 ? (simCount / simObjEvents).toFixed(2) : null;
                              const diffClass = Math.abs(diff) < 2 ? 'cmp-ok'
                                : diff > 0 ? 'cmp-over' : 'cmp-under';
                              return (
                                <tr key={act}>
                                  <td className="metrics-act-name">{act}</td>
                                  <td>{simCount || '—'}</td>
                                  <td>{logCount || '—'}</td>
                                  <td>{simPct > 0 ? simPct.toFixed(1) + '%' : '—'}</td>
                                  <td>{logPct > 0 ? logPct.toFixed(1) + '%' : '—'}</td>
                                  <td className={`cmp-diff ${diffClass}`}>
                                    {simCount > 0 || logCount > 0 ? (diff >= 0 ? '+' : '') + diff.toFixed(1) + 'pp' : '—'}
                                  </td>
                                  <td>{logMeanObj ?? '—'}</td>
                                  <td>{simMeanObj ?? '—'}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </>
                    );
                  }}
                </Collapsible>
              )}

              {results.activity_sequence && results.activity_sequence.length > 0 && (
                <Collapsible
                  className="activity-sequence"
                  title="Activity Sequence"
                  badge={results.activity_sequence.length}
                  defaultOpen={false}
                >
                  <div className="sequence-list">
                    {results.activity_sequence.slice(0, 200).map((activity, idx) => (
                      <span key={idx} className="activity-badge">{activity}</span>
                    ))}
                    {results.activity_sequence.length > 200 && (
                      <span className="activity-badge" style={{ borderColor: '#94a3b8', color: '#94a3b8' }}>
                        … +{results.activity_sequence.length - 200} more
                      </span>
                    )}
                  </div>
                </Collapsible>
              )}

              {results.output_file && (
                <div className="download-row">
                  <button className="download-button" onClick={downloadEventLog}>
                    Download Event Log
                  </button>
                  {results.metrics_file && (
                    <button className="download-button download-button-secondary" onClick={downloadMetrics}>
                      Download Metrics
                    </button>
                  )}
                </div>
              )}

              {results.activity_sequence && results.activity_sequence.length > 0 && (
                <div className="flow-chart-section">
                  <h4>Process Flow</h4>
                  <FlowChart
                    activitySequence={results.activity_sequence}
                    objectTraces={results.object_traces || {}}
                    objectTypesMap={results.object_types_map || {}}
                    activityMetrics={results.metrics && results.metrics.activity_metrics ? results.metrics.activity_metrics : null}
                  />
                </div>
              )}

              {/* ── Timing Metrics Panel ── */}
              {results.metrics && (
                <>
                  {/* Per-Activity */}
                  {results.metrics.activity_metrics && Object.keys(results.metrics.activity_metrics).length > 0 && (
                    <Collapsible
                      className="logs-box timing-metrics-box"
                      title="⏱ Activity Timing"
                      badge={Object.keys(results.metrics.activity_metrics).length}
                      defaultOpen={false}
                    >
                      {/* ── Concurrency indicator ── */}
                      {results.concurrency_pairs && results.concurrency_pairs.length > 0 && (
                        <div className="concurrency-summary">
                          <span className="concurrency-summary-title">⚡ Concurrent activity pairs (from log)</span>
                          <div className="concurrency-pills">
                            {results.concurrency_pairs.map(({ a, b, p }) => (
                              <span key={`${a}|||${b}`} className="concurrency-pill" title={`${a} and ${b} fire concurrently ${Math.round(p * 100)}% of the time`}>
                                <span className="concurrency-pill-acts">{a} ∥ {b}</span>
                                <span className="concurrency-pill-p">{Math.round(p * 100)}%</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      <table className="metrics-table">
                        <thead>
                          <tr>
                            <th>Activity</th>
                            <th>Count</th>
                            <th title="Sampled clock advance at each firing">Mean service</th>
                            <th>Min service</th>
                            <th>Max service</th>
                            <th title="Service + wait in pool (sojourn = how long from becoming eligible to completion)">Mean sojourn</th>
                            <th title="Mean time the activity was in the candidate pool before being chosen">Mean wait in pool</th>
                            <th title="Longest time the activity was available but not chosen before finally firing">Max wait in pool</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(results.metrics.activity_metrics).map(([act, m]) => (
                            <tr key={act}>
                              <td className="metrics-act-name">{act}</td>
                              <td>{m.execution_count}</td>
                              <td>{fmtSeconds(m.mean_service_s)}</td>
                              <td>{fmtSeconds(m.min_service_s)}</td>
                              <td>{fmtSeconds(m.max_service_s)}</td>
                              <td>{fmtSeconds(m.mean_sojourn_s)}</td>
                              <td>{fmtSeconds(m.mean_wait_in_pool_s)}</td>
                              <td>{fmtSeconds(m.max_wait_in_pool_s)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </Collapsible>
                  )}

                  {/* Per-Object */}
                  {results.metrics_file && (
                    <Collapsible
                      className="logs-box timing-metrics-box"
                      title="📦 Object Lifetimes"
                      badge={objectMetricsData ? Object.keys(objectMetricsData).length : results.objects_count}
                      defaultOpen={false}
                    >
                      {() => !objectMetricsData ? (
                        <div style={{ padding: '0.75rem 0' }}>
                          <p style={{ fontSize: '0.82rem', color: '#64748b', marginBottom: '0.5rem' }}>
                            Object lifetime data is stored separately to keep the page responsive.
                            Click to load ({results.objects_count.toLocaleString()} objects).
                          </p>
                          <button
                            className="timing-discover-btn"
                            style={{ fontSize: '0.82rem', padding: '0.4rem 1rem' }}
                            disabled={isLoadingObjMetrics}
                            onClick={loadObjectMetrics}
                          >
                            {isLoadingObjMetrics ? 'Loading…' : '⬇ Load Object Lifetimes'}
                          </button>
                        </div>
                      ) : (
                        objectMetricsByType.map(([otype, items]) => (
                          <Collapsible
                            key={otype}
                            className="metrics-type-group"
                            title={otype}
                            badge={items.length}
                            defaultOpen={false}
                          >
                            <table className="metrics-table">
                              <thead>
                                <tr>
                                  <th>Object</th>
                                  <th>Events</th>
                                  <th>Lifetime</th>
                                  <th>First event</th>
                                  <th>Last event</th>
                                  <th>Activities</th>
                                </tr>
                              </thead>
                              <tbody>
                                {items.map(([oid, m]) => (
                                  <tr key={oid}>
                                    <td className="metrics-act-name">{oid}</td>
                                    <td>{m.event_count}</td>
                                    <td>{fmtSeconds(m.lifetime_s)}</td>
                                    <td className="metrics-ts">{m.first_event_time ? m.first_event_time.replace('T', ' ').slice(0, 19) : '—'}</td>
                                    <td className="metrics-ts">{m.last_event_time  ? m.last_event_time.replace('T', ' ').slice(0, 19)  : '—'}</td>
                                    <td className="metrics-acts">
                                      {m.activities.length > 8
                                        ? m.activities.slice(0, 8).join(' → ') + ` … +${m.activities.length - 8} more`
                                        : m.activities.join(' → ')}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </Collapsible>
                        ))
                      )}
                    </Collapsible>
                  )}
                </>
              )}
            </div>
          )}

          {logs.length > 0 && (
            <div className="logs-box">
              <h4>Simulation Logs</h4>
              <div className="logs-content">
                {logs.map((log, idx) => (
                  <div key={idx} className="log-entry">{log}</div>
                ))}
              </div>
            </div>
          )}

          {results && results.object_links && (
            <Collapsible
              className="logs-box object-tracer-box"
              title="🔗 Object Tracer"
              badge={`${results.object_links.length} links`}
              defaultOpen={false}
            >
              <p className="tracer-intro">
                For each seed object (one not created from another object), this shows the
                chain of objects that were linked to it during the run.
              </p>
              <ObjectTracer
                links={results.object_links}
                typesMap={results.object_types_map || {}}
                objectMetrics={objectMetricsData || {}}
                resourceTypes={results.resource_types || []}
              />
            </Collapsible>
          )}

          {iterationLogs.length > 0 && (
            <div className="logs-box">
              <h4
                className="collapsible-header"
                onClick={() => setIterationLogsOpen(o => !o)}
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                {iterationLogsOpen ? '▼' : '▶'} Iteration Trace ({iterationStepCount} steps)
              </h4>
              {iterationLogsOpen && (
                <div className="logs-content iteration-trace">
                  {(() => {
                    const items = [];
                    for (let i = 0; i < iterationLogs.length; i++) {
                      const entry = iterationLogs[i];
                      if (entry.event === 'candidates') {
                        const next = iterationLogs[i + 1];
                        const chosen = next?.event === 'chosen' ? next : null;
                        const withProbs = entry.candidates_with_probs || entry.candidates.map(a => ({ activity: a, prob: null }));
                        items.push(
                          <div key={i} className="iteration-step">
                            <span className="iter-step-label">Step {entry.step}</span>
                            <span className="iter-candidates">
                              Pool [{entry.num_candidates}]:{' '}
                              {withProbs.map((c, ci) => (
                                <span key={ci} className={chosen?.activity === c.activity ? 'iter-pool-chosen' : 'iter-pool-item'}>
                                  {c.activity}
                                  {c.prob !== null && <span className="iter-prob"> ({(c.prob * 100).toFixed(1)}%)</span>}
                                  {c.objects?.length > 0 && <span className="iter-objects"> [{c.objects.join(', ')}]</span>}
                                  {ci < withProbs.length - 1 ? ', ' : ''}
                                </span>
                              ))}
                            </span>
                            {chosen && (
                              <span className="iter-chosen">
                                → <strong>{chosen.activity}</strong>
                                {chosen.prob !== null && <span className="iter-prob"> ({(chosen.prob * 100).toFixed(1)}%)</span>}
                                {chosen.creates?.length > 0 && ` (creates: ${chosen.creates.join(', ')})`}
                              </span>
                            )}
                          </div>
                        );
                      } else if (entry.event === 'stop') {
                        items.push(
                          <div key={i} className="iteration-step iter-stop">
                            Stopped at step {entry.step}: {entry.reason}
                          </div>
                        );
                      }
                    }
                    return items;
                  })()}
                </div>
              )}
            </div>
          )}
          {/* ── Re-run placeholder ── */}
          {results && (
            <div className="rerun-placeholder">
              <div className="section-header">
                <h2>Re-run / Experiment</h2>
                <span className="placeholder-badge">Placeholder — coming soon</span>
              </div>
              <p className="placeholder-desc">
                Automated parameter sweep, seed comparison, and batch simulation
                will be configurable here in a future version.
              </p>
            </div>
          )}
        </div>{/* end simulation-section */}
      </div>{/* end workflow-container */}

      {/* ── Run History ── */}
      {runHistory.length > 0 && (
        <div className="workflow-container run-history-container">
          <Collapsible
            className="run-history-panel"
            title="🕘 Run History"
            badge={runHistory.length}
            defaultOpen={false}
          >
            <p className="run-history-hint">
              All simulation runs from this project, persisted across sessions.
              Click a row to expand timing metrics; use ↩ Restore to reload its settings.
            </p>
            <table className="run-history-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event log</th>
                  <th>Model</th>
                  <th>Steps</th>
                  <th>Events</th>
                  <th>Objects</th>
                  <th>Seed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runHistory.map(run => (
                  <React.Fragment key={run.id}>
                    <tr
                      className={`run-history-row${expandedRunId === run.id ? ' expanded' : ''}`}
                      onClick={() => loadRunMetrics(run.id)}
                      title="Click to view timing metrics"
                    >
                      <td className="rh-ts">{new Date(run.timestamp).toLocaleString()}</td>
                      <td className="rh-file">{run.event_log_file}</td>
                      <td className="rh-file">{run.ocdeclare_file}</td>
                      <td>{run.steps_executed}</td>
                      <td>{run.events_count}</td>
                      <td>{run.objects_count}</td>
                      <td>{run.seed}</td>
                      <td className="rh-actions" onClick={e => e.stopPropagation()}>
                        <button className="rh-btn" onClick={() => reRunFromHistory(run)} title="Restore these settings into the editor">↩ Restore</button>
                        {run.output_file && (
                          <button className="rh-btn" onClick={() => window.open(`/api/download/${run.output_file}`, '_blank')} title="Download event log">⬇ Log</button>
                        )}
                        {run.metrics_file && (
                          <button className="rh-btn" onClick={() => window.open(`/api/download-metrics/${run.metrics_file}`, '_blank')} title="Download metrics">⬇ Metrics</button>
                        )}
                      </td>
                    </tr>
                    {expandedRunId === run.id && runMetrics[run.id] && (
                      <tr className="run-history-metrics-row">
                        <td colSpan={8}>
                          <div className="rh-metrics-expand">
                            <strong>Activity timing</strong>
                            <table className="metrics-table rh-metrics-table">
                              <thead>
                                <tr>
                                  <th>Activity</th>
                                  <th>Count</th>
                                  <th>Mean service</th>
                                  <th>Min service</th>
                                  <th>Max service</th>
                                  <th>Mean sojourn</th>
                                  <th>Mean wait in pool</th>
                                </tr>
                              </thead>
                              <tbody>
                                {Object.entries(runMetrics[run.id].activity_metrics || {}).map(([act, m]) => (
                                  <tr key={act}>
                                    <td className="metrics-act-name">{act}</td>
                                    <td>{m.execution_count}</td>
                                    <td>{fmtSeconds(m.mean_service_s)}</td>
                                    <td>{fmtSeconds(m.min_service_s)}</td>
                                    <td>{fmtSeconds(m.max_service_s)}</td>
                                    <td>{fmtSeconds(m.mean_sojourn_s)}</td>
                                    <td>{fmtSeconds(m.mean_wait_in_pool_s)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </Collapsible>
        </div>
      )}
    </div>
  );
}

export default App;
