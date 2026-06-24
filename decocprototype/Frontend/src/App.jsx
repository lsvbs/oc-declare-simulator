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
      {open && children}
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
        </Collapsible>
      )}
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
  const [results, setResults] = useState(null);
  const [healthResult, setHealthResult] = useState(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);
  const [iterationLogs, setIterationLogs] = useState([]);
  const [iterationLogsOpen, setIterationLogsOpen] = useState(false);
  const [error, setError] = useState(null);
  const [logs, setLogs] = useState([]);

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

  const runSimulation = async () => {
    setIsSimulating(true);
    setError(null);
    setResults(null);
    setLogs([]);
    setIterationLogs([]);
    setIterationLogsOpen(false);

    try {
      const simulationData = {
        ...config,
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
      setIsSimulating(false);
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
      <header className="header">
        <h1>Declarative OC Simulator</h1>
        <p>Two-step workflow: First discover parameters, then run simulation</p>
      </header>

      <div className="workflow-container">
        {/* STEP 1: Discovery Section */}
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
                        <th>Attributes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(discoveryResults.object_type_stats).map(([type, info]) => (
                        <tr key={type}>
                          <td className="octs-type">{type}</td>
                          <td className="octs-num">{info.count.toLocaleString()}</td>
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

        {/* OC-DECLARE MODEL DISCOVERY SECTION */}
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

        {/* ── Model Selection: choose which discovered OC-Declare model to load ── */}
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

        {/* ── Model Editor (shown when an editable dict-format model is loaded) ── */}
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

        {/* Timing Discovery — after Model Editor */}
        {(() => {
          const timingActivities = discoveryResults?.activities?.length
            ? discoveryResults.activities
            : (!Array.isArray(activeModel) ? (activeModel?.activities || []).map(a => a.name) : []);
          if (!discoveryConfig.eventLogFile || !timingActivities.length) return null;
          return (
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
          );
        })()}

        {/* STEP 3: Simulation Section */}
        <div className={`simulation-section ${!discoveryResults ? 'disabled' : ''}`}>
          <div className="section-header">
            <h2>Step 3: Run Simulation</h2>
            <p>Execute the simulation using your Model Editor inputs above</p>
            {!discoveryResults && (
              <div className="disabled-notice">
                Please complete discovery first
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
                  disabled={isSimulating || !discoveryResults}
                />
              </div>

              <div className="form-group">
                <label>Random Seed</label>
                <input 
                  type="number" 
                  value={config.seed}
                  onChange={(e) => handleConfigChange('seed', parseInt(e.target.value))}
                  disabled={isSimulating || !discoveryResults}
                />
              </div>
            </div>

            <button
              className="health-check-button"
              onClick={runHealthCheck}
              disabled={isCheckingHealth || isSimulating || !discoveryResults || !config.ocdeclareFile || config.startActivities.length === 0}
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
                  {/* Cycles */}
                  {healthResult.cycles?.length > 0 && (
                    <div className="health-section health-error">
                      <div className="health-section-title">🔴 Dependency cycles (deadlock)</div>
                      {healthResult.cycles.map((cy, i) => (
                        <div key={i} className="health-item">
                          <span className="health-badge-error">CYCLE</span>
                          {cy.description}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Permanently blocked */}
                  {healthResult.permanently_blocked?.length > 0 && (
                    <div className="health-section health-error">
                      <div className="health-section-title">🔴 Activities never reaching the pool</div>
                      {healthResult.permanently_blocked.map((b, i) => (
                        <div key={i} className="health-item">
                          <span className="health-badge-error">BLOCKED</span>
                          <strong>{b.activity}</strong>
                          {b.top_blocker && b.top_blocker !== 'never attempted' && (
                            <span className="health-reason"> ← {b.top_blocker}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Chain constraint warnings */}
                  {healthResult.top_blocking_constraints?.filter(c => c.is_chain).length > 0 && (
                    <div className="health-section health-warn">
                      <div className="health-section-title">⚠ Chain constraints (common deadlock source)</div>
                      {healthResult.top_blocking_constraints.filter(c => c.is_chain).map((c, i) => (
                        <div key={i} className="health-item">
                          <span className="health-badge-warn">{c.count}×</span>
                          <code className="health-constraint-label">{c.label}</code>
                          <span className="health-reason"> blocks: {c.blocks.join(', ')}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Weak precedences */}
                  {healthResult.weak_precedences?.length > 0 && (
                    <div className="health-section health-warn">
                      <div className="health-section-title">⚠ Weak precedences (alternative paths in log)</div>
                      {healthResult.weak_precedences.map((wp, i) => (
                        <div key={i} className="health-item">
                          <span className="health-badge-warn">{wp.co_occurrence_pct}%</span>
                          <code className="health-constraint-label">precedence({wp.source}→{wp.target}) each {wp.scope_type}</code>
                          <span className="health-reason"> {wp.message}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Other top blockers */}
                  {healthResult.top_blocking_constraints?.filter(c => !c.is_chain).length > 0 && (
                    <div className="health-section health-info">
                      <div className="health-section-title">ℹ Top non-chain blocking constraints</div>
                      {healthResult.top_blocking_constraints.filter(c => !c.is_chain).slice(0, 8).map((c, i) => (
                        <div key={i} className="health-item">
                          <span className="health-badge-info">{c.count}×</span>
                          <code className="health-constraint-label">{c.label}</code>
                        </div>
                      ))}
                    </div>
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

            <button
              className="simulate-button"
              onClick={runSimulation}
              disabled={isSimulating || !discoveryResults || !config.ocdeclareFile || config.startActivities.length === 0 || hasModelWarnings}
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
              <p>Running simulation...</p>
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
                          {missingTypes.map(a => <li key={a}>{a}</li>)}
                        </ul>
                      </Collapsible>
                    )}
                  </>
                );
              })()}

              {/* ── Activity distribution comparison: simulation vs log ── */}
              {results.metrics?.activity_metrics && discoveryResults?.activity_counts && (
                <Collapsible
                  className="logs-box sim-compare-box"
                  title="📊 Activity Distribution vs Log"
                  badge={null}
                  defaultOpen={false}
                >
                  {(() => {
                    const simMetrics = results.metrics.activity_metrics;
                    const logCounts = discoveryResults.activity_counts || {};
                    const logRepeat = discoveryResults.activity_repeat_stats || {};
                    const simTotal = Object.values(simMetrics).reduce((s, m) => s + (m.execution_count || 0), 0);
                    const logTotal = Object.values(logCounts).reduce((s, v) => s + v, 0);
                    // Order by first-appearance in the simulation sequence (= process flow order).
                    // Falls back to alphabetical for activities that never fired.
                    const actSeq = results.metrics?.activity_sequence || [];
                    const flowRank = {};
                    actSeq.forEach((a, i) => { if (!(a in flowRank)) flowRank[a] = i; });
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
                              const simObjEvents = results.metrics.object_metrics
                                ? Object.values(results.metrics.object_metrics).filter(m =>
                                    m.activities && m.activities.includes(act)
                                  ).length
                                : null;
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
                  })()}
                </Collapsible>
              )}

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

              {results.activity_sequence && results.activity_sequence.length > 0 && (
                <Collapsible
                  className="activity-sequence"
                  title="Activity Sequence"
                  badge={results.activity_sequence.length}
                >
                  <div className="sequence-list">
                    {results.activity_sequence.map((activity, idx) => (
                      <span key={idx} className="activity-badge">{activity}</span>
                    ))}
                  </div>
                </Collapsible>
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
                  {results.metrics.object_metrics && Object.keys(results.metrics.object_metrics).length > 0 && (
                    <Collapsible
                      className="logs-box timing-metrics-box"
                      title="📦 Object Lifetimes"
                      badge={Object.keys(results.metrics.object_metrics).length}
                      defaultOpen={false}
                    >
                      {(() => {
                        const byType = {};
                        Object.entries(results.metrics.object_metrics).forEach(([oid, m]) => {
                          (byType[m.object_type] = byType[m.object_type] || []).push([oid, m]);
                        });
                        return Object.entries(byType).sort().map(([otype, items]) => (
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
                                    <td className="metrics-acts">{m.activities.join(' → ')}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </Collapsible>
                        ));
                      })()}
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
                objectMetrics={results.metrics && results.metrics.object_metrics ? results.metrics.object_metrics : {}}
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
                {iterationLogsOpen ? '▼' : '▶'} Iteration Trace ({iterationLogs.filter(e => e.event === 'candidates').length} steps)
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
        </div>
      </div>

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
