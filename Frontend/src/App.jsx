import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import axios from 'axios';
import './App.css';
import FlowChart from './FlowChart';
import ModelEditor from './ModelEditor';
import { O2ODiagram } from './ModelEditor';

// ── Shared utility: sort activities by log flow order ─────────────────────────
// Uses trace_position (avg position in log traces) first, then first-occurrence
// in object_traces, then alphabetical. Pass discoveryResults and optionally
// an object_traces dict from a results object.
function makeFlowRankSorter(discoveryResults, objectTraces) {
  const rank = {};
  // Primary: trace_position from discovery (average position in log)
  const tp = discoveryResults?.trace_position || {};
  Object.entries(tp).forEach(([act, pos]) => { rank[act] = pos; });
  // Secondary: first occurrence in sim object traces (fills gaps)
  if (objectTraces) {
    Object.values(objectTraces).forEach(trace => {
      (trace || []).forEach((act, i) => {
        if (!(act in rank)) rank[act] = i + 1000; // after log-ranked ones
      });
    });
  }
  return (a, b) => {
    const ra = a in rank ? rank[a] : 999999;
    const rb = b in rank ? rank[b] : 999999;
    return ra !== rb ? ra - rb : a.localeCompare(b);
  };
}

// ── ConstraintFlowGraph ───────────────────────────────────────────────────────
// Possible-routes graph derived purely from activities + constraints.
// Edges represent "A can directly precede B" based on precedence/response/succession
// constraints, after transitive reduction (A→C suppressed if A→B→C exists).
function ConstraintFlowGraph({ activities, constraints, startActivities }) {
  const [nodeOverrides, setNodeOverrides] = React.useState({});
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const dragRef = React.useRef({ type: null });
  const svgRef = React.useRef(null);
  const PAD = 44, R = 22, HGAP = 80;

  // Reset overrides when inputs change
  React.useEffect(() => { setNodeOverrides({}); setPan({ x: 0, y: 0 }); }, [activities, constraints]);

  const { nodes, edges, pos, svgW, svgH, startSet, endSet, actCreates, actDeactivates } = React.useMemo(() => {
    const actNames = (activities || []).map(a => typeof a === 'string' ? a : a.name).filter(Boolean);
    if (!actNames.length) return { nodes: [], edges: [], pos: {}, svgW: 0, svgH: 0, startSet: new Set(), endSet: new Set(), actCreates: {}, actDeactivates: {} };

    const cons = constraints || [];

    // Build per-activity binding type sets for scope validation
    // Also track which types each activity creates / deactivates
    const actBindingTypes = {}; // actName → Set<objectType>
    const actCreates = {}; // actName → [objectType]
    const actDeactivates = {}; // actName → [objectType]
    (activities || []).forEach(a => {
      const name = typeof a === 'string' ? a : a.name;
      actBindingTypes[name] = new Set((a.bindings || []).map(b => b.object_type).filter(Boolean));
      actCreates[name] = (a.bindings || []).filter(b => b.creates && b.object_type).map(b => b.object_type);
      actDeactivates[name] = (a.bindings || []).filter(b => b.deactivates && b.object_type).map(b => b.object_type);
    });

    // Ordering constraints: precedence(A→B) and response(A→B) and succession(A→B)
    // mean A can precede B. chain variants too.
    const ORDERING = new Set(['precedence', 'chain_precedence', 'response', 'chain_response', 'succession', 'chain_succession', 'alternate_response', 'alternate_precedence', 'alternate_succession', 'responded_existence']);
    const NOT_AFTER = new Set(['not_coexistence', 'not_succession', 'not_precedence', 'not_chain_succession']);

    // Raw directed edges from ordering constraints: src can precede tgt
    // Only include edge if the scope object type is actually bound by both activities.
    // (If no scope / global scope, the edge is always valid.)
    const rawEdges = new Set(); // "src→tgt"
    const forbidden = new Set(); // edges explicitly disallowed

    cons.forEach(c => {
      const src = c.source_activity || c.source;
      const tgt = c.target_activity || c.target;
      if (!src || !tgt || src === tgt) return;
      const scopeType = c.scope?.object_type || c.scope_object_type || null;
      // Scope check: if constraint is scoped to an object type, both activities
      // must have a binding for that type (otherwise the constraint is structurally
      // inapplicable and cannot actually constrain the flow between them)
      if (scopeType) {
        const srcHasScope = actBindingTypes[src]?.has(scopeType);
        const tgtHasScope = actBindingTypes[tgt]?.has(scopeType);
        if (!srcHasScope || !tgtHasScope) return; // skip — not a reachable path via this scope
      }
      if (ORDERING.has(c.constraint_type)) rawEdges.add(`${src}→${tgt}`);
      if (NOT_AFTER.has(c.constraint_type)) {
        forbidden.add(`${src}→${tgt}`);
        if (c.constraint_type === 'not_coexistence') forbidden.add(`${tgt}→${src}`);
      }
    });

    // Remove forbidden edges from raw set
    forbidden.forEach(e => rawEdges.delete(e));

    // Build adjacency for reachability
    const adj = {}; // src → Set<tgt>  (direct raw edges only)
    const revAdj = {}; // tgt → Set<src>
    actNames.forEach(n => { adj[n] = new Set(); revAdj[n] = new Set(); });
    rawEdges.forEach(e => {
      const [s, t] = e.split('→');
      if (adj[s] && adj[t] !== undefined) { adj[s].add(t); revAdj[t].add(s); }
    });

    // Transitive closure: reachable[a] = all nodes reachable from a via 2+ hops
    // We'll suppress direct edge A→C if C is reachable from A via an intermediate B
    // i.e. if ∃ B s.t. A→B and B can reach C (through raw edges)
    const reachableFrom = {};
    actNames.forEach(start => {
      const visited = new Set();
      const queue = [...adj[start]];
      while (queue.length) {
        const n = queue.shift();
        if (visited.has(n)) continue;
        visited.add(n);
        (adj[n] || new Set()).forEach(nb => queue.push(nb));
      }
      reachableFrom[start] = visited;
    });

    // Transitive reduction: keep A→B only if B is NOT reachable from A without using A→B directly
    // i.e. B should not be reachable via any other neighbour of A
    const reducedEdges = [];
    rawEdges.forEach(e => {
      const [s, t] = e.split('→');
      if (!adj[s] || !adj[t]) return;
      // Check if t is reachable from any other direct successor of s
      const otherSuccessors = [...adj[s]].filter(n => n !== t);
      const reachableViaOthers = otherSuccessors.some(n => n === t || reachableFrom[n]?.has(t));
      if (!reachableViaOthers) reducedEdges.push({ src: s, tgt: t });
    });

    // Collect all nodes that appear in edges + all model activities
    const nodeSet = new Set(actNames);
    reducedEdges.forEach(e => { nodeSet.add(e.src); nodeSet.add(e.tgt); });
    const nodes = [...nodeSet];

    if (!nodes.length) return { nodes: [], edges: [], pos: {}, svgW: 0, svgH: 0, startSet: new Set(), endSet: new Set() };

    const startSet = new Set((startActivities || []).filter(a => nodeSet.has(a)));
    // If no explicit starts, use nodes with no incoming edges
    if (!startSet.size) {
      const hasPred = new Set(reducedEdges.map(e => e.tgt));
      nodes.forEach(n => { if (!hasPred.has(n)) startSet.add(n); });
    }
    const hasSucc = new Set(reducedEdges.map(e => e.src));
    const endSet = new Set(nodes.filter(n => !hasSucc.has(n)));

    // Topological rank via longest-path from startSet
    const rankOf = {};
    nodes.forEach(n => { rankOf[n] = startSet.has(n) ? 0 : -1; });
    nodes.forEach(n => { if (rankOf[n] < 0) rankOf[n] = 0; });
    for (let pass = 0; pass < nodes.length * 2; pass++) {
      let changed = false;
      reducedEdges.forEach(({ src, tgt }) => {
        if (rankOf[src] + 1 > rankOf[tgt]) { rankOf[tgt] = rankOf[src] + 1; changed = true; }
      });
      if (!changed) break;
    }

    const numRanks = Math.max(...Object.values(rankOf), 0) + 1;
    const byRank = Array.from({ length: numRanks }, () => []);
    nodes.forEach(n => byRank[rankOf[n]].push(n));

    const maxColSize = Math.max(...byRank.map(l => l.length), 1);
    const pitch = R * 2 + Math.max(14, Math.round(120 / Math.max(maxColSize, 1)));
    const midY = PAD + R + Math.floor((maxColSize - 1) / 2) * pitch;

    // Constraint type colour per edge + count of constraints backing each edge
    const edgeType = {};
    const edgeCount = {};
    reducedEdges.forEach(({ src, tgt }) => {
      const key = `${src}→${tgt}`;
      const matching = cons.filter(c => {
        const s = c.source_activity || c.source;
        const t = c.target_activity || c.target;
        if (s !== src || t !== tgt || !ORDERING.has(c.constraint_type)) return false;
        const scopeType = c.scope?.object_type || c.scope_object_type || null;
        if (scopeType) {
          if (!actBindingTypes[src]?.has(scopeType) || !actBindingTypes[tgt]?.has(scopeType)) return false;
        }
        return true;
      });
      edgeCount[key] = matching.length;
      edgeType[key] = matching[0]?.constraint_type || 'precedence';
      // Collect all distinct scope types backing this edge
      const scopes = [...new Set(matching.map(c => c.scope?.object_type || c.scope_object_type || null).filter(Boolean))];
      edgeCount[key + '__scopes'] = scopes;
    });

    // Spine: follow highest out-degree path from first start
    const spineSet = new Set();
    const seeds = [...startSet].filter(n => nodes.includes(n));
    if (!seeds.length) seeds.push(...(byRank[0] || []));
    seeds.forEach(start => {
      spineSet.add(start);
      let cur = start;
      for (let r = rankOf[start]; r < numRanks - 1; r++) {
        const fwd = reducedEdges.filter(e => e.src === cur && rankOf[e.tgt] === r + 1);
        if (!fwd.length) break;
        cur = fwd[0].tgt;
        spineSet.add(cur);
      }
    });

    const pos = {};
    byRank.forEach((layer, r) => {
      const x = PAD + R + r * (R * 2 + HGAP);
      const spineNode = layer.find(n => spineSet.has(n)) || layer[0];
      const others = layer.filter(n => n !== spineNode);
      const above = [], below = [];
      others.forEach((n, i) => { if (i % 2 === 0) above.unshift(n); else below.push(n); });
      const ordered = [...above, spineNode, ...below];
      const spineIdx = ordered.indexOf(spineNode);
      ordered.forEach((n, i) => { pos[n] = { x, y: midY + (i - spineIdx) * pitch, rank: r }; });
    });

    // Shift up if any y < 0 — account for creates labels above nodes (up to ~20px extra)
    const maxCreatesAbove = Math.max(...Object.keys(pos).map(n => (actCreates[n]?.length || 0) * 11 + (actCreates[n]?.length ? 6 : 0)), 0);
    const minY = Math.min(...Object.values(pos).map(p => p.y));
    const dy = minY < R + PAD + maxCreatesAbove ? R + PAD + maxCreatesAbove - minY : 0;
    if (dy > 0) Object.values(pos).forEach(p => { p.y += dy; });

    const maxDeactBelow = Math.max(...Object.keys(pos).map(n => (actDeactivates[n]?.length || 0) * 11), 0);
    const svgW = Math.max(...Object.values(pos).map(p => p.x)) + R + PAD + 10;
    const svgH = Math.max(...Object.values(pos).map(p => p.y)) + R + PAD + maxDeactBelow + 10;

    return { nodes, edges: reducedEdges.map(e => ({
      ...e,
      ctype: edgeType[`${e.src}→${e.tgt}`],
      count: edgeCount[`${e.src}→${e.tgt}`] || 1,
      scopes: edgeCount[`${e.src}→${e.tgt}__scopes`] || [],
    })), pos, svgW, svgH, startSet, endSet, actCreates, actDeactivates };
  }, [activities, constraints, startActivities]);

  if (!nodes.length) return <div style={{color:'#94a3b8',fontSize:'0.82rem',padding:'1rem'}}>Add activities and constraints to see the constraint flow.</div>;

  const ctypeColor = t => t?.startsWith('response') || t?.startsWith('chain_response') || t?.startsWith('alternate_response') ? '#7c3aed'
    : t?.startsWith('chain') ? '#0369a1'
    : '#475569';

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
    const cur = effPos[name];
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

  const effPos = React.useMemo(() => {
    const m = {};
    Object.entries(pos).forEach(([n, p]) => { m[n] = nodeOverrides[n] ? { ...p, ...nodeOverrides[n] } : p; });
    return m;
  }, [pos, nodeOverrides]);

  function edgePath(src, tgt, idx, total) {
    const s = effPos[src], t = effPos[tgt]; if (!s || !t) return { d: '', lx: 0, ly: 0 };
    const dx = t.x - s.x, dy = t.y - s.y, dist = Math.sqrt(dx*dx+dy*dy) || 1;
    const ux = dx/dist, uy = dy/dist, px = -uy, py = ux;
    const spread = (idx - (total-1)/2) * 7;
    const ox = px*spread, oy = py*spread;
    const sx = s.x + ux*R + ox, sy = s.y + uy*R + oy;
    const ex = t.x - ux*R + ox, ey = t.y - uy*R + oy;
    if (t.x < s.x || (t.x === s.x && (t.rank??0) <= (s.rank??0))) {
      const bow = 55 + Math.abs(s.y-t.y)*0.35 + Math.abs(s.x-t.x)*0.25;
      return { d: `M ${sx} ${sy} C ${sx} ${sy-bow} ${ex} ${ey-bow} ${ex} ${ey}`, lx: (sx+ex)/2, ly: Math.min(sy,ey)-bow*0.55 };
    }
    const bendMag = Math.abs(dy)*0.18 + spread*0.4;
    const midX = (sx+ex)/2 + px*bendMag, midY = (sy+ey)/2 + py*bendMag;
    return { d: `M ${sx} ${sy} Q ${midX} ${midY} ${ex} ${ey}`, lx: (sx+ex)/2, ly: (sy+ey)/2 - 6 };
  }

  function nodeLabel(name, cx, cy) {
    const words = name.split(/\s+/), MAX = R*1.7;
    if (words.join('').length * 5 <= MAX * 1.3 && name.length <= 12)
      return <text x={cx} y={cy+3.5} textAnchor="middle" fontSize={8.5} fill="#111" style={{pointerEvents:'none',userSelect:'none'}}>{name}</text>;
    let best=1, bestDiff=Infinity;
    for (let i=1;i<words.length;i++) {
      const d=Math.abs(words.slice(0,i).join(' ').length-words.slice(i).join(' ').length);
      if(d<bestDiff){bestDiff=d;best=i;}
    }
    const trunc = s => s.length*5>MAX ? s.slice(0,Math.floor(MAX/5)-1)+'…' : s;
    return (<>
      <text x={cx} y={cy-3} textAnchor="middle" fontSize={8.5} fill="#111" style={{pointerEvents:'none',userSelect:'none'}}>{trunc(words.slice(0,best).join(' '))}</text>
      <text x={cx} y={cy+8} textAnchor="middle" fontSize={8.5} fill="#111" style={{pointerEvents:'none',userSelect:'none'}}>{trunc(words.slice(best).join(' '))}</text>
    </>);
  }

  const pairGroups = {};
  edges.forEach(e => { const k=`${e.src}||${e.tgt}`; (pairGroups[k]=pairGroups[k]||[]).push(e); });

  return (
    <div className="tfc-wrap">
      <div className="tfc-controls">
        <span className="tfc-edge-count">{edges.length} constraint edges</span>
        <button className="tfc-reset-btn" onClick={() => { setNodeOverrides({}); setPan({x:0,y:0}); }}>↺ Reset</button>
        <span className="tfc-legend">
          <span style={{color:'#16a34a',fontWeight:700}}>◎</span> start &nbsp;
          <span style={{color:'#dc2626',fontWeight:700}}>◎</span> end &nbsp;
          <span style={{color:'#475569',fontWeight:700}}>—</span> precedence &nbsp;
          <span style={{color:'#7c3aed',fontWeight:700}}>—</span> response &nbsp;
          <span style={{color:'#94a3b8'}}>- -</span> single constraint
        </span>
      </div>
      <div className="tfc-scroll" onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
        <svg ref={svgRef} width={svgW} height={svgH} className="tfc-svg"
          onMouseDown={onSVGMouseDown} style={{cursor:'grab'}}>
          <defs>
            <marker id="cfg-arr-grey" markerWidth="7" markerHeight="7" refX="6.5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill="#475569" />
            </marker>
            <marker id="cfg-arr-purple" markerWidth="7" markerHeight="7" refX="6.5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill="#7c3aed" />
            </marker>
            <marker id="cfg-arr-blue" markerWidth="7" markerHeight="7" refX="6.5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill="#0369a1" />
            </marker>
          </defs>
          <g transform={`translate(${pan.x},${pan.y})`}>
            {edges.map(({ src, tgt, ctype, count, scopes }) => {
              const key = `${src}||${tgt}`;
              const group = pairGroups[key] || [{}];
              const idx = group.findIndex(e => e.src === src && e.tgt === tgt);
              const { d, lx, ly } = edgePath(src, tgt, idx, group.length);
              const col = ctypeColor(ctype);
              const markerId = col === '#7c3aed' ? 'cfg-arr-purple' : col === '#0369a1' ? 'cfg-arr-blue' : 'cfg-arr-grey';
              // Abbreviate each scope type: first letter of each word
              const scopeLabels = scopes.map(s => s.split(/\s+/).map(w => w[0].toUpperCase()).join(''));
              const lineH = 10;
              const maxW = Math.max(...scopeLabels.map(l => l.length * 6.4 + 4), 0);
              return (
                <g key={`${src}->${tgt}`}>
                  <path d={d} fill="none" stroke={col} strokeWidth={1.5}
                    strokeDasharray={count === 1 ? '5,3' : undefined}
                    markerEnd={`url(#${markerId})`} />
                  {scopeLabels.length > 0 && (
                    <g>
                      <rect x={lx - maxW/2} y={ly - scopeLabels.length * lineH - 1}
                        width={maxW} height={scopeLabels.length * lineH + 2} rx={2} fill="white" opacity={0.88} />
                      {scopeLabels.map((lbl, i) => (
                        <text key={i} x={lx} y={ly - (scopeLabels.length - 1 - i) * lineH}
                          textAnchor="middle" fontSize={7.5} fill={col}
                          style={{pointerEvents:'none',userSelect:'none',fontWeight:600}}>{lbl}</text>
                      ))}
                    </g>
                  )}
                </g>
              );
            })}
            {nodes.map(name => {
              const p = effPos[name]; if (!p) return null;
              const isStart = startSet.has(name), isEnd = endSet.has(name);
              return (
                <g key={name} style={{cursor:'grab'}} onMouseDown={e => onNodeMouseDown(e, name)}>
                  {(isStart || isEnd) && (
                    <circle cx={p.x} cy={p.y} r={R+5} fill="none"
                      stroke={isStart ? '#16a34a' : '#dc2626'} strokeWidth={1.5} />
                  )}
                  <circle cx={p.x} cy={p.y} r={R}
                    fill={isStart ? '#f0fdf4' : isEnd ? '#fff1f2' : '#f8fafc'}
                    stroke={isStart ? '#16a34a' : isEnd ? '#dc2626' : '#94a3b8'} strokeWidth={1.5} />
                  {nodeLabel(name, p.x, p.y)}
                  {/* Created object types — stacked above node */}
                  {(actCreates[name] || []).map((ot, i, arr) => {
                    const abbr = ot.split(/\s+/).map(w => w[0].toUpperCase()).join('');
                    const yOff = p.y - R - 6 - (arr.length - 1 - i) * 11;
                    return (
                      <text key={'c'+i} x={p.x} y={yOff} textAnchor="middle" fontSize={7}
                        fill="#16a34a" fontWeight={700} style={{pointerEvents:'none',userSelect:'none'}}>+{abbr}</text>
                    );
                  })}
                  {/* Deactivated object types — stacked below node */}
                  {(actDeactivates[name] || []).map((ot, i) => {
                    const abbr = ot.split(/\s+/).map(w => w[0].toUpperCase()).join('');
                    const yOff = p.y + R + 9 + i * 11;
                    return (
                      <text key={'d'+i} x={p.x} y={yOff} textAnchor="middle" fontSize={7}
                        fill="#dc2626" fontWeight={700} style={{pointerEvents:'none',userSelect:'none'}}>−{abbr}</text>
                    );
                  })}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}

const TFC_R = 22;
const TFC_HGAP = 80;
const TFC_PAD  = 44;

function tfc_layout(matrix, threshold, startSet, endSet, tracePosition, forbiddenEdges) {
  // ── Edges ──────────────────────────────────────────────────────────────────
  const edges = [];
  Object.entries(matrix).forEach(([src, tgts]) => {
    Object.entries(tgts)
      .filter(([tgt, p]) => tgt !== src && p >= threshold && !(forbiddenEdges && forbiddenEdges.has(`${src}→${tgt}`)))
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

function TransitionFlowChart({ matrix, activityCounts, startActivities, traceEndProb, likelyEndActivities, tracePosition, constraints }) {
  const [threshold, setThreshold] = useState(0.05);

  // Compute forbidden directed pairs from constraints
  const forbiddenEdges = useMemo(() => {
    const set = new Set();
    (constraints || []).forEach(c => {
      const src = c.source_activity;
      const tgt = c.target_activity;
      if (!src || !tgt) return;
      // not_coexistence: neither can follow the other
      if (c.constraint_type === 'not_coexistence') {
        set.add(`${src}→${tgt}`);
        set.add(`${tgt}→${src}`);
      }
      // not_succession: tgt cannot follow src
      if (c.constraint_type === 'not_succession') {
        set.add(`${src}→${tgt}`);
      }
      // not_precedence: tgt cannot be preceded by src (same direction)
      if (c.constraint_type === 'not_precedence') {
        set.add(`${src}→${tgt}`);
      }
      // not_chain_succession: tgt cannot immediately follow src
      if (c.constraint_type === 'not_chain_succession') {
        set.add(`${src}→${tgt}`);
      }
    });
    return set;
  }, [constraints]);

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
    () => tfc_layout(matrix, threshold, startNodes, endNodes, tracePosition || {}, forbiddenEdges),
    [matrix, threshold, startNodes, endNodes, tracePosition, forbiddenEdges]
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
// Hover popup showing all constraints connected to an activity
function ActivityConstraintTooltip({ activityName, constraints }) {
  const [pos, setPos] = React.useState(null);
  const triggerRef = React.useRef(null);
  const related = React.useMemo(() => (constraints || []).filter(c =>
    c.source_activity === activityName || c.target_activity === activityName
  ), [activityName, constraints]);

  const show = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const popW = 420, popH = Math.min(40 + related.length * 28, 400);
    const vw = window.innerWidth, vh = window.innerHeight;
    // Prefer below, flip to above if not enough room
    let top = rect.bottom + 6;
    if (top + popH > vh - 8) top = rect.top - popH - 6;
    // Prefer left-aligned with trigger, shift left if overflows right
    let left = rect.left;
    if (left + popW > vw - 8) left = vw - popW - 8;
    if (left < 8) left = 8;
    setPos({ top, left, popW });
  };

  const hide = () => setPos(null);

  if (!related.length) return <span>{activityName}</span>;
  return (
    <>
      <span ref={triggerRef} style={{cursor:'help',borderBottom:'1px dashed #94a3b8'}}
        onMouseEnter={show} onMouseLeave={hide}>
        {activityName}
      </span>
      {pos && ReactDOM.createPortal(
        <div onMouseEnter={show} onMouseLeave={hide} style={{
          position:'fixed', zIndex:9999,
          top: pos.top, left: pos.left, width: pos.popW,
          background:'white', border:'1px solid #e2e8f0', borderRadius:'8px',
          boxShadow:'0 4px 20px rgba(0,0,0,0.14)', padding:'0.65rem 0.8rem',
          pointerEvents:'auto',
        }}>
          <div style={{fontSize:'0.7rem',fontWeight:700,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.04em',marginBottom:'0.4rem'}}>
            Constraints — {activityName} ({related.length})
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:'0.22rem',maxHeight:'360px',overflowY:'auto'}}>
            {related.map((c, i) => (
              <div key={i} style={{display:'flex',alignItems:'center',gap:'0.4rem',fontSize:'0.78rem',flexWrap:'wrap'}}>
                <span className={`constraint-type-badge ${c.constraint_type}`} style={{flexShrink:0,fontSize:'0.65rem'}}>
                  {(c.constraint_type||'').replace(/_/g,' ')}
                </span>
                <span style={{color: c.source_activity === activityName ? '#1e293b' : '#94a3b8', fontWeight: c.source_activity === activityName ? 600 : 400}}>
                  {c.source_activity || '—'}
                </span>
                <span style={{color:'#94a3b8',fontSize:'0.7rem'}}>→</span>
                <span style={{color: c.target_activity === activityName ? '#1e293b' : '#94a3b8', fontWeight: c.target_activity === activityName ? 600 : 400}}>
                  {c.target_activity || '—'}
                </span>
                {(c.scope?.object_type || c.scope_object_type) && (
                  <span style={{color:'#64748b',fontSize:'0.65rem'}}>[{c.scope?.object_type || c.scope_object_type}]</span>
                )}
                {(c.nmin != null || c.nmax != null) && (
                  <span style={{color:'#475569',fontSize:'0.65rem',marginLeft:'auto',whiteSpace:'nowrap'}}>
                    {c.nmin != null ? `n≥${c.nmin}` : ''}{c.nmin != null && c.nmax != null ? ' ' : ''}{c.nmax != null ? `n≤${c.nmax}` : ''}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

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
  hideButton = false,
  mode, setMode, singleActivity, setSingleActivity,
}) {

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
        <h2>Discover Time Distributions</h2>
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

      {!hideButton && (
      <button
        className="timing-discover-btn"
        onClick={handleDiscover}
        disabled={isDiscovering || !canDiscover}
        style={{ marginTop: '1rem' }}
      >
        {isDiscovering ? 'Discovering…' : '⏱ Discover Time Distributions'}
      </button>
      )}

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
  timingDiscoveryResult, results, workflowMode, onChangeMode }) {

  const barRef = React.useRef(null);
  React.useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const update = () => {
      document.documentElement.style.setProperty('--topbar-h', el.offsetHeight + 'px');
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    <div className="workflow-topbar" ref={barRef}>
      <div className="topbar-files">
        {modeLabel && (
          <span className="topbar-mode-section">
            <span className="topbar-mode-label">Mode:</span>
            <span className="topbar-mode-badge">{modeLabel}</span>
            {onChangeMode && (
              <button className="mode-switch-btn topbar-mode-change-btn" onClick={onChangeMode} title="Switch workflow mode">
                ↩ Change
              </button>
            )}
          </span>
        )}
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


// ── EvaluationTab ─────────────────────────────────────────────────────────────
function ActivityBarChart({ logDurations, simDurations, metric, title, orderedActivities }) {
  const [mode, setMode] = React.useState('mean');
  const activities = orderedActivities?.length
    ? orderedActivities.filter(a => logDurations?.[a] || simDurations?.[a])
    : [...new Set([...Object.keys(logDurations || {}), ...Object.keys(simDurations || {})])].sort();

  if (activities.length === 0) return (
    <p style={{fontSize:'0.8rem',color:'#94a3b8',fontStyle:'italic',padding:'0.5rem 0'}}>No data available for this metric.</p>
  );

  // Both sides use the same discovered format from compute_ocpa_metrics
  const keyMap = {
    service: { mean: 'service_mean', min: 'service_min', max: 'service_max' },
    waiting: { mean: 'waiting_mean', min: null,          max: null },
  };
  const k = keyMap[metric]?.[mode];

  const logVals = activities.map(a => {
    const v = k ? logDurations?.[a]?.[k] : null;
    return (v != null && v > 0) ? v : null;
  });
  const simVals = activities.map(a => {
    const v = k ? simDurations?.[a]?.[k] : null;
    return (v != null && v > 0) ? v : null;
  });

  const allVals = [...simVals, ...logVals].filter(v => v != null);
  if (allVals.length === 0) return (
    <p style={{fontSize:'0.8rem',color:'#94a3b8',fontStyle:'italic',padding:'0.5rem 0'}}>No data for this metric/mode combination.</p>
  );
  const maxVal = Math.max(...allVals);

  const timeUnit = maxVal > 86400 ? 'days' : maxVal > 3600 ? 'h' : maxVal > 60 ? 'min' : 's';
  const divider = timeUnit === 'days' ? 86400 : timeUnit === 'h' ? 3600 : timeUnit === 'min' ? 60 : 1;
  const fmtV = v => v == null ? '' : (v / divider).toFixed(timeUnit === 'days' || timeUnit === 'h' ? 1 : 0);
  const fmtLabel = v => v == null ? '—' : `${fmtV(v)} ${timeUnit}`;

  const BAR_H = 160, Y_LABEL_W = 52, NAME_H = 90;
  const barW = Math.max(28, Math.min(52, Math.floor(520 / Math.max(activities.length, 1))));
  const gap = Math.max(8, Math.floor(barW * 0.25));
  const chartW = activities.length * (barW + gap) + Y_LABEL_W + 10;
  const ticks = [maxVal, maxVal / 2, 0];

  const renderChart = (vals, color) => (
    <svg width={chartW} height={BAR_H + NAME_H} style={{overflow:'visible', display:'block'}}>
      <line x1={Y_LABEL_W} y1={0} x2={Y_LABEL_W} y2={BAR_H} stroke="#e2e8f0" strokeWidth={1}/>
      {ticks.map((tv, ti) => {
        const ty = ti === 0 ? 2 : ti === 1 ? BAR_H / 2 : BAR_H;
        return (
          <g key={ti}>
            <line x1={Y_LABEL_W - 4} y1={ty} x2={Y_LABEL_W} y2={ty} stroke="#cbd5e1" strokeWidth={1}/>
            <text x={Y_LABEL_W - 6} y={ty + 4} textAnchor="end" fontSize="9" fill="#64748b">
              {tv > 0 ? `${fmtV(tv)} ${timeUnit}` : '0'}
            </text>
            {ti < 2 && <line x1={Y_LABEL_W} y1={ty} x2={chartW} y2={ty} stroke="#f1f5f9" strokeWidth={1}/>}
          </g>
        );
      })}
      {activities.map((act, i) => {
        const v = vals[i];
        const h = v != null && maxVal > 0 ? Math.max(2, (v / maxVal) * BAR_H) : 0;
        const x = Y_LABEL_W + i * (barW + gap) + gap / 2;
        const y = BAR_H - h;
        const lx = x + barW / 2, ly = BAR_H + 8;
        return (
          <g key={act}>
            <rect x={x} y={y} width={barW} height={h} fill={color} fillOpacity={0.8} rx={3}>
              <title>{act}: {fmtLabel(v)}</title>
            </rect>
            {v != null && h > 16 && (
              <text x={x + barW/2} y={y+11} textAnchor="middle" fontSize="8" fill="white" fontWeight="600">{fmtV(v)}</text>
            )}
            <text x={lx} y={ly} textAnchor="end" fontSize="9" fill="#475569"
              transform={`rotate(-45,${lx},${ly})`}>{act}</text>
          </g>
        );
      })}
    </svg>
  );

  return (
    <div className="eval-chart-wrap">
      <div className="eval-chart-header">
        <span className="eval-chart-title">{title}</span>
        <div className="eval-chart-mode-btns">
          {['mean', 'min', 'max'].map(m => (
            <button key={m} className={`eval-mode-btn${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>{m}</button>
          ))}
        </div>
      </div>
      <div className="eval-charts-row">
        <div className="eval-chart-side">
          <div className="eval-chart-side-label">Input Log</div>
          {renderChart(logVals, '#6366f1')}
        </div>
        <div className="eval-chart-side">
          <div className="eval-chart-side-label">Simulation Output</div>
          {renderChart(simVals, '#10b981')}
        </div>
      </div>
    </div>
  );
}


// ── OC-Declare conformance per Definition 8 & 9 ─────────────────────────────
function computeOCDeclareConformance(events, objectTypesMap, constraints) {
  // events: [{id, activity, timestamp, object_ids}]
  // objectTypesMap: {oid → type}
  // constraints: model constraints array

  if (!events || events.length === 0 || !constraints || constraints.length === 0) return null;

  const n = events.length;

  // Build per-event object-set and per-activity index for O(1) lookup
  const eventObjs = events.map(e => new Set(e.object_ids || []));

  // Index events by activity for fast filtering — avoids O(n) scan per source event
  const byActivity = {};
  events.forEach((e, i) => {
    (byActivity[e.activity] = byActivity[e.activity] || []).push(i);
  });

  // Pre-sort check: events are assumed sorted by timestamp.
  // For forward-looking constraints (response/precedence), use binary search
  // to find the first event with ts >= srcTs instead of scanning all n events.
  const sortedTs = events.map(e => e.timestamp);

  const firstIndexAtOrAfter = (ts) => {
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo+hi)>>1; sortedTs[mid] < ts ? lo=mid+1 : hi=mid; }
    return lo;
  };

  // Temporal filter — returns indices of target-activity events in the correct window
  // Uses activity index + binary search instead of full O(n) scan
  const temporalFilter = (srcIdx, ctype, tgtActivity) => {
    const srcTs = events[srcIdx].timestamp;
    // Chain constraints: only immediately adjacent
    if (ctype === 'chain_response')   return srcIdx + 1 < n ? [srcIdx + 1] : [];
    if (ctype === 'chain_precedence') return srcIdx - 1 >= 0 ? [srcIdx - 1] : [];

    const tgtIndices = byActivity[tgtActivity] || [];
    if (ctype === 'response' || ctype === 'chain_response' || ctype === 'succession' ||
        ctype === 'alternate_response' || ctype === 'precedence' || ctype === 'alternate_precedence') {
      // Only events at or after srcTs — use binary search
      const start = firstIndexAtOrAfter(srcTs);
      return tgtIndices.filter(j => j >= start && j !== srcIdx);
    }
    // not_succession, not_coexistence, responded_existence — no temporal restriction
    return tgtIndices.filter(j => j !== srcIdx);
  };

  // Per-event satisfaction: event i satisfies constraint c?
  // Only events of c.source_activity are evaluated; others trivially satisfy.
  const satisfies = (i, c) => {
    if (events[i].activity !== c.source_activity) return true; // trivial

    const nmin = c.nmin ?? 1;
    const nmax = c.nmax ?? null;
    const tgt  = c.target_activity;
    const scope = c.scope || { kind: 'global' };

    // Candidate events: of target activity, in correct temporal window
    // temporalFilter now takes tgt activity and returns only tgt events — no extra filter needed
    const tgtCandidates = temporalFilter(i, c.constraint_type, tgt);

    if (scope.kind === 'global') {
      const cnt = tgtCandidates.length;
      if (c.constraint_type === 'not_coexistence' || c.constraint_type === 'not_succession') {
        return cnt === 0;
      }
      return cnt >= nmin && (nmax == null || cnt <= nmax);
    }

    // scope.kind === 'each' — must hold for every object of scope.object_type in event i
    // scope.kind === 'any'  — must hold for at least one object
    // scope.kind === 'all'  — target event must involve ALL scope objects together
    const scopeObjs = [...eventObjs[i]].filter(oid => objectTypesMap[oid] === scope.object_type);

    if (scopeObjs.length === 0) {
      return true; // no scope objects — vacuously satisfied
    }

    if (scope.kind === 'all') {
      // All: find a target event that involves ALL scope objects simultaneously
      const allSet = new Set(scopeObjs);
      const isNeg = c.constraint_type === 'not_coexistence' || c.constraint_type === 'not_succession';
      const hasJointFiring = tgtCandidates.some(j => scopeObjs.every(oid => eventObjs[j].has(oid)));
      if (isNeg) return !hasJointFiring;
      const jointCount = tgtCandidates.filter(j => scopeObjs.every(oid => eventObjs[j].has(oid))).length;
      return jointCount >= nmin && (nmax == null || jointCount <= nmax);
    }

    if (scope.kind === 'any') {
      // Any: at least one scope object must satisfy
      const isNeg = c.constraint_type === 'not_coexistence' || c.constraint_type === 'not_succession';
      for (const oid of scopeObjs) {
        const matching = tgtCandidates.filter(j => eventObjs[j].has(oid));
        const cnt = matching.length;
        if (isNeg) {
          if (cnt === 0) return true; // this object has no forbidden co-occurrence → satisfied
        } else {
          if (cnt >= nmin && (nmax == null || cnt <= nmax)) return true;
        }
      }
      return isNeg ? false : false; // none satisfied
    }

    // each: must hold for every object
    for (const oid of scopeObjs) {
      const matching = tgtCandidates.filter(j => eventObjs[j].has(oid));
      const cnt = matching.length;
      if (c.constraint_type === 'not_coexistence' || c.constraint_type === 'not_succession') {
        if (cnt > 0) return false;
      } else {
        if (cnt < nmin) return false;
        if (nmax != null && cnt > nmax) return false;
      }
    }
    return true;
  };

  // Per-constraint confidence (Def 9)
  const constraintResults = constraints.map(c => {
    const sourceEvents = events.filter((e, i) => e.activity === c.source_activity);
    if (sourceEvents.length === 0) return null; // not applicable
    const srcIndices = events.reduce((acc, e, i) => { if (e.activity === c.source_activity) acc.push(i); return acc; }, []);
    let satisfied = 0;
    for (const i of srcIndices) {
      if (satisfies(i, c)) satisfied++;
    }
    const confidence = satisfied / srcIndices.length;
    const label = `${c.constraint_type}(${c.source_activity}→${c.target_activity})`;
    return { label, confidence, satisfied, total: srcIndices.length, constraint: c };
  }).filter(Boolean);

  // Global conformance: fraction of ALL events that satisfy ALL constraints
  let globalSatisfied = 0;
  for (let i = 0; i < n; i++) {
    const allSat = constraints.every(c => satisfies(i, c));
    if (allSat) globalSatisfied++;
  }
  const globalConformance = n > 0 ? globalSatisfied / n : null;

  return { constraintResults, globalConformance, globalSatisfied, totalEvents: n };
}

function PerObjectTypeBreakdown({ fitnessPerObject, objectTypesMap }) {
  const [expandedType, setExpandedType] = React.useState(null);

  // Group objects by type
  const byType = React.useMemo(() => {
    const groups = {};
    Object.entries(fitnessPerObject).forEach(([oid, d]) => {
      const otype = objectTypesMap[oid] || 'Unknown';
      if (!groups[otype]) groups[otype] = [];
      groups[otype].push({ oid, ...d });
    });
    return groups;
  }, [fitnessPerObject, objectTypesMap]);

  const typeSummary = Object.entries(byType).map(([otype, objs]) => {
    const totalEvents   = objs.reduce((s, o) => s + o.total, 0);
    const totalEnabled  = objs.reduce((s, o) => s + o.enabled, 0);
    const rate = totalEvents > 0 ? totalEnabled / totalEvents : 1;
    const worstObj = objs.slice().sort((a, b) => (a.enabled/a.total) - (b.enabled/b.total))[0];
    return { otype, objs, totalEvents, totalEnabled, rate, count: objs.length, worstObj };
  }).sort((a, b) => a.rate - b.rate);

  const pct = v => `${(v * 100).toFixed(1)}%`;
  const rateClass = r => r >= 0.8 ? 'conf-good' : r >= 0.5 ? 'conf-mid' : 'conf-bad';

  return (
    <div>
      {/* Type-level summary table */}
      <table className="conf-detail-table" style={{marginBottom:'0.75rem'}}>
        <thead>
          <tr>
            <th>Object Type</th>
            <th className="audit-num">Objects</th>
            <th className="audit-num">Total events</th>
            <th className="audit-num">Enabled</th>
            <th className="audit-num">Fitness</th>
            <th className="audit-num">Worst object</th>
          </tr>
        </thead>
        <tbody>
          {typeSummary.map(({ otype, objs, totalEvents, totalEnabled, rate, count, worstObj }) => (
            <tr key={otype} className={rate < 0.5 ? 'audit-row-accumulating' : ''}>
              <td style={{fontWeight:600}}>{otype}</td>
              <td className="audit-num">{count}</td>
              <td className="audit-num">{totalEvents}</td>
              <td className="audit-num">{totalEnabled}</td>
              <td className="audit-num"><span className={rateClass(rate)}>{pct(rate)}</span></td>
              <td className="audit-num" style={{fontSize:'0.72rem',color:'#64748b'}}>
                {worstObj && worstObj.total > 0
                  ? `${worstObj.oid} (${pct(worstObj.enabled/worstObj.total)})`
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Per-type expandable object list */}
      {typeSummary.map(({ otype, objs }) => (
        <div key={otype} style={{marginBottom:'0.4rem'}}>
          <button
            className="conf-expand-type-btn"
            onClick={() => setExpandedType(expandedType === otype ? null : otype)}
          >
            {expandedType === otype ? '▼' : '▶'} {otype} — {objs.length} object{objs.length !== 1 ? 's' : ''}
            {objs.length > 200 && (
              <span className="conf-expand-warn"> ⚠ {objs.length} objects — may be slow to render</span>
            )}
          </button>
          {expandedType === otype && (
            <table className="conf-detail-table" style={{marginTop:'0.25rem'}}>
              <thead>
                <tr>
                  <th>Object ID</th>
                  <th className="audit-num">Events Completed</th>
                  <th className="audit-num">Enabled</th>
                  <th className="audit-num">Fitness</th>
                </tr>
              </thead>
              <tbody>
                {objs
                  .slice()
                  .sort((a, b) => (a.enabled/a.total) - (b.enabled/b.total))
                  .map(o => {
                    const r = o.total > 0 ? o.enabled / o.total : 1;
                    return (
                      <tr key={o.oid} className={r < 0.5 ? 'audit-row-accumulating' : ''}>
                        <td style={{fontFamily:'monospace',fontSize:'0.75rem'}}>{o.oid}</td>
                        <td className="audit-num">{o.total}</td>
                        <td className="audit-num">{o.enabled}</td>
                        <td className="audit-num">
                          <span className={rateClass(r)}>{pct(r)}</span>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

// ── ConformanceSection ────────────────────────────────────────────────────────
function computeConformance(objectTraces, constraints, activities) {
  // Build lookup: activity name → binding object types
  const actBindings = {};
  (activities || []).forEach(a => { actBindings[a.name] = (a.bindings || []).map(b => b.object_type); });

  // For each object trace, simulate which activities were enabled at each step.
  // We track: for each constraint, whether it was satisfied by the end of the trace.
  // State per object trace: counts of how often each activity fired so far.

  // ── Declarative Token-Replay Fitness ──────────────────────────────────────
  // Per object: for each event in its trace, check if that activity was enabled
  // (all precedence constraints already satisfied at that point).
  // fitness = enabled_events / total_events across all objects.

  let fitnessEnabled = 0, fitnessTotal = 0;
  const fitnessPerObject = {}; // oid → { enabled, total }

  // ── Declarative Constraint Fitness ────────────────────────────────────────
  // Per constraint × object: satisfied at end of trace?
  // ratio = satisfied / evaluated

  let constraintSatisfied = 0, constraintTotal = 0;
  const constraintDetail = {}; // constraint label → { satisfied, total }

  // ── Declarative Precision ─────────────────────────────────────────────────
  // Per transition (position i → i+1 in trace): was the observed next activity
  // in the allowed set (not blocked by any constraint)?
  // precision = allowed_transitions / total_transitions

  let precisionAllowed = 0, precisionTotal = 0;
  const precisionDetail = {}; // constraint label → { blocked_observed, total_transitions }
  // For each transition, also track which constraints were blocking candidates

  const allActNames = (activities || []).map(a => a.name);

  Object.entries(objectTraces || {}).forEach(([oid, trace]) => {
    if (!trace || trace.length === 0) return;

    // Track how many times each activity fired on this object so far
    const fired = {}; // activity → count
    const lastFired = {}; // activity → last index it fired

    fitnessPerObject[oid] = { enabled: 0, total: trace.length };

    trace.forEach((act, step) => {
      fitnessTotal++;

      // Check if this activity was enabled at this step
      // An activity is enabled if all its precedence constraints are satisfied
      const relevantPrecs = constraints.filter(c =>
        c.constraint_type === 'precedence' && c.target_activity === act
      );
      const enabled = relevantPrecs.every(c => {
        const srcCount = fired[c.source_activity] || 0;
        const nmin = c.nmin ?? 1;
        const nmax = c.nmax ?? null;
        if (nmin > 0 && srcCount === 0) return false;
        if (nmax !== null && srcCount > nmax) return false;
        return true;
      });

      if (enabled) {
        fitnessEnabled++;
        fitnessPerObject[oid].enabled++;
      }

      // Fire the activity — update state
      fired[act] = (fired[act] || 0) + 1;
      lastFired[act] = step;

      // ── Precision: after firing act, what was allowed next? ──────────────
      if (step < trace.length - 1) {
        const nextAct = trace[step + 1];
        const tempFired = { ...fired };

        // For each activity, track which constraints block it
        const blockedBy = {}; // candidate → [constraint label]
        allActNames.forEach(candidate => {
          const blocks = [];
          constraints.filter(c =>
            c.constraint_type === 'precedence' && c.target_activity === candidate
          ).forEach(c => {
            const srcCount = tempFired[c.source_activity] || 0;
            const nmin = c.nmin ?? 1;
            const nmax = c.nmax ?? null;
            const label = `${c.constraint_type}(${c.source_activity}→${c.target_activity})`;
            if (nmin > 0 && srcCount === 0) blocks.push(label);
            else if (nmax !== null && srcCount > nmax) blocks.push(label);
          });
          constraints.filter(c =>
            (c.constraint_type === 'not_coexistence' || c.constraint_type === 'not_succession') &&
            (c.source_activity === candidate || c.target_activity === candidate)
          ).forEach(c => {
            const other = c.source_activity === candidate ? c.target_activity : c.source_activity;
            const label = `${c.constraint_type}(${c.source_activity}→${c.target_activity})`;
            if (c.constraint_type === 'not_succession' && c.source_activity !== candidate) {
              if (tempFired[c.source_activity] > 0) blocks.push(label);
            }
            if (c.constraint_type === 'not_coexistence') {
              if (tempFired[other] > 0) blocks.push(label);
            }
          });
          if (blocks.length > 0) blockedBy[candidate] = blocks;
        });

        const allowed = new Set(allActNames.filter(c => !blockedBy[c]));

        // Track per-constraint precision: how many times did this constraint
        // block the OBSERVED next activity (i.e. caused imprecision)?
        // We count total transitions for each constraint as a denominator
        // (how many times was it active / relevant at this step)
        const activeConstraintLabels = new Set();
        Object.values(blockedBy).forEach(labels => labels.forEach(l => activeConstraintLabels.add(l)));
        activeConstraintLabels.forEach(label => {
          if (!precisionDetail[label]) precisionDetail[label] = { blocked_observed: 0, total: 0 };
          precisionDetail[label].total++;
          // If the next observed activity was blocked by this constraint → imprecise for it
          if (blockedBy[nextAct]?.includes(label)) precisionDetail[label].blocked_observed++;
        });
        // Also record constraints that blocked the observed next activity
        // but weren't counted above (because they only blocked nextAct specifically)
        if (blockedBy[nextAct]) {
          blockedBy[nextAct].forEach(label => {
            if (!precisionDetail[label]) precisionDetail[label] = { blocked_observed: 0, total: 0 };
            if (!activeConstraintLabels.has(label)) {
              precisionDetail[label].total++;
              precisionDetail[label].blocked_observed++;
            }
          });
        }

        precisionTotal++;
        if (allowed.has(nextAct)) precisionAllowed++;
      }
    });

    // ── Constraint fitness: check each constraint at end of trace ─────────
    constraints.forEach(c => {
      const label = `${c.constraint_type}(${c.source_activity}→${c.target_activity})`;
      const srcCount = fired[c.source_activity] || 0;
      const tgtCount = fired[c.target_activity] || 0;
      const nmin = c.nmin ?? 1;

      let evaluated = false;
      let satisfied = false;

      if (c.constraint_type === 'response') {
        // If source fired, target must eventually follow
        if (srcCount > 0) {
          evaluated = true;
          satisfied = tgtCount >= srcCount;
        }
      } else if (c.constraint_type === 'precedence') {
        // If target fired, source must have preceded it
        if (tgtCount > 0) {
          evaluated = true;
          satisfied = srcCount >= nmin;
        }
      } else if (c.constraint_type === 'not_coexistence') {
        // Both must not appear
        evaluated = true;
        satisfied = !(srcCount > 0 && tgtCount > 0);
      } else if (c.constraint_type === 'not_succession') {
        // After source, target must never follow
        if (srcCount > 0) {
          evaluated = true;
          // Check if target fired after source's last position
          const srcLast = lastFired[c.source_activity] ?? -1;
          const tgtLast = lastFired[c.target_activity] ?? -1;
          satisfied = tgtLast <= srcLast;
        }
      }

      if (evaluated) {
        constraintTotal++;
        if (satisfied) constraintSatisfied++;
        if (!constraintDetail[label]) constraintDetail[label] = { satisfied: 0, total: 0, type: c.constraint_type };
        constraintDetail[label].total++;
        if (satisfied) constraintDetail[label].satisfied++;
      }
    });
  });

  return {
    fitness: fitnessTotal > 0 ? fitnessEnabled / fitnessTotal : null,
    fitnessEnabled, fitnessTotal,
    fitnessPerObject,
    constraintFitness: constraintTotal > 0 ? constraintSatisfied / constraintTotal : null,
    constraintSatisfied, constraintTotal, constraintDetail,
    precision: precisionTotal > 0 ? precisionAllowed / precisionTotal : null,
    precisionAllowed, precisionTotal, precisionDetail,
  };
}

function ConformanceSection({ results, activeModel, onConformanceSaved, onEventsLoadStart, onEventsLoadDone, onConformanceDone, onScoresComputed, inputLogConfResults, inputEventLogFile }) {
  const constraints  = activeModel?.constraints || [];
  const activities   = activeModel?.activities  || [];
  const objectTraces = results?.object_traces   || {};
  const runId        = results?.output_file     || null;
  const typesMap     = results?.object_types_map || {};

  // OC-Declare conformance — load full event list from output OCEL
  const [ocdEvents,      setOcdEvents]      = React.useState(null);
  const [ocdLoading,     setOcdLoading]     = React.useState(false);
  const [ocdError,       setOcdError]       = React.useState(null);
  const ocdLoadedFor = React.useRef(null);

  // Input log conformance — load events from input OCEL for comparison
  const [inputLogEvents,    setInputLogEvents]    = React.useState(null);
  const [inputLogTypesMap,  setInputLogTypesMap]  = React.useState({});
  const [inputLogObjTraces, setInputLogObjTraces] = React.useState({});
  const inputLogLoadedFor = React.useRef(null);

  React.useEffect(() => {
    if (!inputEventLogFile || inputLogLoadedFor.current === inputEventLogFile) return;
    inputLogLoadedFor.current = inputEventLogFile;
    axios.get(`/api/eventlog-events?file=${encodeURIComponent(inputEventLogFile)}`)
      .then(r => {
        const evts = r.data.events || [];
        const tmap = r.data.object_types_map || {};
        setInputLogEvents(evts);
        setInputLogTypesMap(tmap);
        // Build per-object traces for fitness/precision
        const traces = {};
        evts.forEach(e => {
          (e.object_ids || []).forEach(oid => {
            (traces[oid] = traces[oid] || []).push(e.activity);
          });
        });
        setInputLogObjTraces(traces);
      })
      .catch(() => {});
  }, [inputEventLogFile]);

  React.useEffect(() => {
    if (!runId || ocdLoadedFor.current === runId) return;
    ocdLoadedFor.current = runId;
    setOcdLoading(true);
    setOcdError(null);
    onEventsLoadStart?.();
    axios.get(`/api/run-history/${encodeURIComponent(runId)}/events`)
      .then(r => { setOcdEvents(r.data.events || []); onEventsLoadDone?.(); })
      .catch(e => { setOcdError(e.response?.data?.error || e.message); onEventsLoadDone?.(); })
      .finally(() => setOcdLoading(false));
  }, [runId]);

  // OC-Declare conformance uses a full object type map built from ALL objects
  const fullTypesMap = React.useMemo(() => {
    const m = { ...typesMap };
    (results?.object_types ? Object.entries(results.object_types) : []).forEach(([otype, count]) => {
      // already have per-object map; just keep typesMap
    });
    return m;
  }, [typesMap, results]);

  const ocdConf = React.useMemo(() => {
    if (!ocdEvents || ocdEvents.length === 0) return null;
    return computeOCDeclareConformance(ocdEvents, fullTypesMap, constraints);
  }, [ocdEvents, fullTypesMap, constraints]);

  React.useEffect(() => { if (ocdConf) onConformanceDone?.(); }, [ocdConf]);

  // Input log OC-Declare conformance (from already-loaded events)
  const inputOcdConf = React.useMemo(() => {
    if (!inputLogEvents || inputLogEvents.length === 0) return null;
    return computeOCDeclareConformance(inputLogEvents, inputLogTypesMap, constraints);
  }, [inputLogEvents, inputLogTypesMap, constraints]);

  // Input log fitness/precision (from per-object traces built from input OCEL)
  const inputConf = React.useMemo(
    () => Object.keys(inputLogObjTraces).length > 0
      ? computeConformance(inputLogObjTraces, constraints, activities)
      : null,
    [inputLogObjTraces, constraints, activities]
  );

  const conf = React.useMemo(
    () => computeConformance(objectTraces, constraints, activities),
    [objectTraces, constraints, activities]
  );

  // Propagate scores to parent for inline display as soon as computed
  React.useEffect(() => {
    if (conf.fitness != null) {
      onScoresComputed?.({ fitness: conf.fitness, constraint_fitness: conf.constraintFitness, precision: conf.precision });
    }
  }, [conf.fitness, conf.constraintFitness, conf.precision]);

  // Persist scores back to run history once computed
  const persistedRef = React.useRef(null);
  React.useEffect(() => {
    if (!runId || conf.fitness == null || persistedRef.current === runId) return;
    persistedRef.current = runId;
    axios.patch(`/api/run-history/${encodeURIComponent(runId)}/conformance`, {
      fitness:            conf.fitness,
      constraint_fitness: conf.constraintFitness,
      precision:          conf.precision,
    }).then(() => { onConformanceSaved?.(); }).catch(() => {});
  }, [runId, conf.fitness, conf.constraintFitness, conf.precision]);

  const pct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
  const cls = v => v == null ? '' : v >= 0.8 ? 'conf-good' : v >= 0.5 ? 'conf-mid' : 'conf-bad';
  const MetricRow = ({ label, value, explanation, formula }) => (
    <div className="conf-metric-row">
      <div className="conf-metric-main">
        <span className="conf-metric-label">{label}</span>
        <span className={`conf-metric-value ${value != null ? (value >= 0.8 ? 'conf-good' : value >= 0.5 ? 'conf-mid' : 'conf-bad') : ''}`}>
          {pct(value)}
        </span>
      </div>
      <p className="conf-metric-explanation">{explanation}</p>
      {formula && (
        <details className="formula-details">
          <summary className="formula-summary">Formula</summary>
          <div className="formula-body">{formula}</div>
        </details>
      )}
    </div>
  );
  // Split row: label | input log score | sim score
  const MetricRowSplit = ({ label, logValue, simValue, explanation }) => (
    <div className="conf-metric-row">
      <div className="conf-metric-main" style={{gap:'0'}}>
        <span className="conf-metric-label" style={{flex:1}}>{label}</span>
        <div style={{display:'flex',gap:'0.75rem',alignItems:'center'}}>
          <div style={{textAlign:'center',minWidth:'60px'}}>
            <div style={{fontSize:'0.6rem',color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.04em'}}>Input log</div>
            <span className={`conf-metric-value ${cls(logValue)}`} style={{fontSize:'1rem'}}>{pct(logValue)}</span>
          </div>
          <div style={{fontSize:'0.8rem',color:'#cbd5e1'}}>→</div>
          <div style={{textAlign:'center',minWidth:'60px'}}>
            <div style={{fontSize:'0.6rem',color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.04em'}}>Simulation</div>
            <span className={`conf-metric-value ${cls(simValue)}`} style={{fontSize:'1rem'}}>{pct(simValue)}</span>
          </div>
        </div>
      </div>
      <p className="conf-metric-explanation">{explanation}</p>
    </div>
  );

  // Helper to render one conformance column
  const ConfColumn = ({ label, ocdC, fitC, hasLog }) => (
    <div className="conf-col">
      <div className="conf-col-header">{label}</div>

      {/* OC-Declare Confidence */}
      <Collapsible
        className="eval-subsection"
        title={
          <span style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
            OC-Declare Confidence
            {ocdC?.globalConformance != null && (
              <span className={cls(ocdC.globalConformance)} style={{fontSize:'0.9rem',fontWeight:700}}>
                {(ocdC.globalConformance*100).toFixed(1)}%
              </span>
            )}
          </span>
        }
        defaultOpen={true}
      >
        {!ocdC && !hasLog && <p style={{fontSize:'0.78rem',color:'#94a3b8',fontStyle:'italic'}}>Loading…</p>}
        {ocdC && (
          <>
            <MetricRow label="Confidence" value={ocdC.globalConformance}
              explanation={`${ocdC.globalSatisfied} of ${ocdC.totalEvents} events satisfy all constraints.`}
              formula={<>
                <div style={{display:'flex',alignItems:'center',gap:'0.5rem',flexWrap:'wrap',marginBottom:'0.3rem'}}>
                  <span style={{fontSize:'0.75rem',color:'#4338ca',fontWeight:600}}>Confidence =</span>
                  <span className="formula-frac">
                    <span className="formula-num">events satisfying all constraints</span>
                    <span className="formula-den">total events</span>
                  </span>
                </div>
                <div style={{display:'flex',alignItems:'center',gap:'0.5rem',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.75rem',color:'#4338ca',fontWeight:600}}>Per constraint =</span>
                  <span className="formula-frac">
                    <span className="formula-num">satisfied source events</span>
                    <span className="formula-den">total source events</span>
                  </span>
                </div>
                <div style={{fontSize:'0.68rem',color:'#64748b',marginTop:'0.25rem'}}>Def 8: for each scope object o in event e, count target events after e involving o — must be in [nmin, nmax]</div>
              </>} />
            {ocdC.constraintResults.length > 0 && (
              <Collapsible className="conf-detail-collapsible" title="Per-constraint" defaultOpen={false}>
                <table className="conf-detail-table">
                  <thead><tr><th>Constraint</th><th className="audit-num">Confidence</th></tr></thead>
                  <tbody>
                    {ocdC.constraintResults.slice().sort((a,b)=>a.confidence-b.confidence).map(r => (
                      <tr key={r.label} className={r.confidence < 0.5 ? 'audit-row-accumulating':''}>
                        <td style={{fontFamily:'monospace',fontSize:'0.72rem'}}>{r.label}</td>
                        <td className="audit-num"><span className={cls(r.confidence)}>{(r.confidence*100).toFixed(1)}%</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Collapsible>
            )}
          </>
        )}
      </Collapsible>

      {/* Fitness */}
      <Collapsible
        className="eval-subsection"
        title={<span style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
          Fitness
          {fitC?.fitness != null && <span className={cls(fitC.fitness)} style={{fontSize:'0.9rem',fontWeight:700}}>{(fitC.fitness*100).toFixed(1)}%</span>}
          {fitC?.constraintFitness != null && <span style={{fontSize:'0.75rem',color:'#64748b'}}>Con: <span className={cls(fitC.constraintFitness)} style={{fontWeight:600}}>{(fitC.constraintFitness*100).toFixed(1)}%</span></span>}
        </span>}
        defaultOpen={false}
      >
        {fitC
          ? <>
              <MetricRow label="Object-Replay Fitness" value={fitC.fitness}
                explanation={`${fitC.fitnessEnabled ?? '—'} of ${fitC.fitnessTotal ?? '—'} events were enabled across all objects.`}
                formula={<>
                  <div style={{display:'flex',alignItems:'center',gap:'0.5rem',flexWrap:'wrap',marginBottom:'0.3rem'}}>
                    <span style={{fontSize:'0.75rem',color:'#4338ca',fontWeight:600}}>Fitness =</span>
                    <span className="formula-frac">
                      <span className="formula-num">enabled events</span>
                      <span className="formula-den">total events</span>
                    </span>
                  </div>
                  <div style={{fontSize:'0.68rem',color:'#64748b'}}>Enabled = all precedence constraints on this activity were satisfied on this object at this point (source_count ≥ nmin)</div>
                </>} />
              <MetricRow label="Declarative Constraint Fitness" value={fitC.constraintFitness}
                explanation={`${fitC.constraintSatisfied ?? '—'} of ${fitC.constraintTotal ?? '—'} constraint-trace pairs satisfied.`}
                formula={<>
                  <div style={{display:'flex',alignItems:'center',gap:'0.5rem',flexWrap:'wrap',marginBottom:'0.3rem'}}>
                    <span style={{fontSize:'0.75rem',color:'#4338ca',fontWeight:600}}>Con. Fitness =</span>
                    <span className="formula-frac">
                      <span className="formula-num">satisfied (constraint, object) pairs</span>
                      <span className="formula-den">evaluated (constraint, object) pairs</span>
                    </span>
                  </div>
                  <div style={{fontSize:'0.68rem',color:'#64748b'}}>Evaluated at end of each object trace: response → target followed source? precedence → source preceded target? not_coexistence → only one occurred?</div>
                </>} />
            </>
          : <p style={{fontSize:'0.78rem',color:'#94a3b8',fontStyle:'italic'}}>No object traces available.</p>}
      </Collapsible>

      {/* Precision */}
      <Collapsible
        className="eval-subsection"
        title={<span style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
          Precision
          {fitC?.precision != null && <span className={cls(fitC.precision)} style={{fontSize:'0.9rem',fontWeight:700}}>{(fitC.precision*100).toFixed(1)}%</span>}
        </span>}
        defaultOpen={false}
      >
        {fitC
          ? <MetricRow label="Declarative Precision" value={fitC.precision}
              explanation={`${fitC.precisionAllowed ?? '—'} of ${fitC.precisionTotal ?? '—'} transitions were in the allowed set.`}
              formula={<>
                <div style={{display:'flex',alignItems:'center',gap:'0.5rem',flexWrap:'wrap',marginBottom:'0.3rem'}}>
                  <span style={{fontSize:'0.75rem',color:'#4338ca',fontWeight:600}}>Precision =</span>
                  <span className="formula-frac">
                    <span className="formula-num">transitions where next activity ∈ allowed set</span>
                    <span className="formula-den">total observed transitions</span>
                  </span>
                </div>
                <div style={{fontSize:'0.68rem',color:'#64748b'}}>Allowed set = activities not blocked by any active precedence / not_coexistence / not_succession constraint given current trace state</div>
              </>} />
          : <p style={{fontSize:'0.78rem',color:'#94a3b8',fontStyle:'italic'}}>No object traces available.</p>}
      </Collapsible>
    </div>
  );

  return (
    <Collapsible className="eval-section" title="Conformance" defaultOpen={false}>
      {Object.keys(objectTraces).length === 0 ? (
        <p className="empty-notice">No object traces recorded — run simulation with a larger step count.</p>
      ) : (
        <div className="conf-split-layout">
          <ConfColumn
            label="Input Log"
            ocdC={inputOcdConf}
            fitC={inputConf}
            hasLog={!!inputEventLogFile}
          />
          <div className="conf-split-divider" />
          <ConfColumn
            label="Simulation"
            ocdC={ocdConf}
            fitC={conf}
            hasLog={true}
          />
        </div>
      )}
    </Collapsible>
  );
}

// ── LogInspection ─────────────────────────────────────────────────────────────
function LogInspection({ eventLogFiles, handleFileUpload }) {
  const [selectedFile, setSelectedFile] = React.useState('');
  const [loading,      setLoading]      = React.useState(false);
  const [error,        setError]        = React.useState(null);
  const [data,         setData]         = React.useState(null); // {objTypes, actNames, maxPerObj}
  const [filterType,   setFilterType]   = React.useState('');
  const [sortBy,       setSortBy]       = React.useState('id'); // 'id' | act name
  const fileInputRef = React.useRef(null);
  const loadedFor = React.useRef(null);

  const load = async (file) => {
    if (!file || loadedFor.current === file) return;
    setLoading(true); setError(null); setData(null);
    try {
      const r = await axios.get(`/api/eventlog-events?file=${encodeURIComponent(file)}`);
      const events  = r.data.events || [];
      const typesMap = r.data.object_types_map || {};

      // Per-object: count how many times each activity appeared
      const objActCounts = {}; // {oid: {act: count}}
      events.forEach(ev => {
        const act = ev.activity;
        (ev.object_ids || []).forEach(oid => {
          if (!objActCounts[oid]) objActCounts[oid] = {};
          objActCounts[oid][act] = (objActCounts[oid][act] || 0) + 1;
        });
      });

      // All activity names (ordered by frequency)
      const actFreq = {};
      events.forEach(ev => { actFreq[ev.activity] = (actFreq[ev.activity] || 0) + 1; });
      const actNames = Object.keys(actFreq).sort((a,b) => actFreq[b] - actFreq[a]);

      // All object types
      const objTypes = [...new Set(Object.values(typesMap))].sort();

      // Max count per activity per object type (for column colouring)
      const maxPerAct = {};
      Object.entries(objActCounts).forEach(([oid, counts]) => {
        Object.entries(counts).forEach(([act, cnt]) => {
          maxPerAct[act] = Math.max(maxPerAct[act] || 0, cnt);
        });
      });

      loadedFor.current = file;
      setData({ objActCounts, actNames, actFreq, objTypes, maxPerAct, typesMap });
    } catch(e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  };

  const handleSelect = (file) => {
    setSelectedFile(file);
    if (file) load(file);
  };

  const handleUpload = async (file) => {
    if (!file) return;
    await handleFileUpload?.(file, 'eventlog');
    // After upload the file list updates; auto-select the uploaded file
    setTimeout(() => handleSelect(file.name), 500);
  };

  const filtered = data ? Object.entries(data.objActCounts)
    .filter(([oid]) => !filterType || data.typesMap[oid] === filterType)
    .sort((a, b) => {
      if (sortBy === 'id') return a[0].localeCompare(b[0]);
      const ca = a[1][sortBy] || 0, cb = b[1][sortBy] || 0;
      return cb - ca;
    }) : [];

  const fmtCell = (cnt, act, maxPerAct) => {
    if (!cnt) return null;
    const max = maxPerAct[act] || 1;
    const intensity = Math.min(1, cnt / max);
    const bg = `hsl(220,${Math.round(intensity*60+20)}%,${Math.round(95-intensity*30)}%)`;
    return { cnt, bg };
  };

  return (
    <Collapsible className="eval-section" title="Log Inspection" defaultOpen={false}>
      {/* File selector — same style as discovery */}
      <div style={{marginBottom:'0.75rem'}}>
        <div className="file-selection-row" style={{alignItems:'center'}}>
          <div className="form-group" style={{flex:1,marginBottom:0}}>
            <label style={{fontSize:'0.78rem',fontWeight:600,color:'#475569',marginBottom:'0.2rem',display:'block'}}>
              Event Log File (OCEL 2.0)
            </label>
            <div className="file-select-row">
              <select value={selectedFile} onChange={e => handleSelect(e.target.value)}
                disabled={loading} style={{flex:1}}>
                <option value="">Select event log…</option>
                {(eventLogFiles || []).map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <button className="browse-btn" onClick={() => fileInputRef.current?.click()} title="Browse and upload">📁</button>
              <input ref={fileInputRef} type="file" accept=".json,.xml" style={{display:'none'}}
                onChange={e => { if (e.target.files[0]) handleUpload(e.target.files[0]); e.target.value=''; }} />
            </div>
          </div>
          {data && (
            <div style={{display:'flex',gap:'0.5rem',alignItems:'center',marginTop:'1.1rem'}}>
              <select className="model-params-select" value={filterType}
                onChange={e => setFilterType(e.target.value)}>
                <option value="">All object types</option>
                {data.objTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}
        </div>
        {loading && <div style={{display:'flex',gap:'0.4rem',alignItems:'center',fontSize:'0.8rem',color:'#6366f1',marginTop:'0.4rem'}}><div className="spinner spinner-sm"/>Loading…</div>}
        {error && <p style={{color:'#b91c1c',fontSize:'0.8rem',marginTop:'0.3rem'}}>⚠ {error}</p>}
      </div>

      {data && filtered.length > 0 && (() => {
        const acts = data.actNames;
        return (
          <div style={{overflowX:'auto'}}>
            <p style={{fontSize:'0.73rem',color:'#64748b',marginBottom:'0.4rem'}}>
              Each cell shows the number of times that activity involved that object.
              Colour intensity = relative frequency within the activity column.
              Click a column header to sort by that activity.
            </p>
            <table className="metrics-table" style={{fontSize:'0.72rem',minWidth:`${180 + acts.length*70}px`}}>
              <thead>
                <tr>
                  <th style={{minWidth:'120px',position:'sticky',left:0,background:'white',zIndex:1}}>
                    <button style={{background:'none',border:'none',cursor:'pointer',fontWeight:600,color:'#475569',fontSize:'0.72rem'}}
                      onClick={() => setSortBy('id')}>
                      Object {sortBy==='id' ? '▼' : ''}
                    </button>
                  </th>
                  <th style={{minWidth:'80px',color:'#94a3b8'}}>Type</th>
                  {acts.map(act => (
                    <th key={act} style={{minWidth:'65px',cursor:'pointer',whiteSpace:'nowrap',
                      background: sortBy===act ? '#eef2ff' : undefined}}
                      onClick={() => setSortBy(act)}
                      title={`${act} — log total: ${data.actFreq[act]}`}>
                      <span style={{display:'block',transform:'rotate(-35deg)',transformOrigin:'bottom left',
                        marginLeft:'8px',marginBottom:'2px',fontSize:'0.65rem',width:'80px',overflow:'hidden',
                        textOverflow:'ellipsis',color: sortBy===act ? '#6366f1' : '#475569'}}>
                        {act}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(([oid, counts]) => (
                  <tr key={oid}>
                    <td style={{fontFamily:'monospace',fontSize:'0.7rem',position:'sticky',left:0,background:'white',
                      fontWeight:600,color:'#1e293b'}}>{oid}</td>
                    <td style={{fontSize:'0.7rem',color:'#64748b'}}>{data.typesMap[oid] || '—'}</td>
                    {acts.map(act => {
                      const cell = fmtCell(counts[act], act, data.maxPerAct);
                      return (
                        <td key={act} style={{
                          textAlign:'center',
                          background: cell ? cell.bg : undefined,
                          color: cell ? '#1e293b' : '#e2e8f0',
                          fontWeight: cell && cell.cnt === data.maxPerAct[act] ? 700 : 400,
                        }}>
                          {cell ? cell.cnt : '·'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })()}

      {data && filtered.length === 0 && (
        <p className="empty-notice">No objects match the current filter.</p>
      )}
    </Collapsible>
  );
}

// ── ConstraintAnalysis ────────────────────────────────────────────────────────
function ConstraintAnalysis({ activeModel, results }) {
  const constraints  = activeModel?.constraints  || [];
  const activities   = activeModel?.activities   || [];
  const objectTraces = results?.object_traces    || {};
  const resourceTypes = new Set(activeModel?.resource_types || []);

  const analysis = React.useMemo(() => {
    if (!constraints.length || !activities.length) return null;

    const actNames = new Set(activities.map(a => a.name));
    const actBindings = {};
    activities.forEach(a => { actBindings[a.name] = a.bindings || []; });

    // ── 1. SATISFIABILITY ────────────────────────────────────────────────────
    // Check for direct contradictions that make the model unsatisfiable:
    // a) Mutual blocking: A requires B before it (precedence), B requires A before it
    // b) not_coexistence(A,B) + response(A→B) or response(B→A) — A must happen but then
    //    blocks B, or triggers B which is forbidden
    // c) An activity is required (response obligation) but also absence(nmax=0)
    // d) Circular precedence chains

    const satisfiabilityIssues = [];

    // Build precedence graph: A→B means "A must fire before B"
    const precEdges = {};  // target → [sources that must precede it]
    const respEdges = {};  // source → [targets that must follow it]
    const notCoex   = [];  // pairs that cannot coexist
    const absences  = new Set(); // activities with absence nmax=0

    constraints.forEach(c => {
      const src = c.source_activity, tgt = c.target_activity;
      if (c.constraint_type === 'precedence') {
        (precEdges[tgt] = precEdges[tgt] || []).push(src);
      } else if (c.constraint_type === 'response') {
        (respEdges[src] = respEdges[src] || []).push(tgt);
      } else if (c.constraint_type === 'not_coexistence') {
        notCoex.push([src, tgt]);
      } else if (c.constraint_type === 'absence' && (c.nmax === 0 || c.nmax === null)) {
        absences.add(src || tgt);
      }
    });

    // a) Mutual precedence cycle (A must precede B AND B must precede A)
    const visited = new Set();
    const detectCycle = (node, path, edges) => {
      if (path.includes(node)) {
        const cycle = [...path.slice(path.indexOf(node)), node];
        return cycle;
      }
      if (visited.has(node)) return null;
      visited.add(node);
      for (const next of (edges[node] || [])) {
        const result = detectCycle(next, [...path, node], edges);
        if (result) return result;
      }
      return null;
    };

    // Build forward precedence: if A must precede B, edge A→B
    const precFwd = {};
    Object.entries(precEdges).forEach(([tgt, srcs]) => {
      srcs.forEach(src => { (precFwd[src] = precFwd[src] || []).push(tgt); });
    });
    visited.clear();
    for (const act of actNames) {
      const cycle = detectCycle(act, [], precFwd);
      if (cycle) {
        satisfiabilityIssues.push({
          type: 'cycle',
          severity: 'error',
          msg: `Precedence cycle: ${cycle.join(' → ')} — no valid ordering exists`,
        });
        break;
      }
    }

    // b) not_coexistence + response contradiction
    notCoex.forEach(([a, b]) => {
      if ((respEdges[a] || []).includes(b)) {
        satisfiabilityIssues.push({
          type: 'coex_response',
          severity: 'error',
          msg: `not_coexistence(${a}, ${b}) conflicts with response(${a}→${b}): ${a} must trigger ${b} but ${b} is forbidden after ${a}`,
        });
      }
      if ((respEdges[b] || []).includes(a)) {
        satisfiabilityIssues.push({
          type: 'coex_response',
          severity: 'error',
          msg: `not_coexistence(${a}, ${b}) conflicts with response(${b}→${a}): ${b} must trigger ${a} but they cannot coexist`,
        });
      }
    });

    // c) absence + response obligation
    absences.forEach(act => {
      Object.entries(respEdges).forEach(([src, tgts]) => {
        if (tgts.includes(act)) {
          satisfiabilityIssues.push({
            type: 'absence_response',
            severity: 'error',
            msg: `absence(${act}) conflicts with response(${src}→${act}): ${act} is forbidden but ${src} is obligated to trigger it`,
          });
        }
      });
    });

    // d) Dead activities: required by response but no binding can provide them
    Object.entries(respEdges).forEach(([src, tgts]) => {
      tgts.forEach(tgt => {
        if (!actNames.has(tgt)) {
          satisfiabilityIssues.push({
            type: 'missing_activity',
            severity: 'error',
            msg: `response(${src}→${tgt}): target activity "${tgt}" does not exist in the model`,
          });
        }
      });
    });

    // ── 2. CROSS-OBJECT INCONSISTENCY ────────────────────────────────────────
    // Find constraints where the scope object type doesn't match any binding
    // in the source or target activity — the constraint can never be evaluated
    const crossObjectIssues = [];
    constraints.forEach(c => {
      if (c.scope?.kind !== 'each' || !c.scope?.object_type) return;
      const stype = c.scope.object_type;
      const src = c.source_activity, tgt = c.target_activity;

      const srcBindings = actBindings[src] || [];
      const tgtBindings = actBindings[tgt] || [];
      const srcHasScope = srcBindings.some(b => b.object_type === stype);
      const tgtHasScope = tgtBindings.some(b => b.object_type === stype);

      if (!srcHasScope && actNames.has(src)) {
        crossObjectIssues.push({
          severity: 'warn',
          msg: `${c.constraint_type}(${src}→${tgt}) scoped per ${stype}: source "${src}" has no binding for ${stype} — constraint is always vacuously satisfied (scope objects never present in source event)`,
        });
      }
      if (!tgtHasScope && actNames.has(tgt) && !['not_coexistence','absence','exactly','init'].includes(c.constraint_type)) {
        crossObjectIssues.push({
          severity: 'warn',
          msg: `${c.constraint_type}(${src}→${tgt}) scoped per ${stype}: target "${tgt}" has no binding for ${stype} — shared scope object can never appear in both events`,
        });
      }
    });

    // ── 3. VACUITY CONFORMANCE ───────────────────────────────────────────────
    // A constraint is vacuously satisfied if no source event of the right type
    // ever occurred in the simulation traces.
    const vacuityIssues = [];
    if (Object.keys(objectTraces).length > 0) {
      // Build activity firing counts from traces
      const firedActivities = new Set();
      Object.values(objectTraces).forEach(trace => {
        trace.forEach(act => firedActivities.add(act));
      });

      constraints.forEach(c => {
        const src = c.source_activity;
        if (!firedActivities.has(src)) {
          // Source never fired — constraint was never tested
          const tgt = c.target_activity;
          vacuityIssues.push({
            constraint: `${c.constraint_type}(${src}→${tgt})`,
            reason: `Source activity "${src}" never fired in simulation — constraint was never evaluated, not genuinely satisfied`,
            severity: 'warn',
          });
        }
      });
    }

    return { satisfiabilityIssues, crossObjectIssues, vacuityIssues };
  }, [constraints, activities, objectTraces, resourceTypes]);

  if (!analysis) return null;
  const { satisfiabilityIssues, crossObjectIssues, vacuityIssues } = analysis;
  const totalIssues = satisfiabilityIssues.length + crossObjectIssues.length + vacuityIssues.length;

  const IssueRow = ({ issue, idx }) => (
    <div key={idx} style={{
      display:'flex', gap:'0.5rem', alignItems:'flex-start',
      padding:'0.4rem 0.5rem',
      background: issue.severity === 'error' ? '#fff1f2' : '#fffbeb',
      border: `1px solid ${issue.severity === 'error' ? '#fca5a5' : '#fde68a'}`,
      borderRadius:'5px', marginBottom:'0.3rem', fontSize:'0.78rem',
    }}>
      <span style={{fontWeight:700, color: issue.severity === 'error' ? '#b91c1c' : '#b45309', flexShrink:0}}>
        {issue.severity === 'error' ? '✕' : '⚠'}
      </span>
      <span style={{color:'#1e293b'}}>{issue.msg || issue.reason || issue.constraint}</span>
    </div>
  );

  return (
    <Collapsible
      className="eval-section"
      title="Constraint Analysis"
      badge={totalIssues > 0 ? `${totalIssues} issue${totalIssues !== 1 ? 's' : ''}` : 'no issues'}
      defaultOpen={false}
    >
      {/* Satisfiability */}
      <Collapsible
        className="eval-subsection"
        title="Satisfiability"
        badge={satisfiabilityIssues.length > 0 ? `${satisfiabilityIssues.length} issue${satisfiabilityIssues.length!==1?'s':''}` : '✓ satisfiable'}
        defaultOpen={true}
      >
        <p style={{fontSize:'0.75rem',color:'#64748b',marginBottom:'0.5rem'}}>
          Checks whether a valid trace satisfying all constraints simultaneously is theoretically possible.
          Detects: precedence cycles, not_coexistence + response conflicts, absence + response conflicts.
        </p>
        {satisfiabilityIssues.length === 0
          ? <p style={{fontSize:'0.8rem',color:'#166534',fontWeight:600}}>✓ No satisfiability contradictions detected — at least one valid trace exists.</p>
          : satisfiabilityIssues.map((iss, i) => <IssueRow key={i} issue={iss} idx={i} />)}
      </Collapsible>

      {/* Cross-Object Inconsistency */}
      <Collapsible
        className="eval-subsection"
        title="Cross-Object Inconsistency"
        badge={crossObjectIssues.length > 0 ? `${crossObjectIssues.length} issue${crossObjectIssues.length!==1?'s':''}` : '✓ consistent'}
        defaultOpen={false}
      >
        <p style={{fontSize:'0.75rem',color:'#64748b',marginBottom:'0.5rem'}}>
          Checks whether EACH-scoped constraints can ever be evaluated — the scope object type must appear
          in the bindings of both source and target activity for the constraint to be non-vacuous.
        </p>
        {crossObjectIssues.length === 0
          ? <p style={{fontSize:'0.8rem',color:'#166534',fontWeight:600}}>✓ All scoped constraints have matching bindings.</p>
          : crossObjectIssues.map((iss, i) => <IssueRow key={i} issue={iss} idx={i} />)}
      </Collapsible>

      {/* Vacuity Conformance */}
      <Collapsible
        className="eval-subsection"
        title="Vacuity Conformance"
        badge={vacuityIssues.length > 0 ? `${vacuityIssues.length} vacuous` : objectTraces && Object.keys(objectTraces).length > 0 ? '✓ all tested' : 'no trace data'}
        defaultOpen={false}
      >
        <p style={{fontSize:'0.75rem',color:'#64748b',marginBottom:'0.5rem'}}>
          Flags constraints whose source activity never fired in the simulation. These were never
          evaluated — a 100% confidence score for such constraints reflects vacuous truth, not genuine satisfaction.
          Requires simulation trace data.
        </p>
        {Object.keys(objectTraces).length === 0
          ? <p style={{fontSize:'0.8rem',color:'#94a3b8',fontStyle:'italic'}}>Run a simulation to get trace data for vacuity checking.</p>
          : vacuityIssues.length === 0
            ? <p style={{fontSize:'0.8rem',color:'#166534',fontWeight:600}}>✓ All constraint source activities fired at least once — no vacuous conformance detected.</p>
            : (
              <table className="conf-detail-table">
                <thead><tr><th>Constraint</th><th>Reason</th></tr></thead>
                <tbody>
                  {vacuityIssues.map((v, i) => (
                    <tr key={i} className="audit-row-accumulating">
                      <td style={{fontFamily:'monospace',fontSize:'0.75rem',whiteSpace:'nowrap'}}>{v.constraint}</td>
                      <td style={{fontSize:'0.75rem',color:'#64748b'}}>{v.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      </Collapsible>
    </Collapsible>
  );
}

// ── TraceHealth ───────────────────────────────────────────────────────────────
function TraceHealth({ results }) {
  const [loaded,  setLoaded]  = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [trace,   setTrace]   = React.useState(null);
  const [error,   setError]   = React.useState(null);
  const loadedFor = React.useRef(null);

  const load = async () => {
    const runId = results?.output_file;
    if (!runId || loadedFor.current === runId) { setLoaded(true); return; }
    setLoading(true); setError(null);
    try {
      const r = await axios.get(`/api/run-history/${encodeURIComponent(runId)}/iteration-log`);
      const entries = r.data.iteration_logs || [];
      loadedFor.current = runId;
      setTrace(analyseTrace(entries));
      setLoaded(true);
    } catch(e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  };

  const analyseTrace = (entries) => {
    const applied   = entries.filter(e => e.event === 'applied');
    const candSteps = entries.filter(e => e.event === 'candidates');
    if (!applied.length) return null;

    // Activity counts
    const actCounts = {};
    applied.forEach(e => { actCounts[e.activity] = (actCounts[e.activity] || 0) + 1; });

    // Pool size over time (sample every 50 steps to keep chart manageable)
    const SAMPLE = Math.max(1, Math.floor(candSteps.length / 200));
    const poolSeries = candSteps
      .filter((_, i) => i % SAMPLE === 0)
      .map(s => ({ step: s.step, pool: s.num_candidates, inProg: s.in_progress || 0 }));

    // Empty pool events
    const emptyPools = candSteps.filter(s => s.num_candidates === 0);

    // In-progress accumulation — max recorded
    const maxInProg = Math.max(...candSteps.map(s => s.in_progress || 0));

    // Bottleneck detection:
    // For each step, track which activities are IN the pool (obligation pending)
    // vs actually firing. High pool-presence but low firing rate = bottleneck.
    const poolPresence = {}; // act → steps present in pool
    const poolProbs    = {}; // act → [probs when in pool]
    candSteps.forEach(s => {
      (s.candidates_with_probs || []).forEach(c => {
        poolPresence[c.activity] = (poolPresence[c.activity] || 0) + 1;
        if (c.prob != null) {
          (poolProbs[c.activity] = poolProbs[c.activity] || []).push(c.prob);
        }
      });
    });

    // Bottleneck score: activity that appears in pool many times but fires rarely
    // relative to its pool presence
    const bottlenecks = Object.entries(poolPresence)
      .map(([act, presence]) => {
        const fired = actCounts[act] || 0;
        const avgProb = poolProbs[act]?.length
          ? poolProbs[act].reduce((s,v)=>s+v,0) / poolProbs[act].length : null;
        // fire rate = how often it fires when it's in the pool
        const fireRate = presence > 0 ? fired / presence : 0;
        return { act, presence, fired, avgProb, fireRate };
      })
      .filter(x => x.presence > 10) // ignore activities that barely appeared
      .sort((a, b) => a.fireRate - b.fireRate); // worst fire rate first

    // Activity trend: split into 5 windows, count per window
    const windowSize = Math.ceil(applied.length / 5);
    const actTrend = {};
    applied.forEach((e, i) => {
      const w = Math.min(4, Math.floor(i / windowSize));
      if (!actTrend[e.activity]) actTrend[e.activity] = [0,0,0,0,0];
      actTrend[e.activity][w]++;
    });

    // Late-stage dominant activities (last 20% of steps)
    const lateStart = Math.floor(applied.length * 0.8);
    const lateCounts = {};
    applied.slice(lateStart).forEach(e => { lateCounts[e.activity] = (lateCounts[e.activity]||0)+1; });

    return { actCounts, poolSeries, emptyPools, maxInProg, bottlenecks, actTrend, lateCounts,
             totalSteps: candSteps.length, totalEvents: applied.length };
  };

  const fmtPct = v => v == null ? '—' : `${(v*100).toFixed(1)}%`;

  return (
    <Collapsible className="eval-section" title="Trace Health" defaultOpen={false}>
      {!loaded && !loading && (
        <div>
          <p style={{fontSize:'0.78rem',color:'#64748b',marginBottom:'0.5rem'}}>
            Analyses the iteration trace to identify bottlenecks, pool collapses, and stuck activities.
            Load on demand — large traces may take a moment.
          </p>
          <button className="discovery-button"
            style={{fontSize:'0.82rem',padding:'0.4rem 1rem',display:'inline-flex',alignItems:'center',gap:'0.5rem'}}
            onClick={load} disabled={loading}>
            {loading && <div className="spinner spinner-sm"/>}
            Analyse Trace
          </button>
        </div>
      )}
      {loading && <div style={{display:'flex',gap:'0.5rem',alignItems:'center',fontSize:'0.82rem',color:'#6366f1'}}><div className="spinner spinner-sm"/>Loading trace…</div>}
      {error && <p style={{color:'#b91c1c',fontSize:'0.8rem'}}>⚠ {error}</p>}
      {loaded && trace && (
        <div>
          {/* Summary row */}
          <div className="trace-health-summary">
            <div className="trace-health-stat">
              <span className="trace-health-val">{trace.totalSteps.toLocaleString()}</span>
              <span className="trace-health-lbl">Total steps</span>
            </div>
            <div className="trace-health-stat">
              <span className="trace-health-val">{trace.emptyPools.length.toLocaleString()}</span>
              <span className={`trace-health-lbl ${trace.emptyPools.length > trace.totalSteps * 0.1 ? 'trace-warn' : ''}`}>Empty pool steps</span>
            </div>
            <div className="trace-health-stat">
              <span className="trace-health-val">{trace.maxInProg}</span>
              <span className="trace-health-lbl">Peak in-progress</span>
            </div>
            <div className="trace-health-stat">
              <span className={`trace-health-val ${trace.emptyPools.length / trace.totalSteps > 0.1 ? 'conf-bad' : 'conf-good'}`}>
                {(trace.emptyPools.length / trace.totalSteps * 100).toFixed(1)}%
              </span>
              <span className="trace-health-lbl">Pool stall rate</span>
            </div>
          </div>

          {/* Pool size + in-progress chart */}
          <div style={{marginBottom:'1rem'}}>
            <div style={{fontSize:'0.78rem',fontWeight:600,color:'#475569',marginBottom:'0.35rem'}}>
              Candidate pool size over time
            </div>
            {(() => {
              const W = 600, H = 80, n = trace.poolSeries.length;
              if (n === 0) return null;
              const maxPool = Math.max(...trace.poolSeries.map(s => s.pool), 1);
              const maxIP   = Math.max(...trace.poolSeries.map(s => s.inProg), 1);
              return (
                <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{display:'block',overflow:'visible'}}>
                  {/* In-progress background bars */}
                  {trace.poolSeries.map((s, i) => {
                    const x = (i / n) * W;
                    const w = W / n;
                    const h = (s.inProg / maxIP) * (H - 4);
                    return <rect key={i} x={x} y={H - h} width={w - 0.5} height={h} fill="#e0e7ff" />;
                  })}
                  {/* Pool size line */}
                  <polyline
                    fill="none" stroke="#6366f1" strokeWidth="1.5"
                    points={trace.poolSeries.map((s, i) => {
                      const x = (i / n) * W;
                      const y = H - (s.pool / maxPool) * (H - 4) - 2;
                      return `${x},${y}`;
                    }).join(' ')}
                  />
                  {/* Zero-pool markers */}
                  {trace.poolSeries.filter(s => s.pool === 0).map((s, i) => {
                    const idx = trace.poolSeries.indexOf(s);
                    const x = (idx / n) * W;
                    return <rect key={i} x={x} y={0} width={Math.max(1.5, W/n)} height={H} fill="rgba(239,68,68,0.15)" />;
                  })}
                  {/* Legend */}
                  <rect x={W-120} y={4} width={10} height={6} fill="#e0e7ff"/>
                  <text x={W-108} y={11} fontSize="9" fill="#64748b">In-progress</text>
                  <line x1={W-120} y1={21} x2={W-110} y2={21} stroke="#6366f1" strokeWidth="1.5"/>
                  <text x={W-108} y={24} fontSize="9" fill="#64748b">Pool size</text>
                  <rect x={W-120} y={30} width={10} height={6} fill="rgba(239,68,68,0.3)"/>
                  <text x={W-108} y={37} fontSize="9" fill="#64748b">Empty pool</text>
                </svg>
              );
            })()}
          </div>

          {/* Bottleneck table */}
          <div style={{fontSize:'0.78rem',fontWeight:600,color:'#475569',marginBottom:'0.35rem'}}>
            Bottleneck activities — low fire rate despite pool presence
          </div>
          <p style={{fontSize:'0.73rem',color:'#94a3b8',marginBottom:'0.5rem'}}>
            Fire rate = firings ÷ steps the activity was in the pool. Low = activity is stuck in pool but rarely chosen or always blocked.
          </p>
          <table className="conf-detail-table" style={{marginBottom:'0.75rem'}}>
            <thead>
              <tr>
                <th>Activity</th>
                <th className="audit-num">Pool steps</th>
                <th className="audit-num">Fired</th>
                <th className="audit-num">Fire rate</th>
                <th className="audit-num">Avg prob</th>
                <th>Diagnosis</th>
              </tr>
            </thead>
            <tbody>
              {trace.bottlenecks.map(b => {
                const cls = b.fireRate < 0.05 ? 'conf-bad' : b.fireRate < 0.2 ? 'conf-mid' : 'conf-good';
                let diag = '';
                if (b.fired === 0) diag = 'Never fired — permanently blocked by constraint or missing objects';
                else if (b.avgProb !== null && b.avgProb < 0.05) diag = 'Very low probability weight — outcompeted by other activities';
                else if (b.fireRate < 0.05) diag = 'Rarely fires despite being in pool — likely blocked most steps by precedence/O2O';
                else if (b.fireRate < 0.2) diag = 'Fires infrequently — constraint or probability limiting';
                else diag = 'Moderate fire rate';
                return (
                  <tr key={b.act} className={b.fireRate < 0.05 ? 'audit-row-accumulating' : ''}>
                    <td style={{fontSize:'0.78rem'}}>{b.act}</td>
                    <td className="audit-num">{b.presence.toLocaleString()}</td>
                    <td className="audit-num">{b.fired.toLocaleString()}</td>
                    <td className="audit-num"><span className={cls}>{fmtPct(b.fireRate)}</span></td>
                    <td className="audit-num">{b.avgProb != null ? fmtPct(b.avgProb) : '—'}</td>
                    <td style={{fontSize:'0.72rem',color:'#64748b'}}>{diag}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Late-stage activity distribution */}
          <div style={{fontSize:'0.78rem',fontWeight:600,color:'#475569',marginBottom:'0.35rem'}}>
            Activity distribution in last 20% of steps
          </div>
          <div style={{display:'flex',flexWrap:'wrap',gap:'0.3rem',marginBottom:'0.5rem'}}>
            {Object.entries(trace.lateCounts)
              .sort((a,b) => b[1]-a[1])
              .map(([act, cnt]) => (
                <span key={act} style={{
                  fontSize:'0.72rem',padding:'0.15rem 0.5rem',
                  borderRadius:'20px',background:'#f1f5f9',color:'#334155',
                  border:'1px solid #e2e8f0',
                }}>
                  {act} <strong>{cnt}</strong>
                </span>
              ))}
          </div>
        </div>
      )}
    </Collapsible>
  );
}

// ── ActivityGanttChart (Canvas-based for performance) ────────────────────────
function ActivityGanttChart({ results, orderedActivities, simMetrics, onLoadStart, onLoadDone }) {
  const [loaded,  setLoaded]  = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [events,  setEvents]  = React.useState(null);
  const [tooltip, setTooltip] = React.useState(null);
  const [selBar,  setSelBar]  = React.useState(null); // {x1,x2,y1,y2,event,act}
  const [error,   setError]   = React.useState(null);
  const canvasRef = React.useRef(null);
  const hitmap    = React.useRef([]);
  const drawData  = React.useRef(null); // cached layout for redraw
  const loadedFor = React.useRef(null);

  const fmtTs  = ts => ts ? ts.replace('T',' ').slice(0,19) : '—';
  const fmtDur = s => {
    if (s == null) return '—';
    if (s >= 86400) return `${(s/86400).toFixed(1)} d`;
    if (s >= 3600)  return `${(s/3600).toFixed(1)} h`;
    if (s >= 60)    return `${Math.round(s/60)} min`;
    return `${Math.round(s)} s`;
  };

  const load = async () => {
    const runId = results?.output_file;
    if (!runId || loadedFor.current === runId) { setLoaded(true); onLoadDone?.(); return; }
    setLoading(true); setError(null);
    onLoadStart?.();
    try {
      const r = await axios.get(`/api/run-history/${encodeURIComponent(runId)}/events`);
      setEvents(r.data.events || []);
      loadedFor.current = runId;
      setLoaded(true);
      onLoadDone?.();
    } catch(e) { setError(e.response?.data?.error || e.message); onLoadDone?.(); }
    finally { setLoading(false); }
  };

  const draw = React.useCallback((sel) => {
    const canvas = canvasRef.current;
    const dd = drawData.current;
    if (!canvas || !dd) return;
    const { acts, hitItems, tMin, tMax, span, LABEL_W, CHART_W, ROW_H, TICK_H, numTicks } = dd;

    canvas.width  = LABEL_W + CHART_W + 20;
    canvas.height = TICK_H + acts.length * ROW_H + TICK_H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const tsToX = ts => LABEL_W + ((ts - tMin) / span) * CHART_W;

    // Determine overlapping activities with selected bar
    const overlaps = new Set();
    if (sel) {
      hitItems.forEach(h => {
        if (h.act !== sel.act && h.startMs < sel.endMs && h.endMs > sel.startMs) {
          overlaps.add(h.act);
        }
      });
    }

    // Row backgrounds
    acts.forEach((act, ai) => {
      const y = TICK_H + ai * ROW_H;
      const isOverlap = overlaps.has(act);
      const isSel = sel && sel.act === act;
      ctx.fillStyle = isSel ? '#eef2ff' : isOverlap ? '#fef9c3' : (ai % 2 === 0 ? '#f8fafc' : '#ffffff');
      ctx.fillRect(LABEL_W, y, CHART_W, ROW_H);
    });

    // Tick grid + labels
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 1;
    ctx.fillStyle = '#94a3b8'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    for (let i = 0; i < numTicks; i++) {
      const f = i / (numTicks - 1);
      const x = LABEL_W + f * CHART_W;
      const ms = tMin + f * span;
      const d = new Date(ms);
      const label = span < 3600000 ? d.toISOString().slice(11,19)
                  : span < 86400000 ? d.toISOString().slice(11,16)
                  : d.toISOString().slice(0,10);
      ctx.beginPath(); ctx.moveTo(x, TICK_H); ctx.lineTo(x, TICK_H + acts.length * ROW_H); ctx.stroke();
      ctx.fillText(label, x, TICK_H - 4);
      ctx.fillText(label, x, TICK_H + acts.length * ROW_H + 12);
    }

    // Bars and labels
    acts.forEach((act, ai) => {
      const y = TICK_H + ai * ROW_H;
      const PAD = 3;
      const isOverlap = overlaps.has(act);
      const isSel = sel && sel.act === act;
      const baseColor = `hsl(${(ai * 37) % 360},60%,55%)`;

      // Activity label
      ctx.textAlign = 'right';
      ctx.font = (isOverlap ? 'bold ' : '') + '10px sans-serif';
      ctx.fillStyle = isOverlap ? '#1e293b' : '#475569';
      const label = act.length > 24 ? act.slice(0,23)+'…' : act;
      ctx.fillText(label, LABEL_W - 4, y + ROW_H / 2 + 4);

      // Draw bars for this activity
      hitItems.filter(h => h.act === act).forEach(h => {
        const bx1Raw = tsToX(h.startMs);
        const bx2    = tsToX(h.endMs);
        const bx1    = Math.max(LABEL_W, bx1Raw); // clamp to chart area
        const bW     = Math.max(1.5, bx2 - bx1);
        const bY     = y + PAD, bH = ROW_H - PAD * 2;

        // Highlight selected bar
        if (sel && h === sel) {
          ctx.fillStyle = '#f59e0b';
          ctx.fillRect(bx1 - 1, bY - 1, bW + 2, bH + 2);
        }
        ctx.fillStyle = isOverlap ? '#ef4444' : (isSel ? '#6366f1' : baseColor);
        ctx.globalAlpha = 0.85;
        ctx.fillRect(bx1, bY, bW, bH);
        ctx.globalAlpha = 1.0;
      });
    });

    // Bottom axis line
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LABEL_W, TICK_H + acts.length * ROW_H);
    ctx.lineTo(LABEL_W + CHART_W, TICK_H + acts.length * ROW_H);
    ctx.stroke();

    // Selected bar vertical dotted lines (start and end)
    if (sel) {
      ctx.save();
      ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      [tsToX(sel.startMs), tsToX(sel.endMs)].forEach(lx => {
        ctx.beginPath();
        ctx.moveTo(lx, TICK_H); ctx.lineTo(lx, TICK_H + acts.length * ROW_H);
        ctx.stroke();
      });
      ctx.restore();
    }
  }, []);

  // Build layout data and draw when events change
  React.useEffect(() => {
    if (!events || !canvasRef.current) return;

    const actEvents = {};
    events.forEach(e => { (actEvents[e.activity] = actEvents[e.activity] || []).push(e); });
    const acts = orderedActivities.filter(a => actEvents[a]);
    if (acts.length === 0) return;

    const allTs = events.map(e => new Date(e.timestamp).getTime()).filter(t => !isNaN(t));
    const tMin = Math.min(...allTs), tMax = Math.max(...allTs);
    const span = tMax - tMin || 1;

    const ROW_H = 22, LABEL_W = 180, TICK_H = 20;
    const CHART_W = Math.max(1400, events.length * 4);
    const numTicks = Math.min(20, Math.max(5, Math.floor(CHART_W / 200)));

    // Build hit items with start/end times.
    // Clamp startMs to tMin so bars never extend left of the chart boundary.
    // This prevents activities with long mean_service_s (e.g. Depart ~3 days)
    // from appearing to start before the simulation began.
    const hitItems = [];
    acts.forEach(act => {
      const meanSvc = simMetrics?.[act]?.mean_service_s ?? 60;
      const evts = actEvents[act] || [];
      evts.forEach(e => {
        const endMs   = new Date(e.timestamp).getTime();
        const startMs = Math.max(tMin, endMs - meanSvc * 1000);
        hitItems.push({ act, event: e, startMs, endMs });
      });
    });

    drawData.current = { acts, hitItems, tMin, tMax, span, LABEL_W, CHART_W, ROW_H, TICK_H, numTicks };
    hitmap.current = hitItems;
    draw(null);
  }, [events, orderedActivities, simMetrics, draw]);

  // Redraw when selection changes
  React.useEffect(() => { draw(selBar); }, [selBar, draw]);

  const handleClick = React.useCallback(e => {
    const canvas = canvasRef.current;
    const dd = drawData.current;
    if (!canvas || !dd) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top)  * scaleY;

    const { tMin, span, LABEL_W, CHART_W, TICK_H, ROW_H, acts } = dd;
    const tsToX = ts => LABEL_W + ((ts - tMin) / span) * CHART_W;

    // Find which activity row was clicked
    const rowIdx = Math.floor((cy - TICK_H) / ROW_H);
    if (rowIdx < 0 || rowIdx >= acts.length) { setSelBar(null); setTooltip(null); return; }

    // Find closest bar in that row
    let best = null, bestDist = 12;
    hitmap.current.filter(h => h.act === acts[rowIdx]).forEach(h => {
      const mid = (tsToX(h.startMs) + tsToX(h.endMs)) / 2;
      const d = Math.abs(cx - mid);
      if (d < bestDist) { bestDist = d; best = h; }
    });

    if (best) {
      setSelBar(best);
      setTooltip({
        x: (tsToX(best.startMs) + tsToX(best.endMs)) / 2 / scaleX,
        y: (TICK_H + rowIdx * ROW_H) / scaleY,
        activity:  best.act,
        start:     new Date(best.startMs).toISOString().replace('T',' ').slice(0,19),
        end:       new Date(best.endMs).toISOString().replace('T',' ').slice(0,19),
        duration:  fmtDur((best.endMs - best.startMs) / 1000),
        objects:   (best.event.object_ids || []).join(', ') || '—',
      });
    } else {
      setSelBar(null); setTooltip(null);
    }
  }, [fmtDur]);

  return (
    <Collapsible className="eval-section" title="Activity Timeline (Gantt)" defaultOpen={false}>
      {!loaded && (
        <div>
          <p style={{fontSize:'0.78rem',color:'#64748b',marginBottom:'0.5rem'}}>
            Each firing is shown as a bar sized by mean service time. Click a bar to see start/end
            and highlight overlapping activities in red. Canvas-rendered for performance.
          </p>
          <button
            className="discovery-button"
            style={{fontSize:'0.82rem',padding:'0.4rem 1rem',display:'inline-flex',alignItems:'center',gap:'0.5rem'}}
            onClick={load}
            disabled={loading}
          >
            {loading && <div className="spinner spinner-sm" />}
            {loading ? 'Loading timeline…' : 'Load Timeline'}
          </button>
        </div>
      )}
      {error && <p style={{color:'#b91c1c',fontSize:'0.8rem'}}>⚠ {error}</p>}
      {loaded && events && (
        <div style={{overflowX:'scroll',overflowY:'visible',position:'relative',border:'1px solid #e2e8f0',borderRadius:'6px'}}>
          <canvas ref={canvasRef} style={{display:'block',cursor:'crosshair',maxWidth:'none'}} onClick={handleClick} />
          {tooltip && (
            <div style={{
              position:'absolute', left: tooltip.x + 12, top: tooltip.y - 10,
              background:'#1e293b', color:'white', borderRadius:'6px',
              padding:'0.5rem 0.75rem', fontSize:'0.75rem', maxWidth:'300px',
              pointerEvents:'none', zIndex:10, lineHeight:1.7,
              boxShadow:'0 4px 12px rgba(0,0,0,0.3)',
            }}>
              <strong>{tooltip.activity}</strong><br/>
              Start: {tooltip.start}<br/>
              End:&nbsp;&nbsp; {tooltip.end}<br/>
              Duration: {tooltip.duration}<br/>
              Objects: {tooltip.objects}
            </div>
          )}
        </div>
      )}
    </Collapsible>
  );
}


// ── SimVsDiscoveredComparison ─────────────────────────────────────────────────
// Compares simulation output metrics (mean_service_s, mean_wait_in_pool_s, etc.)
// directly against the input log's discovered timing values.
function SimVsDiscoveredComparison({ simMetrics, logDurations, orderedActivities }) {
  const [metric, setMetric] = React.useState('service');

  const fmtS = v => {
    if (v == null || v === 0) return '—';
    if (v >= 86400) return `${(v/86400).toFixed(1)} d`;
    if (v >= 3600)  return `${(v/3600).toFixed(1)} h`;
    if (v >= 60)    return `${Math.round(v/60)} min`;
    return `${Math.round(v)} s`;
  };
  const pctDiff = (a, b) => (a == null || b == null || a === 0) ? null : (b - a) / a * 100;
  const fmtPct = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  const pctCls  = v => { if (v == null) return ''; const n = Math.abs(v); return n < 10 ? 'cmp-ok' : v > 0 ? 'cmp-over' : 'cmp-under'; };

  // sim keys from activity_metrics
  // In DES mode, resource_wait_s is the meaningful waiting metric.
  // candidate_wait_s (wait_in_pool) is only populated in step-based mode.
  const simKeys = {
    service:       { mean: 'mean_service_s',        min: 'min_service_s',       max: 'max_service_s' },
    resource_wait: { mean: 'mean_resource_wait_s',  min: null,                  max: 'max_resource_wait_s' },
    pool_wait:     { mean: 'mean_wait_in_pool_s',   min: null,                  max: 'max_wait_in_pool_s' },
  };
  // log keys from activity_durations (discovered)
  const logKeys = {
    service:       { mean: 'service_mean', min: 'service_min', max: 'service_max' },
    resource_wait: { mean: 'waiting_mean', min: null,          max: null },
    pool_wait:     { mean: 'waiting_mean', min: null,          max: null },
  };

  const sk = simKeys[metric];
  const lk = logKeys[metric];
  const acts = orderedActivities.filter(a => simMetrics[a] || logDurations[a]);
  if (acts.length === 0) return null;

  return (
    <Collapsible className="eval-subsection" title="Sim Metrics vs Log Discovery" defaultOpen={true}>
      <p style={{fontSize:'0.78rem',color:'#64748b',marginBottom:'0.5rem'}}>
        Compares the simulation run's measured metrics (from activity_metrics) directly against the
        input log's discovered timing values. Left = input log discovered, Right = sim output metrics.
      </p>
      <div style={{display:'flex',gap:'0.5rem',alignItems:'center',marginBottom:'0.75rem'}}>
        <span style={{fontSize:'0.78rem',color:'#475569',fontWeight:600}}>Metric:</span>
        {[
          {v:'service',      l:'Service time'},
          {v:'resource_wait',l:'Resource wait (DES)'},
          {v:'pool_wait',    l:'Pool wait (step-based)'},
        ].map(o => (
          <button key={o.v}
            className={`eval-mode-btn${metric === o.v ? ' active' : ''}`}
            style={{padding:'0.25rem 0.7rem'}}
            onClick={() => setMetric(o.v)}
          >{o.l}</button>
        ))}
      </div>
      <table className="metrics-table" style={{fontSize:'0.78rem'}}>
        <thead>
          <tr>
            <th>Activity</th>
            <th className="audit-num">Log mean</th>
            <th className="audit-num">Sim mean</th>
            <th className="audit-num">Δ mean</th>
            {sk.min && lk.min && <th className="audit-num">Log min</th>}
            {sk.min && lk.min && <th className="audit-num">Sim min</th>}
            {sk.min && lk.min && <th className="audit-num">Δ min</th>}
            <th className="audit-num">Log max</th>
            <th className="audit-num">Sim max</th>
            <th className="audit-num">Δ max</th>
          </tr>
        </thead>
        <tbody>
          {acts.map(act => {
            const log = logDurations[act] || {};
            const sim = simMetrics[act]  || {};
            const lMean = log[lk.mean], sMean = sim[sk.mean];
            const lMin  = lk.min ? log[lk.min] : null, sMin = sk.min ? sim[sk.min] : null;
            const lMax  = lk.max ? log[lk.max] : null, sMax = sk.max ? sim[sk.max] : null;
            const dMean = pctDiff(lMean, sMean);
            const dMin  = pctDiff(lMin, sMin);
            const dMax  = pctDiff(lMax, sMax);
            return (
              <tr key={act}>
                <td className="metrics-act-name">{act}</td>
                <td className="audit-num">{fmtS(lMean)}</td>
                <td className="audit-num">{fmtS(sMean)}</td>
                <td className={`audit-num cmp-diff ${pctCls(dMean)}`}>{fmtPct(dMean)}</td>
                {sk.min && lk.min && <td className="audit-num">{fmtS(lMin)}</td>}
                {sk.min && lk.min && <td className="audit-num">{fmtS(sMin)}</td>}
                {sk.min && lk.min && <td className={`audit-num cmp-diff ${pctCls(dMin)}`}>{fmtPct(dMin)}</td>}
                <td className="audit-num">{fmtS(lMax)}</td>
                <td className="audit-num">{fmtS(sMax)}</td>
                <td className={`audit-num cmp-diff ${pctCls(dMax)}`}>{fmtPct(dMax)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Collapsible>
  );
}

// ── OC-Declare Coverage Measures ─────────────────────────────────────────────
// Implements coverage metrics from Küsters & van der Aalst (BPM 2025) + Di Ciccio et al.
function computeOCCoverage(results, model, discoveryResults) {
  if (!results || !model) return null;
  const constraints = model.constraints || [];
  const activities = (model.activities || []).map(a => typeof a === 'string' ? a : a.name);
  const objectTypes = [...new Set([
    ...(model.object_types || []).map(t => typeof t === 'string' ? t : t.name),
    ...(model.activities || []).flatMap(a => (a.bindings||[]).map(b=>b.object_type))
  ])];

  // Events and objects from simulation
  const activitySequence = results.activity_sequence || [];
  const firedActivities = new Set(activitySequence);
  const simObjectTypes = new Set(Object.keys(results.object_types || {}));
  const objectTraces = results.object_traces || {};  // oid → [act, act, ...]
  const objectTypesMap = results.object_types_map || {};

  // cov_act: fraction of model activities that appear in simulation output
  const modelActSet = new Set([
    ...constraints.map(c=>c.source_activity).filter(Boolean),
    ...constraints.map(c=>c.target_activity).filter(Boolean),
    ...activities
  ]);
  const firedModelActs = [...modelActSet].filter(a => firedActivities.has(a));
  const cov_act = modelActSet.size > 0 ? firedModelActs.length / modelActSet.size : null;

  // cov_ot: fraction of object types referenced in model that were instantiated
  const modelOtSet = new Set(objectTypes.filter(Boolean));
  const firedOts = [...modelOtSet].filter(ot => simObjectTypes.has(ot));
  const cov_ot = modelOtSet.size > 0 ? firedOts.length / modelOtSet.size : null;

  // cov_activation: fraction of constraints with at least one source event (non-vacuous)
  const sourceEventCounts = {};
  activitySequence.forEach(a => { sourceEventCounts[a] = (sourceEventCounts[a]||0)+1; });
  const constraintsWithSource = constraints.filter(c => c.source_activity && (sourceEventCounts[c.source_activity]||0)>0);
  const cov_activation = constraints.length > 0 ? constraintsWithSource.length / constraints.length : null;
  const sourceCounts = constraints.map(c => sourceEventCounts[c.source_activity]||0).filter(n=>n>0);
  const medianSrc = sourceCounts.length > 0 ? sourceCounts.sort((a,b)=>a-b)[Math.floor(sourceCounts.length/2)] : null;

  // cov_inv: fraction of (constraint, obj_type) pairs where |obj^ot(e)| ≥ 2 for some source event
  // Tests whether Each/All/Any modes are distinguishable
  let invTotal = 0, invTestable = 0;
  const scopeTypeCounts = {}; // act -> {ot -> [counts per event]}
  Object.entries(objectTraces).forEach(([oid, trace]) => {
    const ot = objectTypesMap[oid];
    if (!ot) return;
    trace.forEach(act => {
      if (!scopeTypeCounts[act]) scopeTypeCounts[act] = {};
      scopeTypeCounts[act][ot] = (scopeTypeCounts[act][ot]||0)+1;
    });
  });
  constraints.forEach(c => {
    const scopeOt = c.scope?.object_type;
    if (!scopeOt) return;
    invTotal++;
    const maxPerEvent = scopeTypeCounts[c.source_activity]?.[scopeOt];
    if (maxPerEvent != null && maxPerEvent >= 2) invTestable++;
  });
  const cov_inv = invTotal > 0 ? invTestable / invTotal : null;

  // cov_min: fraction of constraints where some cascade count > nmin
  // proxy: activities that fired more times than nmin would require
  let minTotal = 0, minDistinguishable = 0;
  constraints.forEach(c => {
    const nmin = c.nmin ?? 1;
    if (nmin <= 0) return;
    minTotal++;
    const cnt = sourceEventCounts[c.target_activity]||0;
    if (cnt > nmin) minDistinguishable++;
  });
  const cov_min = minTotal > 0 ? minDistinguishable / minTotal : null;

  // cov_max: fraction of finite-nmax constraints where the max was reached
  const finiteMax = constraints.filter(c => c.nmax != null && c.nmax > 0);
  let maxReached = 0;
  finiteMax.forEach(c => {
    const cnt = sourceEventCounts[c.target_activity]||0;
    if (cnt >= c.nmax) maxReached++;
  });
  const cov_max = finiteMax.length > 0 ? maxReached / finiteMax.length : null;

  // cov_neg: fraction of negated constraints (nmax=0) where target appeared at all in the output
  const negConstraints = constraints.filter(c => c.nmax === 0);
  let negNonTrivial = 0;
  negConstraints.forEach(c => {
    if (firedActivities.has(c.target_activity)) negNonTrivial++;
  });
  const cov_neg = negConstraints.length > 0 ? negNonTrivial / negConstraints.length : null;

  // cov_arrow: EF/EP constraints where some event satisfies EF but not a direct-chain version
  // Proxy: fraction of response/precedence (non-chain) constraints where target fired
  const weakArrow = constraints.filter(c => ['response','precedence'].includes(c.constraint_type));
  let arrowDist = 0;
  weakArrow.forEach(c => {
    // If target fires, there's a chance EF/EP is distinguishable from DF/DP
    if (firedActivities.has(c.target_activity)) arrowDist++;
  });
  const cov_arrow = weakArrow.length > 0 ? arrowDist / weakArrow.length : null;

  // cov_guard: not computable from log — mark as N/A
  const cov_guard = null;

  return {
    cov_act:        { value: cov_act,        fired: firedModelActs.length, total: modelActSet.size },
    cov_ot:         { value: cov_ot,         fired: firedOts.length,        total: modelOtSet.size },
    cov_activation: { value: cov_activation, fired: constraintsWithSource.length, total: constraints.length, median: medianSrc },
    cov_inv:        { value: cov_inv,         tested: invTestable, total: invTotal },
    cov_min:        { value: cov_min,         dist: minDistinguishable, total: minTotal },
    cov_max:        { value: cov_max,         reached: maxReached, total: finiteMax.length },
    cov_neg:        { value: cov_neg,         nonTrivial: negNonTrivial, total: negConstraints.length },
    cov_arrow:      { value: cov_arrow,       dist: arrowDist, total: weakArrow.length },
    cov_guard:      { value: null,            note: 'Not computable from log — requires simulator instrumentation' },
  };
}

function OCCoveragePanel({ results, model, discoveryResults }) {
  const cov = React.useMemo(
    () => computeOCCoverage(results, model, discoveryResults),
    [results, model, discoveryResults]
  );
  if (!cov) return <div style={{color:'#94a3b8',fontSize:'0.82rem'}}>Run a simulation to compute coverage.</div>;

  const fmt = v => v == null ? 'N/A' : (v*100).toFixed(1)+'%';
  const color = v => v == null ? '#94a3b8' : v >= 0.9 ? '#16a34a' : v >= 0.6 ? '#d97706' : '#dc2626';

  const rows = [
    { key:'cov_act',        label:'Activity coverage',        desc:'Fraction of model activities that appeared in sim output', detail: `${cov.cov_act.fired}/${cov.cov_act.total} activities fired` },
    { key:'cov_ot',         label:'Object type coverage',     desc:'Fraction of model object types instantiated', detail: `${cov.cov_ot.fired}/${cov.cov_ot.total} types seen` },
    { key:'cov_activation', label:'Constraint activation',    desc:'Fraction of constraints with ≥1 source event (non-vacuous)', detail: `${cov.cov_activation.fired}/${cov.cov_activation.total} non-vacuous, median src events: ${cov.cov_activation.median??'—'}` },
    { key:'cov_inv',        label:'Involvement testability',  desc:'Fraction of (constraint, obj_type) pairs where |obj^ot(e)|≥2 — distinguishes Each/All/Any', detail: `${cov.cov_inv.tested}/${cov.cov_inv.total} pairs testable` },
    { key:'cov_min',        label:'nmin discriminability',    desc:'Fraction of constraints where cascade count > nmin — tighter bound distinguishable', detail: `${cov.cov_min.dist}/${cov.cov_min.total} constraints` },
    { key:'cov_max',        label:'nmax reachability',        desc:'Fraction of finite-nmax constraints where the max was actually reached', detail: `${cov.cov_max.reached}/${cov.cov_max.total} constraints (finite nmax only)` },
    { key:'cov_neg',        label:'Negative constraint test', desc:'Fraction of nmax=0 constraints where target activity appeared (non-trivial test)', detail: `${cov.cov_neg.nonTrivial}/${cov.cov_neg.total} non-trivial` },
    { key:'cov_arrow',      label:'Arrow discriminability',   desc:'Fraction of EF/EP constraints where target fired (EF vs DF / EP vs DP testable)', detail: `${cov.cov_arrow.dist}/${cov.cov_arrow.total} response/precedence constraints` },
    { key:'cov_guard',      label:'Guard coverage',           desc:'Whether precedence constraints blocked candidates during generation', detail: cov.cov_guard.note },
  ];

  return (
    <div>
      <p style={{fontSize:'0.72rem',color:'#64748b',marginBottom:'0.75rem'}}>
        Based on Küsters & van der Aalst (BPM 2025) OC-Declare framework. Green ≥90%, amber ≥60%, red &lt;60%.
      </p>
      <table className="behavior-table" style={{fontSize:'0.78rem'}}>
        <thead><tr><th>Measure</th><th style={{width:'70px',textAlign:'center'}}>Score</th><th>What it indicates</th><th>Detail</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key}>
              <td style={{fontWeight:600,whiteSpace:'nowrap'}}>{r.label}</td>
              <td style={{textAlign:'center',fontWeight:700,color:color(cov[r.key]?.value)}}>{fmt(cov[r.key]?.value)}</td>
              <td style={{color:'#475569',fontSize:'0.72rem'}}>{r.desc}</td>
              <td style={{color:'#94a3b8',fontSize:'0.7rem'}}>{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── OCPQPanel ─────────────────────────────────────────────────────────────────
function OCPQPanel({ results }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [sortKey, setSortKey] = React.useState('support');
  const [sortDir, setSortDir] = React.useState(-1); // -1 desc, 1 asc
  const loadedFor = React.useRef(null);

  React.useEffect(() => {
    const runId = results?.output_file;
    if (!runId || loadedFor.current === runId) return;
    loadedFor.current = runId;
    setLoading(true);
    setData(null);
    setError(null);
    axios.get(`/api/run-history/${encodeURIComponent(runId)}/ocpq`)
      .then(r => setData(r.data))
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [results?.output_file]);

  if (!results?.output_file) return <div style={{color:'#94a3b8',fontSize:'0.85rem',padding:'1rem'}}>No run available.</div>;
  if (loading) return <div style={{display:'flex',alignItems:'center',gap:'0.5rem',padding:'1rem',fontSize:'0.82rem',color:'#64748b'}}><div className="spinner spinner-sm"/>Computing OCPQ measures…</div>;
  if (error) return <div style={{color:'#dc2626',fontSize:'0.82rem',padding:'1rem'}}>{error}</div>;
  if (!data) return null;

  const schemas = [...(data.schemas || [])];
  schemas.sort((a, b) => {
    const av = a[sortKey] ?? -Infinity;
    const bv = b[sortKey] ?? -Infinity;
    return sortDir * (typeof av === 'number' && typeof bv === 'number' ? bv - av : String(bv).localeCompare(String(av)));
  });

  const fmtDur = s => {
    if (s == null) return '—';
    if (s < 60) return Math.round(s) + 's';
    if (s < 3600) return Math.floor(s/60) + 'm';
    if (s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
    const d = Math.floor(s/86400); const h = Math.floor((s%86400)/3600);
    return h > 0 ? d + 'd ' + h + 'h' : d + 'd';
  };
  const fmtPct = v => v == null ? '—' : (v * 100).toFixed(1) + '%';
  const fmtSel = v => v == null ? '—' : v.toFixed(3);
  const colColor = (key, val) => {
    if (val == null) return '#64748b';
    if (key === 'coverage' || key === 'reach') return val >= 0.8 ? '#16a34a' : val >= 0.5 ? '#ca8a04' : '#dc2626';
    if (key === 'selectivity' || key === 'exclusivity') return val >= 0.8 ? '#16a34a' : val >= 0.5 ? '#ca8a04' : '#64748b';
    return '#1e293b';
  };

  const cols = [
    { key: 'source_activity', label: 'Source',      fmt: v => v, color: () => '#1e293b' },
    { key: 'target_activity', label: 'Target',      fmt: v => v, color: () => '#1e293b' },
    { key: 'support',         label: 'Support',     fmt: v => v?.toLocaleString(), color: () => '#1e293b' },
    { key: 'coverage',        label: 'Coverage',    fmt: fmtPct, color: v => colColor('coverage', v) },
    { key: 'selectivity',     label: 'Selectivity', fmt: fmtSel, color: v => colColor('selectivity', v) },
    { key: 'reach',           label: 'Reach',       fmt: fmtPct, color: v => colColor('reach', v) },
    { key: 'exclusivity',     label: 'Exclusivity', fmt: fmtSel, color: v => colColor('exclusivity', v) },
    { key: 'throughput_s',    label: 'Throughput',  fmt: fmtDur, color: () => '#1e293b' },
    { key: 'eq_class',        label: 'Eq',          fmt: v => v ? v.slice(0,6) : '—', color: () => '#94a3b8' },
  ];

  const thStyle = key => ({
    padding: '0.35rem 0.5rem', fontSize: '0.72rem', fontWeight: 700, color: '#475569',
    cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', textAlign: key === 'source_activity' || key === 'target_activity' ? 'left' : 'center',
    background: sortKey === key ? '#f1f5f9' : 'transparent',
  });

  const onSort = key => {
    if (sortKey === key) setSortDir(d => -d);
    else { setSortKey(key); setSortDir(-1); }
  };

  return (
    <div>
      <p style={{fontSize:'0.75rem',color:'#94a3b8',margin:'0 0 0.5rem'}}>
        {data.total} schemas · consecutive same-object event pairs from output log
      </p>
      <div style={{overflowX:'auto'}}>
        <table className="behavior-table" style={{fontSize:'0.75rem',width:'100%'}}>
          <thead>
            <tr>
              {cols.map(c => (
                <th key={c.key} style={thStyle(c.key)} onClick={() => onSort(c.key)}>
                  {c.label}{sortKey === c.key ? (sortDir < 0 ? ' ↓' : ' ↑') : ''}
                </th>
              ))}
              <th style={{...thStyle('object_types'), cursor:'default'}}>Objects</th>
            </tr>
          </thead>
          <tbody>
            {schemas.map((s, i) => (
              <tr key={i} style={{borderBottom:'1px solid #f1f5f9'}}>
                {cols.map(c => (
                  <td key={c.key} style={{
                    padding:'0.3rem 0.5rem', color: c.color(s[c.key]),
                    textAlign: c.key === 'source_activity' || c.key === 'target_activity' ? 'left' : 'center',
                    fontWeight: c.key === 'eq_class' ? 400 : 500,
                    fontFamily: c.key === 'eq_class' ? 'monospace' : undefined,
                    fontSize: c.key === 'eq_class' ? '0.68rem' : undefined,
                  }}>{c.fmt(s[c.key])}</td>
                ))}
                <td style={{padding:'0.3rem 0.5rem',fontSize:'0.68rem',color:'#64748b',textAlign:'center'}}>
                  {Object.entries(s.object_types || {}).map(([ot, n]) =>
                    ot.split(/\s+/).map(w => w[0].toUpperCase()).join('') + (n > 1 ? `×${n}` : '')
                  ).join(' ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{marginTop:'0.5rem',fontSize:'0.7rem',color:'#94a3b8',display:'flex',gap:'1.5rem',flexWrap:'wrap'}}>
        <span><span style={{color:'#16a34a',fontWeight:700}}>■</span> ≥80%</span>
        <span><span style={{color:'#ca8a04',fontWeight:700}}>■</span> 50–80%</span>
        <span><span style={{color:'#dc2626',fontWeight:700}}>■</span> &lt;50% (coverage/reach)</span>
        <span>Selectivity/Exclusivity: 1 = one-to-one, &lt;1 = fan-out/fan-in</span>
      </div>
    </div>
  );
}

// ── EvaluationWrapper — side-by-side As-Is / To-Be with comparison header ────
function EvaluationWrapper({ resultsAsIs, resultsToBe, results, discoveryResults, activeModel, modelBase, serviceTimeMode, simActivityObjectCounts, onConformanceSaved, eventLogFiles, handleFileUpload, inputLogConfResults, inputEventLogFile, onRerunEvaluation, evalRunCount }) {
  const hasBoth = !!(resultsAsIs && resultsToBe);
  const rAsis = resultsAsIs ?? results;
  const rTobe = resultsToBe;
  const [verifyMode, setVerifyMode] = React.useState('frequency');
  const [evalTab, setEvalTab] = React.useState('comparison'); // 'comparison' | 'traces' | 'matrix' | 'asis' | 'tobe'

  const fmtDur = s => { if (!s) return '—'; if (s<60) return Math.round(s)+'s'; if (s<3600) return Math.floor(s/60)+'m'; if (s<86400) return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);return h>0?d+'d '+h+'h':d+'d'; };

  // ── Compute object trace completions ──────────────────────────────────────
  const computeTraceCompletions = (r) => {
    if (!r) return null;
    const audit = r.audit?.object_lifecycle_audit || {};
    const resourceTypes = new Set(r.resource_types || []);
    const totalByType = {}, deactByType = {};
    Object.entries(audit).forEach(([ot, a]) => {
      if (resourceTypes.has(ot)) return;
      totalByType[ot] = a.instance_count || 0;
      deactByType[ot] = a.deactivated_count || 0;
    });
    const totalAll = Object.values(totalByType).reduce((s,v)=>s+v,0);
    const deactAll = Object.values(deactByType).reduce((s,v)=>s+v,0);
    return { totalByType, deactByType, totalAll, deactAll, pct: totalAll>0?Math.round(deactAll/totalAll*100):0 };
  };
  const tracesAsis = computeTraceCompletions(rAsis);
  const tracesTobe = computeTraceCompletions(rTobe);

  // Log trace completion from discoveryResults
  const logTraces = discoveryResults?.log_object_trace_count ?? null;

  // ── Compute verification matrix ────────────────────────────────────────────
  const [timeSubMode, setTimeSubMode] = React.useState('mean'); // mean | min | max

  const buildMatrix = (r) => {
    if (!r) return null;
    const metrics = r.metrics?.activity_metrics || {};
    const serviceByType = r.metrics?.activity_service_by_type || {};
    const resourceTypes = new Set(r.resource_types || []);
    const audit = r.audit?.object_lifecycle_audit || {};
    const activities = Object.keys(metrics).sort(makeFlowRankSorter(discoveryResults, r.object_traces));
    const objTypes = Object.keys(audit).filter(t => !resourceTypes.has(t));

    const actBindings = {};
    const modelToUse = activeModel || modelBase;
    if (modelToUse?.activities) {
      modelToUse.activities.forEach(a => {
        const types = new Set((a.bindings||[]).map(b=>b.object_type).filter(t=>!resourceTypes.has(t)));
        actBindings[a.name] = types;
      });
    }

    const simObjTypes = r.object_types || {};
    return { activities, objTypes, metrics, serviceByType, audit, simObjTypes, actBindings };
  };

  const matrixAsis = buildMatrix(rAsis);
  const matrixTobe = buildMatrix(rTobe);
  const logActivityCounts = discoveryResults?.activity_counts || {};
  const logObjectTypes = discoveryResults?.object_type_stats || {};

  const VERIFY_MODES = [
    { key: 'frequency',   label: 'Event Frequency' },
    { key: 'time',        label: 'Time per Event' },
    { key: 'cardinality', label: 'Objects per Event' },
    { key: 'obj_time',    label: 'Time per Object Type' },
  ];

  // Tab buttons for top navigation
  const tabs = [
    { key: 'comparison', label: 'Comparison' },
    { key: 'coverage',   label: 'Coverage' },
    { key: 'matrix',     label: 'Verification Matrix' },
    { key: 'ocpq',       label: 'OCPQ' },
    { key: 'evaluation', label: 'Evaluation' },
  ];

  const renderTracePanel = (tc, label, logCount) => {
    if (!tc) return <div style={{color:'#94a3b8',fontSize:'0.85rem'}}>No {label} run yet.</div>;
    return (
      <div>
        <div style={{display:'flex',gap:'1rem',flexWrap:'wrap',marginBottom:'0.75rem'}}>
          <div className="behavior-stat-card">
            <div className="behavior-stat-val">{tc.deactAll.toLocaleString()}</div>
            <div className="behavior-stat-label">Completed traces</div>
          </div>
          <div className="behavior-stat-card">
            <div className="behavior-stat-val">{tc.totalAll.toLocaleString()}</div>
            <div className="behavior-stat-label">Total objects</div>
          </div>
          <div className={`behavior-stat-card`} style={{background: tc.pct>=80?'#f0fdf4':tc.pct>=50?'#fffbeb':'#fff1f2'}}>
            <div className="behavior-stat-val">{tc.pct}%</div>
            <div className="behavior-stat-label">Completion rate</div>
          </div>
          {logCount != null && (
            <div className="behavior-stat-card">
              <div className="behavior-stat-val">{logCount.toLocaleString()}</div>
              <div className="behavior-stat-label">Log objects</div>
            </div>
          )}
        </div>
        <table className="behavior-table">
          <thead><tr><th>Object Type</th><th>Total</th><th>Completed</th><th>Active</th><th>Rate</th>
            {logObjectTypes && <th>Log count</th>}
          </tr></thead>
          <tbody>
            {Object.entries(tc.totalByType).map(([ot, tot]) => {
              const deact = tc.deactByType[ot] || 0;
              const active = tot - deact;
              const pct = tot > 0 ? Math.round(deact/tot*100) : 0;
              const logCnt = logObjectTypes[ot]?.count ?? null;
              return (
                <tr key={ot}>
                  <td>{ot}</td>
                  <td>{tot}</td>
                  <td style={{color:pct>=80?'#16a34a':pct>=50?'#d97706':'#dc2626',fontWeight:600}}>{deact}</td>
                  <td style={{color:'#64748b'}}>{active}</td>
                  <td><div style={{background:'#f1f5f9',borderRadius:'4px',height:'8px',width:'80px',overflow:'hidden'}}>
                    <div style={{background:pct>=80?'#16a34a':pct>=50?'#f59e0b':'#ef4444',width:`${pct}%`,height:'100%'}}/>
                  </div><span style={{fontSize:'0.72rem',color:'#64748b',marginLeft:'4px'}}>{pct}%</span></td>
                  {logObjectTypes && <td style={{color:'#94a3b8'}}>{logCnt != null ? logCnt.toLocaleString() : '—'}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderVerifyMatrix = (matrix, label) => {
    if (!matrix) return <div style={{color:'#94a3b8',fontSize:'0.85rem'}}>No {label} run yet.</div>;
    const { activities, objTypes, metrics, serviceByType, audit, simObjTypes, actBindings } = matrix;
    if (!activities.length) return <div style={{color:'#94a3b8',fontSize:'0.85rem'}}>No activity metrics available for {label}. Run a simulation first to populate the matrix.</div>;
    // If no object type audit data, use all object types from actBindings
    const cols = objTypes.length > 0 ? objTypes
      : [...new Set(Object.values(actBindings).flatMap(s => [...s]))].sort();

    // For time mode, columns are object types; service time shown per (activity, object_type)
    const getCellVal = (act, ot) => {
      const m = metrics[act] || {};
      const a = audit[ot] || {};
      const participates = !actBindings[act] || actBindings[act].size === 0 || actBindings[act].has(ot);

      if (verifyMode === 'frequency') {
        const cnt = serviceByType?.[act]?.[ot]?.count ?? null;
        return cnt != null && cnt > 0 ? cnt : null;
      }
      if (verifyMode === 'time') {
        if (!participates) return null;
        // Use per-(activity, object_type) breakdown if available
        const perType = serviceByType?.[act]?.[ot];
        if (perType) {
          const val = timeSubMode === 'min' ? perType.min_s
                    : timeSubMode === 'max' ? perType.max_s
                    : perType.mean_s;
          return (val != null && val > 0) ? val : null;
        }
        // Fallback: activity-level metric (same for all participating types)
        const val = timeSubMode === 'min' ? m.min_service_s
                  : timeSubMode === 'max' ? m.max_service_s
                  : m.mean_service_s;
        return (val != null && val > 0) ? val : null;
      }
      if (verifyMode === 'cardinality') {
        if (!participates) return null;
        const objCount = simObjTypes[ot] || 0;
        const fires = m.execution_count || 0;
        if (!fires || !objCount) return null;
        const ratio = objCount / fires;
        return ratio > 0 ? ratio : null;
      }
      if (verifyMode === 'obj_time') {
        const lt = a.event_count_stats;
        return lt?.mean != null && lt.mean > 0 ? lt.mean : null;
      }
      return null;
    };

    const fmtCell = (val) => {
      if (verifyMode === 'time') return fmtDur(val);
      if (verifyMode === 'cardinality') return val.toFixed(1);
      if (verifyMode === 'obj_time') return val.toFixed(1)+' ev';
      return val?.toLocaleString() ?? '—';
    };

    const getLogVal = (act, ot) => {
      if (verifyMode === 'frequency') {
        const cnt = logActivityCounts[act];
        return cnt > 0 ? cnt.toLocaleString() : null;
      }
      if (verifyMode === 'cardinality') {
        const logOtCount = logObjectTypes[ot]?.count || 0;
        const logActCount = logActivityCounts[act] || 0;
        if (!logActCount || !logOtCount) return null;
        const ratio = logOtCount / logActCount;
        return ratio > 0 ? ratio.toFixed(1) : null;
      }
      return null;
    };

    const showLogRef = verifyMode === 'frequency' || verifyMode === 'cardinality';
    const vertStyle = { writingMode:'vertical-rl', transform:'rotate(180deg)', whiteSpace:'nowrap',
      fontSize:'0.7rem', padding:'0.25rem 0.1rem', maxHeight:'120px', textOverflow:'ellipsis', overflow:'hidden' };

    return (
      <div style={{overflowX:'auto'}}>
        <table className="behavior-table" style={{fontSize:'0.75rem',borderCollapse:'collapse'}}>
          <thead>
            <tr style={{verticalAlign:'bottom'}}>
              <th style={{minWidth:'130px',fontSize:'0.72rem',textAlign:'left',paddingBottom:'0.35rem'}}>Activity</th>
              {cols.map(ot => (
                <th key={ot} title={ot} style={{...vertStyle,fontWeight:600,color:'#475569',border:'1px solid #e2e8f0',background:'#f8fafc'}}>
                  {ot}
                </th>
              ))}
              {showLogRef && <th style={{...vertStyle,color:'#94a3b8',border:'1px solid #e2e8f0',background:'#f8fafc'}}>Log ref</th>}
            </tr>
          </thead>
          <tbody>
            {activities.map(act => {
              const m = metrics[act] || {};
              return (
                <tr key={act}>
                  <td style={{fontWeight:600,fontSize:'0.72rem',whiteSpace:'nowrap',paddingRight:'0.5rem'}}>{act}</td>
                  {cols.map(ot => {
                    const val = getCellVal(act, ot);
                    const hasVal = val != null && val !== 0;
                    return (
                      <td key={ot} style={{textAlign:'center',border:'1px solid #f1f5f9',
                        background: hasVal ? (verifyMode==='time'?'#eff6ff':verifyMode==='frequency'?'#f0fdf4':'#fefce8') : 'transparent',
                        color: hasVal ? (verifyMode==='time'?'#1d4ed8':verifyMode==='frequency'?'#166534':'#78350f') : '#cbd5e1',
                        fontWeight: hasVal ? 600 : 400,
                        fontSize:'0.72rem', padding:'0.2rem 0.3rem',
                      }}>
                        {hasVal ? fmtCell(val) : '—'}
                      </td>
                    );
                  })}
                  {showLogRef && (
                    <td style={{color:'#94a3b8',textAlign:'center',fontSize:'0.7rem',border:'1px solid #f1f5f9'}}>
                      {getLogVal(act, cols[0]) ?? '—'}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div>
      {/* Re-run button mirrored from Results tab */}
      {onRerunEvaluation && (
        <div style={{display:'flex',justifyContent:'flex-end',marginBottom:'0.75rem'}}>
          <button className="simulate-button"
            style={{width:'auto',padding:'0.4rem 1rem',fontSize:'0.82rem',background:'#475569'}}
            onClick={onRerunEvaluation}>
            ↻ Re-run Evaluation
          </button>
        </div>
      )}
      {/* Top navigation */}
      <div style={{display:'flex',gap:'0.4rem',flexWrap:'wrap',marginBottom:'1rem',borderBottom:'1px solid #e2e8f0',paddingBottom:'0.5rem'}}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setEvalTab(t.key)}
            style={{padding:'0.3rem 0.75rem',fontSize:'0.78rem',fontWeight:600,border:'none',borderRadius:'4px',cursor:'pointer',
              background: evalTab===t.key ? '#1e293b' : 'transparent',
              color: evalTab===t.key ? 'white' : '#64748b'}}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Comparison header — always shown when both exist */}
      {hasBoth && evalTab === 'comparison' && (() => {
        const fmtDur = s => { if (!s) return '—'; if (s<60) return Math.round(s)+'s'; if (s<3600) return Math.floor(s/60)+'m'; if (s<86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; };
        const pct = (a,b) => a&&b&&a!==0 ? Math.round((b-a)/Math.abs(a)*100) : null;
        // Graduated color: magnitude of % change scaled by direction preference
        // lower=true: decrease is good; lower=false: increase is good; lower=null: neutral grey
        const changeColor = (p, lower) => {
          if (p === null || lower === null) return '#64748b';
          const goodDir = lower ? p < 0 : p > 0;
          const mag = Math.abs(p);
          if (goodDir) return mag > 25 ? '#16a34a' : mag > 10 ? '#65a30d' : '#64748b';
          return mag < 10 ? '#64748b' : mag < 25 ? '#ca8a04' : mag < 50 ? '#ea580c' : '#dc2626';
        };
        const metrics = [
          { label:'Events Completed',  a:rAsis?.steps_executed,          b:rTobe?.steps_executed,          fmt:v=>v?.toLocaleString(), lower:null },
          { label:'Sim Time',          a:rAsis?.sim_time_s,               b:rTobe?.sim_time_s,               fmt:fmtDur,                 lower:true },
          { label:'Traces Completed',  a:tracesAsis?.deactAll,            b:tracesTobe?.deactAll,            fmt:v=>v?.toLocaleString(), lower:false },
          { label:'Trace Rate',        a:tracesAsis?.pct,                 b:tracesTobe?.pct,                 fmt:v=>v!=null?v+'%':null,  lower:false },
          { label:'Avg Wait Time',     a:rAsis?.avg_wait_s,               b:rTobe?.avg_wait_s,               fmt:fmtDur,                 lower:true },
          { label:'Avg Parallelism',   a:rAsis?.avg_parallelism,          b:rTobe?.avg_parallelism,          fmt:v=>v?.toFixed(2),       lower:false },
          { label:'Pending Obligations', a:rAsis?.completed_traces,       b:rTobe?.completed_traces,         fmt:v=>v?.toLocaleString(), lower:null },
        ];
        return (
          <div className="results-comparison-header" style={{marginBottom:'1rem'}}>
            {metrics.map((m,i) => {
              const p = pct(m.a, m.b);
              const color = changeColor(p, m.lower);
              return (
                <div key={i} className="compare-metric-card">
                  <div className="compare-metric-label">{m.label}</div>
                  <div className="compare-metric-asis">{m.fmt(m.a) ?? '—'}</div>
                  <div className="compare-metric-tobe" style={{color}}>
                    {m.fmt(m.b) ?? '—'}
                    {p!==null && <span className="compare-metric-pct"> {p>0?'+':''}{p}%</span>}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Side-by-side comparison of previous evaluations */}
      {evalTab === 'comparison' && (
        <div className="results-compare-layout">
          {[{label:'As-Is', r:rAsis}, ...(rTobe?[{label:'To-Be',r:rTobe}]:[])].map(({label,r}) => (
            <div key={label} className="run-result-panel">
              <div className="run-result-panel-header">{label}</div>
              <div style={{padding:'0.5rem'}}>
                <EvaluationTab
                  results={r}
                  discoveryResults={discoveryResults}
                  activeModel={activeModel}
                  serviceTimeMode={serviceTimeMode}
                  simActivityObjectCounts={simActivityObjectCounts}
                  onConformanceSaved={onConformanceSaved}
                  eventLogFiles={eventLogFiles}
                  handleFileUpload={handleFileUpload}
                  inputLogConfResults={inputLogConfResults}
                  inputEventLogFile={inputEventLogFile}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Verification matrix tab */}
      {evalTab === 'matrix' && (
        <div>
          <div style={{display:'flex',gap:'0.5rem',marginBottom:'0.75rem',flexWrap:'wrap',alignItems:'center'}}>
            <span style={{fontSize:'0.75rem',fontWeight:700,color:'#64748b',marginRight:'0.25rem'}}>Mode:</span>
            {VERIFY_MODES.map(m => (
              <button key={m.key} onClick={() => setVerifyMode(m.key)}
                style={{padding:'0.2rem 0.65rem',fontSize:'0.75rem',fontWeight:600,borderRadius:'4px',cursor:'pointer',
                  border: verifyMode===m.key ? '2px solid #1e293b' : '1px solid #e2e8f0',
                  background: verifyMode===m.key ? '#1e293b' : 'white',
                  color: verifyMode===m.key ? 'white' : '#475569'}}>
                {m.label}
              </button>
            ))}
            {verifyMode === 'time' && (
              <>
                <span style={{fontSize:'0.75rem',fontWeight:700,color:'#64748b',marginLeft:'0.75rem',marginRight:'0.25rem'}}>Aggregation:</span>
                {['mean','min','max'].map(sub => (
                  <button key={sub} onClick={() => setTimeSubMode(sub)}
                    style={{padding:'0.2rem 0.55rem',fontSize:'0.75rem',fontWeight:600,borderRadius:'4px',cursor:'pointer',
                      border: timeSubMode===sub ? '2px solid #1d4ed8' : '1px solid #e2e8f0',
                      background: timeSubMode===sub ? '#1d4ed8' : 'white',
                      color: timeSubMode===sub ? 'white' : '#475569'}}>
                    {sub.charAt(0).toUpperCase()+sub.slice(1)}
                  </button>
                ))}
              </>
            )}
          </div>
          <div className="results-compare-layout">
            <div className="run-result-panel">
              <div className="run-result-panel-header">As-Is</div>
              <div style={{padding:'1rem'}}>{renderVerifyMatrix(matrixAsis, 'As-Is')}</div>
            </div>
            {rTobe && (
              <div className="run-result-panel">
                <div className="run-result-panel-header">To-Be</div>
                <div style={{padding:'1rem'}}>{renderVerifyMatrix(matrixTobe, 'To-Be')}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Coverage tab — side-by-side for As-Is and To-Be */}
      {evalTab === 'coverage' && (
        <div className="results-compare-layout">
          {[{label:'As-Is', r:rAsis}, ...(rTobe?[{label:'To-Be',r:rTobe}]:[])].map(({label, r}) => (
            <div key={label} className="run-result-panel">
              <div className="run-result-panel-header">{label}</div>
              <div style={{padding:'1rem'}}>
                <OCCoveragePanel results={r} model={activeModel || modelBase} discoveryResults={discoveryResults} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* OCPQ tab — As-Is and To-Be side by side */}
      {evalTab === 'ocpq' && (
        <div className="results-compare-layout">
          {[{label:'As-Is', r:rAsis}, ...(rTobe?[{label:'To-Be',r:rTobe}]:[])].map(({label, r}) => (
            <div key={label} className="run-result-panel">
              <div className="run-result-panel-header">{label}</div>
              <div style={{padding:'0.75rem'}}>
                <OCPQPanel results={r} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Evaluation tab — As-Is and To-Be side by side */}
      {evalTab === 'evaluation' && (
        <div className="results-compare-layout">
          {[{label:'As-Is', r:rAsis}, ...(rTobe?[{label:'To-Be',r:rTobe}]:[])].map(({label, r}) => (
            <div key={label} className="run-result-panel">
              <div className="run-result-panel-header">{label}</div>
              <div style={{padding:'0.5rem'}}>
                {r ? (
                  <EvaluationTab key={evalRunCount} results={r} discoveryResults={discoveryResults} activeModel={activeModel}
                    serviceTimeMode={serviceTimeMode} simActivityObjectCounts={simActivityObjectCounts}
                    onConformanceSaved={onConformanceSaved} eventLogFiles={eventLogFiles}
                    handleFileUpload={handleFileUpload} inputLogConfResults={inputLogConfResults}
                    inputEventLogFile={inputEventLogFile} />
                ) : (
                  <div style={{color:'#94a3b8',fontSize:'0.85rem',padding:'1rem'}}>No {label} run yet.</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EvaluationTab({ results, discoveryResults, activeModel, serviceTimeMode, simActivityObjectCounts, onConformanceSaved, eventLogFiles, handleFileUpload, inputLogConfResults, inputEventLogFile }) {
  const simMetrics = results?.metrics?.activity_metrics || {};
  const logDurations = activeModel?.activity_durations || {};
  const [inlineConfScores, setInlineConfScores] = React.useState(null); // live conformance scores
  const o2oRules = activeModel?.o2o_rules || [];
  const otNames = (activeModel?.object_types || []).map(t => typeof t === 'string' ? t : t.name);

  // ── Evaluation progress tracking ─────────────────────────────────────────
  const EVAL_STEPS = [
    { key: 'timing',      label: 'Output log timing discovery' },
    { key: 'events',      label: 'Loading event log for conformance' },
    { key: 'conformance', label: 'OC-Declare conformance check' },
  ];
  const [stepsDone, setStepsDone] = React.useState({});
  const [stepsLoading, setStepsLoading] = React.useState({ timing: true });
  const markDone  = k => { setStepsDone(p => ({...p, [k]: true}));  setStepsLoading(p => ({...p, [k]: false})); };
  const markStart = k => setStepsLoading(p => ({...p, [k]: true}));
  const doneCount   = EVAL_STEPS.filter(s => stepsDone[s.key]).length;
  const loadingStep = EVAL_STEPS.find(s => stepsLoading[s.key]);
  const allDone     = doneCount === EVAL_STEPS.length;

  // Evaluation elapsed timer
  const [evalElapsed, setEvalElapsed] = React.useState(null);
  const evalStartRef = React.useRef(null);
  const evalTimerRef = React.useRef(null);
  React.useEffect(() => {
    if (!allDone && doneCount === 0 && Object.values(stepsLoading).some(Boolean)) {
      // Starting — begin timer
      if (!evalStartRef.current) {
        evalStartRef.current = Date.now();
        setEvalElapsed(0);
        evalTimerRef.current = setInterval(() => {
          setEvalElapsed(Math.floor((Date.now() - evalStartRef.current) / 1000));
        }, 1000);
      }
    } else if (allDone) {
      clearInterval(evalTimerRef.current);
      evalTimerRef.current = null;
    }
  }, [allDone, doneCount, stepsLoading]);
  React.useEffect(() => () => clearInterval(evalTimerRef.current), []);
  // Reset timer when results change
  React.useEffect(() => {
    evalStartRef.current = null;
    setEvalElapsed(null);
    clearInterval(evalTimerRef.current);
    evalTimerRef.current = null;
  }, [results?.output_file]);

  // ── Timing discovery on output log ───────────────────────────────────────
  const [simDiscovered, setSimDiscovered] = React.useState(null);   // discovered metrics for output log
  const [simDiscovering, setSimDiscovering] = React.useState(false);
  const [simDiscoverError, setSimDiscoverError] = React.useState(null);
  const discoveredForFile = React.useRef(null); // track which output_file we already ran for

  // Reset inline conf scores when simulation result changes
  React.useEffect(() => { setInlineConfScores(null); }, [results?.output_file]);

  React.useEffect(() => {
    const outputFile = results?.output_file;
    if (!outputFile || discoveredForFile.current === outputFile) {
      if (!outputFile) markDone('timing');
      return;
    }
    discoveredForFile.current = outputFile;
    setSimDiscovered(null);
    setSimDiscoverError(null);
    setSimDiscovering(true);
    markStart('timing');
    axios.post('/api/discover-timing-output', { outputFile, serviceTimeMode })
      .then(r => { setSimDiscovered(r.data.metrics || {}); markDone('timing'); })
      .catch(e => { setSimDiscoverError(e.response?.data?.error || e.message); markDone('timing'); })
      .finally(() => setSimDiscovering(false));
  }, [results?.output_file, serviceTimeMode]);

  // Compute flow-rank activity order (same as simulation tab evaluation table)
  const orderedActivities = React.useMemo(() => {
    const actSeq = results?.activity_sequence
      ? [...new Set(results.activity_sequence)]
      : Object.keys(simMetrics);
    const idxOf = {};
    actSeq.forEach((n, i) => { idxOf[n] = i; });
    const trans = {};
    Object.values(results?.object_traces || {}).forEach(seq => {
      seq.forEach((name, i) => {
        if (i < seq.length - 1) {
          const key = `${name}||${seq[i+1]}`;
          trans[key] = (trans[key] || 0) + 1;
        }
      });
    });
    const preds = {};
    actSeq.forEach(n => { preds[n] = []; });
    Object.keys(trans).forEach(key => {
      const [f, t] = key.split('||');
      if (f === t || idxOf[f] === undefined || idxOf[t] === undefined) return;
      if (idxOf[f] < idxOf[t]) preds[t]?.push(f);
    });
    const flowRank = {};
    actSeq.forEach(n => {
      flowRank[n] = preds[n]?.length ? Math.max(...preds[n].map(p => (flowRank[p] ?? 0) + 1)) : 0;
    });
    return [...new Set([...Object.keys(simMetrics), ...Object.keys(logDurations)])]
      .sort((a, b) => {
        const ra = a in flowRank ? flowRank[a] : 999999;
        const rb = b in flowRank ? flowRank[b] : 999999;
        return ra !== rb ? ra - rb : a.localeCompare(b);
      });
  }, [results, simMetrics, logDurations]);

  // Time spans
  const allTs = Object.values(simMetrics).flatMap(m => m.timestamps || []).filter(Boolean).sort();
  const simSpanS = allTs.length >= 2 ? (new Date(allTs[allTs.length-1]) - new Date(allTs[0])) / 1000 : null;
  const ocelSpanS = discoveryResults?.ocel_time_span_s ?? null;
  const fmtDur = s => {
    if (s == null) return '—';
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
    return `${(s / 86400).toFixed(1)} days`;
  };
  const ratio = simSpanS != null && ocelSpanS != null && ocelSpanS > 0 ? simSpanS / ocelSpanS : null;

  // O2O from sim output
  const simO2ORules = React.useMemo(() => {
    const links = results?.object_links;
    if (!links || !Array.isArray(links) || links.length === 0) return [];
    const typesMap = results?.object_types_map || {};
    const linkCounts = {};
    links.forEach(item => {
      const [a, b] = Array.isArray(item) ? item : [item?.source, item?.target];
      if (!a || !b) return;
      const ta = typesMap[a], tb = typesMap[b];
      if (!ta || !tb) return;
      const key = [ta, tb].sort().join('|||');
      if (!linkCounts[key]) linkCounts[key] = { source_type: ta, target_type: tb, perSource: {} };
      linkCounts[key].perSource[a] = (linkCounts[key].perSource[a] || 0) + 1;
    });
    return Object.values(linkCounts).map(r => {
      const counts = Object.values(r.perSource);
      return { source_type: r.source_type, target_type: r.target_type,
        min_links: counts.length > 0 ? Math.min(...counts) : 1,
        max_links: counts.length > 0 ? Math.max(...counts) : 1, bidirectional: true };
    });
  }, [results?.object_links, results?.object_types_map]);

  const simOtNames = results?.object_types ? Object.keys(results.object_types) : otNames;

  // Activity distribution data (same as simulation tab)
  const logCounts = discoveryResults?.activity_counts || {};
  const logRepeat = discoveryResults?.activity_repeat_stats || {};
  const simTotal = Object.values(simMetrics).reduce((s, m) => s + (m.execution_count || 0), 0);
  const logTotal = Object.values(logCounts).reduce((s, v) => s + v, 0);

  const modeLabel = { minimum: 'Minimum sojourn', p25: 'P25 sojourn', p50: 'P50 (median) sojourn' };

  return (
    <div className="evaluation-tab">
      <div className="section-header" style={{marginBottom:'1rem', background:'white'}}>
        <h2>Evaluation</h2>
        <p>Comparison of input event log vs simulation output</p>
      </div>

      {/* ── Progress bar ── */}
      {!allDone && (
        <div className="eval-progress-wrap">
          <div className="eval-progress-bar-outer">
            <div className="eval-progress-bar-inner" style={{width: `${(doneCount / EVAL_STEPS.length) * 100}%`}} />
          </div>
          <div className="eval-progress-status">
            {loadingStep ? (
              <><div className="spinner spinner-sm" style={{display:'inline-block',marginRight:'0.4rem'}} />{loadingStep.label}…</>
            ) : (
              doneCount < EVAL_STEPS.length
                ? <><div className="spinner spinner-sm" style={{display:'inline-block',marginRight:'0.4rem'}} />Preparing…</>
                : null
            )}
            <span style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:'0.75rem'}}>
              {evalElapsed != null && (
                <span className="sim-elapsed-timer" style={{fontSize:'0.82rem'}}>
                  ⏱ {Math.floor(evalElapsed/60).toString().padStart(2,'0')}:{(evalElapsed%60).toString().padStart(2,'0')}
                </span>
              )}
              <span className="eval-progress-count">{doneCount} / {EVAL_STEPS.length}</span>
            </span>
          </div>
          <div className="eval-progress-steps">
            {EVAL_STEPS.map(s => (
              <span key={s.key} className={`eval-step-chip ${stepsDone[s.key] ? 'eval-step-done' : stepsLoading[s.key] ? 'eval-step-loading' : 'eval-step-pending'}`}>
                {stepsDone[s.key] ? '✓ ' : stepsLoading[s.key] ? '⏳ ' : '○ '}{s.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Simulation Result ── */}
      {Object.keys(simMetrics).length > 0 && (
        <Collapsible className="eval-section" title="Simulation Result" defaultOpen={true}>
          {/* Service time summary */}
          {(() => {
            const fmtS = v => {
              if (v == null || v === 0) return '—';
              if (v >= 86400) return `${(v/86400).toFixed(1)} d`;
              if (v >= 3600)  return `${(v/3600).toFixed(1)} h`;
              if (v >= 60)    return `${Math.round(v/60)} min`;
              return `${Math.round(v)} s`;
            };
            // Total accumulated service time across all activities
            const totalSvcS = orderedActivities.reduce((s, act) => {
              const m = simMetrics[act];
              if (!m) return s;
              return s + (m.mean_service_s || 0) * (m.execution_count || 0);
            }, 0);
            const wmapeAct = logTotal > 0 && simTotal > 0
              ? orderedActivities.reduce((s, act) => {
                  const sp = (simMetrics[act]?.execution_count||0) / simTotal * 100;
                  const lp = (logCounts[act]||0) / logTotal * 100;
                  return s + Math.abs(sp - lp);
                }, 0)
              : null;
            return (
              <table className="metrics-table sim-compare-table">
                <thead>
                  <tr>
                    <th>Activity</th>
                    <th title="Times fired in simulation">Sim count</th>
                    <th title="Times fired in input log">Log count</th>
                    <th title="Share of simulated events">Sim %</th>
                    <th title="Share of log events">Log %</th>
                    <th title="Sim % − Log %">Diff {wmapeAct != null && <span style={{fontWeight:400,fontSize:'0.7rem',color: wmapeAct < 10 ? '#16a34a' : wmapeAct < 25 ? '#ca8a04' : wmapeAct < 50 ? '#ea580c' : '#dc2626'}}>WMAPE {wmapeAct.toFixed(1)}%</span>}</th>
                    <th title="Mean service time per firing">Mean svc</th>
                    <th title="Total accumulated service time (mean × count)">Total svc</th>
                    <th title="Share of total accumulated service time across all activities">Time share</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedActivities.map(act => {
                    const m = simMetrics[act] || {};
                    const simCount = m.execution_count ?? 0;
                    const logCount = logCounts[act] ?? 0;
                    const simPct = simTotal > 0 ? (simCount / simTotal * 100) : 0;
                    const logPct = logTotal > 0 ? (logCount / logTotal * 100) : 0;
                    const diff = simPct - logPct;
                    const diffClass = Math.abs(diff) < 2 ? 'cmp-ok' : diff > 0 ? 'cmp-over' : 'cmp-under';
                    const meanSvc = m.mean_service_s ?? null;
                    const totalSvc = meanSvc != null ? meanSvc * simCount : null;
                    const timeShare = totalSvcS > 0 && totalSvc != null ? totalSvc / totalSvcS * 100 : null;
                    return (
                      <tr key={act}>
                        <td className="metrics-act-name">{act}</td>
                        <td>{simCount || '—'}</td>
                        <td>{logCount || '—'}</td>
                        <td>{simPct > 0 ? simPct.toFixed(1) + '%' : '—'}</td>
                        <td>{logPct > 0 ? logPct.toFixed(1) + '%' : '—'}</td>
                        <td className={`cmp-diff ${diffClass}`}>{simCount > 0 || logCount > 0 ? (diff >= 0 ? '+' : '') + diff.toFixed(1) + 'pp' : '—'}</td>
                        <td>{fmtS(meanSvc)}</td>
                        <td>{fmtS(totalSvc)}</td>
                        <td>
                          {timeShare != null ? (
                            <span style={{display:'inline-flex',alignItems:'center',gap:'0.3rem'}}>
                              <span style={{fontSize:'0.78rem',fontWeight:600,minWidth:'36px'}}>{timeShare.toFixed(1)}%</span>
                              <span style={{
                                display:'inline-block', height:'8px',
                                width:`${Math.max(2, timeShare * 1.2)}px`,
                                maxWidth:'80px',
                                background:`hsl(${220 - timeShare * 1.8},70%,55%)`,
                                borderRadius:'3px', flexShrink:0
                              }}/>
                            </span>
                          ) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          })()}

          {/* Log /obj and Sim /obj — collapsible */}
          <Collapsible className="conf-detail-collapsible" title="Firings per object" defaultOpen={false}>
            <table className="conf-detail-table">
              <thead>
                <tr>
                  <th>Activity</th>
                  <th className="audit-num" title="Mean firings per object in log">Log /obj</th>
                  <th className="audit-num" title="Mean firings per object in simulation">Sim /obj</th>
                </tr>
              </thead>
              <tbody>
                {orderedActivities.map(act => {
                  const simCount = simMetrics[act]?.execution_count ?? 0;
                  const logMeanObj = logRepeat[act]?.mean ?? null;
                  const simObjEvts = simActivityObjectCounts?.[act] ?? null;
                  const simMeanObj = simObjEvts > 0 ? (simCount / simObjEvts).toFixed(2) : null;
                  return (
                    <tr key={act}>
                      <td style={{fontSize:'0.78rem'}}>{act}</td>
                      <td className="audit-num">{logMeanObj ?? '—'}</td>
                      <td className="audit-num">{simMeanObj ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Collapsible>

          {/* ── Confidence Score (Conformance) — inline summary + collapsible detail ── */}
          <div style={{marginTop:'0.75rem'}}>
            <div style={{display:'flex',alignItems:'center',gap:'1rem',marginBottom:'0.4rem',flexWrap:'wrap'}}>
              <span style={{fontSize:'0.88rem',fontWeight:700,color:'#1e293b'}}>Confidence Score</span>
              {(() => {
                // Use live computed scores if available, fall back to persisted
                const scores = inlineConfScores || results?.conformance;
                const cls = v => v == null ? '' : v >= 0.8 ? 'conf-good' : v >= 0.5 ? 'conf-mid' : 'conf-bad';
                const fmt = v => v != null ? `${(v*100).toFixed(1)}%` : '—';
                if (scores?.fitness != null || scores?.precision != null) {
                  return (
                    <>
                      <span style={{fontSize:'0.82rem',color:'#64748b'}}>Fitness: <strong className={cls(scores.fitness)}>{fmt(scores.fitness)}</strong></span>
                      <span style={{fontSize:'0.82rem',color:'#64748b'}}>Con. Fitness: <strong className={cls(scores.constraint_fitness)}>{fmt(scores.constraint_fitness)}</strong></span>
                      <span style={{fontSize:'0.82rem',color:'#64748b'}}>Precision: <strong className={cls(scores.precision)}>{fmt(scores.precision)}</strong></span>
                    </>
                  );
                }
                return null;
              })()}
            </div>
            <ConformanceSection
              results={results}
              activeModel={activeModel}
              onConformanceSaved={onConformanceSaved}
              onEventsLoadStart={() => markStart('events')}
              onEventsLoadDone={() => markDone('events')}
              onConformanceDone={() => markDone('conformance')}
              onScoresComputed={scores => setInlineConfScores(scores)}
              inputLogConfResults={inputLogConfResults}
              inputEventLogFile={inputEventLogFile}
            />
          </div>
        </Collapsible>
      )}

      {/* ── Time Comparison ── */}
      <Collapsible className="eval-section" title="Time Comparison" defaultOpen={true}>
        {/* Time span */}
        <div className="eval-timespan-row">
          <div className="eval-timespan-card">
            <span className="eval-timespan-label">Input OCEL time span</span>
            <span className="eval-timespan-val">{fmtDur(ocelSpanS)}</span>
          </div>
          <div className="eval-timespan-arrow">→</div>
          <div className="eval-timespan-card">
            <span className="eval-timespan-label">Simulation time span</span>
            <span className="eval-timespan-val">{fmtDur(simSpanS)}</span>
          </div>
          {ratio != null && (
            <div className={`eval-timespan-ratio ${ratio > 1.5 || ratio < 0.5 ? 'eval-ratio-warn' : 'eval-ratio-ok'}`}>
              {ratio.toFixed(2)}× input
            </div>
          )}
        </div>

        {/* WMAPE: Sim mean vs Log mean, and Log mean vs Discovered mean */}
        {(() => {
          const simM = simMetrics;
          const logDurs = logDurations; // discovered from input OCEL
          const simDurs = simDiscovered || {}; // timing discovered from output OCEL
          const acts = orderedActivities.filter(a => simM[a] || logDurs[a]);
          if (acts.length === 0) return null;

          const fmtS = v => { if(!v) return '—'; if(v>=86400) return (v/86400).toFixed(1)+'d'; if(v>=3600) return (v/3600).toFixed(1)+'h'; if(v>=60) return Math.round(v/60)+'m'; return Math.round(v)+'s'; };

          // WMAPE = Σ |sim - log| / Σ log  (weighted by log count)
          const wmape = (pairs) => {
            let num = 0, den = 0;
            pairs.forEach(([sim, log, w]) => {
              if (sim != null && log != null && log > 0) { num += Math.abs(sim-log) * (w||1); den += log * (w||1); }
            });
            return den > 0 ? (num/den*100) : null;
          };

          const simVsLogPairs = acts.map(a => [simM[a]?.mean_service_s, logDurs[a]?.service_mean, simM[a]?.execution_count||1]);
          const logVsDiscPairs = acts.map(a => [logDurs[a]?.service_mean, simDurs[a]?.service_mean, simM[a]?.execution_count||1]);
          const wmapeSimLog = wmape(simVsLogPairs);
          const wmapeLogDisc = wmape(logVsDiscPairs);

          return (
            <Collapsible className="eval-subsection" title="Timing WMAPE — Sim vs Log vs Discovered" defaultOpen={true}>
              {/* WMAPE summary cards */}
              <div style={{display:'flex',gap:'1rem',marginBottom:'0.75rem',flexWrap:'wrap'}}>
                <div className="behavior-stat-card" style={{background:wmapeSimLog!=null&&wmapeSimLog<20?'#f0fdf4':wmapeSimLog!=null&&wmapeSimLog<50?'#fffbeb':'#fff1f2'}}>
                  <div className="behavior-stat-val">{wmapeSimLog!=null?wmapeSimLog.toFixed(1)+'%':'—'}</div>
                  <div className="behavior-stat-label">WMAPE: Sim mean vs Log mean</div>
                </div>
                {simDurs && Object.keys(simDurs).length > 0 && (
                  <div className="behavior-stat-card" style={{background:wmapeLogDisc!=null&&wmapeLogDisc<20?'#f0fdf4':wmapeLogDisc!=null&&wmapeLogDisc<50?'#fffbeb':'#fff1f2'}}>
                    <div className="behavior-stat-val">{wmapeLogDisc!=null?wmapeLogDisc.toFixed(1)+'%':'—'}</div>
                    <div className="behavior-stat-label">WMAPE: Log mean vs Discovered (output)</div>
                  </div>
                )}
              </div>
              <p style={{fontSize:'0.72rem',color:'#64748b',marginBottom:'0.5rem'}}>
                WMAPE = Σ|sim−log| / Σlog weighted by execution count. Lower = better match.
              </p>

              {/* Per-activity table */}
              <table className="metrics-table" style={{fontSize:'0.78rem'}}>
                <thead>
                  <tr>
                    <th>Activity</th>
                    <th>Log mean</th><th>Sim mean</th><th>|Δ|%</th>
                    {simDurs && Object.keys(simDurs).length > 0 && <><th>Discovered mean</th><th>Log vs Disc |Δ|%</th></>}
                  </tr>
                </thead>
                <tbody>{acts.map(act => {
                  const lm = logDurs[act]?.service_mean;
                  const sm = simM[act]?.mean_service_s;
                  const dm = simDurs[act]?.service_mean;
                  const diffSD = lm&&sm&&lm>0 ? Math.abs(sm-lm)/lm*100 : null;
                  const diffLD = lm&&dm&&lm>0 ? Math.abs(dm-lm)/lm*100 : null;
                  const cls = v => v==null?'':v<10?'cmp-ok':v<50?'':' cmp-over';
                  return (
                    <tr key={act}>
                      <td>{act}</td>
                      <td>{fmtS(lm)}</td>
                      <td>{fmtS(sm)}</td>
                      <td className={`audit-num${cls(diffSD)}`}>{diffSD!=null?diffSD.toFixed(1)+'%':'—'}</td>
                      {simDurs && Object.keys(simDurs).length > 0 && <>
                        <td>{fmtS(dm)}</td>
                        <td className={`audit-num${cls(diffLD)}`}>{diffLD!=null?diffLD.toFixed(1)+'%':'—'}</td>
                      </>}
                    </tr>
                  );
                })}</tbody>
              </table>
            </Collapsible>
          );
        })()}

        {/* Service time chart */}
        <Collapsible className="eval-subsection" title="Service Time per Activity" defaultOpen={false}>
          <p style={{fontSize:'0.78rem',color:'#64748b',marginBottom:'0.5rem'}}>
            Both sides use the <strong>{modeLabel[serviceTimeMode] || serviceTimeMode}</strong> discovery method.
            Left: input OCEL log (from Parameter tab discovery). Right: simulated output log (discovered now).
            {simDiscovering && <span style={{marginLeft:'0.5rem',color:'#6366f1'}}>⏳ Discovering output log…</span>}
            {simDiscoverError && <span style={{marginLeft:'0.5rem',color:'#b91c1c'}}>⚠ {simDiscoverError}</span>}
          </p>
          <ActivityBarChart
            logDurations={logDurations}
            simDurations={simDiscovered || {}}
            metric="service"
            title="Service Time"
            orderedActivities={orderedActivities}
          />
        </Collapsible>

        {/* Waiting time chart */}
        <Collapsible className="eval-subsection" title="Waiting Time per Activity" defaultOpen={false}>
          <p style={{fontSize:'0.78rem',color:'#64748b',marginBottom:'0.5rem'}}>
            Waiting time = sojourn − service, using the same discovery method as service time.
            {simDiscovering && <span style={{marginLeft:'0.5rem',color:'#6366f1'}}>⏳ Discovering output log…</span>}
          </p>
          <ActivityBarChart
            logDurations={logDurations}
            simDurations={simDiscovered || {}}
            metric="waiting"
            title="Waiting Time"
            orderedActivities={orderedActivities}
          />
        </Collapsible>

        {/* Timing Discovery Comparison table */}
        <Collapsible className="eval-subsection" title="Timing Discovery Comparison" defaultOpen={false}>
          {(() => {
            const fmtS = v => {
              if (v == null || v === 0) return '—';
              if (v >= 86400) return `${(v/86400).toFixed(1)} d`;
              if (v >= 3600)  return `${(v/3600).toFixed(1)} h`;
              if (v >= 60)    return `${Math.round(v/60)} min`;
              return `${Math.round(v)} s`;
            };
            const pctDiff = (a, b) => (a == null || b == null || a === 0) ? null : (b - a) / a * 100;
            const fmtPct = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
            const pctCls = v => { if (v == null) return ''; const n = Math.abs(v); return n < 5 ? 'cmp-ok' : v > 0 ? 'cmp-over' : 'cmp-under'; };

            const fields = [
              { key: 'service_mean', label: 'Service mean' },
              { key: 'service_min',  label: 'Service min' },
              { key: 'service_max',  label: 'Service max' },
              { key: 'waiting_mean', label: 'Waiting mean' },
              { key: 'sojourn_mean', label: 'Sojourn mean' },
            ];
            const acts = orderedActivities.filter(a => logDurations[a] || simDiscovered?.[a]);
            if (acts.length === 0) return <p className="empty-notice">No timing data available yet.{simDiscovering && ' Discovering…'}</p>;

            // Overall relative deviation: mean of |Δ%| across all (act, field) pairs
            let deviations = [];
            acts.forEach(act => {
              const log = logDurations[act] || {};
              const sim = simDiscovered?.[act] || {};
              fields.forEach(f => {
                const d = pctDiff(log[f.key], sim[f.key]);
                if (d != null) deviations.push(d);
              });
            });
            const overallMeanDev = deviations.length > 0
              ? deviations.reduce((s, v) => s + v, 0) / deviations.length : null;
            const overallAbsDev = deviations.length > 0
              ? deviations.reduce((s, v) => s + Math.abs(v), 0) / deviations.length : null;

            return (
              <div>
                <p style={{fontSize:'0.78rem',color:'#64748b',marginBottom:'0.5rem'}}>
                  Input OCEL log vs simulated output log, both using <strong>{({minimum:'Minimum sojourn',p25:'P25 sojourn',p50:'P50 (median) sojourn'})[serviceTimeMode] || serviceTimeMode}</strong>.
                  {simDiscovering && <span style={{marginLeft:'0.5rem',color:'#6366f1'}}>⏳ Discovering output log…</span>}
                </p>

                {/* Overall deviation summary */}
                <div className="timing-compare-overall">
                  <span className="timing-compare-overall-label">Overall mean relative deviation</span>
                  <span className={`timing-compare-overall-val ${pctCls(overallMeanDev)}`}>{fmtPct(overallMeanDev)}</span>
                  <span className="timing-compare-overall-label" style={{marginLeft:'1.5rem'}}>Mean absolute deviation</span>
                  <span className="timing-compare-overall-val" style={{color:'#475569'}}>{overallAbsDev != null ? overallAbsDev.toFixed(1) + '%' : '—'}</span>
                </div>

                {/* Per-activity foldable rows */}
                <div className="timing-compare-act-list">
                  {acts.map(act => {
                    const log = logDurations[act] || {};
                    const sim = simDiscovered?.[act] || {};
                    const summaryPcts = fields.map(f => pctDiff(log[f.key], sim[f.key])).filter(v => v != null);
                    const avgPct = summaryPcts.length > 0 ? summaryPcts.reduce((s,v)=>s+v,0)/summaryPcts.length : null;
                    return (
                      <details key={act} className="timing-compare-act-details">
                        <summary className="timing-compare-act-summary">
                          <span className="timing-compare-act-name">{act}</span>
                          <span className="timing-compare-act-chips">
                            {fields.map(f => {
                              const d = pctDiff(log[f.key], sim[f.key]);
                              return d != null ? (
                                <span key={f.key} className={`timing-compare-chip ${pctCls(d)}`} title={f.label}>
                                  {f.label.replace('Service ','svc ').replace('Waiting ','wait ').replace('Sojourn ','sojourn ')}:&nbsp;{fmtPct(d)}
                                </span>
                              ) : null;
                            })}
                          </span>
                          <span className={`timing-compare-act-avg ${pctCls(avgPct)}`}>{fmtPct(avgPct)}</span>
                        </summary>
                        {/* Expanded detail table */}
                        <table className="timing-compare-detail-table">
                          <thead>
                            <tr>
                              <th>Metric</th>
                              <th className="audit-num">Input Log</th>
                              <th className="audit-num">Sim Output</th>
                              <th className="audit-num">Δ absolute</th>
                              <th className="audit-num">Δ %</th>
                            </tr>
                          </thead>
                          <tbody>
                            {fields.map(f => {
                              const lv = log[f.key], sv = sim[f.key];
                              const da = (lv != null && sv != null) ? sv - lv : null;
                              const dp = pctDiff(lv, sv);
                              return (
                                <tr key={f.key}>
                                  <td style={{color:'#64748b',fontSize:'0.72rem'}}>{f.label}</td>
                                  <td className="audit-num">{fmtS(lv)}</td>
                                  <td className="audit-num">{fmtS(sv)}</td>
                                  <td className={`audit-num cmp-diff ${pctCls(da != null ? (da > 0 ? 1 : da < 0 ? -1 : 0) : null)}`}>
                                    {da != null ? (da >= 0 ? '+' : '') + fmtS(da) : '—'}
                                  </td>
                                  <td className={`audit-num cmp-diff ${pctCls(dp)}`}>{fmtPct(dp)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </details>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </Collapsible>

        {/* Activity Timeline moved inside Time Comparison */}
        <ActivityGanttChart
          results={results}
          orderedActivities={orderedActivities}
          simMetrics={simMetrics}
        />
      </Collapsible>

      {/* ── Trace Health ── */}
      <TraceHealth results={results} />

      {/* ── Constraint Analysis ── */}
      <ConstraintAnalysis activeModel={activeModel} results={results} />

      {/* ── O2O Comparison ── */}
      <Collapsible className="eval-section" title="O2O Rules Comparison" defaultOpen={false}>
        <div className="eval-o2o-row">
          <div className="eval-o2o-side">
            <div className="eval-o2o-side-label">Input Model</div>
            {o2oRules.length > 0
              ? <O2ODiagram rules={o2oRules} otNames={otNames} />
              : <p className="empty-notice">No O2O rules in model.</p>}
          </div>
          <div className="eval-o2o-side">
            <div className="eval-o2o-side-label">Simulation Output</div>
            {simO2ORules.length > 0
              ? <O2ODiagram rules={simO2ORules} otNames={simOtNames} />
              : <p className="empty-notice">No object links recorded in simulation.</p>}
          </div>
        </div>
      </Collapsible>

      {/* ── Log Inspection — always last ── */}
      <LogInspection eventLogFiles={eventLogFiles} handleFileUpload={handleFileUpload} />
    </div>
  );
}

// ── PerObjectBoundsChecker ────────────────────────────────────────────────────
// Checks nmin/nmax per scope object across the whole log.
// For each constraint with a scope, for each object of that scope type:
//   - collects all source events involving that object
//   - collects all target events in the correct temporal window involving that object
//   - checks count is in [nmin, nmax]
// Reports per-constraint: how many scope objects violated the bounds.
function PerObjectBoundsChecker({ events, typesMap, constraints, onBoundsResults }) {
  const results = React.useMemo(() => {
    if (!events || events.length === 0 || !constraints || constraints.length === 0) return [];
    const eventObjs = events.map(e => new Set(e.object_ids || []));

    const objEvents = {};
    events.forEach((e, i) => {
      (e.object_ids || []).forEach(oid => {
        (objEvents[oid] = objEvents[oid] || []).push(i);
      });
    });

    const objsByType = {};
    Object.entries(typesMap).forEach(([oid, t]) => {
      (objsByType[t] = objsByType[t] || []).push(oid);
    });

    return constraints
      .filter(c => c.scope?.kind === 'each' && c.scope?.object_type)
      .map(c => {
        const { source_activity: src, target_activity: tgt, constraint_type: ctype,
                scope, nmin = 1, nmax } = c;
        const label = `${ctype}(${src}→${tgt})`;
        const scopeObjs = objsByType[scope.object_type] || [];
        const isBefore = ['precedence','chain_precedence','alternate_precedence'].includes(ctype);
        const isNot = ['not_coexistence','not_succession'].includes(ctype);

        let violated = 0, checked = 0, underMin = 0, overMax = 0, tgtCount = 0;
        let maxObserved = 0; // max target count seen across all scope objects
        const violators = [];

        scopeObjs.forEach(oid => {
          const objEvtIdxs = objEvents[oid] || [];
          if (objEvtIdxs.length === 0) return;

          if (isNot) {
            const hasSrc = objEvtIdxs.some(i => events[i].activity === src);
            const hasTgt = objEvtIdxs.some(i => events[i].activity === tgt);
            if (hasSrc && hasTgt) {
              checked++;
              violated++;
              overMax++;
              if (violators.length < 5) violators.push({ oid, srcCount: 1, tgtCount: 1 });
            }
            return;
          }

          if (isBefore) {
            const tgtEvts = objEvtIdxs.filter(i => events[i].activity === tgt);
            if (tgtEvts.length === 0) return;
            checked++;
            let anyViolation = false;
            tgtEvts.forEach(ti => {
              const tgtTs = events[ti].timestamp;
              const srcBefore = objEvtIdxs.filter(i =>
                events[i].activity === src && events[i].timestamp <= tgtTs
              ).length;
              if (srcBefore > maxObserved) maxObserved = srcBefore;
              if (srcBefore < nmin) { anyViolation = true; underMin++; }
              if (nmax != null && srcBefore > nmax) { anyViolation = true; overMax++; }
              tgtCount = srcBefore;
            });
            // Also track max target count per object (for response-style nmax suggestion)
            const tgtOnObj = tgtEvts.length;
            if (tgtOnObj > maxObserved) maxObserved = tgtOnObj;
            if (anyViolation) {
              violated++;
              if (violators.length < 5) violators.push({ oid, srcCount: objEvtIdxs.filter(i => events[i].activity === src).length, tgtCount });
            }
          } else {
            const srcEvtIdxs = objEvtIdxs.filter(i => events[i].activity === src);
            if (srcEvtIdxs.length === 0) return;
            checked++;
            let anyViolation = false;
            srcEvtIdxs.forEach(si => {
              const srcTs = events[si].timestamp;
              const cnt = objEvtIdxs.filter(i =>
                events[i].activity === tgt && events[i].timestamp >= srcTs
              ).length;
              if (cnt > maxObserved) maxObserved = cnt;
              if (cnt < nmin) { anyViolation = true; underMin++; }
              if (nmax != null && cnt > nmax) { anyViolation = true; overMax++; }
              tgtCount = cnt;
            });
            if (anyViolation) {
              violated++;
              if (violators.length < 5) violators.push({ oid, srcCount: srcEvtIdxs.length, tgtCount });
            }
          }
        });

        if (checked === 0) return null;
        return { label, checked, violated, underMin, overMax, nmin, nmax, maxObserved, violators,
                 constraint: c, hasNmax: nmax != null };
      })
      .filter(Boolean);
  }, [events, typesMap, constraints]);

  React.useEffect(() => { onBoundsResults?.(results); }, [results]);

  if (results.length === 0) return <p style={{fontSize:'0.78rem',color:'#94a3b8',fontStyle:'italic'}}>No scoped constraints to evaluate.</p>;

  const anyViolations = results.some(r => r.violated > 0);
  const pct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`;

  return (
    <Collapsible
      className="conf-detail-collapsible"
      title="Per-Object Bounds Check (nmin/nmax)"
      defaultOpen={false}
    >
      <p style={{fontSize:'0.75rem',color:'#64748b',marginBottom:'0.5rem'}}>
        For each scoped constraint: checks every scope object in the log to see if the count
        of target events falls within [nmin, nmax]. Constraints with nmax=∞ only check the lower bound.
        The <strong>Max observed</strong> column shows the highest count seen — useful for setting nmax.
      </p>
      {!anyViolations && (
        <p style={{fontSize:'0.8rem',color:'#166534',fontWeight:600}}>✓ All scope objects satisfy [nmin, nmax] bounds.</p>
      )}
      <table className="conf-detail-table">
        <thead>
          <tr>
            <th>Constraint</th>
            <th className="audit-num">Bounds</th>
            <th className="audit-num">Max observed</th>
            <th className="audit-num">Objects checked</th>
            <th className="audit-num">Violated</th>
            <th className="audit-num">Under-min</th>
            <th className="audit-num">Over-max</th>
            <th className="audit-num">Compliance</th>
          </tr>
        </thead>
        <tbody>
          {results.sort((a, b) => b.violated - a.violated).map(r => {
            const compliance = r.checked > 0 ? (r.checked - r.violated) / r.checked : 1;
            const cls = compliance >= 0.9 ? 'conf-good' : compliance >= 0.5 ? 'conf-mid' : 'conf-bad';
            const suggestNmax = !r.hasNmax && r.maxObserved > 0;
            return (
              <React.Fragment key={r.label}>
                <tr className={r.violated > 0 ? 'audit-row-accumulating' : ''}>
                  <td style={{fontFamily:'monospace',fontSize:'0.72rem'}}>{r.label}</td>
                  <td className="audit-num" style={{fontSize:'0.72rem',color:'#6366f1',fontWeight:600}}>[{r.nmin}, {r.nmax ?? '∞'}]</td>
                  <td className="audit-num">
                    <span style={{fontWeight:700,color: suggestNmax ? '#6366f1' : '#1e293b'}}
                          title={suggestNmax ? 'No nmax set — consider setting nmax to this value' : ''}>
                      {r.maxObserved}
                      {suggestNmax && <span style={{fontSize:'0.65rem',color:'#6366f1',marginLeft:'0.2rem'}}>→ set nmax?</span>}
                    </span>
                  </td>
                  <td className="audit-num">{r.checked}</td>
                  <td className="audit-num">{r.violated > 0 ? <span style={{color:'#b91c1c',fontWeight:700}}>{r.violated}</span> : '0'}</td>
                  <td className="audit-num">{r.underMin > 0 ? <span style={{color:'#b91c1c'}}>{r.underMin}</span> : '0'}</td>
                  <td className="audit-num">{r.overMax > 0 ? <span style={{color:'#b45309'}}>{r.overMax}</span> : '0'}</td>
                  <td className="audit-num"><span className={cls}>{pct(compliance)}</span></td>
                </tr>
                {r.violated > 0 && r.violators.length > 0 && (
                  <tr>
                    <td colSpan={8} style={{fontSize:'0.68rem',color:'#64748b',paddingLeft:'1rem',paddingBottom:'0.3rem'}}>
                      Example violations: {r.violators.map(v =>
                        `${v.oid} (src×${v.srcCount}, tgt×${v.tgtCount})`
                      ).join(' · ')}{r.violated > r.violators.length ? ` … +${r.violated - r.violators.length} more` : ''}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </Collapsible>
  );
}

// ── LogModelConformance ───────────────────────────────────────────────────────
function LogModelConformance({ eventLogFile, activeModel, onResults, onBoundsResults, autoRunTrigger }) {
  const [events,    setEvents]    = React.useState(null);
  const [typesMap,  setTypesMap]  = React.useState({});
  const [loading,   setLoading]   = React.useState(false);
  const [error,     setError]     = React.useState(null);
  const [progress,  setProgress]  = React.useState({ done: 0, total: 0 });
  const [conf,      setConf]      = React.useState(null);
  const loadedFor   = React.useRef(null); // tracks which file+constraintCount was last run
  const computing   = React.useRef(false);

  const constraints = activeModel?.constraints || [];
  const hasModel = activeModel && !Array.isArray(activeModel) && constraints.length > 0;
  // Key that identifies the current file+model — only re-run when this changes
  const runKey = eventLogFile + '|' + constraints.length;

  // Auto-run when triggered from runAllDiscoveries, but only if not already done for this file+model
  React.useEffect(() => {
    if (autoRunTrigger > 0 && eventLogFile && hasModel && loadedFor.current !== runKey) {
      run();
    }
  }, [autoRunTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (!eventLogFile || !hasModel) return;
    setConf(null);
    setProgress({ done: 0, total: 0 });
    computing.current = true;

    let evts = events;
    let tmap = typesMap;
    if (!evts || loadedFor.current?.split('|')[0] !== eventLogFile) {
      setLoading(true);
      setError(null);
      try {
        const r = await axios.get(`/api/eventlog-events?file=${encodeURIComponent(eventLogFile)}`);
        evts = r.data.events || [];
        tmap = r.data.object_types_map || {};
        setEvents(evts);
        setTypesMap(tmap);
      } catch(e) {
        setError(e.response?.data?.error || e.message);
        setLoading(false);
        computing.current = false;
        return;
      } finally {
        setLoading(false);
      }
    }

    const n = evts.length;
    const total = constraints.length;
    setProgress({ done: 0, total });

    const eventObjs = evts.map(e => new Set(e.object_ids || []));
    // Index events by activity for O(1) lookup instead of O(n) scan
    const byAct = {};
    evts.forEach((e, i) => { (byAct[e.activity] = byAct[e.activity] || []).push(i); });
    const sortedEvtTs = evts.map(e => e.timestamp);
    const firstAtOrAfter = (ts) => {
      let lo = 0, hi = n;
      while (lo < hi) { const mid=(lo+hi)>>1; sortedEvtTs[mid] < ts ? lo=mid+1 : hi=mid; }
      return lo;
    };
    const temporalFilter = (srcIdx, ctype, tgtAct) => {
      const srcTs = evts[srcIdx].timestamp;
      if (ctype === 'chain_response') return srcIdx + 1 < n ? [srcIdx + 1] : [];
      if (ctype === 'chain_precedence') return srcIdx - 1 >= 0 ? [srcIdx - 1] : [];
      const tgtIdxs = byAct[tgtAct] || [];
      if (['response','chain_response','succession','alternate_response',
           'precedence','alternate_precedence'].includes(ctype)) {
        const start = firstAtOrAfter(srcTs);
        return tgtIdxs.filter(j => j >= start && j !== srcIdx);
      }
      return tgtIdxs.filter(j => j !== srcIdx);
    };
    const satisfies = (i, c) => {
      if (evts[i].activity !== c.source_activity) return true;
      const nmin = c.nmin ?? 1, nmax = c.nmax ?? null;
      const tgt = c.target_activity;
      const scope = c.scope || { kind: 'global' };
      const tgtCandidates = temporalFilter(i, c.constraint_type, tgt);
      if (scope.kind === 'global') {
        const cnt = tgtCandidates.length;
        if (['not_coexistence','not_succession'].includes(c.constraint_type)) return cnt === 0;
        return cnt >= nmin && (nmax == null || cnt <= nmax);
      }
      const scopeObjs = [...eventObjs[i]].filter(oid => tmap[oid] === scope.object_type);
      if (scopeObjs.length === 0) return true;
      for (const oid of scopeObjs) {
        const matching = tgtCandidates.filter(j => eventObjs[j].has(oid));
        const cnt = matching.length;
        if (['not_coexistence','not_succession'].includes(c.constraint_type)) {
          if (cnt > 0) return false;
        } else {
          if (cnt < nmin) return false;
          if (nmax != null && cnt > nmax) return false;
        }
      }
      return true;
    };

    const results = [];
    let globalSatisfied = new Array(n).fill(true);

    const evalNext = (idx) => {
      if (!computing.current || idx >= total) {
        const globalCount = globalSatisfied.filter(Boolean).length;
        const result = {
          constraintResults: results,
          globalConformance: n > 0 ? globalCount / n : null,
          globalSatisfied: globalCount,
          totalEvents: n,
        };
        setConf(result);
        setProgress({ done: total, total });
        onResults?.(result);
        loadedFor.current = runKey; // mark as done for this file+model
        computing.current = false;
        return;
      }
      const c = constraints[idx];
      const srcIndices = evts.reduce((acc, e, i) => { if (e.activity === c.source_activity) acc.push(i); return acc; }, []);
      let satisfied = 0;
      for (const i of srcIndices) {
        if (satisfies(i, c)) satisfied++;
        else globalSatisfied[i] = false;
      }
      const label = `${c.constraint_type}(${c.source_activity}→${c.target_activity})`;
      if (srcIndices.length > 0) {
        results.push({ label, confidence: satisfied / srcIndices.length, satisfied, total: srcIndices.length });
      }
      setProgress({ done: idx + 1, total });
      setTimeout(() => evalNext(idx + 1), 0);
    };

    evalNext(0);
  };

  React.useEffect(() => () => { computing.current = false; }, []);

  const pct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
  const cls = v => v == null ? '' : v >= 0.8 ? 'conf-good' : v >= 0.5 ? 'conf-mid' : 'conf-bad';
  const progressPct = progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0;
  const isComputing = progress.done < progress.total && progress.total > 0;

  // Render content directly (no Collapsible wrapper — parent tab handles visibility)
  return (
    <div className="log-model-conf-content">
      {!hasModel && (
        <p style={{fontSize:'0.78rem',color:'#b45309'}}>⚠ No OC-Declare model loaded or no constraints defined.</p>
      )}
      {loading && (
        <div style={{display:'flex',alignItems:'center',gap:'0.5rem',fontSize:'0.82rem',color:'#6366f1'}}>
          <div className="spinner spinner-sm"></div> Loading events…
        </div>
      )}
      {error && <p style={{color:'#b91c1c',fontSize:'0.8rem'}}>⚠ {error}</p>}

      {isComputing && (
        <div style={{marginBottom:'0.75rem'}}>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:'0.75rem',color:'#64748b',marginBottom:'0.25rem'}}>
            <span>Checking constraints…</span>
            <span>{progress.done} / {progress.total} ({progressPct}%)</span>
          </div>
          <div className="ocd-progress-bar">
            <div className="ocd-progress-fill" style={{width:`${progressPct}%`}} />
          </div>
        </div>
      )}

      {hasModel && !conf && !isComputing && !loading && !error && (
        <p style={{fontSize:'0.78rem',color:'#94a3b8',fontStyle:'italic'}}>
          Runs automatically with "Run Discoveries".
        </p>
      )}

      {conf && !isComputing && (
        <>
          <div style={{display:'flex',alignItems:'center',gap:'1rem',marginBottom:'0.75rem',flexWrap:'wrap'}}>
            <div>
              <span style={{fontSize:'0.72rem',color:'#94a3b8',fontWeight:600,textTransform:'uppercase'}}>Confidence</span>
              <div style={{fontSize:'1.4rem',fontWeight:700}} className={cls(conf.globalConformance)}>
                {pct(conf.globalConformance)}
              </div>
              <span style={{fontSize:'0.72rem',color:'#64748b'}}>
                {conf.globalSatisfied} of {conf.totalEvents} events satisfy all constraints
              </span>
            </div>
            <button className="discovery-button" style={{fontSize:'0.75rem',padding:'0.3rem 0.7rem',marginLeft:'auto'}}
              onClick={() => { loadedFor.current = null; setConf(null); setProgress({done:0,total:0}); setEvents(null); computing.current = false; onResults?.(null); run(); }}>
              ↺ Re-check
            </button>
          </div>
          {conf.constraintResults.length > 0 && (
            <table className="conf-detail-table">
              <thead>
                <tr>
                  <th>Constraint</th>
                  <th className="audit-num">Source events</th>
                  <th className="audit-num">Satisfied</th>
                  <th className="audit-num">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {conf.constraintResults.slice().sort((a, b) => a.confidence - b.confidence).map(r => (
                  <tr key={r.label} className={r.confidence < 0.5 ? 'audit-row-accumulating' : ''}>
                    <td style={{fontFamily:'monospace',fontSize:'0.75rem'}}>{r.label}</td>
                    <td className="audit-num">{r.total}</td>
                    <td className="audit-num">{r.satisfied}</td>
                    <td className="audit-num"><span className={cls(r.confidence)}>{pct(r.confidence)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {conf && events && (
            <PerObjectBoundsChecker
              events={events}
              typesMap={typesMap}
              constraints={constraints}
              onBoundsResults={onBoundsResults}
            />
          )}
        </>
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
    resourceThreshold: 2,
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
    maxSteps: '',
    limitBySteps: true,
    limitByTime: false,
    limitByTraces: false,
    maxSimTimeValue: '',
    maxSimTimeUnit: 'days',
    useTimeLimit: false,
    useTraceLimit: false,
    maxTraces: '',
    seed: 42,
    startActivities: [],
  });
  const [isSimulating, setIsSimulating] = useState(false);
  const [liveStepCount, setLiveStepCount] = useState(null);
  const [liveSimTime,   setLiveSimTime]   = useState(null); // simulated time in seconds
  const [liveTraces,    setLiveTraces]    = useState(null); // completed object traces
  const [liveActiveObjects,   setLiveActiveObjects]   = useState(null);
  const [liveObligations,     setLiveObligations]     = useState(null);
  const [liveDeactivPerStep,  setLiveDeactivPerStep]  = useState(null);
  const [liveObligFulfilledPerStep, setLiveObligFulfilledPerStep] = useState(null);
  const [activeRunId,   setActiveRunId]   = useState(null);
  const [simElapsed,    setSimElapsed]    = useState(null); // seconds elapsed during last run
  const [lastRunDuration, setLastRunDuration] = useState(null); // seconds for completed run
  const [lastCompletedMode, setLastCompletedMode] = useState(null); // 'asis' | 'tobe'
  const simStartRef = useRef(null);
  const simTimerRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const prevPollRef = useRef({ deactivations: 0, obligFulfilled: 0, step: 0 });
  const ocelFileRef    = useRef(null);
  const ocdeclFileRef  = useRef(null);
  const paramsFileRef  = useRef(null);
  const [results, setResults] = useState(null);
  const [healthResult, setHealthResult] = useState(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);
  const [blockingResult, setBlockingResult] = useState(null);
  const [isAnalyzingBlocking, setIsAnalyzingBlocking] = useState(false);
  const [pressureResult, setPressureResult] = useState(null);
  const [isRunningPressure, setIsRunningPressure] = useState(false);
  const [isLoadingFullIterationLog, setIsLoadingFullIterationLog] = useState(false);
  const [fullIterationLogLoaded, setFullIterationLogLoaded] = useState(false);
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
  // Keep refs in sync for use inside async callbacks where closure values are stale
  React.useEffect(() => { activeModelRef.current = activeModel; }, [activeModel]);
  React.useEffect(() => { activeProbMatrixRef.current = activeProbMatrix; }, [activeProbMatrix]);
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

  const loadFullIterationLog = useCallback(async () => {
    const runId = results?.output_file;
    if (!runId) return;
    setIsLoadingFullIterationLog(true);
    try {
      const r = await axios.get(`/api/run-history/${encodeURIComponent(runId)}/iteration-log`);
      setFullIterationLogLoaded(true);
    } catch {
      // keep existing capped logs on failure
    } finally {
      setIsLoadingFullIterationLog(false);
    }
  }, [results]);

  // ── Model warnings (activities with no bindings) ──────────────────────────
  const bindingWarnings = activeModel
    ? (activeModel.activities || []).filter(a => !(a.bindings?.length))
    : [];
  const hasModelWarnings = bindingWarnings.length > 0;

  // ── Step 2.5: Timing discovery state ─────────────────────────────────────
  const [timingAnchors,       setTimingAnchors]       = useState({});
  const [timingMode,          setTimingMode]          = useState('single');
  const [timingSingleAct,     setTimingSingleAct]     = useState('');
  const [serviceTimeMode,     setServiceTimeMode]     = useState('minimum'); // 'minimum' | 'p25' | 'p50'
  const [isDiscoveringTiming, setIsDiscoveringTiming] = useState(false);
  const [timingDiscoveryResult, setTimingDiscoveryResult] = useState(null);
  const [timingDiscoveryFile,   setTimingDiscoveryFile]   = useState(null);
  const [timingError,           setTimingError]           = useState(null);

  // ── Workflow mode ─────────────────────────────────────────────────────────
  const [workflowMode, setWorkflowMode] = useState(null);
  const [landingDragOver, setLandingDragOver] = useState(false);
  // null = not chosen yet | 'internal' | 'external-ocel' | 'external-empty'
  const [paramDiscoveryEnabled, setParamDiscoveryEnabled] = useState({
    probability: true, lifecycle: true, time: true,
  });

  // ── External OC-Declare + OCEL tab state ──────────────────────────────────
  const [externalTab, setExternalTab] = useState('parameter'); // 'parameter' | 'behavior' | 'scenario' | 'results' | 'evaluation'
  const [behaviorSection, setBehaviorSection] = useState('activities'); // left nav in Model Behavior
  const [modelBase, setModelBase] = useState(null);        // immutable discovered model snapshot
  const [modelToBe, setModelToBe] = useState(null);        // editable scenario model
  const [probMatrixBase, setProbMatrixBase] = useState(null);
  const [probMatrixToBe, setProbMatrixToBe] = useState(null);
  const [resultsAsIs, setResultsAsIs] = useState(null);    // Run As-Is results
  const [resultsToBe, setResultsToBe] = useState(null);    // Run To-Be results
  const [evaluationReady, setEvaluationReady] = useState(false); // true after Run Evaluation clicked
  const [evalRunCount, setEvalRunCount] = useState(0); // increments on each explicit Run Evaluation click
  const [objTabAsIs, setObjTabAsIs] = useState('concurrency');
  const [objTabToBe, setObjTabToBe] = useState('concurrency');
  const [discoveryChecks, setDiscoveryChecks] = useState({
    lifecycle: true, timing: true, resources: true, o2o: true, startProb: true,
  });
  const [activeDiscoveryTab, setActiveDiscoveryTab] = useState('lifecycle');
  const [isRunningDiscoveries, setIsRunningDiscoveries] = useState(false);
  const [discoveryElapsed, setDiscoveryElapsed] = useState(null);
  const discStartRef = useRef(null);
  const discTimerRef = useRef(null);
  const activeModelRef = useRef(null);      // always current activeModel, safe in callbacks
  const activeProbMatrixRef = useRef(null); // always current activeProbMatrix
  const [healthCheckSteps, setHealthCheckSteps] = useState(500);
  const [discoveryProgress, setDiscoveryProgress] = useState({ current: 0, total: 0, currentName: '' });
  const [startProbApplied, setStartProbApplied] = useState(false);
  // OC-Declare model check results (from First Log Insights panel)
  const [logConfResults, setLogConfResults] = useState(null); // null = not run yet
  const [logBoundsResults, setLogBoundsResults] = useState(null); // per-object bounds check results
  // Trigger for model check from runAllDiscoveries
  // Trigger for model check (reserved for future use)
  // Whether to drop 0%-confidence constraints before Run Discoveries
  const [dropZeroConfConstraints, setDropZeroConfConstraints] = useState(false);
  // Whether to set nmax to max observed for unbounded constraints
  const [setNmaxFromBounds, setSetNmaxFromBounds] = useState(false);
  // Whether to apply nmin/nmax discovered from model check to constraints
  const [applyNminNmaxFromModelCheck, setApplyNminNmaxFromModelCheck] = useState(false);
  const [lifecycleResult, setLifecycleResult] = useState(null);   // {summary, method} or {error}
  const [lifecycleError, setLifecycleError] = useState(null);
  const [resourceResult, setResourceResult] = useState(null);     // [{type, instance_count}]
  const [resourceError, setResourceError] = useState(null);
  const [o2oResult, setO2oResult] = useState(null);               // {count}
  const [o2oError, setO2oError] = useState(null);
  const [resourceThreshold, setResourceThreshold] = useState(50);

  // ── Automated post-processing state ───────────────────────────────────────
  const [autoConfig, setAutoConfig] = useState({
    cycleEnabled:            false,
    cycleNminThreshold:      1,
    weakEnabled:             false,
    weakThreshold:           25,
    chainEnabled:            false,
    chainBlockThreshold:     5,
    o2oEnabled:              false,
    nmaxEnabled:             false,
    createsMissingEnabled:   false,
    startRecEnabled:         false,
    redundantEnabled:        false,
    unconstrainedEnabled:    false,
    noInputBindingEnabled:   false,
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
        // Don't auto-select OC-Declare — user should pick it explicitly on the landing page
        // (previously auto-selected ocdeclareFiles[0] here)
      }
    } catch (err) {
      setDiscoveryError('Failed to load available files. Make sure the backend server is running.');
      console.error('Error loading files:', err);
    }
  };

  const runDiscovery = async (overrideEventLogFile) => {
    setIsDiscovering(true);
    setDiscoveryError(null);
    setDiscoveryResults(null);
    setDiscoveryLogs([]);
    setResults(null); // Clear previous simulation results
    setError(null);

    try {
      const payload = overrideEventLogFile
        ? { ...discoveryConfig, eventLogFile: overrideEventLogFile }
        : discoveryConfig;
      const response = await axios.post('/api/discover', payload);
      
      if (response.data.success) {
        setDiscoveryResults(response.data.results);
        setDiscoveryLogs(response.data.logs || []);
        setAvailableActivities(response.data.results.activities || []);

        // Auto-select start activities using strict criterion (≥95% of firings
        // have no preceding event on any object). Fall back to likely_start if none qualify.
        // Only applied if user hasn't already made a selection.
        const strictStarts = response.data.results.strict_start_activities || [];
        const likelyStarts = response.data.results.likely_start_activities || [];
        const autoStarts = strictStarts.length > 0 ? strictStarts : likelyStarts;
        if (autoStarts.length > 0) {
          setDiscoveryConfig(prev => {
            if (prev.startActivityProbSelected?.length > 0) return prev;
            return { ...prev, startActivityProbSelected: autoStarts };
          });
        }

        // Also keep config.startActivities in sync if empty
        const firstActivity = response.data.results.first_activity
          || autoStarts[0]
          || response.data.results.activities?.[0];
        if (firstActivity) {
          setConfig(prev => prev.startActivities.length > 0
            ? prev
            : { ...prev, startActivities: autoStarts.length > 0 ? autoStarts : [firstActivity] });
        }
        // Build unranked candidates from all activities
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
  // Skip reload if the user has already applied discoveries (modelEdited = true) —
  // we don't want to overwrite lifecycle/resources/o2o/timing results.
  useEffect(() => {
    if (config.ocdeclareFile && !modelEdited) {
      loadModelState(config.ocdeclareFile, discoveryConfig.eventLogFile);
    }
  }, [config.ocdeclareFile, discoveryConfig.eventLogFile, loadModelState, modelEdited]);

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
          setConfig(prev => prev.startActivities.length > 0
            ? prev
            : { ...prev, startActivities: topStart ? [topStart] : [] });
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
                setConfig(prev => prev.startActivities.length > 0
                  ? prev
                  : { ...prev, startActivities: [firstActivity] });
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
        serviceTimeMode,
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
      // Use functional updater so we always work on the latest state, not a stale closure.
      setActiveModel(prev => {
        if (!prev || Array.isArray(prev)) return prev;
        const existing = prev.activity_durations || {};
        const modelActs = (prev.activities || []).map(a => a.name);
        const lowerToModel = {};
        modelActs.forEach(n => { lowerToModel[n.toLowerCase()] = n; });
        const merged = { ...existing };
        Object.entries(metrics).forEach(([metricKey, val]) => {
          const targetName = modelActs.includes(metricKey)
            ? metricKey
            : (lowerToModel[metricKey.toLowerCase()] || metricKey);
          if (!(targetName in existing)) merged[targetName] = val;
        });
        return { ...prev, activity_durations: merged };
      });
      setModelEdited(true);
    } catch (e) {
      setTimingError(e.response?.data?.error || e.message);
    } finally {
      setIsDiscoveringTiming(false);
    }
  };

  // Wraps setActiveModel so any change made through the Model Editor flags the
  // model as user-edited (timing auto-discovery uses setActiveModel directly and
  // therefore does NOT mark the model as custom).
  const handleModelEdit = useCallback((updatedModel) => {
    setActiveModel(updatedModel);
    setModelEdited(true);
  }, []);

  // ── External OC-Declare + OCEL discovery handlers ────────────────────────

  const runLifecycleDerivation = useCallback(async () => {
    setLifecycleError(null);
    setLifecycleResult(null);
    try {
      const payload = { ocdeclareFile: config.ocdeclareFile };
      if (discoveryConfig.eventLogFile) payload.eventLogFile = discoveryConfig.eventLogFile;
      const res = await axios.post('/api/derive-lifecycle', payload);
      if (res.data.success) {
        setActiveModel(prev => ({
          ...(prev || {}),
          activities: res.data.model.activities,
          o2o_rules: res.data.model.o2o_rules?.length ? res.data.model.o2o_rules : ((prev || {}).o2o_rules || []),
        }));
        setModelEdited(true);
        setLifecycleResult({ summary: res.data.summary, method: res.data.method });
      } else {
        setLifecycleError(res.data.error);
      }
    } catch (e) {
      setLifecycleError(e.response?.data?.error || e.message);
    }
  }, [config.ocdeclareFile, discoveryConfig.eventLogFile]);

  const runResourceDiscovery = useCallback(async () => {
    setResourceError(null);
    setResourceResult(null);
    try {
      const res = await axios.post('/api/discover-resources', {
        eventLogFile: discoveryConfig.eventLogFile,
        resourceThreshold,
      });
      if (res.data.success) {
        const newTypes = res.data.resource_types;
        const instanceCounts = {};
        (res.data.resource_info || []).forEach(r => { instanceCounts[r.type] = r.instance_count; });
        setActiveModel(prev => {
          const existingPool = (prev || {}).resource_pool_sizes || {};
          const newPool = {};
          newTypes.forEach(t => { newPool[t] = existingPool[t] ?? (instanceCounts[t] || 1); });
          return { ...(prev || {}), resource_types: newTypes, resource_pool_sizes: newPool };
        });
        setModelEdited(true);
        setResourceResult(res.data.resource_info);
      } else {
        setResourceError(res.data.error || 'Discovery failed');
      }
    } catch (err) {
      setResourceError(err.response?.data?.error || err.message);
    }
  }, [discoveryConfig.eventLogFile, resourceThreshold]);

  const runO2ODiscovery = useCallback(async () => {
    setO2oError(null);
    setO2oResult(null);
    try {
      const res = await axios.post('/api/discover-o2o', { eventLogFile: discoveryConfig.eventLogFile });
      if (res.data.success) {
        setActiveModel(prev => ({ ...(prev || {}), o2o_rules: res.data.o2o_rules }));
        setModelEdited(true);
        setO2oResult({ count: res.data.count });
      } else {
        setO2oError(res.data.error || 'Discovery failed');
      }
    } catch (err) {
      setO2oError(err.response?.data?.error || err.message);
    }
  }, [discoveryConfig.eventLogFile]);

  const stopSimulation = useCallback(async () => {
    if (!activeRunId) return;
    try { await axios.post(`/api/simulate/stop/${activeRunId}`); } catch {}
  }, [activeRunId]);

  const runSimulation = async (mode = 'tobe') => {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Pick model/matrix based on mode
    const simModel  = mode === 'asis' ? modelBase  : (modelToBe  ?? activeModel);
    const simMatrix = mode === 'asis' ? probMatrixBase : (probMatrixToBe ?? activeProbMatrix);
    setIsSimulating(true);
    setLiveStepCount(0);
    setActiveRunId(runId);
    // Start elapsed timer
    simStartRef.current = Date.now();
    setSimElapsed(0);
    setLastRunDuration(null);
    setLastCompletedMode(null);
    if (simTimerRef.current) clearInterval(simTimerRef.current);
    simTimerRef.current = setInterval(() => {
      setSimElapsed(Math.floor((Date.now() - simStartRef.current) / 1000));
    }, 1000);
    setError(null);
    setResults(null);
    setLogs([]);
    setFullIterationLogLoaded(false);

    // Reset live counters
    setLiveSimTime(null);
    setLiveTraces(null);
    setLiveActiveObjects(null);
    setLiveObligations(null);
    setLiveDeactivPerStep(null);
    setLiveObligFulfilledPerStep(null);
    prevPollRef.current = { deactivations: 0, obligFulfilled: 0, step: 0 };

    // Start polling the live step counter every second
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(async () => {
      try {
        const r = await axios.get(`/api/simulate/status/${runId}`);
        setLiveStepCount(r.data.step_count ?? 0);
        setLiveTraces(r.data.completed_traces ?? 0);
        setLiveActiveObjects(r.data.active_objects ?? null);
        setLiveObligations(r.data.total_obligations ?? null);
        // Compute per-poll deltas (proxy for per-step rates)
        const curStep  = r.data.step_count ?? 0;
        const curDeact = r.data.total_deactivations ?? 0;
        const curOblig = r.data.total_oblig_fulfilled ?? 0;
        const prev = prevPollRef.current;
        const stepDelta = Math.max(1, curStep - prev.step);
        setLiveDeactivPerStep(prev.step > 0 ? ((curDeact - prev.deactivations) / stepDelta).toFixed(2) : null);
        const curObligCancelled = r.data.total_oblig_cancelled ?? 0;
        const curObligRemoved = curOblig + curObligCancelled;
        setLiveObligFulfilledPerStep(prev.step > 0 ? ((curObligRemoved - (prev.obligFulfilled)) / stepDelta).toFixed(2) : null);
        prevPollRef.current = { deactivations: curDeact, obligFulfilled: curObligRemoved, step: curStep };
        if (r.data.last_timestamp && r.data.start_timestamp) {
          const elapsed = (new Date(r.data.last_timestamp) - new Date(r.data.start_timestamp)) / 1000;
          setLiveSimTime(elapsed >= 0 ? elapsed : null);
        }
        if (r.data.done) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      } catch {}
    }, 1000);

    try {
      // Compute max_sim_time_s — active when value is filled in (no checkbox needed)
      const unitToS = { seconds: 1, minutes: 60, hours: 3600, days: 86400, weeks: 604800 };
      // Steps: active when maxSteps has a value, else safety cap
      const effectiveMaxEvents = config.maxSteps && parseInt(config.maxSteps) > 0
        ? parseInt(config.maxSteps)
        : 10_000_000;
      const maxSimTimeS = config.maxSimTimeValue !== '' && config.maxSimTimeValue != null && !isNaN(parseFloat(config.maxSimTimeValue))
        ? parseFloat(config.maxSimTimeValue) * (unitToS[config.maxSimTimeUnit ?? 'days'] ?? 86400)
        : null;
      const maxTraces = config.maxTraces !== '' && config.maxTraces != null && parseInt(config.maxTraces) > 0
        ? parseInt(config.maxTraces)
        : null;

      const simulationData = {
        ...config,
        maxEvents: effectiveMaxEvents,
        runId,
        eventLogFile: discoveryConfig.eventLogFile,
        maxSimTimeS,
        maxTraces,
        // Send model/probs for the chosen mode
        ...(simModel  ? { modelOverride:       simModel }  : {}),
        ...(simMatrix ? { probMatrixOverride: simMatrix } : {}),
      };

      const response = await axios.post('/api/simulate', simulationData);

      setResults(response.data.results);
      setLogs(response.data.logs || []);
      // Store in mode-specific state and navigate to results
      if (mode === 'asis') setResultsAsIs(response.data.results);
      else setResultsToBe(response.data.results);
      setLastCompletedMode(mode);
      setEvaluationReady(false); // reset — user must click Run Evaluation for new results
      // Do NOT auto-navigate — show completion banner with button instead

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
      // Stop elapsed timer and record final duration
      clearInterval(simTimerRef.current);
      simTimerRef.current = null;
      const duration = Math.floor((Date.now() - (simStartRef.current || Date.now())) / 1000);
      setLastRunDuration(duration);
      setSimElapsed(null);
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
        steps: healthCheckSteps,
      };
      const res = await axios.post('/api/constraint-health', payload);
      setHealthResult(res.data);
    } catch (err) {
      setHealthResult({ error: err.response?.data?.error || 'Health check failed.' });
    } finally {
      setIsCheckingHealth(false);
    }
  };

  const runBlockingAnalysis = React.useCallback(async (model, matrix, startActs) => {
    if (!model || !startActs?.length) return;
    setIsAnalyzingBlocking(true);
    try {
      const res = await axios.post('/api/analyze-blocking', {
        modelOverride:       model,
        probMatrixOverride:  matrix || {},
        startActivities:     startActs,
        steps:               300,
        seed:                42,
      });
      setBlockingResult(res.data);
    } catch (e) {
      setBlockingResult({ error: e.response?.data?.error || 'Analysis failed.' });
    } finally {
      setIsAnalyzingBlocking(false);
    }
  }, []);

  const runPressureAnalysis = React.useCallback(async () => {
    const model = modelToBe || activeModel;
    const startActs = config.startActivities;
    if (!model || !startActs?.length) return;
    setIsRunningPressure(true);
    setPressureResult(null);
    try {
      const res = await axios.post('/api/analyze-pressure', {
        modelOverride:      model,
        probMatrixOverride: probMatrixToBe || {},
        startActivities:    startActs,
        activityCounts:     discoveryResults?.activity_counts || {},
        ocelTimeSpanS:      discoveryResults?.ocel_time_span_s ?? null,
        steps:              5000,
        seed:               42,
      });
      setPressureResult(res.data);
    } catch (e) {
      setPressureResult({ error: e.response?.data?.error || e.message || 'Analysis failed.' });
    } finally {
      setIsRunningPressure(false);
    }
  }, [modelToBe, activeModel, config.startActivities, probMatrixToBe, discoveryResults]);


  // Auto-run blocking analysis whenever the To-Be model changes
  React.useEffect(() => {
    if (!modelToBe || !config.startActivities?.length) return;
    const t = setTimeout(() => {
      runBlockingAnalysis(modelToBe, probMatrixToBe, config.startActivities);
    }, 800); // debounce 800ms
    return () => clearTimeout(t);
  }, [modelToBe, probMatrixToBe, config.startActivities, runBlockingAnalysis]);
  // never reads a stale closure value.
  const startActivityProbSelectedRef = React.useRef(discoveryConfig.startActivityProbSelected);
  React.useEffect(() => {
    startActivityProbSelectedRef.current = discoveryConfig.startActivityProbSelected;
  }, [discoveryConfig.startActivityProbSelected]);

  // Keep config.startActivities in sync with the discovery tab selection at all times.
  // This ensures the simulation always uses whichever activities the user picked in
  // the "Start Activity + Probability" panel, regardless of whether Run Discoveries was clicked.
  React.useEffect(() => {
    const selected = discoveryConfig.startActivityProbSelected;
    if (!selected?.length) return;
    setConfig(prev => {
      const same = prev.startActivities.length === selected.length &&
        selected.every(a => prev.startActivities.includes(a));
      return same ? prev : { ...prev, startActivities: [...selected] };
    });
  }, [discoveryConfig.startActivityProbSelected, externalTab]); // also re-sync when switching to simulation tab

  // Standalone OC-Declare model check — runs the same logic as LogModelConformance
  // Returns { constraintResults, globalConformance, globalSatisfied, totalEvents }
  const runLogModelCheck = useCallback(async (model, eventLogFile) => {
    if (!model || Array.isArray(model) || !eventLogFile) return null;
    const constraints = model.constraints || [];
    if (!constraints.length) return null;
    try {
      const r = await axios.get(`/api/eventlog-events?file=${encodeURIComponent(eventLogFile)}`);
      const evts = r.data.events || [];
      const tmap = r.data.object_types_map || {};
      const n = evts.length;
      const eventObjs = evts.map(e => new Set(e.object_ids || []));
      const byActIdx = {};
      evts.forEach((e, i) => { (byActIdx[e.activity] = byActIdx[e.activity] || []).push(i); });
      const sortedEvtsTs = evts.map(e => e.timestamp);
      const firstGe = (ts) => { let lo=0,hi=n; while(lo<hi){const m=(lo+hi)>>1;sortedEvtsTs[m]<ts?lo=m+1:hi=m;}return lo; };
      const temporalFilter = (srcIdx, ctype, tgtAct) => {
        const srcTs = evts[srcIdx].timestamp;
        if (ctype === 'chain_response') return srcIdx + 1 < n ? [srcIdx + 1] : [];
        if (ctype === 'chain_precedence') return srcIdx - 1 >= 0 ? [srcIdx - 1] : [];
        const tgtIs = byActIdx[tgtAct] || [];
        if (['response','chain_response','succession','alternate_response',
             'precedence','alternate_precedence'].includes(ctype)) {
          const start = firstGe(srcTs);
          return tgtIs.filter(j => j >= start && j !== srcIdx);
        }
        return tgtIs.filter(j => j !== srcIdx);
      };
      const satisfies = (i, c) => {
        if (evts[i].activity !== c.source_activity) return true;
        const nmin = c.nmin ?? 1, nmax = c.nmax ?? null;
        const tgt = c.target_activity;
        const scope = c.scope || { kind: 'global' };
        const tgtCandidates = temporalFilter(i, c.constraint_type, tgt);
        if (scope.kind === 'global') {
          const cnt = tgtCandidates.length;
          if (['not_coexistence','not_succession'].includes(c.constraint_type)) return cnt === 0;
          return cnt >= nmin && (nmax == null || cnt <= nmax);
        }
        const scopeObjs = [...eventObjs[i]].filter(oid => tmap[oid] === scope.object_type);
        if (scopeObjs.length === 0) return true;
        for (const oid of scopeObjs) {
          const matching = tgtCandidates.filter(j => eventObjs[j].has(oid));
          const cnt = matching.length;
          if (['not_coexistence','not_succession'].includes(c.constraint_type)) {
            if (cnt > 0) return false;
          } else {
            if (cnt < nmin) return false;
            if (nmax != null && cnt > nmax) return false;
          }
        }
        return true;
      };
      const results = [];
      let globalSatisfied = new Array(n).fill(true);
      for (let idx = 0; idx < constraints.length; idx++) {
        const c = constraints[idx];
        const sourceEvents = evts.map((e,i) => e.activity === c.source_activity ? i : -1).filter(i => i >= 0);
        const label = `${c.constraint_type}(${c.source_activity}→${c.target_activity})`;
        if (sourceEvents.length === 0) {
          results.push({ label, confidence: 1, satisfied: 0, total: 0, constraint: c,
                         observedNmin: null, observedNmax: null });
          continue;
        }
        const scope = c.scope || { kind: 'global' };
        let satisfied = 0;
        // Track target repetitions per (source event, scope object) to derive observed nmin/nmax
        const repCounts = []; // all observed repetition counts across source events × scope objects
        for (const i of sourceEvents) {
          const temporal = temporalFilter(i, c.constraint_type, c.target_activity);
          const tgtCandidates = temporal; // already filtered to target activity
          if (scope.kind === 'each' && scope.object_type) {
            const scopeObjs = [...eventObjs[i]].filter(oid => tmap[oid] === scope.object_type);
            if (scopeObjs.length > 0) {
              for (const oid of scopeObjs) {
                repCounts.push(tgtCandidates.filter(j => eventObjs[j].has(oid)).length);
              }
            }
          } else {
            repCounts.push(tgtCandidates.length);
          }
          if (satisfies(i, c)) { satisfied++; } else { globalSatisfied[i] = false; }
        }
        const observedNmin = repCounts.length > 0 ? Math.min(...repCounts) : null;
        const observedNmax = repCounts.length > 0 ? Math.max(...repCounts) : null;
        const confidence = sourceEvents.length > 0 ? satisfied / sourceEvents.length : 1;
        results.push({ label, confidence, satisfied, total: sourceEvents.length, constraint: c,
                       observedNmin, observedNmax });
      }
      const globalCount = globalSatisfied.filter(Boolean).length;
      return { constraintResults: results, globalConformance: n > 0 ? globalCount / n : null, globalSatisfied: globalCount, totalEvents: n };
    } catch(e) {
      console.error('Model check failed:', e);
      return null;
    }
  }, []);

  // Separated from runAllDiscoveries so discoveryConfig is always fresh (avoids stale closure)
  const applyStartProbability = useCallback(async () => {
    if (!activeProbMatrix || !discoveryResults?.likely_start_activities?.length) return;
    const counts = discoveryResults.activity_counts;
    const total = Object.values(counts).reduce((s, v) => s + v, 0);
    if (!total) return;
    const latestSelected = startActivityProbSelectedRef.current;
    // Nothing selected → skip (user must explicitly choose start activities)
    if (!latestSelected?.length) return;
    const selected = new Set(latestSelected);
    const combinedProb = [...selected].reduce((s, a) => s + (counts[a] || 0), 0) / total;
    const selectedCountSum = [...selected].reduce((s, a) => s + (counts[a] || 0), 0);
    const newMatrix = {};
    Object.entries(activeProbMatrix).forEach(([src, targets]) => {
      const tgts = { ...targets };
      selected.forEach(a => delete tgts[a]);
      const existingSum = Object.values(tgts).reduce((s, v) => s + v, 0);
      const scale = existingSum > 0 ? (1 - combinedProb) / existingSum : 0;
      const scaled = {};
      Object.entries(tgts).forEach(([t, v]) => { scaled[t] = Math.round(v * scale * 10000) / 10000; });
      selected.forEach(a => {
        const share = selectedCountSum > 0 ? combinedProb * (counts[a] || 0) / selectedCountSum : combinedProb / selected.size;
        scaled[a] = Math.round(share * 10000) / 10000;
      });
      newMatrix[src] = scaled;
    });
    setActiveProbMatrix(newMatrix);
    setStartProbApplied(true);
    setConfig(p => ({ ...p, startActivities: [...selected] }));
  }, [discoveryResults, activeProbMatrix]);

  const runAllDiscoveries = useCallback(async () => {
    if (!discoveryConfig.eventLogFile) return;
    setIsRunningDiscoveries(true);
    // Start discovery elapsed timer
    discStartRef.current = Date.now();
    setDiscoveryElapsed(0);
    if (discTimerRef.current) clearInterval(discTimerRef.current);
    discTimerRef.current = setInterval(() => {
      setDiscoveryElapsed(Math.floor((Date.now() - discStartRef.current) / 1000));
    }, 1000);

    // If checkbox is on and model check was run, drop 0%-confidence constraints first
    if (dropZeroConfConstraints && logConfResults?.constraintResults) {
      const zeroLabels = new Set(
        logConfResults.constraintResults
          .filter(r => r.confidence === 0)
          .map(r => r.label)
      );
      if (zeroLabels.size > 0) {
        setActiveModel(prev => {
          if (!prev || Array.isArray(prev)) return prev;
          const filtered = (prev.constraints || []).filter(c => {
            const label = `${c.constraint_type}(${c.source_activity}→${c.target_activity})`;
            return !zeroLabels.has(label);
          });
          return { ...prev, constraints: filtered };
        });
      }
    }

    const allSteps = [
      { key: 'lifecycle', label: 'Object Constraints',           fn: runLifecycleDerivation },
      { key: 'resources', label: 'Resource Objects',             fn: runResourceDiscovery },
      { key: 'timing',    label: 'Timing',                       fn: runTimingDiscovery },
      { key: 'o2o',       label: 'O2O Relationships',            fn: runO2ODiscovery },
      { key: 'startProb', label: 'Start Activity + Probability', fn: applyStartProbability },
    ];
    const steps = allSteps.filter(s => discoveryChecks[s.key]);
    const total = steps.length + 2; // +1 health check, +1 model check

    try {
      for (let i = 0; i < steps.length; i++) {
        setDiscoveryProgress({ current: i + 1, total, currentName: steps[i].label });
        await steps[i].fn();
      }

      // Auto-assign no_parallel_activities for activities that involve resource objects
      setActiveModel(prev => {
        if (!prev || Array.isArray(prev)) return prev;
        const resourceTypes = new Set(prev.resource_types || []);
        if (resourceTypes.size === 0) return prev;
        const noParallel = new Set(prev.no_parallel_activities || []);
        (prev.activities || []).forEach(a => {
          const hasResource = (a.bindings || []).some(b => resourceTypes.has(b.object_type));
          if (hasResource) noParallel.add(a.name);
        });
        return { ...prev, no_parallel_activities: [...noParallel] };
      });

      // OC-Declare Model Check
      setDiscoveryProgress({ current: steps.length + 1, total, currentName: 'OC-Declare Model Check' });
      const modelForCheck = activeModelRef.current;
      const modelCheckResult = await runLogModelCheck(modelForCheck, discoveryConfig.eventLogFile);
      if (modelCheckResult) {
        setLogConfResults(modelCheckResult);
        // Apply nmin/nmax from model check if checkbox is on
        if (applyNminNmaxFromModelCheck) {
          setActiveModel(prev => {
            if (!prev || Array.isArray(prev)) return prev;
            const updated = (prev.constraints || []).map(c => {
              const label = `${c.constraint_type}(${c.source_activity}→${c.target_activity})`;
              const result = modelCheckResult.constraintResults.find(r => r.label === label);
              if (!result || result.total === 0) return c;
              // Only fill in the missing value — never overwrite an already-set value
              const newNmin = (c.nmin == null && result.observedNmin != null) ? result.observedNmin : c.nmin;
              const newNmax = (c.nmax == null && result.observedNmax != null) ? result.observedNmax : c.nmax;
              if (newNmin === c.nmin && newNmax === c.nmax) return c;
              return { ...c, nmin: newNmin, nmax: newNmax };
            });
            return { ...prev, constraints: updated };
          });
        }
      }

      setDiscoveryProgress({ current: steps.length + 2, total, currentName: 'Constraint Health Check' });
      await runHealthCheck();
      // Snapshot discovered model as immutable base using refs (not stale closure values)
      const snapModel  = activeModelRef.current  ? JSON.parse(JSON.stringify(activeModelRef.current))  : null;
      const snapMatrix = activeProbMatrixRef.current ? JSON.parse(JSON.stringify(activeProbMatrixRef.current)) : null;
      setModelBase(snapModel);
      setModelToBe(snapModel  ? JSON.parse(JSON.stringify(snapModel))  : null);
      setProbMatrixBase(snapMatrix);
      setProbMatrixToBe(snapMatrix ? JSON.parse(JSON.stringify(snapMatrix)) : null);
      setExternalTab('behavior');
    } finally {
      clearInterval(discTimerRef.current);
      discTimerRef.current = null;
      setDiscoveryElapsed(Math.floor((Date.now() - (discStartRef.current || Date.now())) / 1000));
      setIsRunningDiscoveries(false);
      setDiscoveryProgress({ current: 0, total: 0, currentName: '' });
    }
  }, [discoveryChecks, discoveryConfig.eventLogFile, dropZeroConfConstraints, logConfResults,
      applyNminNmaxFromModelCheck, runLogModelCheck,
      runLifecycleDerivation, runResourceDiscovery, runTimingDiscovery, runO2ODiscovery,
      applyStartProbability, runHealthCheck]);

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

  // Load a saved parameter file (from IO/input/parameters) into the editor.
  const handleLoadParameters = useCallback(async (filename) => {
    if (!filename) return;
    try {
      const res = await axios.get(`/api/parameters/${encodeURIComponent(filename)}`);
      if (res.data.success && res.data.model && !Array.isArray(res.data.model)) {
        const m = res.data.model;
        setActiveModel(m);
        if (res.data.probMatrix && Object.keys(res.data.probMatrix).length > 0) {
          setActiveProbMatrix(res.data.probMatrix);
        }
        // Restore simulation config fields saved in the parameter file
        if (m.start_activities?.length) {
          setConfig(prev => ({ ...prev, startActivities: m.start_activities }));
        }
        if (m.seed != null) {
          setConfig(prev => ({ ...prev, seed: m.seed }));
        }
        if (m.max_steps != null) {
          setConfig(prev => ({ ...prev, maxSteps: m.max_steps }));
        }
        if (m.start_activity_prob_selected?.length) {
          setDiscoveryConfig(prev => ({ ...prev, startActivityProbSelected: m.start_activity_prob_selected }));
        }
        setModelEdited(true);
        setExternalTab('simulation');
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

  const handleFileUpload = useCallback(async (file, type) => {
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', type);
    try {
      const res = await axios.post('/api/upload-file', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (res.data.success) {
        await loadAvailableFiles({ preserveSelections: true });
        const filename = res.data.filename;
        if (type === 'eventlog') {
          handleDiscoveryConfigChange('eventLogFile', filename);
          if (workflowMode === 'external-ocel') setTimeout(() => runDiscovery(filename), 0);
        } else if (type === 'ocdeclare') {
          handleConfigChange('ocdeclareFile', filename);
        } else if (type === 'parameters') {
          handleLoadParameters(filename);
        }
      } else {
        alert(`Upload failed: ${res.data.error || 'Unknown error'}`);
      }
    } catch (err) {
      alert(`Upload failed: ${err.response?.data?.error || err.message}`);
    }
  }, [loadAvailableFiles, handleDiscoveryConfigChange, handleConfigChange, handleLoadParameters, workflowMode, runDiscovery]);

  const handleDownloadParameters = useCallback(() => {
    if (!activeModel || Array.isArray(activeModel)) return;
    const m = activeModel;
    const resourceTypes = m.resource_types || [];
    const exportObj = {
      object_types: m.object_types || [],
      activities:   m.activities   || [],
      constraints:  m.constraints  || [],
      o2o_rules:    m.o2o_rules    || [],
      ...(m.attribute_schema && Object.keys(m.attribute_schema).length ? { attribute_schema: m.attribute_schema } : {}),
      ...(m.activity_durations && Object.keys(m.activity_durations).length ? { activity_durations: m.activity_durations } : {}),
      ...(m.max_consecutive && Object.keys(m.max_consecutive).length ? { max_consecutive: m.max_consecutive } : {}),
      ...(m.max_consecutive_per_object && Object.keys(m.max_consecutive_per_object).length ? { max_consecutive_per_object: m.max_consecutive_per_object } : {}),
      ...(resourceTypes.length ? { resource_types: resourceTypes } : {}),
      ...(m.resource_pool_sizes && Object.keys(m.resource_pool_sizes).length ? { resource_pool_sizes: m.resource_pool_sizes } : {}),
      ...(activeProbMatrix && Object.keys(activeProbMatrix).length ? { transition_matrix: activeProbMatrix } : {}),
      // Simulation config
      ...(config.startActivities?.length ? { start_activities: config.startActivities } : {}),
      ...(config.seed != null ? { seed: config.seed } : {}),
      ...(config.maxSteps != null ? { max_steps: config.maxSteps } : {}),
      // Start activity probability selection
      ...(discoveryConfig.startActivityProbSelected?.length ? { start_activity_prob_selected: discoveryConfig.startActivityProbSelected } : {}),
    };
    const base = (config.ocdeclareFile || 'parameters').replace(/\.json$/i, '').replace(/^discovered_/, '');
    const ts = new Date().toISOString().slice(0,19).replace('T','_').replace(/-/g,'').replace(/:/g,'');
    const filename = `parameters_${base}_${ts}.json`;
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    handleSaveParameters(filename, exportObj);
  }, [activeModel, activeProbMatrix, config, discoveryConfig.startActivityProbSelected, handleSaveParameters]);

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
  const generateSuggestions = (hr, model, cfg, startActivities = [], confResults = null, dropZeroConf = false, boundsResults = null, setNmaxFromLog = false) => {
    if (!hr || !model) return [];
    const suggestions = [];
    let id = 0;
    const startActSet = new Set(startActivities);

    // ── Rule 0: Remove 0%-confidence constraints from model check ─────────
    if (dropZeroConf && confResults?.constraintResults) {
      const zeroConf = confResults.constraintResults.filter(r => r.confidence === 0);
      zeroConf.forEach(r => {
        const c = (model.constraints || []).find(con =>
          `${con.constraint_type}(${con.source_activity}→${con.target_activity})` === r.label
        );
        if (!c) return;
        suggestions.push({
          id: id++, type: 'ZERO_CONF',
          badgeLabel: '0% conf',
          label: `Remove ${r.label}`,
          desc: `0% confidence in OC-Declare model check — this constraint was never satisfied by any source event in the input log.`,
          action: m => ({ ...m, constraints: (m.constraints || []).filter(x => x !== c) }),
        });
      });
    }

    // ── Rule 0b: Set nmax to max observed for unbounded constraints ───────────
    if (setNmaxFromLog && boundsResults?.length) {
      boundsResults
        .filter(r => !r.hasNmax && r.maxObserved > 0)
        .forEach(r => {
          const c = (model.constraints || []).find(con =>
            `${con.constraint_type}(${con.source_activity}→${con.target_activity})` === r.label
          );
          if (!c) return;
          suggestions.push({
            id: id++, type: 'SET_NMAX',
            badgeLabel: `nmax=${r.maxObserved}`,
            label: `Set nmax=${r.maxObserved} on ${r.label}`,
            desc: `No upper bound currently set. Max observed in input log: ${r.maxObserved} firings per scope object. Setting nmax to this value caps the constraint at what was actually seen.`,
            action: m => ({
              ...m,
              constraints: (m.constraints || []).map(con =>
                con === c ? { ...con, nmax: r.maxObserved } : con
              ),
            }),
          });
        });
    }

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
        if (startActSet.has(a.name)) return; // start activities don't need input bindings
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
        onChangeMode={workflowMode ? () => setWorkflowMode(null) : null}
      />

      <header className="header">
        <h1>Declarative OC Simulator</h1>
        <p>Object-centric declarative process simulation</p>
      </header>

      {/* ── Main tab bar — only shown after landing page is complete ── */}
      {workflowMode === 'external-ocel' && externalTab !== 'parameter' && (
        <div className="main-tab-bar">
          {[
            { key: 'behavior',   label: 'Model Behavior' },
            { key: 'scenario',   label: 'Scenario Builder' },
            { key: 'results',    label: 'Results' },
            { key: 'evaluation', label: 'Evaluation', disabled: !evaluationReady },
          ].map(t => (
            <button key={t.key}
              className={`main-tab-btn${externalTab === t.key ? ' active' : ''}`}
              disabled={t.disabled}
              title={t.disabled ? 'Click Run Evaluation in the Results tab first' : undefined}
              onClick={() => !t.disabled && setExternalTab(t.key)}
              style={t.disabled ? {opacity:0.4, cursor:'not-allowed'} : {}}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Mode selector ── */}
      {!workflowMode && (
        <div className="mode-selector">
          <h2 className="mode-selector-title">Choose your workflow</h2>
          <div className="mode-cards">
            <div className="mode-card" onClick={() => setWorkflowMode('internal')}>
              <div className="mode-card-icon">◈</div>
              <div className="mode-card-label">Internal Discovery</div>
              <div className="mode-card-desc">Load an OCEL log and discover everything — constraints, probabilities, and timing — from scratch.</div>
            </div>
            <div className="mode-card" onClick={() => setWorkflowMode('external-ocel')}>
              <div className="mode-card-icon">◉</div>
              <div className="mode-card-label">External OC-Declare + OCEL</div>
              <div className="mode-card-desc">Bring your own OC-Declare constraint file and an OCEL log for parameter discovery.</div>
            </div>
            <div className="mode-card" onClick={() => setWorkflowMode('external-empty')}>
              <div className="mode-card-icon">◎</div>
              <div className="mode-card-label">Manual / No Files</div>
              <div className="mode-card-desc">Build the model entirely in the editor. Discovery features unavailable without an OCEL log.</div>
            </div>
          </div>
          {/* Small link to switch later */}
          <p className="mode-selector-hint">You can change mode at any time using the button below.</p>
        </div>
      )}

      <div className="workflow-container" style={!workflowMode ? {display:'none'} : {}}>
        {/* ── STEP 1: Parameter Discovery (internal mode only) ── */}
        {workflowMode === 'internal' && (
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
                onChange={(e) => {
                  handleDiscoveryConfigChange('eventLogFile', e.target.value);
                  if (e.target.value && workflowMode === 'external-ocel') {
                    // auto-trigger base discovery immediately for external-ocel
                    setTimeout(() => runDiscovery(e.target.value), 0);
                  }
                }}
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

              {/* Log Insights */}
              <div style={{background:'#f0f9ff',border:'1px solid #bae6fd',borderRadius:'8px',padding:'0.65rem 0.9rem',marginBottom:'0.75rem',marginTop:'0.25rem'}}>
                <div style={{fontSize:'0.7rem',fontWeight:700,color:'#0369a1',textTransform:'uppercase',letterSpacing:'0.05em',marginBottom:'0.45rem'}}>
                  Log Insights
                </div>
                <div style={{display:'flex',gap:'1.5rem',flexWrap:'wrap'}}>
                  {discoveryResults.log_object_trace_count != null && (
                    <div style={{display:'flex',flexDirection:'column',gap:'0.1rem'}}>
                      <span style={{fontSize:'1rem',fontWeight:700,color:'#0c4a6e'}}>{discoveryResults.log_object_trace_count}</span>
                      <span style={{fontSize:'0.7rem',color:'#0369a1'}}>Object traces</span>
                    </div>
                  )}
                  {discoveryResults.ocel_first_timestamp && discoveryResults.ocel_last_timestamp && (
                    <div style={{display:'flex',flexDirection:'column',gap:'0.1rem'}}>
                      <span style={{fontSize:'0.82rem',fontWeight:600,color:'#0c4a6e'}}>
                        {discoveryResults.ocel_first_timestamp.replace('T',' ')} → {discoveryResults.ocel_last_timestamp.replace('T',' ')}
                      </span>
                      <span style={{fontSize:'0.7rem',color:'#0369a1'}}>First to last timestamp</span>
                    </div>
                  )}
                  {!discoveryResults.ocel_first_timestamp && discoveryResults.ocel_time_span_s != null && (
                    <div style={{display:'flex',flexDirection:'column',gap:'0.1rem'}}>
                      <span style={{fontSize:'0.82rem',fontWeight:600,color:'#0c4a6e'}}>
                        {(() => {
                          const s = discoveryResults.ocel_time_span_s;
                          if (s < 60) return `${Math.round(s)}s`;
                          if (s < 3600) return `${Math.floor(s/60)}m`;
                          if (s < 86400) return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
                          const d = Math.floor(s/86400); const h = Math.floor((s%86400)/3600);
                          return h > 0 ? `${d}d ${h}h` : `${d}d`;
                        })()}
                      </span>
                      <span style={{fontSize:'0.7rem',color:'#0369a1'}}>First to last timestamp</span>
                    </div>
                  )}
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
                    constraints={activeModel?.constraints || []}
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

        )}

      {workflowMode === 'external-ocel' && (
          <div className="ext-ocel-tabs">

            {/* ── LANDING PAGE (replaces Parameters tab) ── */}
            {externalTab === 'parameter' && (
              <div className="landing-page">
                <h1>Declarative OC Simulator</h1>

                {/* OCEL Drop Zone */}
                <div
                  className={`ocel-drop-zone${landingDragOver ? ' drag-over' : ''}${discoveryConfig.eventLogFile ? ' loaded' : ''}`}
                  onClick={e => { if (!e.target.closest('.landing-discovery-options')) ocelFileRef.current?.click(); }}
                  onDragOver={e => { e.preventDefault(); setLandingDragOver(true); }}
                  onDragLeave={() => setLandingDragOver(false)}
                  onDrop={e => {
                    e.preventDefault(); setLandingDragOver(false);
                    const f = e.dataTransfer.files[0];
                    if (f) handleFileUpload(f, 'eventlog');
                  }}
                >
                  {/* File info top-left */}
                  {discoveryConfig.eventLogFile && (
                    <div className="ocel-drop-zone-info">
                      <div className="file-name">{discoveryConfig.eventLogFile}</div>
                      {(isDiscovering) && <div className="file-meta">Loading…</div>}
                      {discoveryResults && !isDiscovering && (
                        <div className="file-meta">
                          {discoveryResults.total_events != null && `${discoveryResults.total_events.toLocaleString()} events`}
                          {discoveryResults.log_object_trace_count != null && ` · ${discoveryResults.log_object_trace_count.toLocaleString()} objects`}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Drop prompt */}
                  {!discoveryConfig.eventLogFile && (
                    <div className="ocel-drop-prompt">
                      
                      <div className="ocel-drop-label">Drop event log here</div>
                      <div className="ocel-drop-sub">or click to browse (.json, .xml)</div>
                    </div>
                  )}
                  {discoveryConfig.eventLogFile && isDiscovering && (
                    <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:'0.75rem',padding:'1rem 0'}}>
                      <div className="spinner"></div>
                      <span style={{fontSize:'0.85rem',color:'#64748b'}}>Analysing log…</span>
                    </div>
                  )}

                  {/* Discovery options — shown after log is loaded */}
                  {discoveryConfig.eventLogFile && discoveryResults && !isDiscovering && (
                    <div className="landing-discovery-options" onClick={e => e.stopPropagation()}>

                      {/* Start Activity toggle pills */}
                      <div className="landing-option-group">
                        <label className="landing-option-label">Start Activity</label>
                        <div style={{display:'flex',flexDirection:'column',gap:'0.25rem',marginTop:'0.25rem',maxHeight:'160px',overflowY:'auto',border:'1px solid #e2e8f0',borderRadius:'6px',padding:'0.3rem'}}>
                          {(() => {
                            const likely = discoveryResults.likely_start_activities || [];
                            const others = Object.keys(discoveryResults.activity_counts || {})
                              .filter(a => !likely.includes(a))
                              .sort((a,b) => (discoveryResults.activity_counts[b]||0)-(discoveryResults.activity_counts[a]||0));
                            const candidates = [...likely, ...others];
                            const selected = new Set(discoveryConfig.startActivityProbSelected ?? []);
                            return candidates.map((a, i) => {
                              const isSelected = selected.has(a);
                              return (
                                <button key={a}
                                  onClick={() => {
                                    const next = new Set(selected);
                                    isSelected ? next.delete(a) : next.add(a);
                                    setDiscoveryConfig(p => ({ ...p, startActivityProbSelected: [...next] }));
                                  }}
                                  style={{
                                    textAlign:'left',
                                    padding:'0.3rem 0.6rem',
                                    fontSize:'0.82rem',
                                    borderRadius:'4px',
                                    border:'none',
                                    background: isSelected ? '#1e293b' : 'transparent',
                                    color: isSelected ? 'white' : '#475569',
                                    cursor:'pointer',
                                    fontWeight: isSelected ? 600 : 400,
                                    transition:'background 0.1s, color 0.1s',
                                  }}>
                                  {a}
                                </button>
                              );
                            });
                          })()}
                        </div>
                        {!(discoveryConfig.startActivityProbSelected?.length > 0) && (
                          <div style={{fontSize:'0.7rem',color:'#b91c1c',marginTop:'0.25rem'}}>Select at least one</div>
                        )}
                      </div>

                      {/* Right column: Timing + Resource threshold */}
                      <div style={{display:'flex',flexDirection:'column',gap:'1rem',flex:1}}>
                        {/* Timing mode */}
                        <div className="landing-option-group">
                          <label className="landing-option-label">Timing Discovery</label>
                          <div style={{display:'flex',flexDirection:'column',gap:'0.3rem'}}>
                            {[
                              { value: 'minimum', label: 'Minimum' },
                              { value: 'p25',     label: 'P25 (25th percentile)' },
                              { value: 'p50',     label: 'P50 (median)' },
                            ].map(opt => (
                              <label key={opt.value} style={{display:'flex',alignItems:'center',gap:'0.4rem',fontSize:'0.82rem',cursor:'pointer'}}>
                                <input type="radio" name="landingTimingMode" value={opt.value}
                                  checked={serviceTimeMode === opt.value}
                                  onChange={() => setServiceTimeMode(opt.value)} />
                                {opt.label}
                              </label>
                            ))}
                          </div>
                        </div>

                        {/* Resource threshold */}
                        <div className="landing-option-group">
                          <label className="landing-option-label">Resource Threshold</label>
                          <input type="number" min={1} value={resourceThreshold}
                            onChange={e => setResourceThreshold(Math.max(1, parseInt(e.target.value)||1))}
                            style={{width:'80px',padding:'0.25rem 0.4rem',border:'1px solid #cbd5e1',borderRadius:'5px',fontSize:'0.82rem'}} />
                          <div style={{fontSize:'0.7rem',color:'#94a3b8',marginTop:'0.2rem'}}>max same-activity repetitions/instance</div>
                        </div>

                        {/* Model check options */}
                        {config.ocdeclareFile && (
                          <div className="landing-option-group" style={{borderTop:'1px solid #e2e8f0',paddingTop:'0.75rem',marginTop:'0.25rem'}}>
                            <label className="landing-option-label">OC-Declare Model Check</label>
                            <label style={{display:'flex',alignItems:'center',gap:'0.4rem',fontSize:'0.78rem',cursor:'pointer',marginTop:'0.25rem'}}>
                              <input type="checkbox" checked={applyNminNmaxFromModelCheck}
                                onChange={e => setApplyNminNmaxFromModelCheck(e.target.checked)} />
                              Apply nmin/nmax from log to constraints
                            </label>
                            <div style={{fontSize:'0.7rem',color:'#94a3b8',marginTop:'0.2rem'}}>Sets bounds per constraint based on how often they fire in the log</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Hidden file input */}
                  <input ref={ocelFileRef} type="file" accept=".json,.xml" style={{display:'none'}}
                    onChange={e => { if (e.target.files[0]) handleFileUpload(e.target.files[0], 'eventlog'); e.target.value=''; }} />
                </div>

                {/* OC-Declare section — shown after OCEL loaded */}
                {discoveryConfig.eventLogFile && (
                  <div className="landing-ocdecl-section">
                    <div
                      className={`ocel-drop-zone${config.ocdeclareFile ? ' loaded' : ''}`}
                      style={{minHeight:'70px',padding:'1rem 1.25rem'}}
                      onClick={e => { if (!e.target.closest('select')) ocdeclFileRef.current?.click(); }}
                      onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }}
                      onDragLeave={e => e.currentTarget.classList.remove('drag-over')}
                      onDrop={e => {
                        e.preventDefault(); e.currentTarget.classList.remove('drag-over');
                        const f = e.dataTransfer.files[0];
                        if (f) handleFileUpload(f, 'ocdeclare');
                      }}
                    >
                      {/* File info top-left */}
                      {config.ocdeclareFile && (
                        <div className="ocel-drop-zone-info">
                          <div className="file-name">{config.ocdeclareFile}</div>
                          {activeModel && !Array.isArray(activeModel) && discoveryResults?.activities && (() => {
                            const logActs = new Set(discoveryResults.activities);
                            const modelActs = (activeModel.activities || []).map(a => typeof a === 'string' ? a : a.name);
                            const missing = modelActs.filter(a => !logActs.has(a));
                            return (
                              <div className="file-meta">
                                {missing.length === 0
                                  ? <span style={{color:'#15803d'}}>✓ All activities match</span>
                                  : <span style={{color:'#b45309'}}>⚠ {missing.length} not in log</span>}
                              </div>
                            );
                          })()}
                        </div>
                      )}

                      {/* Drop prompt or loaded state */}
                      <div style={{display:'flex',alignItems:'center',justifyContent:'center',paddingTop: config.ocdeclareFile ? '1.5rem' : '0'}}>
                        {!config.ocdeclareFile && (
                          <div className="ocel-drop-prompt" style={{gap:'0.2rem'}}>
                            
                            <div className="ocel-drop-label" style={{fontSize:'0.9rem'}}>Drop OC-Declare file here</div>
                            <div className="ocel-drop-sub">or click to browse (.json)</div>
                          </div>
                        )}
                      </div>

                      <input ref={ocdeclFileRef} type="file" accept=".json" style={{display:'none'}}
                        onChange={e => { if (e.target.files[0]) handleFileUpload(e.target.files[0], 'ocdeclare'); e.target.value=''; }} />
                    </div>
                  </div>
                )}

                {/* Progress display while running discoveries */}
                {isRunningDiscoveries && (
                  <div style={{marginTop:'1rem',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'8px',padding:'0.75rem 1rem'}}>
                    <div className="disc-progress">
                      <div className="spinner spinner-sm"></div>
                      <span className="disc-progress-label">
                        {discoveryProgress.currentName}… ({discoveryProgress.current}/{discoveryProgress.total + 1})
                      </span>
                      <div className="disc-progress-bar" style={{flex:1}}>
                        <div className="disc-progress-fill"
                          style={{width:`${((discoveryProgress.current)/(discoveryProgress.total+1))*100}%`}} />
                      </div>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="landing-actions">
                  <button className="start-over-link" onClick={() => {
                    setWorkflowMode(null);
                    handleConfigChange('ocdeclareFile', '');
                    handleDiscoveryConfigChange('eventLogFile', '');
                    setDiscoveryResults(null);
                    setExternalTab('parameter');
                  }}>
                    ← Start Over
                  </button>
                  <button
                    className="simulate-button"
                    disabled={!discoveryConfig.eventLogFile || isRunningDiscoveries || isDiscovering || !(discoveryConfig.startActivityProbSelected?.length > 0)}
                    onClick={runAllDiscoveries}
                    style={{minWidth:'260px'}}
                  >
                    {isRunningDiscoveries ? 'Discovering…' : 'Discover Parameters & Simulation Model →'}
                  </button>
                </div>

                {/* Hidden inputs needed elsewhere */}
                <input ref={paramsFileRef} type="file" accept=".json" style={{display:'none'}}
                  onChange={e => { if (e.target.files[0]) handleFileUpload(e.target.files[0], 'parameters'); e.target.value=''; }} />
              </div>
            )}{/* end landing page */}

            {/* ── MODEL BEHAVIOR TAB ── */}
            {externalTab === 'behavior' && (
              <div className="ext-ocel-tab-content">
                {/* Stat strip */}
                <div className="behavior-stat-strip">
                  {[
                    { label: 'Events Analyzed', val: discoveryResults?.total_events?.toLocaleString() },
                    { label: 'Object Traces',   val: discoveryResults?.log_object_trace_count?.toLocaleString() },
                    { label: 'Activity Types',  val: discoveryResults?.activity_count },
                    { label: 'Transitions',     val: discoveryResults?.transition_count },
                    { label: 'Log Time Span',   val: (() => {
                        const s = discoveryResults?.ocel_time_span_s;
                        if (!s) return null;
                        if (s < 60) return s + 's';
                        if (s < 3600) return Math.floor(s/60) + 'm';
                        if (s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
                        const d = Math.floor(s/86400); const h = Math.floor((s%86400)/3600);
                        return h > 0 ? d + 'd ' + h + 'h' : d + 'd';
                      })() },
                  ].filter(c => c.val != null).map((c, i) => (
                    <div key={i} className="behavior-stat-card">
                      <div className="behavior-stat-val">{c.val}</div>
                      <div className="behavior-stat-label">{c.label}</div>
                    </div>
                  ))}
                </div>

                {!modelBase ? (
                  <div style={{padding:'2rem',textAlign:'center',color:'#94a3b8'}}>No model loaded yet.</div>
                ) : (
                  <div className="behavior-body">
                    <nav className="behavior-nav">
                      {[
                        ['activities',    'Activities'],
                        ['time',          'Time'],
                        ['probabilities', 'Probabilities'],
                        ['constraints',   'Constraints'],
                        ['o2o',           'O2O Rules'],
                        ['objects',       'Objects'],
                      ].map(([key, label]) => (
                        <button key={key}
                          className={'behavior-nav-item' + (behaviorSection === key ? ' active' : '')}
                          onClick={() => setBehaviorSection(key)}>
                          {label}
                        </button>
                      ))}
                    </nav>
                    <div className="behavior-content">

                      {behaviorSection === 'activities' && (
                        <div>
                          <div className="behavior-section-title">Activities</div>
                          {(modelBase.activities||[]).length > 0 ? (
                            <table className="behavior-table">
                              <thead><tr><th>Activity</th><th>Object Type</th><th>Min</th><th>Max</th><th>Creates</th><th>Deactivates</th></tr></thead>
                              <tbody>
                                {(modelBase.activities||[]).flatMap(a =>
                                  (a.bindings||[]).length > 0
                                    ? (a.bindings||[]).map((b, bi) => (
                                        <tr key={a.name + '-' + bi}>
                                          {bi === 0 ? <td rowSpan={(a.bindings||[]).length} style={{fontWeight:600}}>{a.name}</td> : null}
                                          <td>{b.object_type}</td>
                                          <td>{b.min_count ?? 1}</td>
                                          <td>{b.max_count ?? 1}</td>
                                          <td style={{textAlign:'center'}}>{b.creates ? '✓' : ''}</td>
                                          <td style={{textAlign:'center'}}>{b.deactivates ? '✓' : ''}</td>
                                        </tr>
                                      ))
                                    : [<tr key={a.name}><td style={{fontWeight:600}}>{a.name}</td><td colSpan={5} style={{color:'#94a3b8'}}>no bindings</td></tr>]
                                )}
                              </tbody>
                            </table>
                          ) : <p className="behavior-empty">No activities in model.</p>}
                        </div>
                      )}

                      {behaviorSection === 'time' && (
                        <div>
                          <div className="behavior-section-title">Time</div>
                          {modelBase.activity_durations && Object.keys(modelBase.activity_durations).length > 0 ? (
                            <table className="behavior-table">
                              <thead><tr><th>Activity</th><th>Distribution</th><th>Mean (s)</th><th>Std (s)</th><th>Min (s)</th><th>Max (s)</th></tr></thead>
                              <tbody>
                                {Object.entries(modelBase.activity_durations).map(([act, d]) => (
                                  <tr key={act}>
                                    <td>{act}</td>
                                    <td>{d.dist_type || '—'}</td>
                                    <td>{d.mean_seconds != null ? Math.round(d.mean_seconds) : '—'}</td>
                                    <td>{d.std_seconds  != null ? Math.round(d.std_seconds)  : '—'}</td>
                                    <td>{d.min_seconds  != null ? Math.round(d.min_seconds)  : '—'}</td>
                                    <td>{d.max_seconds  != null ? Math.round(d.max_seconds)  : '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : <p className="behavior-empty">No timing data discovered.</p>}
                        </div>
                      )}

                      {behaviorSection === 'probabilities' && (
                        <div>
                          <div className="behavior-section-title">Transition Probabilities</div>
                          {probMatrixBase && Object.keys(probMatrixBase).length > 0 ? (
                            <table className="behavior-table">
                              <thead><tr><th>From</th><th>To</th><th>Probability</th></tr></thead>
                              <tbody>
                                {Object.entries(probMatrixBase).flatMap(([src, targets]) =>
                                  Object.entries(targets || {}).filter(([, p]) => p > 0.001).map(([tgt, p], i) => (
                                    <tr key={src + '-' + tgt}>
                                      {i === 0 ? <td rowSpan={Object.entries(targets||{}).filter(([,p2])=>p2>0.001).length} style={{fontWeight:600}}>{src}</td> : null}
                                      <td>{tgt}</td>
                                      <td>{(p * 100).toFixed(1)}%</td>
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </table>
                          ) : <p className="behavior-empty">No probability data.</p>}
                        </div>
                      )}

                      {behaviorSection === 'constraints' && (
                        <div>
                          <div className="behavior-section-title">Constraints</div>
                          {(modelBase.constraints||[]).length > 0 ? (
                            <table className="behavior-table">
                              <thead><tr><th>Type</th><th>Source</th><th>Target</th><th>Scope</th><th>n≥</th><th>n≤</th></tr></thead>
                              <tbody>
                                {(modelBase.constraints||[]).map((c, i) => (
                                  <tr key={i}>
                                    <td><span className={'con-type-badge'}>{c.constraint_type}</span></td>
                                    <td>{c.source_activity || c.source || '—'}</td>
                                    <td>{c.target_activity || c.target || '—'}</td>
                                    <td>{c.scope_object_type || '—'}</td>
                                    <td>{c.nmin ?? '—'}</td>
                                    <td>{c.nmax ?? '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          ) : <p className="behavior-empty">No constraints in model.</p>}
                        </div>
                      )}

                      {behaviorSection === 'o2o' && (
                        <div>
                          <div className="behavior-section-title">O2O Rules</div>
                          {(modelBase.o2o_rules||[]).length > 0 ? (
                            <>
                              <table className="behavior-table" style={{marginBottom:'1rem'}}>
                                <thead><tr><th>Source Type</th><th>Target Type</th><th>Min</th><th>Max</th><th>Direction</th></tr></thead>
                                <tbody>
                                  {(modelBase.o2o_rules||[]).map((r, i) => (
                                    <tr key={i}>
                                      <td>{r.source_type}</td><td>{r.target_type}</td>
                                      <td>{r.min_links ?? '—'}</td><td>{r.max_links ?? '—'}</td>
                                      <td>{r.bidirectional ? '↔' : '→'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              <O2ODiagram
                                rules={modelBase.o2o_rules}
                                otNames={(modelBase.object_types||[]).map(t => typeof t === 'string' ? t : t.name)}
                              />
                            </>
                          ) : <p className="behavior-empty">No O2O rules discovered.</p>}
                        </div>
                      )}

                      {behaviorSection === 'objects' && (
                        <div>
                          <div className="behavior-section-title">Objects</div>
                          <div style={{display:'flex',gap:'2rem',flexWrap:'wrap',marginBottom:'1.5rem'}}>
                            <div style={{flex:1,minWidth:'180px'}}>
                              <div className="behavior-sub-title">Resources</div>
                              {(modelBase.resource_types||[]).length > 0 ? (
                                <table className="behavior-table">
                                  <thead><tr><th>Type</th><th>Pool Size</th></tr></thead>
                                  <tbody>
                                    {(modelBase.resource_types||[]).map(r => (
                                      <tr key={r}><td>{r}</td><td>{(modelBase.resource_pool_sizes||{})[r] ?? 1}</td></tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : <p className="behavior-empty">No resource types.</p>}
                            </div>
                            <div style={{flex:1,minWidth:'180px'}}>
                              <div className="behavior-sub-title">Attributes</div>
                              {Object.keys(modelBase.attribute_defaults||{}).length > 0 ? (
                                <table className="behavior-table">
                                  <thead><tr><th>Object Type</th><th>Attribute</th><th>Default</th></tr></thead>
                                  <tbody>
                                    {Object.entries(modelBase.attribute_defaults||{}).flatMap(([ot, attrs]) =>
                                      Object.entries(attrs||{}).map(([attr, val], i) => (
                                        <tr key={ot+'-'+attr}>
                                          {i===0?<td rowSpan={Object.keys(attrs||{}).length} style={{fontWeight:600}}>{ot}</td>:null}
                                          <td>{attr}</td><td>{String(val)}</td>
                                        </tr>
                                      ))
                                    )}
                                  </tbody>
                                </table>
                              ) : <p className="behavior-empty">No attributes defined.</p>}
                            </div>
                          </div>
                          <div className="behavior-sub-title">Object Flow</div>
                          {(modelBase.activities||[]).map(a => {
                            const bound = (a.bindings||[]);
                            if (!bound.length) return null;
                            return bound.map(b => ({ act: a.name, ot: b.object_type, creates: b.creates, deactivates: b.deactivates }));
                          }).filter(Boolean).flat().reduce((acc, row) => {
                            (acc[row.ot] = acc[row.ot] || []).push(row);
                            return acc;
                          }, {}) && (() => {
                            const byType = {};
                            (modelBase.activities||[]).forEach(a => (a.bindings||[]).forEach(b => {
                              (byType[b.object_type] = byType[b.object_type]||[]).push({act:a.name,creates:b.creates,deactivates:b.deactivates});
                            }));
                            return Object.entries(byType).map(([ot, nodes]) => (
                              <div key={ot} className="object-flow-type">
                                <div className="object-flow-type-label">{ot}</div>
                                <div className="object-flow-track">
                                  {nodes.map(n => (
                                    <div key={n.act} className="flow-node">
                                      <span className="flow-node-name">{n.act}</span>
                                      {n.creates && <span className="flow-node-badge flow-node-creates">+</span>}
                                      {n.deactivates && <span className="flow-node-badge flow-node-deactivates">✕</span>}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ));
                          })()}
                        </div>
                      )}

                    </div>
                  </div>
                )}
              </div>
            )}{/* end behavior tab */}

            {/* ── SCENARIO BUILDER TAB ── */}
            {externalTab === 'scenario' && (
              <div className="ext-ocel-tab-content">
                <div className="scenario-layout">

                  {/* LEFT: Model Editor — bound to modelToBe */}
                  <div className="scenario-editor-col">
                    <div className="behavior-section-title" style={{marginBottom:'0.5rem'}}>
                      Model Editor <span style={{fontSize:'0.72rem',fontWeight:400,color:'#94a3b8'}}>(To-Be — editable)</span>
                    </div>
                    {modelToBe ? (
                      <ModelEditor
                        model={modelToBe}
                        probMatrix={probMatrixToBe || {}}
                        onModelChange={m => { setModelToBe(m); setActiveModel(m); handleModelEdit(m); }}
                        onProbMatrixChange={m => { setProbMatrixToBe(m); setActiveProbMatrix(m); }}
                        sourceFile={config.ocdeclareFile}
                        parameterFiles={parameterFiles}
                        onLoadParameters={handleLoadParameters}
                        onSaveParameters={handleSaveParameters}
                        nmaxSuggestions={discoveryResults?.activity_nmax_suggestions || {}}
                        eventLogFile={discoveryConfig.eventLogFile || ''}
                        hideParameterButtons={true}
                        startActivities={config.startActivities}
                        onStartActivitiesChange={acts => setConfig(p => ({...p, startActivities: acts}))}
                      />
                    ) : (
                      <div style={{color:'#94a3b8',fontSize:'0.85rem',padding:'2rem',textAlign:'center'}}>Run discoveries first to populate the model.</div>
                    )}

                    {/* Constraint Flow Graph — always shown when activities/constraints exist */}
                    {modelToBe && (modelToBe.activities?.length > 0 || modelToBe.constraints?.length > 0) && (
                      <div style={{marginTop:'1.5rem',background:'white',border:'1px solid #e2e8f0',borderRadius:'10px',padding:'1rem'}}>
                        <div className="behavior-section-title" style={{marginBottom:'0.75rem'}}>
                          Constraint Flow <span style={{fontSize:'0.7rem',fontWeight:400,color:'#94a3b8'}}>— possible routes from activities &amp; constraints (transitive reduction)</span>
                        </div>
                        <ConstraintFlowGraph
                          activities={modelToBe.activities || []}
                          constraints={modelToBe.constraints || []}
                          startActivities={config.startActivities || []}
                        />
                      </div>
                    )}

                    {/* OC-DFG — auto-updates when model/matrix changes */}
                    {modelToBe && probMatrixToBe && Object.keys(probMatrixToBe).length > 0 && (
                      <div style={{marginTop:'1.5rem',background:'white',border:'1px solid #e2e8f0',borderRadius:'10px',padding:'1rem'}}>
                        <div className="behavior-section-title" style={{marginBottom:'0.75rem'}}>
                          OC-DFG <span style={{fontSize:'0.7rem',fontWeight:400,color:'#94a3b8'}}>— updates on model changes</span>
                        </div>
                        <TransitionFlowChart
                          matrix={probMatrixToBe}
                          activityCounts={discoveryResults?.activity_counts || {}}
                          startActivities={config.startActivities}
                          traceEndProb={discoveryResults?.trace_end_prob || {}}
                          likelyEndActivities={discoveryResults?.likely_end_activities || []}
                          tracePosition={discoveryResults?.trace_position || {}}
                          constraints={modelToBe?.constraints || []}
                        />
                        {/* Constraints — collapsible */}
                        {(modelToBe.constraints||[]).length > 0 && (
                          <Collapsible
                            title={`Constraints (${modelToBe.constraints.length})`}
                            defaultOpen={false}
                          >
                            <div style={{display:'flex',flexDirection:'column',gap:'0.25rem',maxHeight:'180px',overflowY:'auto'}}>
                              {(modelToBe.constraints||[]).map((c,i) => (
                                <div key={i} style={{display:'flex',alignItems:'center',gap:'0.5rem',fontSize:'0.78rem',color:'#334155'}}>
                                  <span className={`con-type-badge con-${(c.constraint_type||'').toLowerCase().replace(/_/g,'-')}`} style={{flexShrink:0}}>
                                    {c.constraint_type}
                                  </span>
                                  <span>{c.source_activity||c.source||'—'}</span>
                                  <span style={{color:'#94a3b8'}}>→</span>
                                  <span>{c.target_activity||c.target||'—'}</span>
                                  {c.scope_object_type && <span style={{color:'#94a3b8',fontSize:'0.7rem'}}>({c.scope_object_type})</span>}
                                </div>
                              ))}
                            </div>
                          </Collapsible>
                        )}

                        {/* Blocking analysis — auto-updates on model change */}
                        <Collapsible
                          title={isAnalyzingBlocking ? '🔍 Analyzing blocking constraints…' : `🔍 Blocking Constraints${blockingResult?.blocking?.length ? ` (${blockingResult.blocking.length})` : ''}`}
                          defaultOpen={false}
                          badge={blockingResult?.blocking?.length > 0 ? blockingResult.blocking.length : null}
                        >
                          {isAnalyzingBlocking && (
                            <div style={{display:'flex',alignItems:'center',gap:'0.5rem',fontSize:'0.82rem',color:'#64748b',padding:'0.5rem 0'}}>
                              <div className="spinner spinner-sm"></div> Running dry-run analysis…
                            </div>
                          )}
                          {!isAnalyzingBlocking && blockingResult?.error && (
                            <div style={{fontSize:'0.78rem',color:'#dc2626'}}>{blockingResult.error}</div>
                          )}
                          {!isAnalyzingBlocking && blockingResult?.blocking?.length === 0 && (
                            <div style={{fontSize:'0.82rem',color:'#16a34a',padding:'0.4rem 0'}}>✓ No blocking constraints detected</div>
                          )}
                          {!isAnalyzingBlocking && blockingResult?.blocking?.length > 0 && (
                            <div style={{display:'flex',flexDirection:'column',gap:'0.5rem'}}>
                              <div style={{fontSize:'0.72rem',color:'#64748b',marginBottom:'0.25rem'}}>
                                Based on {blockingResult.total_steps}-step dry run + static check. Pressure = fraction of steps where activity was absent from candidate pool.
                              </div>
                              {blockingResult.blocking.map((b, i) => (
                                <div key={i} style={{background: b.severity==='high'?'#fff1f2':'#fffbeb', border:`1px solid ${b.severity==='high'?'#fecdd3':'#fde68a'}`, borderRadius:'6px', padding:'0.5rem 0.75rem'}}>
                                  <div style={{display:'flex',alignItems:'center',gap:'0.5rem',marginBottom:'0.25rem'}}>
                                    <span style={{fontWeight:700,fontSize:'0.85rem',color: b.severity==='high'?'#be123c':'#92400e'}}>{b.activity}</span>
                                    {b.pressure != null && (
                                      <span style={{fontSize:'0.72rem',background:'#f1f5f9',borderRadius:'4px',padding:'0.1rem 0.4rem',color:'#475569'}}>
                                        {Math.round(b.pressure*100)}% blocked
                                      </span>
                                    )}
                                    <span style={{fontSize:'0.7rem',color: b.severity==='high'?'#be123c':'#92400e',marginLeft:'auto'}}>{b.severity}</span>
                                  </div>
                                  {b.reason?.startsWith('static:') && (
                                    <div style={{fontSize:'0.75rem',color:'#64748b',marginBottom:'0.2rem'}}>{b.reason.replace('static: ','')}</div>
                                  )}
                                  {(b.related_constraints||[]).length > 0 && (
                                    <div style={{display:'flex',flexDirection:'column',gap:'0.15rem',marginTop:'0.2rem'}}>
                                      {b.related_constraints.map((rc,j) => (
                                        <div key={j} style={{fontSize:'0.72rem',color:'#475569',display:'flex',gap:'0.35rem',alignItems:'center'}}>
                                          <span className={`con-type-badge con-${(rc.constraint_type||'').toLowerCase().replace(/_/g,'-')}`} style={{fontSize:'0.65rem'}}>{rc.constraint_type}</span>
                                          <span>{rc.source}</span><span style={{color:'#94a3b8'}}>→</span><span>{rc.target}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </Collapsible>
                      </div>
                    )}
                  </div>

                  {/* RIGHT: Simulation */}
                  <div className="scenario-sim-col">
                    <div className="behavior-section-title" style={{marginBottom:'0.75rem'}}>Simulation</div>

                    {/* Run buttons */}
                    <div style={{display:'flex',gap:'0.75rem',marginBottom:'1rem'}}>
                      <button className="simulate-button" style={{flex:1,fontSize:'0.9rem',padding:'0.7rem',background:'#334155'}}
                        disabled={isSimulating || !modelBase}
                        onClick={() => runSimulation('asis')}>
                        {isSimulating ? 'Running…' : '▶ Run As-Is'}
                      </button>
                      <button className="simulate-button" style={{flex:1,fontSize:'0.9rem',padding:'0.7rem'}}
                        disabled={isSimulating || !modelToBe || config.startActivities.length === 0 || !resultsAsIs}
                        title={!resultsAsIs ? 'Run As-Is first to establish a baseline' : undefined}
                        onClick={() => runSimulation('tobe')}>
                        {isSimulating ? 'Running…' : '▶ Run To-Be'}
                      </button>
                    </div>

                    {/* Start Activities */}
                    <div className="form-group" style={{marginBottom:'0.75rem'}}>
                      <label>Start Activities</label>
                      <div className="sa-picker">
                        {(() => {
                          const candidates = startActivityCandidates.length > 0 ? startActivityCandidates
                            : (availableActivities.length > 0 ? availableActivities.map(a => ({activity:a,pct:null}))
                            : (modelToBe?.activities||[]).map(a => ({activity:a.name,pct:null})));
                          return (<>
                            <div style={{display:'flex',gap:'0.4rem',flexWrap:'wrap',marginTop:'0.3rem'}}>
                              {candidates.map((c, i) => {
                                const selected = config.startActivities.includes(c.activity);
                                return (
                                  <button key={c.activity}
                                    onClick={() => {
                                      const n = selected
                                        ? config.startActivities.filter(a => a !== c.activity)
                                        : [...config.startActivities, c.activity];
                                      setConfig(p => ({...p, startActivities: n}));
                                    }}
                                    style={{
                                      padding:'0.3rem 0.7rem',
                                      fontSize:'0.82rem',
                                      borderRadius:'20px',
                                      border: selected ? '2px solid #1e293b' : '1px solid #cbd5e1',
                                      background: selected ? '#1e293b' : 'white',
                                      color: selected ? 'white' : '#475569',
                                      cursor:'pointer',
                                      fontWeight: selected ? 600 : 400,
                                      transition:'all 0.12s',
                                    }}>
                                    {i === 0 && c.pct !== null && '★ '}{c.activity}
                                    {c.pct !== null && <span style={{opacity:0.7,fontSize:'0.72rem'}}> {c.pct}%</span>}
                                  </button>
                                );
                              })}
                            </div>
                          </>);
                        })()}
                      </div>
                    </div>

                    {/* Stop conditions */}
                    <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'8px',padding:'0.75rem 1rem',marginBottom:'0.75rem'}}>
                      <div style={{fontSize:'0.72rem',fontWeight:700,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.04em',marginBottom:'0.5rem'}}>
                        Stop conditions
                      </div>
                      <div style={{display:'flex',flexDirection:'column',gap:'0.5rem'}}>
                        {/* Max events */}
                        <div style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
                          <span style={{fontSize:'0.82rem',color:'#475569',minWidth:'110px'}}>Max events</span>
                          <input type="text" inputMode="numeric" value={config.maxSteps ?? ''}
                            placeholder="e.g. 500"
                            onChange={e => handleConfigChange('maxSteps', e.target.value === '' ? '' : parseInt(e.target.value.replace(/\D/,''))||1)}
                            disabled={isSimulating}
                            style={{width:'80px',padding:'0.25rem 0.4rem',border:'1px solid #cbd5e1',borderRadius:'5px',fontSize:'0.82rem'}} />
                          {discoveryResults?.total_events != null && (
                            <button
                              style={{fontSize:'0.7rem',color:'#475569',background:'none',border:'1px solid #e2e8f0',borderRadius:'4px',padding:'0.15rem 0.45rem',cursor:'pointer',whiteSpace:'nowrap'}}
                              onClick={() => handleConfigChange('maxSteps', discoveryResults.total_events)}
                              disabled={isSimulating}
                              title="Use log event count as limit"
                            >{discoveryResults.total_events.toLocaleString()} in log</button>
                          )}
                        </div>
                        {/* Simulated time */}
                        <div style={{display:'flex',alignItems:'center',gap:'0.5rem',flexWrap:'wrap'}}>
                          <span style={{fontSize:'0.82rem',color:'#475569',minWidth:'110px'}}>Simulated time</span>
                          <input type="text" inputMode="numeric" value={config.maxSimTimeValue ?? ''}
                            placeholder="e.g. 450"
                            onChange={e => handleConfigChange('maxSimTimeValue', e.target.value === '' ? '' : parseFloat(e.target.value))}
                            disabled={isSimulating}
                            style={{width:'60px',padding:'0.25rem 0.4rem',border:'1px solid #cbd5e1',borderRadius:'5px',fontSize:'0.82rem'}} />
                          <select value={config.maxSimTimeUnit ?? 'days'}
                            onChange={e => handleConfigChange('maxSimTimeUnit', e.target.value)}
                            disabled={isSimulating}
                            style={{fontSize:'0.82rem',padding:'0.2rem 0.3rem',border:'1px solid #cbd5e1',borderRadius:'5px'}}>
                            <option value="seconds">sec</option><option value="minutes">min</option>
                            <option value="hours">hrs</option><option value="days">days</option><option value="weeks">wks</option>
                          </select>
                          {/* Suggestion from log time span */}
                          {discoveryResults?.ocel_time_span_s != null && (() => {
                            const s = discoveryResults.ocel_time_span_s;
                            const unitToS = { seconds:1, minutes:60, hours:3600, days:86400, weeks:604800 };
                            const unit = config.maxSimTimeUnit ?? 'days';
                            const val = Math.round(s / unitToS[unit] * 10) / 10;
                            return (
                              <button
                                style={{fontSize:'0.7rem',color:'#6366f1',background:'none',border:'1px solid #c7d2fe',borderRadius:'4px',padding:'0.15rem 0.45rem',cursor:'pointer',whiteSpace:'nowrap'}}
                                onClick={() => handleConfigChange('maxSimTimeValue', val)}
                                disabled={isSimulating}
                                title="Use log duration as limit"
                              >
                                ↑ log: {val} {unit}
                              </button>
                            );
                          })()}
                        </div>
                        {/* Completed traces */}
                        <div style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
                          <span style={{fontSize:'0.82rem',color:'#475569',minWidth:'110px'}}>Completed traces</span>
                          <input type="text" inputMode="numeric" value={config.maxTraces ?? ''}
                            placeholder="e.g. 100"
                            onChange={e => handleConfigChange('maxTraces', e.target.value === '' ? '' : parseInt(e.target.value.replace(/\D/,''))||1)}
                            disabled={isSimulating}
                            style={{width:'80px',padding:'0.25rem 0.4rem',border:'1px solid #cbd5e1',borderRadius:'5px',fontSize:'0.82rem'}} />
                          {discoveryResults?.log_object_trace_count != null && (
                            <button
                              style={{fontSize:'0.7rem',color:'#475569',background:'none',border:'1px solid #e2e8f0',borderRadius:'4px',padding:'0.15rem 0.45rem',cursor:'pointer',whiteSpace:'nowrap'}}
                              onClick={() => handleConfigChange('maxTraces', discoveryResults.log_object_trace_count)}
                              disabled={isSimulating}
                              title="Use log trace count as limit"
                            >{discoveryResults.log_object_trace_count.toLocaleString()} in log</button>
                          )}
                        </div>
                        <div style={{fontSize:'0.7rem',color:'#94a3b8',marginTop:'0.1rem'}}>Leave blank to disable. First reached stops simulation.</div>
                      </div>
                    </div>

                    {/* Seed */}
                    <div className="form-row" style={{marginBottom:'0.75rem'}}>
                      <div className="form-group">
                        <label>Random Seed</label>
                        <input type="number" value={config.seed} onChange={e => handleConfigChange('seed', parseInt(e.target.value))} disabled={isSimulating} />
                      </div>
                    </div>

                    {/* Progress */}
                    {isSimulating && (
                      <div className="loading-box" style={{padding:'1.5rem'}}>
                        <div className="spinner"></div>
                        <p>Running… <span className="sim-step-counter">events {liveStepCount ?? 0}</span></p>
                        {liveSimTime != null && (
                          <p className="sim-elapsed-timer" style={{fontSize:'0.82rem'}}>
                            {'🕐 sim '}
                            {(() => {
                              const s = liveSimTime;
                              if (s < 60) return `${Math.floor(s)}s`;
                              if (s < 3600) return `${Math.floor(s/60)}m ${Math.floor(s%60)}s`;
                              if (s < 86400) return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
                              const d = Math.floor(s/86400); const h = Math.floor((s%86400)/3600);
                              return `${d}d ${h}h`;
                            })()}
                            {config.maxSimTimeValue !== '' && config.maxSimTimeValue != null && (() => {
                              const unitToS = { seconds:1, minutes:60, hours:3600, days:86400, weeks:604800 };
                              const maxS = parseFloat(config.maxSimTimeValue) * (unitToS[config.maxSimTimeUnit ?? 'days'] ?? 86400);
                              return ` / ${config.maxSimTimeValue} ${config.maxSimTimeUnit ?? 'days'}`;
                            })()}
                          </p>
                        )}
                        {liveTraces != null && liveTraces > 0 && (
                          <p className="sim-elapsed-timer" style={{fontSize:'0.82rem'}}>
                            {'📦 traces: '}{liveTraces}
                            {config.maxTraces !== '' && config.maxTraces != null ? ` / ${config.maxTraces}` : ''}
                          </p>
                        )}
                        <p className="sim-elapsed-timer">{(() => { const s=simElapsed??0; return `⏱ ${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`; })()}</p>
                        {liveActiveObjects != null && (
                          <p className="sim-elapsed-timer" style={{fontSize:'0.82rem'}}>🟢 {liveActiveObjects.toLocaleString()} active objects</p>
                        )}
                        {liveObligations != null && (
                          <p className="sim-elapsed-timer" style={{fontSize:'0.82rem',color: liveObligations > 100 ? '#dc2626' : liveObligations > 20 ? '#d97706' : '#64748b'}}>
                            🔗 {liveObligations.toLocaleString()} pending obligations
                          </p>
                        )}
                        {liveDeactivPerStep != null && (
                          <p className="sim-elapsed-timer" style={{fontSize:'0.78rem',color:'#64748b'}}>
                            📤 {liveDeactivPerStep}/step deactivated · ✅ {liveObligFulfilledPerStep ?? 0}/step obligations removed
                          </p>
                        )}
                        <button className="sim-stop-btn" onClick={stopSimulation}>⏹ Stop</button>
                      </div>
                    )}

                    {/* Completion banner */}
                    {!isSimulating && lastCompletedMode && (
                      <div style={{background:'#f0fdf4',border:'1px solid #86efac',borderRadius:'8px',padding:'0.9rem 1rem',display:'flex',alignItems:'center',justifyContent:'space-between',gap:'1rem',marginBottom:'0.75rem'}}>
                        <div>
                          <div style={{fontWeight:700,color:'#166534',fontSize:'0.9rem'}}>
                            ✓ {lastCompletedMode === 'asis' ? 'As-Is' : 'To-Be'} simulation complete
                          </div>
                          {lastRunDuration != null && (
                            <div style={{fontSize:'0.75rem',color:'#15803d',marginTop:'0.15rem'}}>
                              ⏱ {Math.floor(lastRunDuration/60).toString().padStart(2,'0')}:{(lastRunDuration%60).toString().padStart(2,'0')} wall-clock
                            </div>
                          )}
                        </div>
                        <button
                          className="simulate-button"
                          style={{width:'auto',padding:'0.5rem 1.1rem',fontSize:'0.85rem',background:'#166534'}}
                          onClick={() => setExternalTab('results')}
                        >
                          View Results →
                        </button>
                      </div>
                    )}

                    {/* Model diff */}
                    {modelBase && modelToBe && (() => {
                      const diffC = (modelToBe.constraints||[]).length - (modelBase.constraints||[]).length;
                      const diffO = (modelToBe.o2o_rules||[]).length - (modelBase.o2o_rules||[]).length;
                      const baseActs = JSON.stringify((modelBase.activities||[]).map(a=>a.name).sort());
                      const tobeActs = JSON.stringify((modelToBe.activities||[]).map(a=>a.name).sort());
                      const actChanged = baseActs !== tobeActs;
                      if (diffC === 0 && diffO === 0 && !actChanged) return null;
                      return (
                        <div className="model-diff-summary">
                          <div style={{fontSize:'0.72rem',fontWeight:700,color:'#92400e',marginBottom:'0.3rem'}}>Changes vs Base Model</div>
                          <div style={{display:'flex',gap:'0.5rem',flexWrap:'wrap'}}>
                            {diffC !== 0 && <span className={'diff-badge '+(diffC>0?'diff-add':'diff-rem')}>{diffC>0?'+':''}{diffC} constraints</span>}
                            {diffO !== 0 && <span className={'diff-badge '+(diffO>0?'diff-add':'diff-rem')}>{diffO>0?'+':''}{diffO} O2O rules</span>}
                            {actChanged && <span className="diff-badge diff-mod">activities changed</span>}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Post-Processing */}
                    <Collapsible
                      className="postprocessing-result-section"
                      title="Post-Processing"
                      badge={healthResult && !healthResult.error ? (() => {
                        const s = healthResult.summary || {};
                        return s.errors > 0 ? `${s.errors} errors` : s.warnings > 0 ? `${s.warnings} warnings` : 'healthy';
                      })() : null}
                      defaultOpen={false}
                    >
                      <p style={{fontSize:'0.82rem',color:'#64748b',margin:'0 0 0.75rem'}}>Health check ran automatically after discoveries</p>
                      {isCheckingHealth && <div style={{display:'flex',alignItems:'center',gap:'0.5rem',fontSize:'0.82rem',color:'#64748b'}}><div className="spinner spinner-sm"></div> Running…</div>}
                      {healthResult && !healthResult.error && (() => {
                        const s = healthResult.summary || {};
                        const hasErr = s.errors > 0; const hasWarn = s.warnings > 0;
                        const badge = `${s.errors} error${s.errors!==1?'s':''}, ${s.warnings} warning${s.warnings!==1?'s':''}`;
                        return (
                          <Collapsible className="health-report-box"
                            title={<span className={hasErr?'health-title-error':hasWarn?'health-title-warn':'health-title-ok'}>🩺 Constraint Health Report</span>}
                            badge={badge} defaultOpen={hasErr||hasWarn}>
                            {healthResult.cycles?.length > 0 && <div className="health-section health-error"><div className="health-section-title">🔴 Cycles</div>{healthResult.cycles.map((cy,i)=><div key={i} className="health-item"><span className="health-badge-error">CYCLE</span>{cy.description}</div>)}</div>}
                            {healthResult.no_input_activities?.length > 0 && <div className="health-section health-warn"><div className="health-section-title">⚠ No input constraints</div>{healthResult.no_input_activities.map((a,i)=><div key={i} className="health-item"><span className={`health-badge-${a.is_pure_start?'error':'warn'}`}>{a.is_pure_start?'START':'NO INPUT'}</span><strong>{a.activity}</strong></div>)}</div>}
                            {healthResult.weak_precedences?.length > 0 && <div className="health-section health-warn"><div className="health-section-title">⚠ Weak precedences</div>{healthResult.weak_precedences.map((wp,i)=><div key={i} className="health-item"><span className="health-badge-warn">WEAK</span>{wp.description}</div>)}</div>}
                            {!hasErr && !hasWarn && <div style={{color:'#15803d',fontSize:'0.82rem',padding:'0.5rem'}}>✓ No issues found</div>}
                          </Collapsible>
                        );
                      })()}
                      {healthResult?.error && <div className="error-box"><p>{healthResult.error}</p></div>}
                      {healthResult && !healthResult.error && (
                        <div style={{marginTop:'0.75rem',display:'flex',gap:'0.5rem',flexWrap:'wrap'}}>
                          <button className="run-button" onClick={() => {
                            const suggs = generateSuggestions(healthResult, modelToBe||activeModel, autoConfig, config.startActivities, logConfResults, dropZeroConfConstraints, logBoundsResults, setNmaxFromBounds);
                            setAutoSuggestions(suggs);
                            setAutoSelected(new Set(suggs.map((_,i)=>i)));
                          }}>Generate Suggestions</button>
                          {autoSuggestions.length > 0 && (
                            <button className="run-button" onClick={() => {
                              let model = { ...(modelToBe||activeModel) };
                              autoSuggestions.forEach((s,i) => {
                                if (!autoSelected.has(i)) return;
                                if (s.type==='ADD_CONSTRAINT'&&s.actionFactory) model=s.actionFactory('')(model);
                                else if (s.type==='ADD_BINDING'&&s.actionFactory) model=s.actionFactory('')(model);
                                else if (s.action) model=s.action(model);
                              });
                              setModelToBe(model); setActiveModel(model); handleModelEdit(model);
                              setAutoSuggestions([]); setAutoSelected(new Set());
                            }}>Apply Selected ({[...autoSelected].length})</button>
                          )}
                        </div>
                      )}
                      {autoSuggestions.length > 0 && (
                        <div className="auto-suggestions-list" style={{marginTop:'0.5rem'}}>
                          {autoSuggestions.map((s,i) => (
                            <label key={i} style={{display:'flex',alignItems:'center',gap:'0.5rem',fontSize:'0.82rem',padding:'0.3rem 0',borderBottom:'1px solid #f1f5f9'}}>
                              <input type="checkbox" checked={autoSelected.has(i)} onChange={() => setAutoSelected(prev => { const n=new Set(prev); n.has(i)?n.delete(i):n.add(i); return n; })} />
                              <span className={`auto-badge auto-badge-${(s.type||'').toLowerCase()}`}>{s.type}</span>
                              <span>{s.label || s.description || s.desc}</span>
                            </label>
                          ))}
                        </div>
                      )}

                      {/* ── Constraint Pressure Analysis ── */}
                      <div style={{marginTop:'1rem',borderTop:'1px solid #e2e8f0',paddingTop:'0.75rem'}}>
                        <div style={{display:'flex',alignItems:'center',gap:'0.75rem',marginBottom:'0.5rem'}}>
                          <span style={{fontSize:'0.85rem',fontWeight:700,color:'#1e293b'}}>Constraint Pressure Analysis</span>
                          <button
                            className="run-button"
                            style={{padding:'0.3rem 0.9rem',fontSize:'0.78rem'}}
                            disabled={isRunningPressure}
                            onClick={runPressureAnalysis}
                          >
                            {isRunningPressure ? 'Running…' : pressureResult ? '↻ Re-run Health Check' : '▶ Run Health Check'}
                          </button>
                          {isRunningPressure && <div className="spinner spinner-sm"></div>}
                        </div>
                        <p style={{fontSize:'0.75rem',color:'#94a3b8',margin:'0 0 0.5rem'}}>
                          5000-step dry run — ranks constraints by how much they block activities relative to log-expected firing rates.
                        </p>

                        {pressureResult?.error && (
                          <div className="error-box" style={{marginTop:'0.5rem'}}><p>{pressureResult.error}</p></div>
                        )}

                        {pressureResult && !pressureResult.error && (() => {
                          const top = pressureResult.top_blocking || [];
                          const fmtRate = r => r != null ? r.toFixed(1) + '/day' : '—';
                          const reasonLabel = r => r === 'precedence' ? 'PRECEDENCE' : r === 'resource_busy' ? 'RESOURCE' : r === 'no_objects' ? 'NO OBJECTS' : 'CONSTRAINT';
                          const reasonColor = r => r === 'precedence' ? '#b45309' : r === 'resource_busy' ? '#7c3aed' : r === 'no_objects' ? '#dc2626' : '#475569';
                          const scoreColor = s => s >= 2 ? '#dc2626' : s >= 0.5 ? '#d97706' : '#16a34a';

                          if (top.length === 0) {
                            return <div style={{fontSize:'0.82rem',color:'#15803d',padding:'0.5rem 0'}}>✓ No significant blocking constraints found in this dry run.</div>;
                          }

                          const maxScore = Math.max(...top.map(t => t.score), 0.01);

                          return (
                            <div style={{marginTop:'0.25rem'}}>
                              <div style={{fontSize:'0.72rem',color:'#64748b',marginBottom:'0.4rem'}}>
                                {pressureResult.total_steps} steps · {pressureResult.sim_days}d sim span · Score = pressure × firing deficit
                              </div>
                              {top.map((entry, i) => {
                                const rates = pressureResult.activity_rates?.[entry.activity] || {};
                                const cd = entry.blocking_constraint || {};
                                const barW = Math.round((entry.score / maxScore) * 100);
                                return (
                                  <div key={i} style={{
                                    background:'#f8fafc', border:'1px solid #e2e8f0',
                                    borderRadius:'6px', padding:'0.6rem 0.75rem',
                                    marginBottom:'0.4rem',
                                  }}>
                                    <div style={{display:'flex',alignItems:'center',gap:'0.5rem',marginBottom:'0.3rem',flexWrap:'wrap'}}>
                                      <span style={{
                                        fontSize:'0.68rem',fontWeight:700,padding:'1px 6px',borderRadius:'3px',
                                        background: reasonColor(entry.primary_reason)+'22',
                                        color: reasonColor(entry.primary_reason),
                                      }}>{reasonLabel(entry.primary_reason)}</span>
                                      <span style={{fontWeight:700,fontSize:'0.82rem',color:'#1e293b'}}>{entry.activity}</span>
                                      {cd.constraint_type === 'precedence' || cd.constraint_type === 'chain_precedence' ? (
                                        <span style={{fontSize:'0.75rem',color:'#64748b'}}>← {cd.source}</span>
                                      ) : cd.resource_type ? (
                                        <span style={{fontSize:'0.75rem',color:'#64748b'}}>{cd.resource_type}</span>
                                      ) : null}
                                      <span style={{marginLeft:'auto',fontWeight:700,fontSize:'0.82rem',color:scoreColor(entry.score)}}>
                                        score {entry.score.toFixed(2)}
                                      </span>
                                    </div>
                                    {/* Score bar */}
                                    <div style={{height:'4px',background:'#e2e8f0',borderRadius:'2px',marginBottom:'0.35rem'}}>
                                      <div style={{height:'100%',width:`${barW}%`,background:scoreColor(entry.score),borderRadius:'2px',transition:'width 0.3s'}}/>
                                    </div>
                                    <div style={{fontSize:'0.72rem',color:'#64748b',display:'flex',gap:'1rem',flexWrap:'wrap',marginBottom:'0.3rem'}}>
                                      <span>Blocked {Math.round(entry.pressure * 100)}% of steps</span>
                                      {rates.expected != null && <span>Expected {fmtRate(rates.expected)} · Actual {fmtRate(rates.actual)}</span>}
                                      {rates.deficit > 0 && <span style={{color:'#dc2626'}}>Deficit {fmtRate(rates.deficit)}</span>}
                                    </div>
                                    {entry.suggestion && (
                                      <div style={{fontSize:'0.75rem',color:'#1e40af',background:'#eff6ff',borderRadius:'4px',padding:'0.3rem 0.5rem',marginTop:'0.2rem'}}>
                                        → {entry.suggestion}
                                      </div>
                                    )}
                                    {entry.cascade_note && (
                                      <div style={{fontSize:'0.72rem',color:'#7c3aed',background:'#faf5ff',borderRadius:'4px',padding:'0.25rem 0.5rem',marginTop:'0.2rem'}}>
                                        ⚡ {entry.cascade_note}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                    </Collapsible>

                  </div>
                </div>
              </div>
            )}{/* end scenario tab */}

            {/* ── RESULTS TAB ── */}
            {externalTab === 'results' && (
              <div className="ext-ocel-tab-content">

                {/* ── Comparison header (only when both runs exist) ── */}
                {resultsAsIs && resultsToBe && (() => {
                  const fmtDur = s => {
                    if (s == null) return '—';
                    if (s < 60) return Math.round(s) + 's';
                    if (s < 3600) return Math.floor(s/60) + 'm ' + Math.floor(s%60) + 's';
                    if (s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
                    const d = Math.floor(s/86400); const h = Math.floor((s%86400)/3600);
                    return h > 0 ? d + 'd ' + h + 'h' : d + 'd';
                  };
                  const pct = (asis, tobe) => {
                    if (asis == null || tobe == null || asis === 0) return null;
                    return Math.round((tobe - asis) / Math.abs(asis) * 100);
                  };
                  const metrics = [
                    {
                      label: 'Avg Trace Duration',
                      asis: resultsAsIs.avg_trace_lifetime_s,
                      tobe: resultsToBe.avg_trace_lifetime_s,
                      fmt: fmtDur,
                      lowerIsBetter: true,
                    },
                    {
                      label: 'Avg Wait Time',
                      asis: resultsAsIs.avg_wait_s,
                      tobe: resultsToBe.avg_wait_s,
                      fmt: fmtDur,
                      lowerIsBetter: true,
                    },
                    {
                      label: 'Avg Parallelism',
                      asis: resultsAsIs.avg_parallelism,
                      tobe: resultsToBe.avg_parallelism,
                      fmt: v => v == null ? '—' : v.toFixed(2),
                      lowerIsBetter: false,
                    },
                    {
                      label: 'Events Completed',
                      asis: resultsAsIs.steps_executed,
                      tobe: resultsToBe.steps_executed,
                      fmt: v => v == null ? '—' : v.toLocaleString(),
                      lowerIsBetter: null,
                    },
                    {
                      label: 'Object Traces Completed',
                      asis: resultsAsIs.completed_traces,
                      tobe: resultsToBe.completed_traces,
                      fmt: v => v == null ? '—' : v.toLocaleString(),
                      lowerIsBetter: null,
                    },
                    {
                      label: 'Avg Trace Duration',
                      asis: resultsAsIs.avg_connected_trace_duration_s,
                      tobe: resultsToBe.avg_connected_trace_duration_s,
                      fmt: fmtDur,
                      lowerIsBetter: true,
                    },
                  ];
                  return (
                    <div className="results-comparison-header">
                      {metrics.map(m => {
                        const p = pct(m.asis, m.tobe);
                        const diff = m.tobe != null && m.asis != null ? m.tobe - m.asis : null;
                        const mag = Math.abs(p ?? 0);
                        const goodDir = m.lowerIsBetter === null ? null : (m.lowerIsBetter ? diff < 0 : diff > 0);
                        const color = diff === 0 || diff == null || m.lowerIsBetter === null || p === null ? '#64748b'
                          : goodDir
                            ? (mag > 25 ? '#16a34a' : mag > 10 ? '#65a30d' : '#64748b')
                            : (mag < 10 ? '#64748b' : mag < 25 ? '#ca8a04' : mag < 50 ? '#ea580c' : '#dc2626');
                        return (
                          <div key={m.label} className="compare-metric-card">
                            <div className="compare-metric-label">{m.label}</div>
                            <div className="compare-metric-asis">{m.fmt(m.asis)}</div>
                            <div className="compare-metric-tobe" style={{color}}>
                              {m.fmt(m.tobe)}
                              {p !== null && (
                                <span className="compare-metric-pct" style={{color}}>
                                  {' '}{p > 0 ? '+' : ''}{p}%
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* Run Evaluation button */}
                {(resultsAsIs || resultsToBe) && (
                  <div style={{display:'flex',alignItems:'center',gap:'1rem',marginBottom:'1rem',
                    background: evaluationReady ? '#f0fdf4' : '#f8fafc',
                    border:`1px solid ${evaluationReady?'#86efac':'#e2e8f0'}`,
                    borderRadius:'8px',padding:'0.75rem 1rem'}}>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:'0.85rem',color:'#1e293b'}}>
                        {evaluationReady ? '✓ Evaluation ready' : 'Run Evaluation to compute conformance, trace completion, and verification metrics'}
                      </div>
                      {evaluationReady && (
                        <div style={{fontSize:'0.72rem',color:'#64748b',marginTop:'0.15rem'}}>
                          Re-run after new simulations to update results
                        </div>
                      )}
                    </div>
                    <button
                      className="simulate-button"
                      style={{width:'auto',padding:'0.5rem 1.25rem',fontSize:'0.85rem',
                        background: evaluationReady ? '#475569' : '#1e293b'}}
                      onClick={() => {
                        setEvaluationReady(true);
                        setEvalRunCount(c => c + 1);
                        setExternalTab('evaluation');
                      }}
                    >
                      {evaluationReady ? '↻ Re-run Evaluation' : '▶ Run Evaluation'}
                    </button>
                  </div>
                )}

                <div className="results-compare-layout">
                  {[{label:'As-Is', r:resultsAsIs, objTab:objTabAsIs, setObjTab:setObjTabAsIs}, {label:'To-Be', r:resultsToBe, objTab:objTabToBe, setObjTab:setObjTabToBe}].map(({label, r, objTab, setObjTab}) => (
                    <div key={label} className="run-result-panel">
                      <div className="run-result-panel-header">{label}</div>
                      {!r ? (
                        <div className="run-result-placeholder">Run {label} to see results here</div>
                      ) : (() => {
                        const firedTypes = r.activity_sequence ? [...new Set(r.activity_sequence)] : Object.keys(r.metrics?.activity_metrics||{});
                        const discoveredTypes = discoveryResults?.activities || [];
                        const coverage = discoveredTypes.length > 0 ? firedTypes.filter(a=>discoveredTypes.includes(a)).length : firedTypes.length;
                        return (
                          <div style={{padding:'1rem'}}>
                            <div className="stat-grid" style={{marginBottom:'1rem'}}>
                              <div className="stat-card"><div className="stat-value">{r.steps_executed}</div><div className="stat-label">Events Completed</div></div>
                              <div className={'stat-card'+(discoveredTypes.length>0&&coverage<discoveredTypes.length?' stat-card-warn':' stat-card-ok')}>
                                <div className="stat-value">{coverage}{discoveredTypes.length>0&&<span className="stat-value-denom"> / {discoveredTypes.length}</span>}</div>
                                <div className="stat-label">Activity Types</div>
                              </div>
                              <div className="stat-card"><div className="stat-value">{r.objects_count}</div><div className="stat-label">Objects</div></div>
                              {r.sim_time_s!=null&&<div className="stat-card"><div className="stat-value">{(()=>{const s=r.sim_time_s;if(s<60)return Math.round(s)+'s';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';const d=Math.floor(s/86400);return d+'d';})()}</div><div className="stat-label">Sim Time</div></div>}
                              {r.completed_traces!=null&&(()=>{
                                const logTraceCount = discoveryResults?.log_object_trace_count;
                                const cardClass = logTraceCount==null ? '' : r.completed_traces >= logTraceCount ? ' stat-card-ok' : r.completed_traces >= logTraceCount * 0.75 ? ' stat-card-warn' : ' stat-card-bad';
                                return (
                                  <div className={'stat-card'+cardClass}>
                                    <div className="stat-value">
                                      {r.completed_traces.toLocaleString()}
                                      {logTraceCount!=null && <span className="stat-value-denom"> / {logTraceCount.toLocaleString()}</span>}
                                    </div>
                                    <div className="stat-label">Traces Completed</div>
                                  </div>
                                );
                              })()}
                              {r.avg_connected_trace_duration_s!=null&&<div className="stat-card"><div className="stat-value">{(()=>{const s=r.avg_connected_trace_duration_s;if(s<60)return Math.round(s)+'s';if(s<3600)return Math.floor(s/60)+'m '+Math.floor(s%60)+'s';if(s<86400)return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);return h>0?d+'d '+h+'h':d+'d';})()}</div><div className="stat-label">Avg Trace Duration</div></div>}
                            </div>
                            {r.metrics?.activity_metrics && discoveryResults?.activity_counts && (() => {
                              const simMetrics = r.metrics.activity_metrics;
                              const logCounts = discoveryResults.activity_counts || {};
                              const logRepeat = discoveryResults.activity_repeat_stats || {};
                              const simTotal = Object.values(simMetrics).reduce((s, m) => s + (m.execution_count || 0), 0);
                              const logTotal = Object.values(logCounts).reduce((s, v) => s + v, 0);
                              const allActs = [...new Set([...Object.keys(simMetrics), ...Object.keys(logCounts)])]
                                .sort(makeFlowRankSorter(discoveryResults, r.object_traces));
                              const wmape = logTotal > 0 && simTotal > 0
                                ? allActs.reduce((s, act) => {
                                    const sp = (simMetrics[act]?.execution_count||0) / simTotal * 100;
                                    const lp = (logCounts[act]||0) / logTotal * 100;
                                    return s + Math.abs(sp - lp);
                                  }, 0)
                                : null;
                              return (
                                <Collapsible className="logs-box sim-compare-box" title="Activity Distribution vs Log" defaultOpen={false}>
                                  <p className="sim-compare-hint">Proportional share of total events (simulation vs log). Diff = sim% − log% in percentage points. Time share = activity's total sim time / sim span.</p>
                                  <table className="metrics-table sim-compare-table">
                                    <thead>
                                      <tr>
                                        <th>Activity</th>
                                        <th>Sim count</th>
                                        <th>Log count</th>
                                        <th>Sim %</th>
                                        <th>Log %</th>
                                        <th>Diff {wmape != null && <span style={{fontWeight:400,fontSize:'0.7rem',color: wmape < 10 ? '#16a34a' : wmape < 25 ? '#ca8a04' : wmape < 50 ? '#ea580c' : '#dc2626'}}>WMAPE {wmape.toFixed(1)}%</span>}</th>
                                        <th title="Activity's total service time as % of total simulated time span">Time share</th>
                                        <th title="Mean service time per firing in simulation">Sim mean dur</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {allActs.map(act => {
                                        const simCount = simMetrics[act]?.execution_count ?? 0;
                                        const logCount = logCounts[act] ?? 0;
                                        const simPct = simTotal > 0 ? simCount / simTotal * 100 : 0;
                                        const logPct = logTotal > 0 ? logCount / logTotal * 100 : 0;
                                        const diff = simPct - logPct;
                                        const meanS = simMetrics[act]?.mean_service_s ?? null;
                                        const simSpan = r.sim_time_s ?? null;
                                        const timeShare = (meanS != null && simCount > 0 && simSpan)
                                          ? (meanS * simCount / simSpan * 100) : null;
                                        const fmtDur = s => { if (s == null) return '—'; if (s < 60) return Math.round(s)+'s'; if (s < 3600) return Math.floor(s/60)+'m'; if (s < 86400) return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);return h>0?d+'d '+h+'h':d+'d'; };
                                        const diffClass = Math.abs(diff) < 2 ? 'cmp-ok' : diff > 0 ? 'cmp-over' : 'cmp-under';
                                        return (
                                          <tr key={act}>
                                            <td className="metrics-act-name">
                                              <ActivityConstraintTooltip activityName={act} constraints={activeModel?.constraints} />
                                            </td>
                                            <td>{simCount || '—'}</td>
                                            <td>{logCount || '—'}</td>
                                            <td>{simPct > 0 ? simPct.toFixed(1) + '%' : '—'}</td>
                                            <td>{logPct > 0 ? logPct.toFixed(1) + '%' : '—'}</td>
                                            <td className={`cmp-diff ${diffClass}`}>{simCount > 0 || logCount > 0 ? (diff >= 0 ? '+' : '') + diff.toFixed(1) + 'pp' : '—'}</td>
                                            <td className={timeShare != null && timeShare > 50 ? 'cmp-over' : ''}>{timeShare != null ? timeShare.toFixed(1)+'%' : '—'}</td>
                                            <td>{fmtDur(meanS)}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </Collapsible>
                              );
                            })()}

                            {/* Objects — tabbed: Concurrency + Object Lifecycle */}
                            {(() => {
                              const simMetrics = r.metrics?.activity_metrics || {};
                              const simSpan = r.sim_time_s ?? null;
                              const noParallel = new Set(activeModel?.no_parallel_activities || []);
                              return (
                                <Collapsible title="Objects" defaultOpen={false}>
                                  <div style={{display:'flex',gap:'0.5rem',marginBottom:'0.75rem',borderBottom:'1px solid #e2e8f0',paddingBottom:'0.5rem'}}>
                                    {['concurrency','lifecycle'].map(t => (
                                      <button key={t}
                                        onClick={() => setObjTab(t)}
                                        style={{padding:'0.25rem 0.75rem',fontSize:'0.78rem',fontWeight:600,border:'none',borderRadius:'4px',cursor:'pointer',
                                          background: objTab===t ? '#1e293b' : 'transparent',
                                          color: objTab===t ? 'white' : '#64748b'}}>
                                        {t === 'concurrency' ? 'Concurrency' : 'Object Lifecycle'}
                                      </button>
                                    ))}
                                  </div>

                                  {objTab === 'concurrency' && (
                                    <div>
                                      <p style={{fontSize:'0.78rem',color:'#64748b',marginBottom:'0.5rem'}}>
                                        Concurrency ratio = activity's total occupied time / total sim time. Values &gt;1.0 mean multiple instances ran simultaneously.
                                        Self-concurrency shows whether multiple instances of the same activity ran at once.
                                      </p>
                                      <table className="behavior-table">
                                        <thead>
                                          <tr>
                                            <th>Activity</th>
                                            <th title="Total service time / sim span — values >1 indicate overlap">Concurrency ratio</th>
                                            <th title="Mean duration per firing">Mean duration</th>
                                            <th title="Whether multiple instances of this activity can run simultaneously">Self-concurrent</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {Object.entries(simMetrics)
                                            .map(([act, m]) => {
                                              const meanS = m.mean_service_s ?? 0;
                                              const cnt = m.execution_count ?? 0;
                                              const ratio = simSpan && simSpan > 0 ? (meanS * cnt / simSpan) : null;
                                              const fmtDur = s => { if (!s) return '—'; if (s<60) return Math.round(s)+'s'; if (s<3600) return Math.floor(s/60)+'m'; if (s<86400) return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);return h>0?d+'d '+h+'h':d+'d'; };
                                              return { act, ratio, meanS, cnt };
                                            })
                                            .sort((a,b) => (b.ratio??0) - (a.ratio??0))
                                            .map(({act, ratio, meanS, cnt}) => (
                                              <tr key={act}>
                                                <td>{act}</td>
                                                <td style={{color: ratio != null && ratio > 1 ? '#16a34a' : '#475569', fontWeight: ratio != null && ratio > 1 ? 600 : 400}}>
                                                  {ratio != null ? ratio.toFixed(2) + '×' : '—'}
                                                  {ratio != null && ratio > 1 && <span style={{fontSize:'0.7rem',color:'#16a34a',marginLeft:'0.3rem'}}>parallel</span>}
                                                </td>
                                                <td style={{fontSize:'0.78rem',color:'#475569'}}>
                                                  {(() => { const s=meanS; if (!s) return '—'; if (s<60) return Math.round(s)+'s'; if (s<3600) return Math.floor(s/60)+'m'; if (s<86400) return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);return h>0?d+'d '+h+'h':d+'d'; })()}
                                                </td>
                                                <td>
                                                  {noParallel.has(act)
                                                    ? <span style={{color:'#dc2626',fontSize:'0.75rem'}}>No (restricted)</span>
                                                    : <span style={{color:'#16a34a',fontSize:'0.75rem'}}>Yes (allowed)</span>}
                                                </td>
                                              </tr>
                                            ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}

                                  {objTab === 'lifecycle' && r.audit?.object_lifecycle_audit && (
                                    <table className="behavior-table">
                                      <thead><tr><th>Type</th><th>Created</th><th>Active</th><th>Deactivated</th><th>Status</th></tr></thead>
                                      <tbody>{Object.entries(r.audit.object_lifecycle_audit).map(([ot,a])=>(
                                        <tr key={ot}><td>{ot}</td><td>{a.instance_count}</td><td>{a.active_count}</td><td>{a.deactivated_count}</td><td><span className={`audit-badge audit-badge-${a.classification}`}>{a.classification}</span></td></tr>
                                      ))}</tbody>
                                    </table>
                                  )}
                                  {objTab === 'lifecycle' && !r.audit?.object_lifecycle_audit && (
                                    <p style={{fontSize:'0.82rem',color:'#94a3b8'}}>No object lifecycle data available.</p>
                                  )}
                                </Collapsible>
                              );
                            })()}
                            {r.metrics?.activity_metrics&&(
                              <Collapsible title="Activity Timing" defaultOpen={false}>
                                <table className="behavior-table">
                                  <thead><tr><th>Activity</th><th>Count</th><th>Mean (s)</th></tr></thead>
                                  <tbody>{Object.entries(r.metrics.activity_metrics)
                                    .sort(([a],[b]) => makeFlowRankSorter(discoveryResults, r.object_traces)(a,b))
                                    .map(([act,m])=>(
                                    <tr key={act}><td>{act}</td><td>{m.execution_count}</td><td>{m.mean_service_s!=null?Math.round(m.mean_service_s):'—'}</td></tr>
                                  ))}</tbody>
                                </table>
                              </Collapsible>
                            )}

                            {/* Trace Completion — moved from Evaluation tab */}
                            {r.audit?.object_lifecycle_audit && (() => {
                              const resourceTypes = new Set(r.resource_types||[]);
                              const audit = r.audit.object_lifecycle_audit;
                              const logObjTypes = discoveryResults?.object_type_stats || {};
                              const logTotal = discoveryResults?.log_object_trace_count ?? null;
                              const nonRes = Object.entries(audit).filter(([ot])=>!resourceTypes.has(ot));
                              const totalAll = nonRes.reduce((s,[,a])=>s+(a.instance_count||0),0);
                              const deactAll = nonRes.reduce((s,[,a])=>s+(a.deactivated_count||0),0);
                              const pctAll = totalAll>0?Math.round(deactAll/totalAll*100):0;
                              return (
                                <Collapsible title="Trace Completion" defaultOpen={false}>
                                  <div style={{display:'flex',gap:'0.75rem',flexWrap:'wrap',marginBottom:'0.75rem'}}>
                                    <div className="behavior-stat-card"><div className="behavior-stat-val">{deactAll.toLocaleString()}</div><div className="behavior-stat-label">Completed</div></div>
                                    <div className="behavior-stat-card"><div className="behavior-stat-val">{totalAll.toLocaleString()}</div><div className="behavior-stat-label">Total objects</div></div>
                                    <div className="behavior-stat-card" style={{background:pctAll>=80?'#f0fdf4':pctAll>=50?'#fffbeb':'#fff1f2'}}><div className="behavior-stat-val">{pctAll}%</div><div className="behavior-stat-label">Rate</div></div>
                                    {logTotal!=null&&<div className="behavior-stat-card"><div className="behavior-stat-val">{logTotal.toLocaleString()}</div><div className="behavior-stat-label">Log objects</div></div>}
                                  </div>
                                  <table className="behavior-table">
                                    <thead><tr><th>Type</th><th>Total</th><th>Completed</th><th>Active</th><th>Rate</th>{Object.keys(logObjTypes).length>0&&<th>Log count</th>}</tr></thead>
                                    <tbody>{nonRes.map(([ot,a])=>{
                                      const pct=a.instance_count>0?Math.round(a.deactivated_count/a.instance_count*100):0;
                                      return (<tr key={ot}><td>{ot}</td><td>{a.instance_count}</td>
                                        <td style={{color:pct>=80?'#16a34a':pct>=50?'#d97706':'#dc2626',fontWeight:600}}>{a.deactivated_count}</td>
                                        <td>{a.instance_count-a.deactivated_count}</td>
                                        <td><div style={{background:'#f1f5f9',borderRadius:'4px',height:'8px',width:'60px',overflow:'hidden',display:'inline-block',verticalAlign:'middle',marginRight:'4px'}}><div style={{background:pct>=80?'#16a34a':pct>=50?'#f59e0b':'#ef4444',width:`${pct}%`,height:'100%'}}/></div>{pct}%</td>
                                        {Object.keys(logObjTypes).length>0&&<td style={{color:'#94a3b8'}}>{logObjTypes[ot]?.count!=null?logObjTypes[ot].count.toLocaleString():'—'}</td>}
                                      </tr>);
                                    })}</tbody>
                                  </table>
                                </Collapsible>
                              );
                            })()}

                            {/* OC-Declare Coverage Measures */}
                            <Collapsible title="OC-Declare Coverage" defaultOpen={false}>
                              <OCCoveragePanel
                                results={r}
                                model={activeModel || modelBase}
                                discoveryResults={discoveryResults}
                              />
                            </Collapsible>

                            {/* Former Evaluation Part — immediately available after sim stop */}
                            {r.metrics?.activity_metrics && (
                              <Collapsible title="Former Evaluation Part" defaultOpen={false}>
                                {/* Service & Waiting time per activity */}
                                <Collapsible title="Service / Waiting Time per Activity" defaultOpen={false}>
                                  <table className="behavior-table" style={{fontSize:'0.78rem'}}>
                                    <thead><tr><th>Activity</th><th>Mean svc</th><th>Min svc</th><th>Max svc</th><th>Mean res. wait</th><th>Mean pool wait</th></tr></thead>
                                    <tbody>{Object.entries(r.metrics.activity_metrics)
                                      .sort(([a],[b]) => makeFlowRankSorter(discoveryResults, r.object_traces)(a,b))
                                      .map(([act,m])=>{
                                        const fmtS = v => { if(!v) return '—'; if(v>=86400) return (v/86400).toFixed(1)+'d'; if(v>=3600) return (v/3600).toFixed(1)+'h'; if(v>=60) return Math.round(v/60)+'m'; return Math.round(v)+'s'; };
                                        return (<tr key={act}>
                                          <td>{act}</td>
                                          <td>{fmtS(m.mean_service_s)}</td>
                                          <td>{fmtS(m.min_service_s)}</td>
                                          <td>{fmtS(m.max_service_s)}</td>
                                          <td>{fmtS(m.mean_resource_wait_s)}</td>
                                          <td>{fmtS(m.mean_wait_in_pool_s)}</td>
                                        </tr>);
                                      })}
                                    </tbody>
                                  </table>
                                </Collapsible>

                                {/* Sim Metrics vs Log Discovery */}
                                {activeModel?.activity_durations && (() => {
                                  const logDurs = activeModel.activity_durations || {};
                                  const simM = r.metrics.activity_metrics;
                                  const fmtS = v => { if(!v) return '—'; if(v>=86400) return (v/86400).toFixed(1)+'d'; if(v>=3600) return (v/3600).toFixed(1)+'h'; if(v>=60) return Math.round(v/60)+'m'; return Math.round(v)+'s'; };
                                  const pct = (a,b) => a&&b&&a!==0 ? ((b-a)/a*100) : null;
                                  const fmtPct = v => v==null?'—':(v>=0?'+':'')+v.toFixed(1)+'%';
                                  const cls = v => { if(v==null) return ''; const n=Math.abs(v); return n<10?'cmp-ok':v>0?'cmp-over':'cmp-under'; };
                                  const acts = Object.keys(simM).sort(makeFlowRankSorter(discoveryResults, r.object_traces));
                                  return (
                                    <Collapsible title="Sim Metrics vs Log Discovery" defaultOpen={false}>
                                      <table className="metrics-table" style={{fontSize:'0.78rem'}}>
                                        <thead><tr><th>Activity</th><th>Log mean</th><th>Sim mean</th><th>Δ</th><th>Log max</th><th>Sim max</th><th>Δ</th></tr></thead>
                                        <tbody>{acts.map(act => {
                                          const log = logDurs[act] || {};
                                          const sim = simM[act] || {};
                                          const dMean = pct(log.service_mean, sim.mean_service_s);
                                          const dMax  = pct(log.service_max,  sim.max_service_s);
                                          return (<tr key={act}>
                                            <td>{act}</td>
                                            <td>{fmtS(log.service_mean)}</td>
                                            <td>{fmtS(sim.mean_service_s)}</td>
                                            <td className={`audit-num cmp-diff ${cls(dMean)}`}>{fmtPct(dMean)}</td>
                                            <td>{fmtS(log.service_max)}</td>
                                            <td>{fmtS(sim.max_service_s)}</td>
                                            <td className={`audit-num cmp-diff ${cls(dMax)}`}>{fmtPct(dMax)}</td>
                                          </tr>);
                                        })}</tbody>
                                      </table>
                                    </Collapsible>
                                  );
                                })()}
                              </Collapsible>
                            )}
                            {r.output_file && (
                              <div style={{marginTop:'0.75rem',display:'flex',gap:'0.5rem',flexWrap:'wrap'}}>
                                <a className="download-button"
                                  href={`/api/download/${encodeURIComponent(r.output_file)}`}
                                  download={r.output_file}>
                                  ⬇ Download Event Log
                                </a>
                                {r.metrics_file && (
                                  <a className="download-button download-button-secondary"
                                    href={`/api/download-metrics/${encodeURIComponent(r.metrics_file)}`}
                                    download={r.metrics_file}>
                                    ⬇ Download Metrics
                                  </a>
                                )}
                                {r.iteration_log_file && (
                                  <button className="download-button download-button-secondary"
                                    onClick={async () => {
                                      try {
                                        const res = await axios.get(`/api/run-history/${encodeURIComponent(r.output_file)}/iteration-log`);
                                        const blob = new Blob([JSON.stringify(res.data, null, 2)], {type:'application/json'});
                                        const url = URL.createObjectURL(blob);
                                        const a = document.createElement('a');
                                        a.href = url;
                                        a.download = r.iteration_log_file;
                                        a.click();
                                        URL.revokeObjectURL(url);
                                      } catch {}
                                    }}>
                                    ⬇ Download Iteration Trace
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  ))}
                </div>
              </div>
            )}{/* end results tab */}

            {/* ── EVALUATION TAB ── */}
            <div className="ext-ocel-tab-content" style={{display: externalTab === 'evaluation' ? undefined : 'none'}}>
              {!(resultsToBe||resultsAsIs||results) ? (
                <div className="discovery-section">
                  <div className="section-header"><h2>Evaluation</h2><p>Run a simulation first.</p></div>
                </div>
              ) : (
                <EvaluationWrapper
                  resultsAsIs={resultsAsIs}
                  resultsToBe={resultsToBe}
                  results={results}
                  discoveryResults={discoveryResults}
                  activeModel={activeModel}
                  modelBase={modelBase}
                  serviceTimeMode={serviceTimeMode}
                  simActivityObjectCounts={simActivityObjectCounts}
                  onConformanceSaved={() => axios.get('/api/run-history').then(r => setRunHistory(r.data.runs||[])).catch(()=>{})}
                  eventLogFiles={eventLogFiles}
                  handleFileUpload={handleFileUpload}
                  inputLogConfResults={logConfResults}
                  inputEventLogFile={discoveryConfig.eventLogFile}
                  evalRunCount={evalRunCount}
                  onRerunEvaluation={() => { setEvaluationReady(true); setEvalRunCount(c => c + 1); }}
                />
              )}
            </div>{/* end evaluation tab */}
          </div>
        )}{/* end external-ocel tabs */}

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
        {workflowMode !== 'external-ocel' && (
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
        )}{/* end Model Selection guard */}

        {/* ── Session History ── */}
        {sessionHistory.length > 0 && (
          <Collapsible title="🕘 Session History" badge={sessionHistory.length} defaultOpen={false}>
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
          </Collapsible>
        )}

        {/* ── Post-Processing section ── */}
        {workflowMode !== 'external-ocel' && (
        <>
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
                  mode={timingMode}
                  setMode={setTimingMode}
                  singleActivity={timingSingleAct}
                  setSingleActivity={setTimingSingleAct}
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

        </div>
        </>
        )}

        {/* ── Post-Processing Result section ── */}
        {workflowMode !== 'external-ocel' && (
        <div className="postprocessing-result-section">
          <div className="section-header">
            <h2>Post-Processing Result</h2>
            <p>Review the constraint health before running the simulation</p>
          </div>

          {isCheckingHealth && (
            <div style={{display:'flex',alignItems:'center',gap:'0.5rem',fontSize:'0.82rem',color:'#64748b',marginBottom:'0.5rem'}}>
              <div className="spinner spinner-sm"></div> Running health check…
            </div>
          )}

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
                {healthResult.cycles?.length > 0 && (
                  <div className="health-section health-error">
                    <div className="health-section-title">🔴 Dependency cycles (deadlock)</div>
                    {healthResult.cycles.map((cy, i) => (
                      <div key={i} className="health-item"><span className="health-badge-error">CYCLE</span>{cy.description}</div>
                    ))}
                  </div>
                )}
                {healthResult.permanently_blocked?.length > 0 && (
                  <div className="health-section health-error">
                    <div className="health-section-title">🔴 Activities never reaching the pool</div>
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
                  </div>
                )}
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
                const suggs = generateSuggestions(healthResult, activeModel, autoConfig, config.startActivities, logConfResults, dropZeroConfConstraints, logBoundsResults, setNmaxFromBounds);
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
        </div>
        )}

        {/* ── Run Simulation section ── */}
        {workflowMode !== 'external-ocel' && (
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
                <label>Max Events</label>
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
                  {config.maxSteps ? `events ${liveStepCount ?? 0} / ${config.maxSteps}` : `events ${liveStepCount ?? 0}`}
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
                  <div className="stat-grid">
                    <div className="stat-card">
                      <div className="stat-value">{results.steps_executed}</div>
                      <div className="stat-label">Events Completed</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-value">{totalEvents}</div>
                      <div className="stat-label">Events Completed</div>
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
                );
              })()}


              {/* ── Evaluation ── */}
              {(results.audit?.object_lifecycle_audit || results.audit?.activity_participation_audit) && (
                <Collapsible className="logs-box" title="📋 Evaluation" badge={null} defaultOpen={false}>

              {/* ── sim-coverage-warning ── */}
              {(() => {
                const _firedTypes = results.activity_sequence
                  ? [...new Set(results.activity_sequence)]
                  : (results.metrics?.activity_metrics ? Object.keys(results.metrics.activity_metrics) : []);
                const _discoveredTypes = discoveryResults?.activities || [];
                const missingTypes = _discoveredTypes.filter(a => !_firedTypes.includes(a));
                return missingTypes.length > 0 ? (
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
                ) : null;
              })()}

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
                    const allActs = [...new Set([...Object.keys(simMetrics), ...Object.keys(logCounts)])]
                      .sort(makeFlowRankSorter(discoveryResults, results?.object_traces));
                    const wmape = logTotal > 0 && simTotal > 0
                      ? allActs.reduce((s, act) => {
                          const sp = (simMetrics[act]?.execution_count||0) / simTotal * 100;
                          const lp = (logCounts[act]||0) / logTotal * 100;
                          return s + Math.abs(sp - lp);
                        }, 0)
                      : null;
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
                              <th title="Sim % minus Log % — positive means over-represented in simulation">Diff {wmape != null && <span style={{fontWeight:400,fontSize:'0.7rem',color: wmape < 10 ? '#16a34a' : wmape < 25 ? '#ca8a04' : wmape < 50 ? '#ea580c' : '#dc2626'}}>WMAPE {wmape.toFixed(1)}%</span>}</th>
                              <th title="Activity's total service time as % of total simulated time span">Time share</th>
                              <th title="Mean service time per firing in simulation">Sim mean dur</th>
                            </tr>
                          </thead>
                          <tbody>
                            {allActs.map(act => {
                              const simCount = simMetrics[act]?.execution_count ?? 0;
                              const logCount = logCounts[act] ?? 0;
                              const simPct = simTotal > 0 ? (simCount / simTotal * 100) : 0;
                              const logPct = logTotal > 0 ? (logCount / logTotal * 100) : 0;
                              const diff = simPct - logPct;
                              const meanS = simMetrics[act]?.mean_service_s ?? null;
                              const simSpan = results?.sim_time_s ?? null;
                              const timeShare = (meanS != null && simCount > 0 && simSpan)
                                ? (meanS * simCount / simSpan * 100) : null;
                              const fmtDur = s => { if (s==null) return '—'; if (s<60) return Math.round(s)+'s'; if (s<3600) return Math.floor(s/60)+'m'; if (s<86400) return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);return h>0?d+'d '+h+'h':d+'d'; };
                              const diffClass = Math.abs(diff) < 2 ? 'cmp-ok'
                                : diff > 0 ? 'cmp-over' : 'cmp-under';
                              return (
                                <tr key={act}>
                                  <td className="metrics-act-name">
                                    <ActivityConstraintTooltip activityName={act} constraints={activeModel?.constraints} />
                                  </td>
                                  <td>{simCount || '—'}</td>
                                  <td>{logCount || '—'}</td>
                                  <td>{simPct > 0 ? simPct.toFixed(1) + '%' : '—'}</td>
                                  <td>{logPct > 0 ? logPct.toFixed(1) + '%' : '—'}</td>
                                  <td className={`cmp-diff ${diffClass}`}>
                                    {simCount > 0 || logCount > 0 ? (diff >= 0 ? '+' : '') + diff.toFixed(1) + 'pp' : '—'}
                                  </td>
                                  <td className={timeShare != null && timeShare > 50 ? 'cmp-over' : ''}>{timeShare != null ? timeShare.toFixed(1)+'%' : '—'}</td>
                                  <td>{fmtDur(meanS)}</td>
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
                      {Object.entries(results.audit.activity_participation_audit)
                        .sort(([a],[b]) => makeFlowRankSorter(discoveryResults, results?.object_traces)(a,b))
                        .map(([act, a]) => (
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

                </Collapsible>
              )}{/* end Evaluation */}

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
                      {/* ── Time span comparison ── */}
                      {(() => {
                        const allTs = Object.values(results.metrics.activity_metrics)
                          .flatMap(m => m.timestamps || []).filter(Boolean).sort();
                        const simSpanS = allTs.length >= 2
                          ? (new Date(allTs[allTs.length-1]) - new Date(allTs[0])) / 1000 : null;
                        const ocelSpanS = discoveryResults?.ocel_time_span_s ?? null;
                        const fmtDur = s => {
                          if (s == null) return '—';
                          if (s < 3600) return `${Math.round(s/60)} min`;
                          if (s < 86400) return `${(s/3600).toFixed(1)} h`;
                          return `${(s/86400).toFixed(1)} days`;
                        };
                        if (simSpanS == null && ocelSpanS == null) return null;
                        const ratio = (simSpanS != null && ocelSpanS != null && ocelSpanS > 0)
                          ? (simSpanS / ocelSpanS) : null;
                        return (
                          <div className="timing-span-comparison">
                            <span className="timing-span-label">Time span</span>
                            <span className="timing-span-item">
                              <span className="timing-span-tag">Input OCEL</span>
                              <strong>{fmtDur(ocelSpanS)}</strong>
                            </span>
                            <span className="timing-span-sep">→</span>
                            <span className="timing-span-item">
                              <span className="timing-span-tag">Simulation</span>
                              <strong>{fmtDur(simSpanS)}</strong>
                            </span>
                            {ratio != null && (
                              <span className={`timing-span-ratio ${ratio > 1.5 || ratio < 0.5 ? 'timing-span-ratio-warn' : 'timing-span-ratio-ok'}`}>
                                {ratio.toFixed(2)}× input
                              </span>
                            )}
                          </div>
                        );
                      })()}
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
                            <th title="Sampled service duration at each firing">Mean service</th>
                            <th>Min service</th>
                            <th>Max service</th>
                            <th title="Pre-start process waiting time (DES only)">Mean process wait</th>
                            <th title="Longest pre-start process wait">Max process wait</th>
                            <th title="Service + process wait total">Mean sojourn</th>
                            <th title="Resource-contention wait (DES only)">Mean resource wait</th>
                            <th title="Mean wait in candidate pool (non-DES only)">Mean wait in pool</th>
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
                              <td>{fmtSeconds(m.mean_process_wait_s)}</td>
                              <td>{fmtSeconds(m.max_process_wait_s)}</td>
                              <td>{fmtSeconds(m.mean_sojourn_s)}</td>
                              <td>{fmtSeconds(m.mean_resource_wait_s)}</td>
                              <td>{fmtSeconds(m.mean_wait_in_pool_s)}</td>
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
                                  <th>Events Completed</th>
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

          {results?.iteration_log_file && (
            <div style={{marginTop:'0.5rem'}}>
              <button
                className="download-button download-button-secondary"
                onClick={async () => {
                  const runId = results.output_file;
                  const r = await axios.get(`/api/run-history/${encodeURIComponent(runId)}/iteration-log`);
                  const lines = (r.data.iteration_logs || []).map(e => JSON.stringify(e)).join('\n');
                  const blob = new Blob([lines], {type:'application/x-ndjson'});
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url; a.download = `iteration_${runId}.jsonl`;
                  document.body.appendChild(a); a.click();
                  document.body.removeChild(a); URL.revokeObjectURL(url);
                }}
              >
                ⬇ Download Iteration Trace
              </button>
              <span style={{fontSize:'0.72rem',color:'#94a3b8',marginLeft:'0.5rem'}}>
                JSONL — candidates, weights, chosen activity, timestamps
              </span>
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
        </div>
        )}

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
              Conformance scores appear after visiting the Evaluation tab for that run.
              Click a row to expand timing metrics; use ↩ Restore to reload its settings.
            </p>
            {(() => {
              const withConf    = runHistory.filter(r => r.conformance?.fitness != null);
              const withoutConf = runHistory.filter(r => r.conformance?.fitness == null);
              const pct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
              const confClass = v => v == null ? '' : v >= 0.8 ? 'conf-good' : v >= 0.5 ? 'conf-mid' : 'conf-bad';

              const RunTable = ({ runs, showConf }) => (
                <table className="run-history-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event log</th>
                      <th>Model</th>
                      <th>Steps</th>
                      <th>Events Completed</th>
                      <th>Objects</th>
                      <th>Seed</th>
                      <th title="Simulation wall-clock runtime">Runtime</th>
                      {showConf && <th className="audit-num rh-conf-col" title="Object-Replay Fitness">Fitness</th>}
                      {showConf && <th className="audit-num rh-conf-col" title="Declarative Constraint Fitness">Con. Fitness</th>}
                      {showConf && <th className="audit-num rh-conf-col" title="Declarative Precision">Precision</th>}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map(run => (
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
                          <td style={{fontVariantNumeric:'tabular-nums',fontSize:'0.78rem'}}>
                            {run.runtime_s != null ? (() => {
                              const s = run.runtime_s;
                              const m = Math.floor(s/60).toString().padStart(2,'0');
                              const sec = Math.floor(s%60).toString().padStart(2,'0');
                              return `${m}:${sec}`;
                            })() : '—'}
                          </td>
                          {showConf && (
                            <td className="audit-num rh-conf-col">
                              <span className={confClass(run.conformance?.fitness)}>{pct(run.conformance?.fitness)}</span>
                            </td>
                          )}
                          {showConf && (
                            <td className="audit-num rh-conf-col">
                              <span className={confClass(run.conformance?.constraint_fitness)}>{pct(run.conformance?.constraint_fitness)}</span>
                            </td>
                          )}
                          {showConf && (
                            <td className="audit-num rh-conf-col">
                              <span className={confClass(run.conformance?.precision)}>{pct(run.conformance?.precision)}</span>
                            </td>
                          )}
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
                            <td colSpan={showConf ? 12 : 9}>
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
              );

              return (
                <>
                  {withConf.length > 0 && <RunTable runs={withConf} showConf={true} />}
                  {withConf.length === 0 && withoutConf.length > 0 && (
                    <p style={{fontSize:'0.8rem',color:'#94a3b8',fontStyle:'italic',marginBottom:'0.5rem'}}>
                      No conformance scores yet — open a run in the Evaluation tab to compute them.
                    </p>
                  )}
                  {withoutConf.length > 0 && (
                    <Collapsible
                      className="rh-legacy-collapsible"
                      title={`Runs without conformance scores (${withoutConf.length})`}
                      defaultOpen={withConf.length === 0}
                    >
                      <RunTable runs={withoutConf} showConf={false} />
                    </Collapsible>
                  )}
                </>
              );
            })()}
          </Collapsible>
        </div>
      )}
    </div>
  </div>
  );
}

export default App;
