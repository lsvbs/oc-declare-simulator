import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import axios from 'axios';
import './App.css';
import FlowChart from './FlowChart';
import ModelEditor from './ModelEditor';
import { O2ODiagram, CONSTRAINT_HELP } from './ModelEditor';

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

// ── Scope formatter ───────────────────────────────────────────────────────────
// Returns "each manuscript" for single-type, "Each(editor,version), All(invitation)"
// for multi-type bindings.
// Normalise a constraint scope to [[object_type, involvement], ...].
// Discovered model JSON carries `involvement_per_label` (a dict); the engine's
// Scope dataclass carries `bindings` (pairs). Reading only `bindings` meant every
// multi-type constraint silently rendered as a single-type row, because the JSON
// the editor loads never has that key.
function scopeBindings(scope) {
  if (!scope) return [];
  if (Array.isArray(scope.bindings) && scope.bindings.length) return scope.bindings;
  const ipl = scope.involvement_per_label;
  if (ipl && typeof ipl === 'object') return Object.entries(ipl);
  if (scope.object_type) return [[scope.object_type, scope.kind || 'each']];
  return [];
}

function formatScope(scope) {
  if (!scope) return '';
  const bindings = scopeBindings(scope);
  if (bindings.length <= 1) {
    if (scope.kind && scope.object_type) return `${scope.kind} ${scope.object_type}`;
    return scope.object_type || scope.kind || '';
  }
  const groups = {};
  for (const [t, inv] of bindings) {
    (groups[inv] = groups[inv] || []).push(t);
  }
  return Object.entries(groups)
    .map(([inv, types]) => `${inv.charAt(0).toUpperCase() + inv.slice(1)}(${types.join(',')})`)
    .join(', ');
}

// ── ConstraintFlowGraph ───────────────────────────────────────────────────────
// Possible-routes graph derived purely from activities + constraints.
// Edges represent "A can directly precede B" based on precedence/response/succession
// constraints, after transitive reduction (A→C suppressed if A→B→C exists).
function ConstraintFlowGraph({ activities, constraints, startActivities, probMatrix }) {
  const [nodeOverrides, setNodeOverrides] = React.useState({});
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [svgTip, setSvgTip] = React.useState(null); // {text, x, y}
  const [containerW, setContainerW] = React.useState(800);
  const dragRef = React.useRef({ type: null });
  const svgRef = React.useRef(null);
  const wrapRef = React.useRef(null);
  const PAD = 44, R = 22, HGAP = 80;

  // Reset overrides when inputs change
  React.useEffect(() => { setNodeOverrides({}); setPan({ x: 0, y: 0 }); }, [activities, constraints]);

  // Track container width for dynamic HGAP
  React.useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width;
      if (w > 0) setContainerW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    // Vertical pitch between nodes in the same column — includes space for creates/deactivates labels
    const maxCreatesAny = Math.max(...nodes.map(n => actCreates[n]?.length || 0), 0);
    const maxDeactsAny  = Math.max(...nodes.map(n => actDeactivates[n]?.length || 0), 0);
    const labelExtra = (maxCreatesAny > 0 ? maxCreatesAny * 11 + 6 : 0) + (maxDeactsAny > 0 ? maxDeactsAny * 11 + 9 : 0);
    const pitch = R * 2 + labelExtra + Math.max(14, Math.round(120 / Math.max(maxColSize, 1)));
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
      const scopes = [...new Set(matching.map(c => {
        const b = c.scope?.bindings || [];
        return b.length > 1 ? b.map(([t]) => t).join(',') : (c.scope?.object_type || c.scope_object_type || null);
      }).filter(Boolean))];
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
    const dynamicHGAP = numRanks > 1
      ? Math.max(HGAP, Math.floor((containerW - 2 * (PAD + R) - 10) / (numRanks - 1)) - 2 * R)
      : HGAP;
    byRank.forEach((layer, r) => {
      const x = PAD + R + r * (R * 2 + dynamicHGAP);
      const spineNode = layer.find(n => spineSet.has(n)) || layer[0];
      const others = layer.filter(n => n !== spineNode);
      const above = [], below = [];
      others.forEach((n, i) => { if (i % 2 === 0) above.unshift(n); else below.push(n); });
      const ordered = [...above, spineNode, ...below];
      const spineIdx = ordered.indexOf(spineNode);
      ordered.forEach((n, i) => { pos[n] = { x, y: midY + (i - spineIdx) * pitch, rank: r }; });
    });

    // Shift up if any y < 0 — account for creates labels above nodes
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
  }, [activities, constraints, startActivities, containerW]);


  // Compute max probability across all edges for stroke-width scaling
  const maxProb = React.useMemo(() => {
    if (!probMatrix) return 1;
    let max = 0.001;
    edges.forEach(({ src, tgt }) => {
      const p = probMatrix[src]?.[tgt] || 0;
      if (p > max) max = p;
    });
    return max;
  }, [edges, probMatrix]);

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
  function svgCoord(e) {
    const svg = svgRef.current; if (!svg) return { x: e.clientX, y: e.clientY };
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const ctm = svg.getScreenCTM(); if (!ctm) return { x: e.clientX, y: e.clientY };
    return pt.matrixTransform(ctm.inverse());
  }
  function onNodeMouseDown(e, name) {
    e.stopPropagation();
    const { x, y } = getSVGPoint(e);
    const cur = effPos[name];
    dragRef.current = { type: 'node', name, startX: x, startY: y, origX: cur.x, origY: cur.y };
  }
  function onSVGMouseDown(e) {
    if (dragRef.current.type) return;
    const { x, y } = svgCoord(e);
    dragRef.current = { type: 'pan', startX: x, startY: y, origPanX: pan.x, origPanY: pan.y };
  }
  function onMouseMove(e) {
    const d = dragRef.current; if (!d.type) return;
    if (d.type === 'node') {
      const { x, y } = getSVGPoint(e);
      setNodeOverrides(prev => ({ ...prev, [d.name]: { x: d.origX + x - d.startX, y: d.origY + y - d.startY } }));
    } else {
      const { x, y } = svgCoord(e);
      setPan({ x: d.origPanX + x - d.startX, y: d.origPanY + y - d.startY });
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
    const spread = (idx - (total-1)/2) * 14;
    const ox = px*spread, oy = py*spread;
    const sx = s.x + ux*R + ox, sy = s.y + uy*R + oy;
    const ex = t.x - ux*R + ox, ey = t.y - uy*R + oy;
    let h = 0; for (let i = 0; i < (src+tgt).length; i++) h = (h * 31 + (src+tgt).charCodeAt(i)) & 0xffff;
    const pairBow = (h % 13) - 6;
    if (t.x < s.x || (t.x === s.x && (t.rank ?? 0) <= (s.rank ?? 0))) {
      const bow = 55 + Math.abs(s.y-t.y)*0.35 + Math.abs(s.x-t.x)*0.25;
      const dir = idx % 2 === 0 ? -1 : 1;
      return { d: `M ${sx} ${sy} C ${sx} ${sy+dir*bow} ${ex} ${ey+dir*bow} ${ex} ${ey}`,
               lx: (sx+ex)/2, ly: Math.min(sy,ey)-bow*0.55 };
    }
    const bendMag = Math.abs(dy)*0.18 + spread*0.4 + pairBow;
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
      <div ref={wrapRef} className="tfc-scroll" onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseUp}>
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
              // Probability-based stroke width (like OC-DFG) — 0.8 to 3.5px
              const prob = probMatrix ? (probMatrix[src]?.[tgt] || 0) : 0;
              const sw = probMatrix
                ? 0.8 + (prob / maxProb) * 2.7
                : 1.5;
              // Abbreviate scope: first letter of each type, joined
              const scopeLabels = scopes.map(s => s.split(/[,\s]+/).map(w => w[0].toUpperCase()).join(''));
              const lineH = 10;
              const maxW = Math.max(...scopeLabels.map(l => l.length * 6.4 + 4), 0);
              return (
                <g key={`${src}->${tgt}`}>
                  <path d={d} fill="none" stroke={col} strokeWidth={sw}
                    strokeDasharray={count === 1 ? '5,3' : undefined}
                    markerEnd={`url(#${markerId})`} />
                  {scopeLabels.length > 0 && (
                    <g>
                      <rect x={lx - maxW/2} y={ly - scopeLabels.length * lineH - 1}
                        width={maxW} height={scopeLabels.length * lineH + 2} rx={2} fill="white" opacity={0.88}
                        style={{cursor:'default'}}
                        onMouseEnter={e => setSvgTip({text:scopes.join(', '), x:e.clientX, y:e.clientY})}
                        onMouseMove={e => setSvgTip(t => t ? {...t, x:e.clientX, y:e.clientY} : t)}
                        onMouseLeave={() => setSvgTip(null)} />
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
                  {/* Opaque background mask — gaps any edge path that passes through this node */}
                  <circle cx={p.x} cy={p.y} r={isStart || isEnd ? R+7 : R+4} fill="#fafbff" />
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
                      <g key={'c'+i} style={{cursor:'default'}}
                        onMouseEnter={e => setSvgTip({text:`Creates: ${ot}`, x:e.clientX, y:e.clientY})}
                        onMouseMove={e => setSvgTip(t => t ? {...t, x:e.clientX, y:e.clientY} : t)}
                        onMouseLeave={() => setSvgTip(null)}>
                        <text x={p.x} y={yOff} textAnchor="middle" fontSize={7}
                          fill="#16a34a" fontWeight={700} style={{pointerEvents:'none',userSelect:'none'}}>+{abbr}</text>
                        <rect x={p.x-8} y={yOff-8} width={16} height={10} fill="transparent"/>
                      </g>
                    );
                  })}
                  {/* Deactivated object types — stacked below node */}
                  {(actDeactivates[name] || []).map((ot, i) => {
                    const abbr = ot.split(/\s+/).map(w => w[0].toUpperCase()).join('');
                    const yOff = p.y + R + 9 + i * 11;
                    return (
                      <g key={'d'+i} style={{cursor:'default'}}
                        onMouseEnter={e => setSvgTip({text:`Deactivates: ${ot}`, x:e.clientX, y:e.clientY})}
                        onMouseMove={e => setSvgTip(t => t ? {...t, x:e.clientX, y:e.clientY} : t)}
                        onMouseLeave={() => setSvgTip(null)}>
                        <text x={p.x} y={yOff} textAnchor="middle" fontSize={7}
                          fill="#dc2626" fontWeight={700} style={{pointerEvents:'none',userSelect:'none'}}>−{abbr}</text>
                        <rect x={p.x-8} y={yOff-8} width={16} height={10} fill="transparent"/>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      {svgTip && ReactDOM.createPortal(
        <div style={{position:'fixed',left:Math.min(svgTip.x+14,window.innerWidth-200),
          top:Math.max(svgTip.y-10,4),background:'#1e293b',color:'white',fontSize:'0.72rem',
          padding:'0.3rem 0.5rem',borderRadius:'5px',whiteSpace:'nowrap',zIndex:9999,
          lineHeight:1.4,pointerEvents:'none',boxShadow:'0 2px 8px rgba(0,0,0,0.25)'}}>
          {svgTip.text}
        </div>,
        document.body
      )}
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
                <span className={`constraint-type-badge ${c.constraint_type}`} style={{flexShrink:0,fontSize:'0.65rem'}} title={CONSTRAINT_HELP[c.constraint_type] || (c.constraint_type||'').replace(/_/g,' ')}>
                  {(c.constraint_type||'').replace(/_/g,' ')}
                </span>
                <span style={{color: c.source_activity === activityName ? '#1e293b' : '#94a3b8', fontWeight: c.source_activity === activityName ? 600 : 400}}>
                  {c.source_activity || '—'}
                </span>
                <span style={{color:'#94a3b8',fontSize:'0.7rem'}}>→</span>
                <span style={{color: c.target_activity === activityName ? '#1e293b' : '#94a3b8', fontWeight: c.target_activity === activityName ? 600 : 400}}>
                  {c.target_activity || '—'}
                </span>
                {(c.scope?.object_type || c.scope_object_type || (c.scope?.bindings?.length > 0)) && (
                  <span style={{color:'#64748b',fontSize:'0.65rem'}}>[{formatScope(c.scope) || c.scope_object_type}]</span>
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
function Collapsible({ title, badge, defaultOpen = false, className = '', children, preview, stickyContent }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <h4 className="collapsible-header" onClick={() => setOpen(o => !o)}>
        <span className="collapsible-caret">{open ? '▼' : '▶'}</span>
        <span className="collapsible-title">{title}</span>
        {badge != null && <span className="collapsible-badge">{badge}</span>}
      </h4>
      {stickyContent}
      {!open && preview}
      {open && (typeof children === 'function' ? children() : children)}
    </div>
  );
}

function InfoTip({ text }) {
  const [show, setShow] = React.useState(false);
  return (
    <span
      style={{position:'relative', display:'inline-block', marginLeft:'3px', cursor:'help', color:'#94a3b8', fontSize:'0.85em', lineHeight:1}}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      ⓘ
      {show && (
        <span style={{
          position:'absolute', bottom:'calc(100% + 5px)', left:'50%', transform:'translateX(-50%)',
          background:'#1e293b', color:'#f1f5f9', padding:'6px 9px', borderRadius:'6px',
          fontSize:'0.72rem', lineHeight:'1.45', width:'220px', zIndex:1000,
          pointerEvents:'none', whiteSpace:'normal', boxShadow:'0 4px 14px rgba(0,0,0,0.25)',
        }}>
          {text}
        </span>
      )}
    </span>
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
          {isResource && <span className="tracer-resource-badge" title="Immutable object — excluded from chain timing">immutable</span>}
          {!isResource && lifetime != null && (
            <span className="tracer-obj-lifetime" title="Service time: first to last event on this object">
              {_fmtChainTime(lifetime)}
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
                        {_fmtChainTime(ct.elapsedS)} elapsed
                      </span>
                    )}
                    {ct.totalServiceS != null && (
                      <span className="tracer-timing-chip tracer-timing-service" title="Total service time: sum of individual object lifetimes across the chain">
                        {_fmtChainTime(ct.totalServiceS)} service
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
        {isDiscovering ? 'Discovering…' : 'Discover Time Distributions'}
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

  return (
    <div className="workflow-topbar" ref={barRef}>
      <div className="topbar-files">
        <span className={`topbar-file-pill ${ocelFile ? 'loaded' : ''}`}>
          {ocelFile || 'No OCEL loaded'}
        </span>
        {workflowMode !== 'external-empty' && (
          <span className={`topbar-file-pill ${ocdeclFile ? 'loaded' : ''}`}>
            {ocdeclFile || 'No OC-Declare loaded'}
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

// ── normalizeModelOrientation ─────────────────────────────────────────────────
// Discovered models are stored in ARC orientation: `from` is the OC-DECLARE
// arc's source s and `to` its target t, exactly as the paper and the OCPQ
// converter write them. The engine reads `precedence` the other way round —
// "source must appear before target" — so EP/DP arcs have their endpoints
// swapped when they cross into engine-facing code.
//
// That swap used to happen inside discovery, which meant the file on disk
// carried arc_type: "EP" next to already-flipped activities and could not be
// compared to OCPQ without undoing it first. It now happens in the adapters:
// parse_ocdeclare_dict on the Python side, and this function here, so that the
// ~117 places in this file that read source_activity/target_activity keep
// working untouched.
//
// Applied once as a model enters state. The marker is dropped on the way out,
// so the normalised model can be POSTed back as modelOverride without the
// backend applying the swap a second time.
function normalizeModelOrientation(model) {
  if (!model || Array.isArray(model) || model.constraint_orientation !== 'arc') return model;

  const constraints = (model.constraints || []).map(c => {
    const arc = c.arc_type;
    const flip = arc === 'EP' || arc === 'DP';
    const source = flip ? c.to   : c.from;
    const target = flip ? c.from : c.to;

    // nmin gates on occurrences of the SOURCE activity, nmax bounds the TARGET,
    // so the endpoint-keyed observed_counts follow the same flip.
    const obs  = c.observed_counts || {};
    const from = obs.from || [null, null];
    const to   = obs.to   || [null, null];
    const [srcCounts, tgtCounts] = flip ? [to, from] : [from, to];

    return {
      ...c,
      source_activity: source, target_activity: target,
      source: source,          target: target,
      nmin: c.nmin != null ? c.nmin : (srcCounts[0] != null ? srcCounts[0] : 1),
      nmax: c.nmax != null ? c.nmax : (tgtCounts[1] != null ? tgtCounts[1] : null),
    };
  });

  const { constraint_orientation, ...rest } = model;
  return { ...rest, constraints };
}

// ── SimThroughputChart ────────────────────────────────────────────────────────
// Live wall-clock throughput of the running simulation: events produced per
// second and objects created per second (left axis, lines), against cumulative
// events (right axis, filled area). Samples come from the 1s status poll.
//
// Wall-clock, not simulated time — this answers "how fast is the simulator
// going", which is the question when a run is grinding. Simulated-time density
// (events per simulated day) is a different measure and lives in the results.
//
// Pure SVG, no chart library: three series over a few hundred points does not
// justify a dependency, and the surrounding app ships no charting runtime.
function SimThroughputChart({ samples }) {
  if (!samples || samples.length < 2) {
    return (
      <div className="tp-chart tp-chart--empty">
        <span className="tp-dev">[DEV]</span>
        Collecting throughput… (first points appear after ~2s)
      </div>
    );
  }

  const W = 560, H = 150;
  const P = { t: 10, r: 46, b: 20, l: 42 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;

  // Stride to at most ~240 drawn points so a long run stays cheap to render
  // and the line stays readable. The newest sample is always kept.
  const stride = Math.max(1, Math.ceil(samples.length / 240));
  const pts = samples.filter((_, i) => i % stride === 0 || i === samples.length - 1);

  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const span = Math.max(t1 - t0, 1e-6);
  const rateMax = Math.max(1, ...pts.map(p => Math.max(p.ev, p.ob)));
  const cumMax  = Math.max(1, ...pts.map(p => p.cum));

  const x    = p => P.l + ((p.t - t0) / span) * iw;
  const yR   = v => P.t + ih - (v / rateMax) * ih;   // left axis: rates
  const yC   = v => P.t + ih - (v / cumMax)  * ih;   // right axis: cumulative
  const line = (acc, sel) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${acc(sel(p)).toFixed(1)}`).join(' ');

  const areaPath =
    `M${x(pts[0]).toFixed(1)},${(P.t + ih).toFixed(1)} ` +
    pts.map(p => `L${x(p).toFixed(1)},${yC(p.cum).toFixed(1)}`).join(' ') +
    ` L${x(pts[pts.length - 1]).toFixed(1)},${(P.t + ih).toFixed(1)} Z`;

  const last = samples[samples.length - 1];
  const fmtRate = v => v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  const fmtDur  = s => s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}`;

  return (
    <div className="tp-chart">
      <div className="tp-dev">[DEV]</div>
      <div className="tp-legend">
        <span className="tp-key tp-key--ev"><i></i>events/s <b>{fmtRate(last.ev)}</b></span>
        <span className="tp-key tp-key--ob"><i></i>objects/s <b>{fmtRate(last.ob)}</b></span>
        <span className="tp-key tp-key--cum"><i></i>total events <b>{last.cum.toLocaleString()}</b></span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="tp-svg" role="img"
           aria-label={`Throughput: ${fmtRate(last.ev)} events per second, ${fmtRate(last.ob)} objects per second, ${last.cum} events total`}>
        {/* horizontal guides at 0 / 50% / 100% of the rate axis */}
        {[0, 0.5, 1].map(f => (
          <line key={f} className="tp-grid"
                x1={P.l} x2={P.l + iw} y1={yR(rateMax * f)} y2={yR(rateMax * f)} />
        ))}
        <path className="tp-area" d={areaPath} />
        <path className="tp-line tp-line--cum" d={line(yC, p => p.cum)} />
        <path className="tp-line tp-line--ob"  d={line(yR, p => p.ob)} />
        <path className="tp-line tp-line--ev"  d={line(yR, p => p.ev)} />

        {/* left axis — rate */}
        <text className="tp-tick" x={P.l - 6} y={yR(rateMax) + 4} textAnchor="end">{fmtRate(rateMax)}</text>
        <text className="tp-tick" x={P.l - 6} y={yR(0) + 4} textAnchor="end">0</text>
        {/* right axis — cumulative */}
        <text className="tp-tick tp-tick--cum" x={P.l + iw + 6} y={yC(cumMax) + 4}>{cumMax.toLocaleString()}</text>
        {/* x axis — elapsed wall time */}
        <text className="tp-tick" x={P.l} y={H - 6}>{fmtDur(t0)}</text>
        <text className="tp-tick" x={P.l + iw} y={H - 6} textAnchor="end">{fmtDur(t1)}</text>
      </svg>
    </div>
  );
}

// ── ObjectTimelines (#28) ─────────────────────────────────────────────────────
// Per-object lifecycle log from the run: every status change with its timestamp,
// the activity involved, and the resulting status. The idle gap between one
// activity completing and the next starting is shown explicitly — that gap is
// waiting time, and comparing it against the source log is how you see whether
// the simulation paces objects realistically.
function ObjectTimelines({ lifecycles, total }) {
  const [typeFilter, setTypeFilter] = React.useState('all');
  const [selected, setSelected] = React.useState(lifecycles[0]?.object_id ?? null);

  const types = React.useMemo(
    () => [...new Set(lifecycles.map(l => l.object_type))].sort(),
    [lifecycles]
  );
  const shown = React.useMemo(
    () => typeFilter === 'all' ? lifecycles : lifecycles.filter(l => l.object_type === typeFilter),
    [lifecycles, typeFilter]
  );
  const current = shown.find(l => l.object_id === selected) || shown[0] || null;

  const fmtTime = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  };
  const fmtDur = s => {
    if (s == null) return '';
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${(s / 60).toFixed(1)}m`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
  };

  // Rows with the elapsed time since the previous entry, so idle gaps are visible.
  const rows = React.useMemo(() => {
    if (!current) return [];
    let prev = null;
    return current.entries.map(e => {
      const t = e.timestamp ? new Date(e.timestamp).getTime() / 1000 : null;
      const delta = (t != null && prev != null) ? t - prev : null;
      if (t != null) prev = t;
      return { ...e, delta };
    });
  }, [current]);

  const totalIdle = rows.reduce(
    (acc, r, i) => acc + ((r.lastupdate === 'started' && i > 0 && r.delta) ? r.delta : 0), 0);
  const totalBusy = rows.reduce(
    (acc, r) => acc + ((r.lastupdate === 'completed' && r.delta) ? r.delta : 0), 0);

  const statusColor = s =>
    s === 'busy' ? '#0d6d78' : s === 'inactive' ? '#94a3b8' : '#b45309';

  return (
    <div className="object-timelines">
      <div className="object-timelines-controls">
        <label>
          Type&nbsp;
          <select value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setSelected(null); }}>
            <option value="all">All ({lifecycles.length})</option>
            {types.map(t => (
              <option key={t} value={t}>
                {t} ({lifecycles.filter(l => l.object_type === t).length})
              </option>
            ))}
          </select>
        </label>
        <label>
          Object&nbsp;
          <select value={current?.object_id ?? ''} onChange={e => setSelected(e.target.value)}>
            {shown.map(l => (
              <option key={l.object_id} value={l.object_id}>
                {l.object_id} — {l.entries.length} change{l.entries.length !== 1 ? 's' : ''}
                {l.active ? '' : ' · deactivated'}
              </option>
            ))}
          </select>
        </label>
        {total > lifecycles.length && (
          <span className="object-timelines-note">
            showing the {lifecycles.length} most active of {total} objects
          </span>
        )}
      </div>

      {current ? (
        <>
          <div className="object-timelines-summary">
            <span><strong>{current.object_id}</strong> · {current.object_type}</span>
            <span>{current.active ? 'active' : 'deactivated'}</span>
            <span>in activities: <strong>{fmtDur(totalBusy)}</strong></span>
            <span>idle between activities: <strong>{fmtDur(totalIdle)}</strong></span>
          </div>
          <div className="object-timelines-scroll">
            <table className="object-timelines-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Since previous</th>
                  <th>Update</th>
                  <th>Activity</th>
                  <th>Status after</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="ot-mono">{fmtTime(r.timestamp)}</td>
                    <td className="ot-mono ot-delta">
                      {r.delta != null && r.delta > 0 ? `+${fmtDur(r.delta)}` : ''}
                      {r.lastupdate === 'started' && r.delta > 0 && (
                        <span className="ot-idle-tag" title="Object was idle for this long before the activity started">idle</span>
                      )}
                    </td>
                    <td>{r.lastupdate}</td>
                    <td>{r.activity || '—'}</td>
                    <td>
                      <span className="ot-status" style={{ color: statusColor(r.status) }}>
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="object-timelines-note">No objects of this type in the captured sample.</p>
      )}
    </div>
  );
}

// ── ObjectLifecycleWarning ────────────────────────────────────────────────────
// Blocking warning for object types missing a creates and/or deactivates
// binding. Rendered wherever the user can act on it: the Model Editor (where
// the fix is made) and the Results section (next to the disabled Run button).
function ObjectLifecycleWarning({ issues, compact }) {
  if (!issues || issues.length === 0) return null;
  const noCreate     = issues.filter(i => i.missingCreate && !i.missingDeactivate);
  const noDeactivate = issues.filter(i => i.missingDeactivate && !i.missingCreate);
  const neither      = issues.filter(i => i.missingCreate && i.missingDeactivate);
  const names = list => list.map(i => i.type).join(', ');
  return (
    <div className="object-lifecycle-warning">
      <div className="object-lifecycle-warning-title">
        ⚠ Simulation blocked — incomplete object lifecycle
      </div>
      {neither.length > 0 && (
        <div className="object-lifecycle-warning-group">
          <strong>{names(neither)}</strong> — no activity creates or deactivates {neither.length === 1 ? 'it' : 'them'}.
        </div>
      )}
      {noCreate.length > 0 && (
        <div className="object-lifecycle-warning-group">
          <strong>{names(noCreate)}</strong> — no activity has <code>creates: true</code>.
          Objects of {noCreate.length === 1 ? 'this type' : 'these types'} are never instantiated,
          so every activity requiring {noCreate.length === 1 ? 'it' : 'them'} can never fire.
        </div>
      )}
      {noDeactivate.length > 0 && (
        <div className="object-lifecycle-warning-group">
          <strong>{names(noDeactivate)}</strong> — no activity has <code>deactivates: true</code>.
          Objects of {noDeactivate.length === 1 ? 'this type' : 'these types'} never leave the active
          set: they accumulate for the whole run, and once the work-in-progress cap is reached the
          activity creating {noDeactivate.length === 1 ? 'it' : 'them'} is locked out, which cascades
          upstream and can starve the start activities.
        </div>
      )}
      {!compact && (
        <p className="object-lifecycle-warning-hint">
          Fix in Model Editor → Activities: set <code>creates</code> on the binding that first
          produces the object, and <code>deactivates</code> on the binding of the activity that
          finishes with it.
        </p>
      )}
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

  const RichTip = ({ tip, children }) => {
    const [pos, setPos] = React.useState(null);
    return (
      <span style={{cursor:'help'}}
        onMouseEnter={e => setPos({x:e.clientX,y:e.clientY})}
        onMouseMove={e => setPos({x:e.clientX,y:e.clientY})}
        onMouseLeave={() => setPos(null)}>
        {children}
        {pos && ReactDOM.createPortal(
          <div style={{position:'fixed',left:Math.min(pos.x+12,window.innerWidth-310),
            top:Math.max(pos.y-10,4),background:'#1e293b',color:'white',fontSize:'0.72rem',
            padding:'0.5rem 0.65rem',borderRadius:'6px',maxWidth:'300px',
            zIndex:9999,lineHeight:1.5,pointerEvents:'none',boxShadow:'0 2px 12px rgba(0,0,0,0.3)'}}>
            {tip}
          </div>,
          document.body
        )}
      </span>
    );
  };

  const MetricLine = ({ label, value, tip }) => (
    <div style={{display:'flex',alignItems:'center',gap:'0.5rem',padding:'0.32rem 0.1rem',borderBottom:'1px solid #f1f5f9'}}>
      <RichTip tip={tip}>
        <span style={{fontSize:'0.83rem',fontWeight:600,color:'#1e293b',flex:1}}>{label}</span>
      </RichTip>
      <RichTip tip={tip}>
        <span className={cls(value)} style={{fontSize:'0.97rem',fontWeight:700,minWidth:'52px',textAlign:'right'}}>
          {pct(value)}
        </span>
      </RichTip>
    </div>
  );

  // Helper to render one conformance column
  const ConfColumn = ({ label, ocdC, fitC, hasLog }) => (
    <div className="conf-col">
      <div className="conf-col-header">{label}</div>

      {!ocdC && !hasLog && <p style={{fontSize:'0.78rem',color:'#94a3b8',fontStyle:'italic'}}>Loading…</p>}
      {ocdC && (
        <MetricLine label="OC-Declare Confidence" value={ocdC.globalConformance}
          tip={<>
            <div>{ocdC.globalSatisfied} of {ocdC.totalEvents} events satisfy all constraints.</div>
            <div style={{marginTop:'0.35rem',color:'#a5b4fc',fontWeight:600}}>Formula</div>
            <div style={{color:'#cbd5e1'}}>events satisfying all constraints ÷ total events</div>
            <div style={{marginTop:'0.2rem',color:'#94a3b8',fontSize:'0.68rem'}}>Per constraint: satisfied source events ÷ total source events (Def 8)</div>
          </>}
        />
      )}
      {fitC ? (
        <>
          <MetricLine label="Fitness" value={fitC.fitness}
            tip={<>
              <div>{fitC.fitnessEnabled ?? '—'} of {fitC.fitnessTotal ?? '—'} events were enabled across all objects.</div>
              <div style={{marginTop:'0.35rem',color:'#a5b4fc',fontWeight:600}}>Formula</div>
              <div style={{color:'#cbd5e1'}}>enabled events ÷ total events</div>
              <div style={{marginTop:'0.2rem',color:'#94a3b8',fontSize:'0.68rem'}}>Enabled = all precedence constraints satisfied at this point (source_count ≥ nmin)</div>
            </>}
          />
          <MetricLine label="Precision" value={fitC.precision}
            tip={<>
              <div>{fitC.precisionAllowed ?? '—'} of {fitC.precisionTotal ?? '—'} transitions were in the allowed set.</div>
              <div style={{marginTop:'0.35rem',color:'#a5b4fc',fontWeight:600}}>Formula</div>
              <div style={{color:'#cbd5e1'}}>transitions where next activity ∈ allowed set ÷ total observed transitions</div>
              <div style={{marginTop:'0.2rem',color:'#94a3b8',fontSize:'0.68rem'}}>Allowed set = activities not blocked by any active precedence / not_coexistence / not_succession constraint</div>
            </>}
          />
        </>
      ) : (
        <p style={{fontSize:'0.78rem',color:'#94a3b8',fontStyle:'italic'}}>No object traces available.</p>
      )}
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
              <button className="browse-btn" onClick={() => fileInputRef.current?.click()} title="Browse and upload">…</button>
              <input ref={fileInputRef} type="file" accept=".json,.jsonocel,.xml,.csv" style={{display:'none'}}
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
                  <th title="Object instance ID — click to sort alphabetically" style={{minWidth:'120px',position:'sticky',left:0,background:'white',zIndex:1}}>
                    <button style={{background:'none',border:'none',cursor:'pointer',fontWeight:600,color:'#475569',fontSize:'0.72rem'}}
                      onClick={() => setSortBy('id')}>
                      Object {sortBy==='id' ? '▼' : ''}
                    </button>
                  </th>
                  <th title="Object type as defined in the model" style={{minWidth:'80px',color:'#94a3b8'}}>Type</th>
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
                <thead><tr><th title="The declarative constraint (type, source, target)">Constraint</th><th title="Why this constraint is considered vacuous — e.g. source activity never fired">Reason</th></tr></thead>
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

// ── ActivityTimeMatrix — activity × object-type timing matrix ─────────────────
function ActivityTimeMatrix({ activityMetrics, activeModel, discoveryResults, objectTraces }) {
  const [mode, setMode] = React.useState('mean');
  const allOts = (activeModel?.object_types || []).map(t => typeof t === 'string' ? t : t.name);
  const acts = Object.keys(activityMetrics).sort(makeFlowRankSorter(discoveryResults, objectTraces));
  const actOts = {};
  (activeModel?.activities || []).forEach(a => {
    actOts[a.name] = new Set((a.bindings || []).map(b => b.object_type));
  });
  const fmt = s => { if (s==null) return '—'; if (s<60) return (Math.abs(s%1)<0.005?Math.round(s):s.toFixed(1))+'s'; if (s<3600) return Math.floor(s/60)+'m '+Math.floor(s%60)+'s'; if (s<86400) return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);return h>0?d+'d '+h+'h':d+'d'; };
  const getVal = m => mode==='mean' ? m.mean_service_s : mode==='min' ? m.min_service_s : m.max_service_s;
  if (!allOts.length || !acts.length) return null;
  return (
    <div style={{marginTop:'1rem'}}>
      <div style={{display:'flex',gap:'0.4rem',alignItems:'center',marginBottom:'0.5rem'}}>
        <span style={{fontSize:'0.75rem',fontWeight:600,color:'#475569'}}>Time per Activity × Object Type</span>
        {['mean','min','max'].map(m => (
          <button key={m} onClick={() => setMode(m)}
            style={{fontSize:'0.72rem',padding:'2px 10px',borderRadius:'20px',
              border: '1.5px solid ' + (mode===m ? '#1e293b' : '#e2e8f0'),
              background: mode===m ? '#1e293b' : 'white',
              color: mode===m ? 'white' : '#64748b',
              cursor:'pointer', fontWeight: mode===m ? 600 : 400}}>
            {m}
          </button>
        ))}
      </div>
      <div style={{overflowX:'auto',border:'1.5px solid #1e293b',borderRadius:'6px'}}>
        <table className="behavior-table" style={{fontSize:'0.75rem'}}>
          <thead>
            <tr>
              <th style={{textAlign:'left'}}>Activity</th>
              {allOts.map(ot => (
                <th key={ot} style={{textAlign:'center',verticalAlign:'bottom',height:'80px',padding:'0 6px',whiteSpace:'nowrap'}}>
                  <div style={{writingMode:'vertical-rl',transform:'rotate(180deg)',display:'inline-block',fontSize:'0.72rem',fontWeight:600,lineHeight:1.1}}>{ot}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {acts.map(act => {
              const m = activityMetrics[act];
              const val = fmt(getVal(m));
              const bound = actOts[act] || new Set();
              return (
                <tr key={act}>
                  <td style={{fontWeight:500,whiteSpace:'nowrap'}}>{act}</td>
                  {allOts.map(ot => (
                    <td key={ot} style={{textAlign:'center',
                      background: bound.has(ot) ? '#f0fdf4' : undefined,
                      color: bound.has(ot) ? '#15803d' : '#cbd5e1',
                      fontWeight: bound.has(ot) ? 600 : 400}}>
                      {bound.has(ot) ? val : '—'}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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

  return {
    cov_act:        { value: cov_act,        fired: firedModelActs.length, total: modelActSet.size },
    cov_ot:         { value: cov_ot,         fired: firedOts.length,        total: modelOtSet.size },
    cov_activation: { value: cov_activation, fired: constraintsWithSource.length, total: constraints.length, median: medianSrc },
    cov_inv:        { value: cov_inv,         tested: invTestable, total: invTotal },
    cov_min:        { value: cov_min,         dist: minDistinguishable, total: minTotal },
    cov_max:        { value: cov_max,         reached: maxReached, total: finiteMax.length },
    cov_neg:        { value: cov_neg,         nonTrivial: negNonTrivial, total: negConstraints.length },
    cov_arrow:      { value: cov_arrow,       dist: arrowDist, total: weakArrow.length },
  };
}

function OCCoveragePanel({ results, model, discoveryResults, logResults }) {
  const cov = React.useMemo(
    () => computeOCCoverage(results, model, discoveryResults),
    [results, model, discoveryResults]
  );
  const logCov = React.useMemo(
    () => logResults ? computeOCCoverage(logResults, model, discoveryResults) : null,
    [logResults, model, discoveryResults]
  );
  if (!cov) return <div style={{color:'#94a3b8',fontSize:'0.82rem'}}>Run a simulation to compute coverage.</div>;

  const fmt   = v => v == null ? 'N/A' : (v*100).toFixed(1)+'%';
  const color = v => v == null ? '#94a3b8' : v >= 0.9 ? '#16a34a' : v >= 0.6 ? '#d97706' : '#dc2626';

  const scoreBar = (simVal, logVal) => {
    const sp = simVal == null ? 0 : Math.max(0, Math.min(100, simVal * 100));
    const lp = logVal == null ? 0 : Math.max(0, Math.min(100, logVal * 100));
    const c  = color(simVal);
    return (
      <div style={{minWidth:'85px'}}>
        <div style={{display:'flex', gap:'0.3rem', alignItems:'baseline', marginBottom:'2px'}}>
          <span style={{fontSize:'0.72rem', fontWeight:700, color:c}}>{fmt(simVal)}</span>
          {logVal != null && <span style={{fontSize:'0.63rem', color:'#94a3b8'}}>{fmt(logVal)}</span>}
        </div>
        <div style={{position:'relative', height:'5px', borderRadius:'3px', background:'#f1f5f9', overflow:'hidden'}}>
          {logVal != null && (
            <div style={{position:'absolute', left:0, top:0, height:'100%', width:`${lp}%`, background:'#cbd5e1'}}/>
          )}
          <div style={{position:'absolute', left:0, top:0, height:'100%', width:`${sp}%`, background:c, opacity:0.88}}/>
        </div>
      </div>
    );
  };

  // ── Radar axes (5 dimensions — Jalali C.E/C.A/C.I/C.C/C.R) ─────────────────
  // C.E = mean(cov_act, cov_ot)   — element coverage
  // C.C = mean(cov_min, cov_max, cov_neg) — count/cardinality coverage
  const ceVal = (() => {
    const vals = [cov.cov_act.value, cov.cov_ot.value].filter(v => v != null);
    return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  })();
  const cardVal = (() => {
    const vals = [cov.cov_min.value, cov.cov_max.value, cov.cov_neg.value].filter(v => v != null);
    return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  })();

  const axes = [
    { key: 'C.E', label: 'Element\nCoverage',    value: ceVal },
    { key: 'C.A', label: 'Activation\nCoverage', value: cov.cov_activation.value },
    { key: 'C.I', label: 'Involvement\nCoverage',value: cov.cov_inv.value },
    { key: 'C.C', label: 'Count\nCoverage',       value: cardVal },
    { key: 'C.R', label: 'Arrow\nCoverage',       value: cov.cov_arrow.value },
  ];

  // ── Pure-SVG spider/radar chart (no external lib) ────────────────────────
  const CX = 160, CY = 155, R = 110;
  const N = axes.length;
  const angleOf = i => (Math.PI * 2 * i) / N - Math.PI / 2;

  const spoke = (i, r) => ({
    x: CX + r * Math.cos(angleOf(i)),
    y: CY + r * Math.sin(angleOf(i)),
  });

  const ringLevels = [0.25, 0.5, 0.75, 1.0];
  const ringColor  = ['#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8'];

  const dataPoints = axes.map((ax, i) => spoke(i, R * Math.max(0, ax.value ?? 0)));
  const dataPath   = dataPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';

  // Log reference polygon
  const logPath = logCov ? (() => {
    const lce   = (() => { const vs=[logCov.cov_act.value,logCov.cov_ot.value].filter(v=>v!=null); return vs.length?vs.reduce((s,v)=>s+v,0)/vs.length:null; })();
    const lcard = (() => { const vs=[logCov.cov_min.value,logCov.cov_max.value,logCov.cov_neg.value].filter(v=>v!=null); return vs.length?vs.reduce((s,v)=>s+v,0)/vs.length:null; })();
    const lvals = [lce, logCov.cov_activation.value, logCov.cov_inv.value, lcard, logCov.cov_arrow.value];
    const lpts  = lvals.map((v, i) => spoke(i, R * Math.max(0, v ?? 0)));
    return lpts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';
  })() : null;

  const radarColor = v => v == null ? '#94a3b8' : v >= 0.9 ? '#16a34a' : v >= 0.6 ? '#d97706' : '#dc2626';
  const overallVal = axes.filter(a => a.value != null).reduce((s, a) => s + a.value, 0) /
                     Math.max(1, axes.filter(a => a.value != null).length);

  return (
    <div>
      {/* ── Citation banner — commented out for now ──
      <div style={{fontSize:'0.68rem',color:'#64748b',background:'#f8fafc',border:'1px solid #e2e8f0',
                   borderRadius:'6px',padding:'0.4rem 0.75rem',marginBottom:'0.75rem',lineHeight:'1.6'}}>
        <strong>Radar chart axes</strong> — visualization form inspired by Pourshahid &amp; Amyot,
        <em> "A Systematic Review and Assessment of Aspect-Oriented Methods Applied to Business Process
        Adaptation"</em>, JSoftware 2012 (pentagon scoring 0–4 per capability axis). Axes content from
        Küsters &amp; van der Aalst, <em>"OCPQ: Object-Centric Process Querying &amp; Constraints"</em>,
        RCIS 2025 (coverage, selectivity, reach) and the DeCo simulation log (activity/object-type
        participation, constraint activation, involvement testability, cardinality bounds,
        arrow discriminability). Details in the table below.
      </div>
      ── end citation ── */}

      {/* ── Radar + legend row ── */}
      <div style={{display:'flex',gap:'1.5rem',alignItems:'flex-start',flexWrap:'wrap',marginBottom:'1rem'}}>
        {/* Radar SVG */}
        <svg width={320} height={310} style={{flexShrink:0,overflow:'visible'}}>
          {/* Ring grid */}
          {ringLevels.map((lvl, li) => {
            const pts = axes.map((_, i) => spoke(i, R * lvl));
            const d = pts.map((p, i) => `${i===0?'M':'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';
            return (
              <g key={li}>
                <path d={d} fill="none" stroke={ringColor[li]} strokeWidth={li === 3 ? 1.5 : 1}/>
                <text x={CX + 3} y={CY - R * lvl - 2} fontSize="8" fill="#94a3b8">{(lvl*100).toFixed(0)}%</text>
              </g>
            );
          })}
          {/* Spokes */}
          {axes.map((_, i) => {
            const tip = spoke(i, R);
            return <line key={i} x1={CX} y1={CY} x2={tip.x.toFixed(1)} y2={tip.y.toFixed(1)}
                         stroke="#e2e8f0" strokeWidth={1}/>;
          })}
          {/* Log reference polygon (drawn behind sim) */}
          {logPath && <path d={logPath} fill="#94a3b820" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 2"/>}
          {/* Data polygon */}
          <path d={dataPath} fill={`${radarColor(overallVal)}22`} stroke={radarColor(overallVal)} strokeWidth={2}/>
          {/* Data points */}
          {dataPoints.map((p, i) => (
            <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={4}
                    fill={radarColor(axes[i].value)} stroke="white" strokeWidth={1.5}>
              <title>{axes[i].label.replace('\n',' ')}: {fmt(axes[i].value)}</title>
            </circle>
          ))}
          {/* Axis labels — split on \n, offset outward */}
          {axes.map((ax, i) => {
            const tip  = spoke(i, R + 22);
            const lines = ax.label.split('\n');
            const anchor = tip.x < CX - 5 ? 'end' : tip.x > CX + 5 ? 'start' : 'middle';
            return (
              <text key={i} x={tip.x.toFixed(1)} y={(tip.y - (lines.length - 1) * 7).toFixed(1)}
                    textAnchor={anchor} fontSize="9.5" fontWeight="600" fill="#475569">
                {lines.map((l, li) => (
                  <tspan key={li} x={tip.x.toFixed(1)} dy={li === 0 ? 0 : 13}>{l}</tspan>
                ))}
              </text>
            );
          })}
          {/* Overall score badge */}
          <circle cx={CX} cy={CY} r={22} fill="white" stroke={radarColor(overallVal)} strokeWidth={2}/>
          <text x={CX} y={CY - 5} textAnchor="middle" fontSize="11" fontWeight="700"
                fill={radarColor(overallVal)}>{(overallVal*100).toFixed(0)}%</text>
          <text x={CX} y={CY + 9} textAnchor="middle" fontSize="8" fill="#64748b">overall</text>
        </svg>

        {/* Mini legend */}
        <div style={{display:'flex',flexDirection:'column',gap:'0.35rem',paddingTop:'0.25rem'}}>
          {axes.map((ax, i) => (
            <div key={i} style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
              <div style={{width:10,height:10,borderRadius:'50%',flexShrink:0,
                           background: radarColor(ax.value)}}/>
              <span style={{fontSize:'0.72rem',color:'#475569',fontWeight:600,whiteSpace:'nowrap'}}>
                {ax.label.replace('\n',' ')}
              </span>
              <span style={{fontSize:'0.72rem',fontWeight:700,color:radarColor(ax.value),marginLeft:'auto',paddingLeft:'0.5rem'}}>
                {fmt(ax.value)}
              </span>
            </div>
          ))}
          <div style={{marginTop:'0.5rem',fontSize:'0.68rem',color:'#94a3b8',lineHeight:'1.5'}}>
            <span style={{color:'#16a34a',fontWeight:700}}>●</span> ≥90% &nbsp;
            <span style={{color:'#d97706',fontWeight:700}}>●</span> ≥60% &nbsp;
            <span style={{color:'#dc2626',fontWeight:700}}>●</span> &lt;60%
          </div>
          {logPath && (
            <div style={{marginTop:'0.5rem',display:'flex',gap:'0.75rem',fontSize:'0.68rem',color:'#64748b'}}>
              <span style={{display:'flex',alignItems:'center',gap:'0.25rem'}}>
                <svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={radarColor(overallVal)} strokeWidth="2"/></svg>
                Simulation
              </span>
              <span style={{display:'flex',alignItems:'center',gap:'0.25rem'}}>
                <svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="4 2"/></svg>
                Input log
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Detail table ── */}
      <p style={{fontSize:'0.72rem',color:'#64748b',marginBottom:'0.5rem'}}>
        Full detail — Green ≥90%, amber ≥60%, red &lt;60%.
        Axis scores: C.E = mean(act, ot) · C.C = mean(nmin, nmax, neg).
        {logCov && <> · Coloured bar = simulation · <span style={{color:'#94a3b8'}}>grey bar</span> = input log.</>}
      </p>
      <table className="behavior-table" style={{fontSize:'0.78rem'}}>
        <thead><tr>
          <th title="Jalali axis this measure contributes to" style={{width:'52px'}}>Axis</th>
          <th title="Name of the coverage or quality measure">Measure</th>
          <th title="Computed score for this measure (0–1 or %). Coloured bar = simulation; grey bar = input log (when available)." style={{width:'100px',textAlign:'left'}}>Score</th>
          <th title="What a high or low score means for simulation quality">What it indicates</th>
          <th title="Raw counts or values behind the score">Detail</th>
        </tr></thead>
        <tbody>
          {/* C.E — Element Coverage */}
          <tr><td colSpan={5} style={{background:'#f1f5f9',fontWeight:700,fontSize:'0.7rem',color:'#475569',padding:'0.25rem 0.5rem',letterSpacing:'0.03em'}}>
            C.E — Element Coverage &nbsp;<span style={{fontWeight:400,color:'#94a3b8'}}>axis score: {fmt(ceVal)}</span>
          </td></tr>
          <tr>
            <td style={{color:'#94a3b8',fontSize:'0.7rem',fontStyle:'italic'}}>C.E</td>
            <td style={{fontWeight:600,whiteSpace:'nowrap'}}>Activity coverage</td>
            <td style={{padding:'0.3rem 0.4rem'}}>{scoreBar(cov.cov_act.value, logCov?.cov_act.value)}</td>
            <td style={{color:'#475569',fontSize:'0.72rem'}}>Fraction of model activities that appeared in sim output</td>
            <td style={{color:'#94a3b8',fontSize:'0.7rem'}}>{cov.cov_act.fired}/{cov.cov_act.total} activities fired</td>
          </tr>
          <tr>
            <td style={{color:'#94a3b8',fontSize:'0.7rem',fontStyle:'italic'}}>C.E</td>
            <td style={{fontWeight:600,whiteSpace:'nowrap'}}>Object type coverage</td>
            <td style={{padding:'0.3rem 0.4rem'}}>{scoreBar(cov.cov_ot.value, logCov?.cov_ot.value)}</td>
            <td style={{color:'#475569',fontSize:'0.72rem'}}>Fraction of model object types instantiated</td>
            <td style={{color:'#94a3b8',fontSize:'0.7rem'}}>{cov.cov_ot.fired}/{cov.cov_ot.total} types seen</td>
          </tr>
          {/* C.A — Activation Coverage */}
          <tr><td colSpan={5} style={{background:'#f1f5f9',fontWeight:700,fontSize:'0.7rem',color:'#475569',padding:'0.25rem 0.5rem',letterSpacing:'0.03em'}}>
            C.A — Activation Coverage &nbsp;<span style={{fontWeight:400,color:'#94a3b8'}}>axis score: {fmt(cov.cov_activation.value)}</span>
          </td></tr>
          <tr>
            <td style={{color:'#94a3b8',fontSize:'0.7rem',fontStyle:'italic'}}>C.A</td>
            <td style={{fontWeight:600,whiteSpace:'nowrap'}}>Constraint activation</td>
            <td style={{padding:'0.3rem 0.4rem'}}>{scoreBar(cov.cov_activation.value, logCov?.cov_activation.value)}</td>
            <td style={{color:'#475569',fontSize:'0.72rem'}}>Fraction of constraints with ≥1 source event (non-vacuous)</td>
            <td style={{color:'#94a3b8',fontSize:'0.7rem'}}>{cov.cov_activation.fired}/{cov.cov_activation.total} non-vacuous, median src events: {cov.cov_activation.median??'—'}</td>
          </tr>
          {/* C.I — Involvement Coverage */}
          <tr><td colSpan={5} style={{background:'#f1f5f9',fontWeight:700,fontSize:'0.7rem',color:'#475569',padding:'0.25rem 0.5rem',letterSpacing:'0.03em'}}>
            C.I — Involvement Coverage &nbsp;<span style={{fontWeight:400,color:'#94a3b8'}}>axis score: {fmt(cov.cov_inv.value)}</span>
          </td></tr>
          <tr>
            <td style={{color:'#94a3b8',fontSize:'0.7rem',fontStyle:'italic'}}>C.I</td>
            <td style={{fontWeight:600,whiteSpace:'nowrap'}}>Involvement testability</td>
            <td style={{padding:'0.3rem 0.4rem'}}>{scoreBar(cov.cov_inv.value, logCov?.cov_inv.value)}</td>
            <td style={{color:'#475569',fontSize:'0.72rem'}}>Fraction of (constraint, obj_type) pairs where |obj^ot(e)|≥2 — distinguishes Each/All/Any</td>
            <td style={{color:'#94a3b8',fontSize:'0.7rem'}}>{cov.cov_inv.tested}/{cov.cov_inv.total} pairs testable</td>
          </tr>
          {/* C.C — Count Coverage */}
          <tr><td colSpan={5} style={{background:'#f1f5f9',fontWeight:700,fontSize:'0.7rem',color:'#475569',padding:'0.25rem 0.5rem',letterSpacing:'0.03em'}}>
            C.C — Count Coverage &nbsp;<span style={{fontWeight:400,color:'#94a3b8'}}>axis score: {fmt(cardVal)}</span>
          </td></tr>
          <tr>
            <td style={{color:'#94a3b8',fontSize:'0.7rem',fontStyle:'italic'}}>C.C</td>
            <td style={{fontWeight:600,whiteSpace:'nowrap'}}>nmin discriminability</td>
            <td style={{padding:'0.3rem 0.4rem'}}>{scoreBar(cov.cov_min.value, logCov?.cov_min.value)}</td>
            <td style={{color:'#475569',fontSize:'0.72rem'}}>Fraction of constraints where cascade count &gt; nmin — tighter bound distinguishable</td>
            <td style={{color:'#94a3b8',fontSize:'0.7rem'}}>{cov.cov_min.dist}/{cov.cov_min.total} constraints</td>
          </tr>
          <tr>
            <td style={{color:'#94a3b8',fontSize:'0.7rem',fontStyle:'italic'}}>C.C</td>
            <td style={{fontWeight:600,whiteSpace:'nowrap'}}>nmax reachability</td>
            <td style={{padding:'0.3rem 0.4rem'}}>{scoreBar(cov.cov_max.value, logCov?.cov_max.value)}</td>
            <td style={{color:'#475569',fontSize:'0.72rem'}}>Fraction of finite-nmax constraints where the max was actually reached</td>
            <td style={{color:'#94a3b8',fontSize:'0.7rem'}}>{cov.cov_max.reached}/{cov.cov_max.total} constraints (finite nmax only)</td>
          </tr>
          <tr>
            <td style={{color:'#94a3b8',fontSize:'0.7rem',fontStyle:'italic'}}>C.C</td>
            <td style={{fontWeight:600,whiteSpace:'nowrap'}}>Negative constraint test</td>
            <td style={{padding:'0.3rem 0.4rem'}}>{scoreBar(cov.cov_neg.value, logCov?.cov_neg.value)}</td>
            <td style={{color:'#475569',fontSize:'0.72rem'}}>Fraction of nmax=0 constraints where target activity appeared (non-trivial test)</td>
            <td style={{color:'#94a3b8',fontSize:'0.7rem'}}>{cov.cov_neg.nonTrivial}/{cov.cov_neg.total} non-trivial</td>
          </tr>
          {/* C.R — Arrow Coverage */}
          <tr><td colSpan={5} style={{background:'#f1f5f9',fontWeight:700,fontSize:'0.7rem',color:'#475569',padding:'0.25rem 0.5rem',letterSpacing:'0.03em'}}>
            C.R — Arrow Coverage &nbsp;<span style={{fontWeight:400,color:'#94a3b8'}}>axis score: {fmt(cov.cov_arrow.value)}</span>
          </td></tr>
          <tr>
            <td style={{color:'#94a3b8',fontSize:'0.7rem',fontStyle:'italic'}}>C.R</td>
            <td style={{fontWeight:600,whiteSpace:'nowrap'}}>Arrow discriminability</td>
            <td style={{padding:'0.3rem 0.4rem'}}>{scoreBar(cov.cov_arrow.value, logCov?.cov_arrow.value)}</td>
            <td style={{color:'#475569',fontSize:'0.72rem'}}>Fraction of EF/EP constraints where target fired (EF vs DF / EP vs DP testable)</td>
            <td style={{color:'#94a3b8',fontSize:'0.7rem'}}>{cov.cov_arrow.dist}/{cov.cov_arrow.total} response/precedence constraints</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Normalized color gradient: red (min) → amber → green (max) ───────────────
// higherIsBetter=false inverts the scale (e.g. violation rate: lower = better).
const normColor = (val, allVals, higherIsBetter = true) => {
  const valid = allVals.filter(v => v != null && isFinite(v));
  if (valid.length === 0 || val == null) return '#64748b';
  const mn = Math.min(...valid), mx = Math.max(...valid);
  if (mn === mx) return '#16a34a';
  let t = (val - mn) / (mx - mn);
  if (!higherIsBetter) t = 1 - t;
  t = Math.max(0, Math.min(1, t));
  if (t <= 0.5) {
    const u = t * 2;
    return `rgb(${Math.round(220+u*(217-220))},${Math.round(38+u*(119-38))},${Math.round(38+u*(6-38))})`;
  }
  const u = (t - 0.5) * 2;
  return `rgb(${Math.round(217+u*(22-217))},${Math.round(119+u*(163-119))},${Math.round(6+u*(74-6))})`;
};

// ── OCPQPanel ─────────────────────────────────────────────────────────────────
function OCPQPanel({ results, onTotalsComputed }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [sortKey, setSortKey] = React.useState('reach');
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
      .then(r => { setData(r.data); return r.data; })
      .then(d => {
        if (!onTotalsComputed) return;
        const all = d.schemas || [];
        const _mean = (arr, k) => { const v = arr.map(r => r[k]).filter(x => x != null); return v.length ? v.reduce((s,x) => s+x, 0)/v.length : null; };
        onTotalsComputed({ reach: _mean(all,'reach'), exclusivity: _mean(all,'exclusivity') });
      })
      .catch(e => setError(e.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [results?.output_file]);

  if (!results?.output_file) return <div style={{color:'#94a3b8',fontSize:'0.85rem',padding:'1rem'}}>No run available.</div>;
  if (loading) return <div style={{display:'flex',alignItems:'center',gap:'0.5rem',padding:'1rem',fontSize:'0.82rem',color:'#64748b'}}><div className="spinner spinner-sm"/>Computing OCPQ measures…</div>;
  if (error) return <div style={{color:'#dc2626',fontSize:'0.82rem',padding:'1rem'}}>{error}</div>;
  if (!data) return null;

  const allSchemas = data.schemas || [];
  const schemas = [...allSchemas];
  schemas.sort((a, b) => {
    const av = a[sortKey] ?? -Infinity;
    const bv = b[sortKey] ?? -Infinity;
    return sortDir * (typeof av === 'number' && typeof bv === 'number' ? bv - av : String(bv).localeCompare(String(av)));
  });

  const _mean = (arr, key) => {
    const vals = arr.map(r => r[key]).filter(v => v != null);
    return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  const totals = {
    support:     allSchemas.reduce((s, r) => s + (r.support ?? 0), 0),
    coverage:    _mean(allSchemas, 'coverage'),
    selectivity: _mean(allSchemas, 'selectivity'),
    reach:       _mean(allSchemas, 'reach'),
    exclusivity: _mean(allSchemas, 'exclusivity'),
    throughput_s:_mean(allSchemas, 'throughput_s'),
    eq_class:    new Set(allSchemas.map(r => r.eq_class).filter(Boolean)).size,
  };

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
    { key: 'source_activity', label: 'Source',      tip: 'Source activity — the activity that precedes the target on the same object',           fmt: v => v, color: () => '#1e293b' },
    { key: 'target_activity', label: 'Target',      tip: 'Target activity — the activity that follows the source on the same object',            fmt: v => v, color: () => '#1e293b' },
    { key: 'reach',           label: 'Reach',       tip: 'Fraction of target-activity firings reached from this source (connected targets ÷ total target firings)',   fmt: fmtPct, color: v => normColor(v, allSchemas.map(s => s.reach)) },
    { key: 'exclusivity',     label: 'Exclusivity', tip: 'How exclusively this source leads to the target — 1 = one-to-one, <1 = fan-in from multiple sources (1 ÷ avg sources per target)', fmt: fmtSel, color: v => normColor(v, allSchemas.map(s => s.exclusivity)) },
  ].filter(c => c.key !== 'eq_class');

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
                  {c.label}<InfoTip text={c.tip} />{sortKey === c.key ? (sortDir < 0 ? ' ↓' : ' ↑') : ''}
                </th>
              ))}
              <th style={{...thStyle('object_types'), cursor:'default'}}>Objects<InfoTip text="Object types involved in this transition and the average count per event (abbreviation × count)." /></th>
            </tr>
          </thead>
          <tbody>
            <tr style={{borderBottom:'2px solid #cbd5e1',background:'#f8fafc'}}>
              <td style={{padding:'0.35rem 0.5rem',fontSize:'0.72rem',fontWeight:700,color:'#334155',textAlign:'left'}}>Overall</td>
              <td style={{padding:'0.35rem 0.5rem',fontSize:'0.7rem',color:'#64748b',textAlign:'left'}}>{allSchemas.length} paths</td>
              <td style={{padding:'0.35rem 0.5rem',fontSize:'0.72rem',fontWeight:700,color:normColor(totals.reach, allSchemas.map(s => s.reach)),textAlign:'center'}}>{fmtPct(totals.reach)}</td>
              <td style={{padding:'0.35rem 0.5rem',fontSize:'0.72rem',fontWeight:700,color:normColor(totals.exclusivity, allSchemas.map(s => s.exclusivity)),textAlign:'center'}}>{fmtSel(totals.exclusivity)}</td>
              <td style={{padding:'0.35rem 0.5rem',fontSize:'0.7rem',color:'#94a3b8',textAlign:'center',fontFamily:'monospace'}}>{totals.eq_class} unique</td>
              <td/>
            </tr>
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
        <span><strong style={{color:'#475569'}}>Reach:</strong> fraction of all target-activity firings that are reachable from this source</span>
        <span><strong style={{color:'#475569'}}>Exclusivity:</strong> 1.0 = each target event has exactly one source (one-to-one); values below 1 indicate fan-in (multiple sources feed the same target)</span>
      </div>
      <div style={{marginTop:'0.75rem',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'6px',padding:'0.6rem 0.85rem'}}>
        <div style={{fontSize:'0.7rem',fontWeight:700,color:'#475569',marginBottom:'0.4rem',textTransform:'uppercase',letterSpacing:'0.05em'}}>Formulas</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))',gap:'0.3rem 1.5rem'}}>
          {[
            ['Reach',       'distinct target events reached ÷ all target-activity firings'],
            ['Exclusivity', '1 ÷ avg sources per target event (1 = one-to-one)'],
          ].map(([name, formula]) => (
            <div key={name} style={{display:'flex',gap:'0.35rem',alignItems:'baseline'}}>
              <span style={{fontSize:'0.72rem',fontWeight:700,color:'#334155',minWidth:'82px',flexShrink:0}}>{name}</span>
              <span style={{fontSize:'0.7rem',color:'#64748b'}}>{formula}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── VerificationMatrix — activity × object-type cross-matrix ─────────────────
function VerificationMatrix({ results, discoveryResults, activeModel, modelBase }) {
  const [verifyMode,  setVerifyMode]  = React.useState('frequency');
  const [timeSubMode, setTimeSubMode] = React.useState('mean');

  const VERIFY_MODES = [
    { key: 'frequency',   label: 'Event Frequency' },
    { key: 'time',        label: 'Time per Event' },
    { key: 'cardinality', label: 'Objects per Event' },
  ];

  const fmtDur = s => { if (!s) return '—'; if (s<60) return Math.abs(s%1)<0.005?Math.round(s)+'s':s.toFixed(2)+'s'; if (s<3600) return Math.floor(s/60)+'m'; if (s<86400) return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);return h>0?d+'d '+h+'h':d+'d'; };

  const logActivityCounts = discoveryResults?.activity_counts || {};
  const logObjectTypes    = discoveryResults?.object_type_stats || {};

  if (!results) return <div style={{color:'#94a3b8',fontSize:'0.85rem'}}>No run available.</div>;

  const metrics       = results.metrics?.activity_metrics || {};
  const serviceByType = results.metrics?.activity_service_by_type || {};
  const resourceTypes = new Set(results.resource_types || []);
  const audit         = results.audit?.object_lifecycle_audit || {};
  const activities    = Object.keys(metrics).sort(makeFlowRankSorter(discoveryResults, results.object_traces));
  const objTypes      = Object.keys(audit).filter(t => !resourceTypes.has(t));

  const actBindings = {};
  const modelToUse  = activeModel || modelBase;
  if (modelToUse?.activities) {
    modelToUse.activities.forEach(a => {
      const types = new Set((a.bindings||[]).map(b=>b.object_type).filter(t=>!resourceTypes.has(t)));
      actBindings[a.name] = types;
    });
  }

  const simObjTypes = results.object_types || {};
  const cols = objTypes.length > 0 ? objTypes
    : [...new Set(Object.values(actBindings).flatMap(s => [...s]))].sort();

  if (!activities.length) return (
    <div style={{color:'#94a3b8',fontSize:'0.85rem'}}>No activity metrics available. Run a simulation first.</div>
  );

  const getCellVal = (act, ot) => {
    const m = metrics[act] || {};
    const participates = !actBindings[act] || actBindings[act].size === 0 || actBindings[act].has(ot);
    if (verifyMode === 'frequency') {
      const cnt = serviceByType?.[act]?.[ot]?.count ?? null;
      return cnt != null && cnt > 0 ? cnt : null;
    }
    if (verifyMode === 'time') {
      if (!participates) return null;
      const perType = serviceByType?.[act]?.[ot];
      if (perType) {
        const val = timeSubMode === 'min' ? perType.min_s : timeSubMode === 'max' ? perType.max_s : perType.mean_s;
        return (val != null && val > 0) ? val : null;
      }
      const val = timeSubMode === 'min' ? m.min_service_s : timeSubMode === 'max' ? m.max_service_s : m.mean_service_s;
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
    return null;
  };

  const fmtCell = val => {
    if (verifyMode === 'time') return fmtDur(val);
    if (verifyMode === 'cardinality') return val.toFixed(1);
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
  const vertStyle  = { writingMode:'vertical-rl', transform:'rotate(180deg)', whiteSpace:'nowrap',
    fontSize:'0.7rem', padding:'0.25rem 0.1rem', maxHeight:'120px', textOverflow:'ellipsis', overflow:'hidden' };

  return (
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
      <div style={{overflowX:'auto'}}>
        <table className="behavior-table" style={{fontSize:'0.75rem',borderCollapse:'collapse'}}>
          <thead>
            <tr style={{verticalAlign:'bottom'}}>
              <th style={{minWidth:'130px',fontSize:'0.72rem',textAlign:'left',paddingBottom:'0.35rem'}}>Activity</th>
              {cols.map(ot => (
                <th key={ot} title={ot} style={{...vertStyle,fontWeight:600,color:'#475569',border:'1px solid #e2e8f0',background:'#f8fafc'}}>{ot}</th>
              ))}
              {showLogRef && <th title="Reference value from the input event log (read-only)" style={{...vertStyle,color:'#94a3b8',border:'1px solid #e2e8f0',background:'#f8fafc'}}>Log ref</th>}
            </tr>
          </thead>
          <tbody>
            {activities.map(act => (
              <tr key={act}>
                <td style={{fontWeight:600,fontSize:'0.72rem',whiteSpace:'nowrap',paddingRight:'0.5rem'}}>{act}</td>
                {cols.map(ot => {
                  const val = getCellVal(act, ot);
                  const hasVal = val != null && val !== 0;
                  return (
                    <td key={ot} style={{textAlign:'center',border:'1px solid #f1f5f9',
                      background: hasVal ? (verifyMode==='time'?'#eff6ff':verifyMode==='frequency'?'#f0fdf4':'#fefce8') : 'transparent',
                      color: hasVal ? (verifyMode==='time'?'#1d4ed8':verifyMode==='frequency'?'#166534':'#78350f') : '#cbd5e1',
                      fontWeight: hasVal ? 600 : 400, fontSize:'0.72rem', padding:'0.2rem 0.3rem',
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
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function computeNGD(simTraces, realTraces, n = 2) {
  const dummy = '◦';
  const countNgrams = (traces) => {
    const map = {};
    Object.values(traces).forEach(trace => {
      if (!trace || trace.length === 0) return;
      const seq = [...Array(n - 1).fill(dummy), ...trace, ...Array(n - 1).fill(dummy)];
      for (let i = 0; i <= seq.length - n; i++) {
        const key = seq.slice(i, i + n).join(' → ');
        map[key] = (map[key] || 0) + 1;
      }
    });
    return map;
  };
  const ng1 = countNgrams(simTraces);
  const ng2 = countNgrams(realTraces);
  const allKeys = new Set([...Object.keys(ng1), ...Object.keys(ng2)]);
  let sumDiff = 0, sumTotal = 0;
  const rows = [];
  allKeys.forEach(k => {
    const f1 = ng1[k] || 0;
    const f2 = ng2[k] || 0;
    sumDiff += Math.abs(f1 - f2);
    sumTotal += f1 + f2;
    rows.push({ ngram: k, sim: f1, real: f2, absDiff: Math.abs(f1 - f2) });
  });
  rows.sort((a, b) => b.absDiff - a.absDiff);
  return {
    ngd: sumTotal > 0 ? sumDiff / sumTotal : 0,
    n,
    rows,
    totalSimNgrams: Object.values(ng1).reduce((s, v) => s + v, 0),
    totalRealNgrams: Object.values(ng2).reduce((s, v) => s + v, 0),
    uniqueNgrams: allKeys.size,
  };
}

function CoverageRadarMini({ results, model, discoveryResults, logResults }) {
  const [hoveredAxis, setHoveredAxis] = React.useState(null);
  const [tipPos,      setTipPos]      = React.useState(null);
  const cov = React.useMemo(
    () => computeOCCoverage(results, model, discoveryResults),
    [results, model, discoveryResults]
  );
  const logCov = React.useMemo(
    () => logResults ? computeOCCoverage(logResults, model, discoveryResults) : null,
    [logResults, model, discoveryResults]
  );
  if (!cov) return <span style={{fontSize:'0.72rem',color:'#94a3b8',fontStyle:'italic'}}>No coverage data</span>;

  const ceVal = (() => { const vs=[cov.cov_act.value,cov.cov_ot.value].filter(v=>v!=null); return vs.length?vs.reduce((s,v)=>s+v,0)/vs.length:null; })();
  const cardVal = (() => { const vs=[cov.cov_min.value,cov.cov_max.value,cov.cov_neg.value].filter(v=>v!=null); return vs.length?vs.reduce((s,v)=>s+v,0)/vs.length:null; })();
  const axes = [
    { key:'C.E', label:'Element',    value: ceVal,                    hint:'Fraction of constraint elements observed in the simulation output.\nAverages activity coverage (which activities fired) and object-type coverage (which object types appeared).\nLow value → the sim never invoked some activities or object types referenced in the model.' },
    { key:'C.A', label:'Activation', value: cov.cov_activation.value, hint:'Fraction of constraints that were triggered (activated) at least once during the simulation.\nLow value → entire constraints went untested — the sim conditions that would fire them never occurred.' },
    { key:'C.I', label:'Involvement',value: cov.cov_inv.value,        hint:'Fraction of constraints where every involved activity and object type participated at least once.\nReflects how thoroughly the full scope of each constraint was exercised.' },
    { key:'C.C', label:'Count',      value: cardVal,                  hint:'How well the simulation exercises cardinality bounds (min/max occurrence counts) defined in constraints.\nAverages min-bound, max-bound, and negation coverage.\nLow value → cardinality rules were rarely or never tested.' },
    { key:'C.R', label:'Arrow',      value: cov.cov_arrow.value,      hint:'Fraction of constraint relations (response edges, exclusion pairs, etc.) that were exercised.\nLow value → most constraint links were never traversed during the simulation.' },
  ];

  // Log reference polygon values (same axis order)
  const logAxisValues = logCov ? (() => {
    const lce = (() => { const vs=[logCov.cov_act.value,logCov.cov_ot.value].filter(v=>v!=null); return vs.length?vs.reduce((s,v)=>s+v,0)/vs.length:null; })();
    const lcard = (() => { const vs=[logCov.cov_min.value,logCov.cov_max.value,logCov.cov_neg.value].filter(v=>v!=null); return vs.length?vs.reduce((s,v)=>s+v,0)/vs.length:null; })();
    return [lce, logCov.cov_activation.value, logCov.cov_inv.value, lcard, logCov.cov_arrow.value];
  })() : null;
  const CX=105,CY=100,R=72,N=axes.length;
  const angleOf=i=>(Math.PI*2*i)/N-Math.PI/2;
  const spoke=(i,r)=>({x:CX+r*Math.cos(angleOf(i)),y:CY+r*Math.sin(angleOf(i))});
  const ringLevels=[0.25,0.5,0.75,1.0];
  const ringColor=['#f1f5f9','#e2e8f0','#cbd5e1','#94a3b8'];
  const rc=v=>v==null?'#94a3b8':v>=0.9?'#16a34a':v>=0.6?'#d97706':'#dc2626';
  const overall=axes.filter(a=>a.value!=null).reduce((s,a)=>s+a.value,0)/Math.max(1,axes.filter(a=>a.value!=null).length);
  const pts=axes.map((ax,i)=>spoke(i,R*Math.max(0,ax.value??0)));
  const path=pts.map((p,i)=>`${i===0?'M':'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')+' Z';

  const hovered = hoveredAxis != null ? axes[hoveredAxis] : null;
  const tipW = 230;

  // Build log reference SVG path if available
  const logPath = logAxisValues ? (() => {
    const lpts = logAxisValues.map((v, i) => spoke(i, R * Math.max(0, v ?? 0)));
    return lpts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';
  })() : null;

  return (
    <div style={{display:'inline-block'}}>
      <svg width={210} height={200} style={{overflow:'visible'}}>
        {ringLevels.map((lvl,li)=>{const rpts=axes.map((_,i)=>spoke(i,R*lvl));const d=rpts.map((p,i)=>`${i===0?'M':'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')+' Z';return(<g key={li}><path d={d} fill="none" stroke={ringColor[li]} strokeWidth={li===3?1.5:1}/></g>);})}
        {axes.map((_,i)=>{const tip=spoke(i,R);return<line key={i} x1={CX} y1={CY} x2={tip.x.toFixed(1)} y2={tip.y.toFixed(1)} stroke="#e2e8f0" strokeWidth={1}/>;} )}
        {/* Log reference polygon (drawn behind sim) */}
        {logPath && <path d={logPath} fill="#94a3b820" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="3 2"/>}
        {/* Sim polygon */}
        <path d={path} fill={`${rc(overall)}22`} stroke={rc(overall)} strokeWidth={2}/>
        {pts.map((p,i)=>(<circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={3} fill={rc(axes[i].value)} stroke="white" strokeWidth={1.5}><title>{axes[i].label}: {axes[i].value!=null?(axes[i].value*100).toFixed(1)+'%':'N/A'}</title></circle>))}
        {axes.map((ax,i)=>{
          const tip=spoke(i,R+18);
          const anchor=tip.x<CX-5?'end':tip.x>CX+5?'start':'middle';
          return (
            <text key={i} x={tip.x.toFixed(1)} y={tip.y.toFixed(1)}
              textAnchor={anchor} fontSize="8.5" fontWeight="600"
              fill={hoveredAxis===i?'#2563eb':'#475569'}
              style={{cursor:'help'}}
              onMouseEnter={e=>{
                const left = Math.min(Math.max(8, e.clientX + 12), window.innerWidth - tipW - 8);
                setTipPos({ left, top: Math.max(8, e.clientY - 50) });
                setHoveredAxis(i);
              }}
              onMouseLeave={()=>{ setHoveredAxis(null); setTipPos(null); }}>
              {ax.label}
            </text>
          );
        })}
        <circle cx={CX} cy={CY} r={18} fill="white" stroke={rc(overall)} strokeWidth={1.5}/>
        <text x={CX} y={CY-3} textAnchor="middle" fontSize="9.5" fontWeight="700" fill={rc(overall)}>{(overall*100).toFixed(0)}%</text>
        <text x={CX} y={CY+9} textAnchor="middle" fontSize="7.5" fill="#64748b">overall</text>
      </svg>
      {/* Legend — only shown when log reference is present */}
      {logPath && (
        <div style={{display:'flex',gap:'0.75rem',fontSize:'0.62rem',color:'#64748b',marginTop:'0.1rem'}}>
          <span style={{display:'flex',alignItems:'center',gap:'0.25rem'}}>
            <svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={rc(overall)} strokeWidth="2"/></svg>
            Simulation
          </span>
          <span style={{display:'flex',alignItems:'center',gap:'0.25rem'}}>
            <svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="3 2"/></svg>
            Input log
          </span>
        </div>
      )}
      {hovered && tipPos && ReactDOM.createPortal(
        <div style={{position:'fixed',left:tipPos.left,top:tipPos.top,background:'#1e293b',color:'white',padding:'0.5rem 0.65rem',borderRadius:'6px',fontSize:'0.72rem',lineHeight:'1.45',width:tipW+'px',textAlign:'left',zIndex:9999,pointerEvents:'none',whiteSpace:'pre-wrap',boxShadow:'0 4px 12px rgba(0,0,0,0.18)'}}>
          <div style={{fontWeight:700,marginBottom:'0.25rem'}}>{hovered.label} ({hovered.key}) — {hovered.value!=null?(hovered.value*100).toFixed(1)+'%':'N/A'}</div>
          {hovered.hint}
        </div>,
        document.body
      )}
    </div>
  );
}

function SummaryMetricCard({ m }) {
  const [tipPos, setTipPos] = React.useState(null);
  const ref = React.useRef(null);
  const handleMouseEnter = () => {
    if (!m.hint) return;
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const tipW = 230;
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - tipW / 2), window.innerWidth - tipW - 8);
    setTipPos({ left, bottom: window.innerHeight - rect.top + 6 });
  };
  return (
    <div ref={ref}
      style={{minWidth:'88px',padding:'0.35rem 0.5rem',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'6px',textAlign:'center',flex:'0 0 auto',cursor:m.hint?'help':'default'}}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setTipPos(null)}
    >
      <div style={{fontSize:'1.05rem',fontWeight:700,color:m.color,lineHeight:1.1}}>{m.display}</div>
      <div style={{fontSize:'0.58rem',color:'#64748b',marginTop:'3px',lineHeight:1.2}}>{m.label}</div>
      {tipPos && m.hint && ReactDOM.createPortal(
        <div style={{position:'fixed',left:tipPos.left,bottom:tipPos.bottom,background:'#1e293b',color:'white',padding:'0.5rem 0.65rem',borderRadius:'6px',fontSize:'0.72rem',lineHeight:'1.45',width:'230px',textAlign:'left',zIndex:9999,pointerEvents:'none',whiteSpace:'pre-wrap',boxShadow:'0 4px 12px rgba(0,0,0,0.18)'}}>
          {m.hint}
        </div>,
        document.body
      )}
    </div>
  );
}

// ── EvaluationWrapper — side-by-side As-Is / To-Be with comparison header ────
function EvaluationWrapper({ resultsAsIs, resultsToBe, results, discoveryResults, activeModel, modelBase, serviceTimeMode, simActivityObjectCounts, onConformanceSaved, eventLogFiles, handleFileUpload, inputLogConfResults, inputEventLogFile, onRerunEvaluation, evalRunCount, onEventLogFileChange }) {
  const hasBoth = !!(resultsAsIs && resultsToBe);
  const rAsis = resultsAsIs ?? results;
  const rTobe = resultsToBe;
  const [evalTab, setEvalTab] = React.useState('conformance');
  const [cmpSections, setCmpSections] = React.useState({conformance: true});
  const [ocpqTotals,        setOcpqTotals]        = React.useState(null);
  const [liveConfScores,    setLiveConfScores]    = React.useState(null);
  const [ocpqTotalsTobe,    setOcpqTotalsTobe]    = React.useState(null);
  const [liveConfScoresTobe,setLiveConfScoresTobe] = React.useState(null);

  // Reset live scores when the run changes
  React.useEffect(() => { setLiveConfScores(null); setOcpqTotals(null); }, [rAsis?.output_file]);
  React.useEffect(() => { setLiveConfScoresTobe(null); setOcpqTotalsTobe(null); }, [rTobe?.output_file]);

  // WMAPE: sim mean vs log mean — computed from rAsis metrics + model durations
  const wmapeAsis = React.useMemo(() => {
    const sm = rAsis?.metrics?.activity_metrics || {};
    const ld = activeModel?.activity_durations || {};
    let num = 0, den = 0;
    Object.keys({...sm, ...ld}).forEach(a => {
      const sim = sm[a]?.mean_service_s, log = ld[a]?.service_mean, w = sm[a]?.execution_count || 1;
      if (sim != null && log != null && log > 0) { num += Math.abs(sim - log) * w; den += log * w; }
    });
    return den > 0 ? (num / den * 100) : null;
  }, [rAsis?.output_file, activeModel]);

  const confScores     = liveConfScores     || rAsis?.conformance;
  const confScoresTobe = liveConfScoresTobe || rTobe?.conformance;

  const wmapeTobe = React.useMemo(() => {
    const sm = rTobe?.metrics?.activity_metrics || {};
    const ld = activeModel?.activity_durations || {};
    let num = 0, den = 0;
    Object.keys({...sm, ...ld}).forEach(a => {
      const sim = sm[a]?.mean_service_s, log = ld[a]?.service_mean, w = sm[a]?.execution_count || 1;
      if (sim != null && log != null && log > 0) { num += Math.abs(sim - log) * w; den += log * w; }
    });
    return den > 0 ? (num / den * 100) : null;
  }, [rTobe?.output_file, activeModel]);

  // Weighted mean real sojourn time — used to normalise W1 colour grading
  const meanSojourn = React.useMemo(() => {
    const sm = rAsis?.metrics?.activity_metrics || {};
    const ld = activeModel?.activity_durations || {};
    let weightedSum = 0, totalW = 0;
    Object.keys(ld).forEach(a => {
      const mean = ld[a]?.service_mean;
      const w = (sm[a]?.execution_count) || 1;
      if (mean != null && mean > 0) { weightedSum += mean * w; totalW += w; }
    });
    return totalW > 0 ? weightedSum / totalW : null;
  }, [rAsis?.output_file, activeModel]);

  // Satisfiability + cross-object inconsistency from model constraints
  const modelQuality = React.useMemo(() => {
    const constraints = activeModel?.constraints || [];
    const activities  = activeModel?.activities  || [];
    if (!constraints.length || !activities.length) return null;
    const actNames = new Set(activities.map(a => a.name || a));
    const precFwd = {}, respEdges = {}, notCoex = [], absences = new Set();
    constraints.forEach(c => {
      if (c.constraint_type === 'precedence') { (precFwd[c.source_activity] = precFwd[c.source_activity]||[]).push(c.target_activity); }
      else if (c.constraint_type === 'response') { (respEdges[c.source_activity] = respEdges[c.source_activity]||[]).push(c.target_activity); }
      else if (c.constraint_type === 'not_coexistence') { notCoex.push([c.source_activity, c.target_activity]); }
      else if (c.constraint_type === 'absence' && (c.nmax === 0 || c.nmax === null)) { absences.add(c.source_activity || c.target_activity); }
    });
    const visited = new Set();
    const hasCycle = (node, path) => { if (path.includes(node)) return true; if (visited.has(node)) return false; visited.add(node); return (precFwd[node]||[]).some(n => hasCycle(n, [...path, node])); };
    let satisfOk = true;
    for (const a of actNames) { if (hasCycle(a, [])) { satisfOk = false; break; } }
    if (satisfOk) notCoex.forEach(([a,b]) => { if ((respEdges[a]||[]).includes(b)||(respEdges[b]||[]).includes(a)) satisfOk = false; });
    if (satisfOk) absences.forEach(act => { if (Object.values(respEdges).some(tgts => tgts.includes(act))) satisfOk = false; });
    const actBindings = {};
    activities.forEach(a => { actBindings[a.name||a] = a.bindings || []; });
    let crossOk = true;
    constraints.forEach(c => {
      if (c.scope?.kind !== 'each' || !c.scope?.object_type) return;
      const stype = c.scope.object_type;
      if (actNames.has(c.source_activity) && !(actBindings[c.source_activity]||[]).some(b=>b.object_type===stype)) crossOk = false;
      if (!['not_coexistence','absence','exactly','init'].includes(c.constraint_type) && actNames.has(c.target_activity) && !(actBindings[c.target_activity]||[]).some(b=>b.object_type===stype)) crossOk = false;
    });
    return { satisfOk, crossOk };
  }, [activeModel]);

  const vacuityStatus = React.useMemo(() => {
    const constraints = activeModel?.constraints || [];
    const objectTraces = rAsis?.object_traces || {};
    if (!constraints.length || Object.keys(objectTraces).length === 0) return null;
    const fired = new Set();
    Object.values(objectTraces).forEach(trace => trace.forEach(act => fired.add(act)));
    const count = constraints.filter(c => c.source_activity && !fired.has(c.source_activity)).length;
    return { ok: count === 0, count };
  }, [activeModel, rAsis]);

  const fmtDur = s => { if (!s) return '—'; if (s<60) return Math.abs(s % 1) < 0.005 ? Math.round(s)+'s' : s.toFixed(2)+'s'; if (s<3600) return Math.floor(s/60)+'m'; if (s<86400) return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);return h>0?d+'d '+h+'h':d+'d'; };

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

  const [distFidAsis,    setDistFidAsis]    = React.useState(null);
  const [distFidTobe,    setDistFidTobe]    = React.useState(null);
  const [distFidLoading, setDistFidLoading] = React.useState(false);
  const [distFidError,   setDistFidError]   = React.useState(null);
  const [distFidOpen,    setDistFidOpen]    = React.useState(true);
  const [evalAllLoading, setEvalAllLoading] = React.useState(false);

  const runDistFidelity = async () => {
    if (!rAsis?.output_file || !inputEventLogFile) return;
    setDistFidLoading(true);
    setDistFidError(null);
    setDistFidAsis(null);
    setDistFidTobe(null);
    try {
      const promises = [
        axios.post('/api/further-eval/distribution-fidelity', {
          outputFile: rAsis.output_file, eventLogFile: inputEventLogFile,
        })
      ];
      if (rTobe?.output_file) {
        promises.push(axios.post('/api/further-eval/distribution-fidelity', {
          outputFile: rTobe.output_file, eventLogFile: inputEventLogFile,
        }));
      }
      const [asisRes, tobeRes] = await Promise.all(promises);
      setDistFidAsis(asisRes.data);
      if (tobeRes) setDistFidTobe(tobeRes.data);
    } catch (e) {
      setDistFidError(e.response?.data?.error || e.message);
    } finally {
      setDistFidLoading(false);
    }
  };

  const [xlogData,    setXlogData]    = React.useState(null);
  const [xlogLoading, setXlogLoading] = React.useState(false);
  const [xlogError,   setXlogError]   = React.useState(null);

  const [ngdData,    setNgdData]    = React.useState(null);
  const [ngdLoading, setNgdLoading] = React.useState(false);
  const [ngdError,   setNgdError]   = React.useState(null);

  const [cardFidAsis,    setCardFidAsis]    = React.useState(null);
  const [cardFidLoading, setCardFidLoading] = React.useState(false);
  const [cardFidError,   setCardFidError]   = React.useState(null);

  // Input log coverage reference — synthetic results-like object for CoverageRadarMini
  const [inputLogCovResults, setInputLogCovResults] = React.useState(null);
  React.useEffect(() => {
    if (!inputEventLogFile) { setInputLogCovResults(null); return; }
    axios.get(`/api/eventlog-events?file=${encodeURIComponent(inputEventLogFile)}`)
      .then(resp => {
        const evts = resp.data.events || [];
        const tmap = resp.data.object_types_map || {};
        const traces = {};
        evts.forEach(e => { (e.object_ids || []).forEach(oid => { (traces[oid] = traces[oid] || []).push(e.activity); }); });
        const objTypes = {};
        Object.entries(tmap).forEach(([oid, ot]) => { objTypes[ot] = (objTypes[ot] || 0) + 1; });
        setInputLogCovResults({ activity_sequence: evts.map(e => e.activity), object_types: objTypes, object_traces: traces, object_types_map: tmap });
      })
      .catch(() => setInputLogCovResults(null));
  }, [inputEventLogFile]);


  const runXlogFidelity = async () => {
    if (!rAsis?.output_file || !inputEventLogFile) return;
    setXlogLoading(true); setXlogError(null); setXlogData(null);
    try {
      const r = await axios.post('/api/further-eval/log-fidelity', {
        outputFile: rAsis.output_file, eventLogFile: inputEventLogFile,
      });
      setXlogData(r.data);
    } catch (e) { setXlogError(e.response?.data?.error || e.message); }
    finally { setXlogLoading(false); }
  };

  const runCardFidelity = async () => {
    if (!rAsis?.output_file || !inputEventLogFile) return;
    setCardFidLoading(true); setCardFidError(null); setCardFidAsis(null);
    try {
      const r = await axios.post('/api/further-eval/cardinality-fidelity', {
        outputFile: rAsis.output_file, eventLogFile: inputEventLogFile,
      });
      setCardFidAsis(r.data);
    } catch (e) { setCardFidError(e.response?.data?.error || e.message); }
    finally { setCardFidLoading(false); }
  };

  const ocdeclareFile = activeModel?._source_file || null;
  const modelOverride = activeModel || null;
  const safeStartActivities = discoveryResults?.strict_start_activities || discoveryResults?.likely_start_activities || [];
  const constraintStats = rAsis?.constraint_obligation_stats || {};
  const obligationsFulfilled = rAsis?.obligations_fulfilled ?? 0;
  const obligationsViolated  = rAsis?.obligations_violated  ?? 0;
  const obligationsCancelled = rAsis?.obligations_cancelled ?? 0;
  const fmtPct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
  const fmtNum = v => v == null ? '—' : Number.isInteger(v) ? v.toLocaleString() : v.toFixed(3);

  const [confData,    setConfData]    = React.useState(null);
  const [confLoading, setConfLoading] = React.useState(false);
  const [confError,   setConfError]   = React.useState(null);

  const runConformanceCheck = async () => {
    if (!rAsis?.output_file) return;
    setConfLoading(true); setConfError(null); setConfData(null);
    try {
      const r = await axios.post('/api/further-eval/conformance-check', { outputFile: rAsis.output_file, ocdeclareFile, modelOverride });
      setConfData(r.data);
    } catch(e) { setConfError(e.response?.data?.error || e.message); }
    finally { setConfLoading(false); }
  };

  // Run all summary-strip metrics when Run Evaluation is clicked
  React.useEffect(() => {
    if (!rAsis?.output_file) return;

    setEvalAllLoading(true);
    const _promises = [];

    // Fitness / Precision / OC-Declare Confidence — synchronous from object_traces
    const computeAndSetConf = (r, setter) => {
      if (!r?.object_traces) return;
      const s = computeConformance(r.object_traces, activeModel?.constraints || [], activeModel?.activities || []);
      if (s.fitness != null) setter({ fitness: s.fitness, constraint_fitness: s.constraintFitness, precision: s.precision });
    };
    computeAndSetConf(rAsis, setLiveConfScores);
    if (rTobe?.output_file) computeAndSetConf(rTobe, setLiveConfScoresTobe);

    // Overall Reach / Exclusivity — async OCPQ fetch
    const fetchOcpq = async (outputFile, setter) => {
      try {
        const resp = await axios.get(`/api/run-history/${encodeURIComponent(outputFile)}/ocpq`);
        const all = resp.data.schemas || [];
        const _mean = (arr, k) => { const vs = arr.map(x => x[k]).filter(x => x != null); return vs.length ? vs.reduce((s,x) => s+x, 0)/vs.length : null; };
        setter({ reach: _mean(all,'reach'), exclusivity: _mean(all,'exclusivity') });
      } catch(e) {}
    };
    _promises.push(fetchOcpq(rAsis.output_file, setOcpqTotals));
    if (rTobe?.output_file) _promises.push(fetchOcpq(rTobe.output_file, setOcpqTotalsTobe));

    // Post-hoc Fitness — async conformance check
    _promises.push(runConformanceCheck());

    // Distribution + cross-log fidelity — require event log
    if (inputEventLogFile) {
      _promises.push(runDistFidelity());
      _promises.push(runXlogFidelity());
      _promises.push(runCardFidelity());

      // NGD — load real log traces and compute n-gram distance (n=2)
      if (rAsis?.object_traces) {
        setNgdData(null); setNgdError(null); setNgdLoading(true);
        _promises.push(
          axios.get(`/api/eventlog-events?file=${encodeURIComponent(inputEventLogFile)}`)
            .then(resp => {
              const evts = resp.data.events || [];
              const realTraces = {};
              evts.forEach(e => {
                (e.object_ids || []).forEach(oid => {
                  (realTraces[oid] = realTraces[oid] || []).push(e.activity);
                });
              });
              setNgdData(computeNGD(rAsis.object_traces, realTraces, 2));
            })
            .catch(e => setNgdError(e.response?.data?.error || e.message))
            .finally(() => setNgdLoading(false))
        );
      }
    }

    Promise.allSettled(_promises).finally(() => setEvalAllLoading(false));
  }, [evalRunCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const [multiSeeds,   setMultiSeeds]   = React.useState('42,99,123,456,789');
  const [multiData,    setMultiData]    = React.useState(null);
  const [multiLoading, setMultiLoading] = React.useState(false);
  const [multiError,   setMultiError]   = React.useState(null);

  const runMultiSeed = async () => {
    const seeds = multiSeeds.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    if (!seeds.length) return;
    setMultiLoading(true); setMultiError(null); setMultiData(null);
    try {
      const r = await axios.post('/api/further-eval/multi-run', {
        seeds, ocdeclareFile, modelOverride, eventLogFile: inputEventLogFile,
        startActivities: safeStartActivities, maxEvents: 50000,
      });
      setMultiData(r.data);
    } catch(e) { setMultiError(e.response?.data?.error || e.message); }
    finally { setMultiLoading(false); }
  };

  // Tab buttons for top navigation
  const tabs = [
    { key: 'conformance',    label: 'Conformance' },
    { key: 'coverage',       label: 'Coverage' },
    { key: 'time',           label: 'Time' },
    { key: 'log-comparison', label: 'Log comparison' },
  ];

  return (
    <div>
      {evalAllLoading ? (
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'4rem 2rem',gap:'1rem'}}>
          <div className="spinner" />
          <div style={{fontSize:'0.9rem',color:'#64748b',fontWeight:500}}>Computing evaluation metrics…</div>
        </div>
      ) : (
        <>
      {/* Model / run header */}
      {rAsis && (
        <div style={{display:'flex',alignItems:'center',gap:'0.5rem',flexWrap:'wrap',marginBottom:'0.75rem',padding:'0.4rem 0.75rem',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'6px',fontSize:'0.78rem',color:'#475569'}}>
          <span style={{fontWeight:600}}>Evaluating:</span>
          <span>{(activeModel?.activities||[]).length > 0 ? `${(activeModel.activities||[]).length} activities · ${(activeModel.constraints||[]).length} constraints` : 'Current model'}</span>
          {inputEventLogFile && <><span style={{color:'#cbd5e1'}}>·</span><span style={{color:'#64748b'}}>compared against <strong style={{color:'#475569'}}>{inputEventLogFile.split('/').pop()}</strong></span></>}
        </div>
      )}

      {/* Log file picker — shown when no event log is linked (e.g. parameters loaded directly) */}
      {!inputEventLogFile && onEventLogFileChange && (eventLogFiles||[]).length > 0 && (
        <div style={{display:'flex',alignItems:'center',gap:'0.5rem',flexWrap:'wrap',marginBottom:'0.75rem',padding:'0.4rem 0.75rem',background:'#fffbeb',border:'1px solid #fde68a',borderRadius:'6px',fontSize:'0.78rem',color:'#92400e'}}>
          <span style={{fontWeight:600}}>⚠ No event log linked.</span>
          <span style={{color:'#78350f'}}>Select a log to enable log-comparison measures:</span>
          <select
            defaultValue=""
            style={{fontSize:'0.78rem',padding:'0.2rem 0.4rem',borderRadius:'4px',border:'1px solid #fcd34d',background:'#fff',color:'#334155'}}
            onChange={e => { if (e.target.value) onEventLogFileChange(e.target.value); }}
          >
            <option value="">— select event log —</option>
            {(eventLogFiles||[]).map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
      )}

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

      {/* ── Key Metrics Summary Strip ── */}
      {(() => {
        const pct  = v => v == null ? null : `${(v * 100).toFixed(1)}%`;
        const fmtW = v => {
          if (v == null) return null;
          if (v >= 86400) { const d=Math.floor(v/86400), h=Math.floor((v%86400)/3600); return h>0?`${d}d ${h}h`:`${d}d`; }
          if (v >= 3600)  { const h=Math.floor(v/3600),  m=Math.floor((v%3600)/60);   return m>0?`${h}h ${m}m`:`${h}h`; }
          if (v >= 60)    { const m=Math.floor(v/60),    s=Math.floor(v%60);           return s>0?`${m}m ${s}s`:`${m}m`; }
          return v < 10 ? `${v.toFixed(1)}s` : `${Math.round(v)}s`;
        };
        const ga = (v, hi, mid) => v == null ? '#64748b' : v >= hi ? '#16a34a' : v >= mid ? '#d97706' : '#dc2626';
        const ra = (v, lo, mid) => v == null ? '#64748b' : v <= lo ? '#16a34a' : v <= mid ? '#d97706' : '#dc2626';

        const secLabel = txt => (
          <div style={{fontSize:'0.57rem',fontWeight:700,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.09em',padding:'0.45rem 0.75rem 0.2rem'}}>
            {txt}
          </div>
        );
        const secRow = children => (
          <div style={{padding:'0.2rem 0.75rem 0.55rem',display:'flex',alignItems:'center',gap:'0.65rem',flexWrap:'wrap'}}>
            {children}
          </div>
        );
        const inlineMeasure = (label, value, ok, hint) => (
          <div key={label} style={{display:'flex',alignItems:'center',gap:'0.3rem',fontSize:'0.74rem',color:'#475569'}}>
            <span style={{color:'#64748b'}}>{label}{hint && <InfoTip text={hint}/>}:</span>
            <span style={{fontWeight:700,color:ok===true?'#16a34a':ok===false?'#dc2626':'#64748b'}}>{value}</span>
          </div>
        );

        const hasConformance = confData?.overall_fitness != null || modelQuality;
        const hasCoverage    = !!(rAsis?.output_file || rAsis?.metrics);
        const hasTime        = distFidAsis?.overall_w1_s != null || wmapeAsis != null;
        const hasLogComp     = xlogData?.activity_kl_divergence != null || true; // always show (NGD placeholder)
        if (!hasConformance && !hasCoverage && !hasTime) return null;

        return (
          <div style={{marginBottom:'1rem',background:'white',border:'1px solid #e2e8f0',borderRadius:'8px',overflow:'hidden'}}>

            {/* CONFORMANCE */}
            {hasConformance && (<>
              {secLabel('Conformance')}
              {secRow(<>
                {confData?.overall_fitness != null && (
                  <SummaryMetricCard m={{label:'Post-hoc Fitness',display:pct(confData.overall_fitness),color:ga(confData.overall_fitness,0.9,0.7),hint:'Post-hoc OC-Declare conformance — fraction of constraint checks that passed when replaying the output OCEL.\nHigher is better: ≥90% excellent · ≥70% acceptable.'}} />
                )}
                {modelQuality && inlineMeasure('Satisfiability', modelQuality.satisfOk?'✓ OK':'✗ Issues', modelQuality.satisfOk, 'Checks whether the constraint set can ever be satisfied — detects logical conflicts where no valid execution trace could satisfy all constraints simultaneously.')}
                {modelQuality && inlineMeasure('Cross-object inconsistency', modelQuality.crossOk?'✓ OK':'✗ Issues', modelQuality.crossOk, 'Checks whether constraints referencing the same activities across different object types are mutually consistent — e.g. one type requires A before B while another requires B before A.')}
           {vacuityStatus && inlineMeasure('Vacuity conformance', vacuityStatus.ok?'✓ OK':`✗ ${vacuityStatus.count} vacuous`, vacuityStatus.ok, "Checks whether every constraint's source activity fired at least once. A constraint whose trigger never occurred is technically satisfied but only vacuously — it was never actually tested.")}
              </>)}
            </>)}

            {/* COVERAGE */}
            {hasCoverage && (
              <div style={{borderTop:'1px solid #f1f5f9'}}>
                {secLabel('Coverage')}
                <div style={{padding:'0.1rem 0.75rem 0.5rem'}}>
                  <CoverageRadarMini results={rAsis} model={activeModel} discoveryResults={discoveryResults} logResults={inputLogCovResults} />
                </div>
              </div>
            )}

            {/* TIME */}
            {hasTime && (
              <div style={{borderTop:'1px solid #f1f5f9'}}>
                {secLabel('Time')}
                {secRow(<>
                  {wmapeAsis != null && <SummaryMetricCard m={{label:'WMAPE',display:`${wmapeAsis.toFixed(1)}%`,color:ra(wmapeAsis,20,50),hint:'Weighted Mean Absolute % Error — avg difference between simulated and real-log activity service times, weighted by execution count.\nLower is better: <20% excellent · <50% acceptable.'}} />}
                  {distFidAsis?.overall_w1_s != null && (() => {
                    const w1Pct = meanSojourn ? distFidAsis.overall_w1_s / meanSojourn * 100 : null;
                    return <SummaryMetricCard m={{label:'Overall W1',display:fmtW(distFidAsis.overall_w1_s),color:ra(w1Pct,10,30),hint:'Wasserstein-1 on per-activity sojourn time distributions.\nColour = W1 as % of weighted mean real sojourn time.\nLower is better: <10% excellent · <30% acceptable.'}} />;
                  })()}
                </>)}
              </div>
            )}

            {/* LOG COMPARISON */}
            <div style={{borderTop:'1px solid #f1f5f9'}}>
              {secLabel('Log Comparison')}
              {secRow(<>
                {xlogData?.activity_kl_divergence != null && <SummaryMetricCard m={{label:'Activity KL Div.',display:xlogData.activity_kl_divergence.toFixed(4),color:ra(xlogData.activity_kl_divergence,0.2,0.5),hint:'KL divergence on activity frequency distributions — how much the simulated activity mix differs from the real log.\n0 = identical · lower is better: <0.2 excellent · <0.5 acceptable.'}} />}
                {ngdData != null
                  ? <SummaryMetricCard m={{label:'NGD (n=2)',display:ngdData.ngd.toFixed(4),color:ra(ngdData.ngd,0.1,0.3),hint:'N-Gram Distance (n=2): measures how well the simulator reproduces consecutive activity pairs (bigrams) in object traces — e.g. "Create Order→Pay Invoice" is one bigram. 0 = identical pair distributions; 1 = completely different. Lower is better: <0.10 excellent · <0.30 acceptable. (Chapela-Campa et al., 2023)'}} />
                  : ngdLoading
                    ? <span style={{fontSize:'0.74rem',color:'#94a3b8',fontStyle:'italic'}}>NGD computing…</span>
                    : <span style={{fontSize:'0.74rem',color:'#94a3b8',fontStyle:'italic'}}>NGD — run evaluation</span>
                }
              </>)}
            </div>

          </div>
        );
      })()}

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

      {evalTab === 'conformance' && (
        <>
          {/* ── Per-Constraint Obligation Rates ── */}
          <Collapsible className="eval-section" title="Per-Constraint Obligation Rates" defaultOpen={false}
            stickyContent={rAsis ? (
              <div style={{display:'flex',gap:'1rem',flexWrap:'wrap',marginBottom:'0.75rem'}}>
                {[
                  {label:'Fulfilled',  val:obligationsFulfilled, color:'#16a34a', tip:'Total obligations fulfilled — response target fired before the case closed.'},
                  {label:'Violated',   val:obligationsViolated,  color:'#dc2626', tip:'Total obligations violated — case closed before the response target ever fired.'},
                  {label:'Cancelled',  val:obligationsCancelled, color:'#ca8a04', tip:'Obligations removed at case-close without being fulfilled or counted as violated.'},
                ].map(({label,val,color,tip}) => (
                  <div key={label} className="behavior-stat-card" style={{minWidth:'100px'}}>
                    <div className="behavior-stat-val" style={{color}}>{val.toLocaleString()}</div>
                    <div className="behavior-stat-label">{label}<InfoTip text={tip} /></div>
                  </div>
                ))}
              </div>
            ) : null}
          >
            {!rAsis ? (
              <p className="empty-notice">Run a simulation first.</p>
            ) : (
              <div>
                <div style={{fontSize:'0.72rem',color:'#64748b',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'6px',padding:'0.5rem 0.75rem',marginBottom:'0.75rem',lineHeight:'1.6'}}>
                  <strong>Fulfillment Rate</strong> = obligations fulfilled ÷ (fulfilled + violated). An obligation is created each time a response constraint's source activity fires for a scope object. It is <em>fulfilled</em> when the target activity later fires for that object, and <em>violated</em> when the object is deactivated (case closed) before the target ever fires. <em>Cancelled</em> obligations are a subset of violations — they are removed at case-close time. A rate of 0% means the model has response constraints but the response activity never fired before cases ended; this commonly means the constraint is unenforced or the simulation terminates too early.
                </div>
                {Object.keys(constraintStats).length === 0 ? (
                  (() => {
                    const hasResponseConstraints = (activeModel?.constraints || [])
                      .some(c => c.constraint_type === 'response' || c.constraint_type === 'chain_response');
                    return (
                      <p style={{fontSize:'0.8rem',color:'#94a3b8',fontStyle:'italic'}}>
                        {!hasResponseConstraints
                          ? 'No response constraints in the active model — obligation tracking only applies to response/chain_response constraints.'
                          : 'Response constraints exist but no obligations were recorded in this run. This may mean the source activities never fired, or the model was not loaded when the simulation ran (re-simulate to populate).'}
                      </p>
                    );
                  })()
                ) : (
                  <table className="conf-detail-table" style={{width:'100%'}}>
                    <thead>
                      <tr>
                        <th title="The declarative constraint (type, source → target)" style={{textAlign:'left',fontSize:'0.72rem'}}>Constraint</th>
                        <th className="audit-num" title="Number of times an obligation was created and later met (target fired before case closed)">Fulfilled</th>
                        <th className="audit-num" title="Number of obligations that were not met — target never fired before case closed">Violated</th>
                        <th className="audit-num" title="Obligations removed at case-close without being fulfilled or recorded as violated">Cancelled</th>
                        <th className="audit-num" title="Fulfilled ÷ (Fulfilled + Violated) — fraction of obligations that were met">Fulfillment Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(constraintStats).sort((a,b) => {
                        const ra = a[1].violated/(a[1].fulfilled+a[1].violated||1);
                        const rb = b[1].violated/(b[1].fulfilled+b[1].violated||1);
                        return rb - ra;
                      }).map(([key, stats]) => {
                        const total = stats.fulfilled + stats.violated;
                        const rate  = total > 0 ? stats.fulfilled / total : null;
                        return (
                          <tr key={key}>
                            <td style={{fontSize:'0.72rem',color:'#475569',fontFamily:'monospace'}}>{key}</td>
                            <td className="audit-num" style={{color:'#16a34a'}}>{stats.fulfilled}</td>
                            <td className="audit-num" style={{color:'#dc2626'}}>{stats.violated}</td>
                            <td className="audit-num" style={{color:'#ca8a04'}}>{stats.cancelled}</td>
                            <td className="audit-num">
                              <span style={{
                                color: rate == null ? '#94a3b8' : rate >= 0.9 ? '#16a34a' : rate >= 0.7 ? '#ca8a04' : '#dc2626',
                                fontWeight: 600,
                              }}>
                                {rate == null ? '—' : fmtPct(rate)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </Collapsible>

          {/* ── Post-hoc Conformance Check ── */}
          <Collapsible className="eval-section" title="Post-hoc Conformance Check" defaultOpen={false}>
            {!rAsis?.output_file ? (
              <p className="empty-notice">No simulation output — run a simulation first.</p>
            ) : (
              <>
                {confLoading && <p style={{fontSize:'0.8rem',color:'#64748b',marginBottom:'0.5rem',display:'flex',alignItems:'center',gap:'0.4rem'}}><span className="spinner spinner-sm"/>Checking conformance…</p>}
                {confError && <p style={{color:'#dc2626',fontSize:'0.8rem'}}>{confError}</p>}
                {confData && (
                  <div>
                    <div style={{display:'flex',gap:'1rem',flexWrap:'wrap',marginBottom:'0.75rem'}}>
                      {[
                        {label:'Overall Fitness', val: confData.overall_fitness != null ? fmtPct(confData.overall_fitness) : '—', color: confData.overall_fitness >= 0.9 ? '#16a34a' : confData.overall_fitness >= 0.7 ? '#ca8a04' : '#dc2626', tip:'Fraction of all constraint checks that passed — satisfied ÷ total checked.'},
                        {label:'Constraints Checked', val: confData.num_constraints, color:'#1e293b', tip:'Number of distinct OC-Declare constraints evaluated in this replay.'},
                        {label:'Scope Objects Checked', val: confData.total_checked, color:'#1e293b', tip:'Total number of (constraint, object) pairs evaluated during replay.'},
                        {label:'Violations', val: confData.total_violated, color: confData.total_violated > 0 ? '#dc2626' : '#16a34a', tip:'Total number of (constraint, object) pairs where the constraint was not satisfied.'},
                      ].map(({label,val,color,tip}) => (
                        <div key={label} className="behavior-stat-card" style={{minWidth:'120px'}}>
                          <div className="behavior-stat-val" style={{color}}>{typeof val === 'number' ? val.toLocaleString() : val}</div>
                          <div className="behavior-stat-label">{label}<InfoTip text={tip} /></div>
                        </div>
                      ))}
                    </div>
                    <table className="conf-detail-table" style={{width:'100%'}}>
                      <thead>
                        <tr>
                          <th style={{textAlign:'left',fontSize:'0.72rem'}}>Constraint<InfoTip text="The OC-Declare constraint being checked." /></th>
                          <th className="audit-num">Scope Type<InfoTip text="Object type scope for which this constraint is evaluated." /></th>
                          <th className="audit-num">Checked<InfoTip text="Total number of (constraint, object) instances evaluated." /></th>
                          <th className="audit-num">Violated<InfoTip text="Number of instances where the constraint was not satisfied." /></th>
                          <th className="audit-num">Violation Rate<InfoTip text="Violated ÷ Checked — fraction of instances that violated this constraint." /></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const sorted = (confData.constraint_results || []).sort((a,b) => (b.violation_rate||0)-(a.violation_rate||0));
                          const violRates = sorted.map(r => r.violation_rate).filter(v => v != null);
                          const violCounts = sorted.map(r => r.violated).filter(v => v != null && v > 0);
                          return sorted.map((r,i) => (
                          <tr key={i}>
                            <td style={{fontSize:'0.72rem',fontFamily:'monospace',color:'#475569'}}>{r.constraint}</td>
                            <td className="audit-num" style={{color:'#64748b',fontSize:'0.7rem'}}>{r.scope_type || '—'}</td>
                            <td className="audit-num">{r.checked}</td>
                            <td className="audit-num" style={{color: r.violated > 0 ? normColor(r.violated, violCounts, false) : '#16a34a'}}>{r.violated}</td>
                            <td className="audit-num">
                              <span style={{color: r.violation_rate == null ? '#94a3b8' : normColor(r.violation_rate, violRates, false), fontWeight:600}}>
                                {r.violation_rate == null ? '—' : fmtPct(r.violation_rate)}
                              </span>
                            </td>
                          </tr>
                          ));
                        })()}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </Collapsible>

          {/* ── OCPQ Analysis ── */}
          <Collapsible className="eval-section" title="OCPQ Analysis" defaultOpen={false}>
            <div style={{padding:'0.75rem 0'}}>
              <OCPQPanel results={rAsis} onTotalsComputed={setOcpqTotals} />
            </div>
          </Collapsible>
        </>
      )}

      {evalTab === 'time' && (
        <>
          {/* Distribution & Cross-Log Fidelity — merged */}
          {inputEventLogFile && (() => {
        const ksColor = (v) => v == null ? '#64748b' : v < 0.1 ? '#16a34a' : v < 0.2 ? '#d97706' : '#dc2626';
        const allRows = distFidAsis?.activity_rows || [];
        const fmtPct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
        const pctCls = d => d == null ? '' : Math.abs(d) < 10 ? 'cmp-ok' : Math.abs(d) < 30 ? 'cmp-under' : 'cmp-over';
        return (
          <div style={{background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:'8px', padding:'0.65rem 0.75rem', marginBottom:'0.75rem'}}>
            <div style={{display:'flex', alignItems:'center', gap:'0.5rem', marginBottom:'0.4rem', flexWrap:'wrap', cursor:'pointer', userSelect:'none'}} onClick={() => setDistFidOpen(o => !o)}>
              <span style={{fontSize:'0.7rem', color:'#94a3b8', flexShrink:0}}>{distFidOpen ? '▼' : '▶'}</span>
              <span style={{fontSize:'0.72rem', fontWeight:700, color:'#475569', whiteSpace:'nowrap'}}>
                Distribution Fidelity (sim vs real log)
              </span>
              <span style={{fontSize:'0.65rem', color:'#94a3b8'}}>
                W1/KS on sojourn times · KL divergence on activity &amp; object distributions · EMD on timing
              </span>
              {(distFidLoading || xlogLoading) && <span style={{marginLeft:'auto', fontSize:'0.7rem', color:'#94a3b8', whiteSpace:'nowrap'}}>Computing…</span>}
            </div>
            {distFidError && <p style={{color:'#dc2626', fontSize:'0.7rem', margin:'0 0 0.4rem'}}>{distFidError}</p>}
            {xlogError   && <p style={{color:'#dc2626', fontSize:'0.7rem', margin:'0 0 0.4rem'}}>{xlogError}</p>}

            {/* Always-visible summary cards — stacked rows */}
            {(distFidAsis || xlogData) && (
              <div style={{display:'flex', flexDirection:'column', gap:'0.4rem', marginBottom:'0.5rem'}}>
                {/* Row 1: Overall W1 */}
                {distFidAsis && (
                  <div style={{display:'flex', gap:'0.5rem', flexWrap:'wrap'}}>
                    <div className="compare-metric-card" style={{minWidth:'120px'}}>
                      <div className="compare-metric-label">Overall W1 (timing)<InfoTip text="Wasserstein-1 distance between the per-activity sojourn time distributions of the simulated and real log. Computed as a weighted mean over all activities (weight = real-log sample count). Lower is better; unit is seconds." /></div>
                      <div className="compare-metric-asis">{fmtDur(distFidAsis.overall_w1_s)}</div>
                    </div>
                  </div>
                )}
                {/* Row 2: Overall KS */}
                {distFidAsis && (
                  <div style={{display:'flex', gap:'0.5rem', flexWrap:'wrap'}}>
                    <div className="compare-metric-card" style={{minWidth:'100px'}}>
                      <div className="compare-metric-label">Overall KS (sojourn)<InfoTip text="Kolmogorov-Smirnov statistic comparing per-activity sojourn time distributions. Weighted mean over all activities (weight = real-log sample count). Range 0–1; lower is better (0 = identical distributions, >0.2 = high divergence)." /></div>
                      <div className="compare-metric-asis" style={{color: ksColor(distFidAsis.overall_ks_s)}}>
                        {distFidAsis.overall_ks_s?.toFixed(3) ?? '—'}
                      </div>
                    </div>
                  </div>
                )}
                {/* Row 3: Activity KL Div. | Object Type KL Div. | Timing EMD */}
                {xlogData && (
                  <div style={{display:'flex', gap:'0.5rem', flexWrap:'wrap'}}>
                    {[
                      {label:'Activity KL Div.',    val: xlogData.activity_kl_divergence?.toFixed(4),    tip:'KL divergence between simulated and real per-activity frequency distributions. 0 = identical; lower is better.'},
                      {label:'Object Type KL Div.', val: xlogData.object_type_kl_divergence?.toFixed(4), tip:'KL divergence between simulated and real object type count distributions. 0 = identical; lower is better.'},
                      {label:'Timing EMD',         val: xlogData.timing_emd_s != null ? fmtDur(xlogData.timing_emd_s) : '—',   tip:'Earth Mover\'s Distance (Wasserstein-1) on inter-event time gaps between simulation and real log. Lower is better.'},
                    ].map(({label,val,tip}) => (
                      <div key={label} className="compare-metric-card" style={{minWidth:'110px'}}>
                        <div className="compare-metric-label">{label}<InfoTip text={tip} /></div>
                        <div className="compare-metric-asis">{val ?? '—'}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Expandable detail content */}
            {distFidOpen && (
              <div style={{display:'flex',flexDirection:'column',gap:'0.75rem',marginTop:'0.25rem'}}>
                {/* Per-activity sojourn table */}
                {distFidAsis && allRows.length > 0 && (
                  <div style={{maxHeight:'260px', overflowY:'auto', fontSize:'0.7rem'}}>
                    <table style={{width:'100%', borderCollapse:'collapse'}}>
                      <thead>
                        <tr style={{background:'#f1f5f9', position:'sticky', top:0}}>
                          <th style={{textAlign:'left', padding:'3px 6px', fontWeight:600, color:'#475569'}}>Activity</th>
                          <th style={{textAlign:'right', padding:'3px 6px', fontWeight:600, color:'#475569'}}>Real n</th>
                          <th style={{textAlign:'right', padding:'3px 6px', fontWeight:600, color:'#475569'}}>Sim n</th>
                          <th style={{textAlign:'right', padding:'3px 6px', fontWeight:600, color:'#475569'}}>W1 (timing)<InfoTip text="Wasserstein-1 distance between sojourn time distributions for this activity. Sojourn = backward gap to the last event sharing an object. Unit: seconds; lower = closer match to the real log." /></th>
                          <th style={{textAlign:'right', padding:'3px 6px', fontWeight:600, color:'#475569'}}>KS (sojourn)<InfoTip text="Kolmogorov-Smirnov statistic on sojourn time distributions for this activity. Range 0–1; lower = closer match." /></th>
                        </tr>
                      </thead>
                      <tbody>
                        {allRows.map((row, i) => {
                          const fmtVal = (v, isDur) => v != null ? (isDur ? fmtDur(v) : v.toFixed(3)) : '—';
                          const valColor = (v) => v != null ? '#334155' : '#94a3b8';
                          return (
                            <tr key={row.activity} style={{background: i%2===0?'#fff':'#f8fafc', borderBottom:'1px solid #f1f5f9'}}>
                              <td style={{padding:'3px 6px', color:'#334155'}}>{row.activity}</td>
                              <td style={{padding:'3px 6px', textAlign:'right', color:'#64748b'}}>{row.real_n}</td>
                              <td style={{padding:'3px 6px', textAlign:'right', color:'#64748b'}}>{row.sim_n}</td>
                              <td style={{padding:'3px 6px', textAlign:'right', color: valColor(row.w1_s)}}>{fmtVal(row.w1_s, true)}</td>
                              <td style={{padding:'3px 6px', textAlign:'right', color: valColor(row.ks_s)}}>{fmtVal(row.ks_s, false)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Cross-log detail content */}
                {!rAsis?.output_file ? (
                  <p className="empty-notice">No simulation output — run a simulation first.</p>
                ) : (distFidAsis || xlogData) && (
                  <div style={{display:'flex',flexDirection:'column',gap:'0.75rem'}}>
                    <div style={{display:'flex',gap:'1rem',flexWrap:'wrap'}}>
                      {distFidAsis && [
                        {label:'Real Events',  val: distFidAsis.real_event_count?.toLocaleString()},
                        {label:'Sim Events',   val: distFidAsis.sim_event_count?.toLocaleString()},
                      ].map(({label,val}) => (
                        <div key={label} className="behavior-stat-card" style={{minWidth:'110px'}}>
                          <div className="behavior-stat-val">{val ?? '—'}</div>
                          <div className="behavior-stat-label">{label}</div>
                        </div>
                      ))}
                      {xlogData && [
                        {label:'Real Events (xlog)', val: xlogData.real_event_count?.toLocaleString()},
                        {label:'Sim Events (xlog)',  val: xlogData.sim_event_count?.toLocaleString()},
                      ].map(({label,val}) => (
                        <div key={label} className="behavior-stat-card" style={{minWidth:'110px'}}>
                          <div className="behavior-stat-val">{val ?? '—'}</div>
                          <div className="behavior-stat-label">{label}</div>
                        </div>
                      ))}
                    </div>
                    {xlogData && (<>
                    {xlogData.timing_summary && (
                      <details>
                        <summary style={{fontSize:'0.78rem',fontWeight:600,cursor:'pointer',color:'#475569'}}>Timing Summary</summary>
                        <div style={{display:'flex',gap:'1rem',flexWrap:'wrap',marginTop:'0.5rem'}}>
                          {[
                            {label:'Real Mean Gap',   val: fmtDur(xlogData.timing_summary.real_gap_mean_s)},
                            {label:'Sim Mean Gap',    val: fmtDur(xlogData.timing_summary.sim_gap_mean_s)},
                            {label:'Real Median Gap', val: fmtDur(xlogData.timing_summary.real_gap_median_s)},
                            {label:'Sim Median Gap',  val: fmtDur(xlogData.timing_summary.sim_gap_median_s)},
                          ].map(({label,val}) => (
                            <div key={label} className="behavior-stat-card" style={{minWidth:'110px'}}>
                              <div className="behavior-stat-val">{val}</div>
                              <div className="behavior-stat-label">{label}</div>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    <details open>
                      <summary style={{fontSize:'0.78rem',fontWeight:600,cursor:'pointer',color:'#475569'}}>Activity Frequency Comparison</summary>
                      <div style={{overflowX:'auto',marginTop:'0.5rem'}}>
                        <table className="conf-detail-table" style={{width:'100%'}}>
                          <thead>
                            <tr>
                              <th style={{textAlign:'left',fontSize:'0.72rem'}}>Activity</th>
                              <th className="audit-num" title="Count in real log">Real Count</th>
                              <th className="audit-num" title="Count in sim log">Sim Count</th>
                              <th className="audit-num" title="Fraction in real log">Real Freq</th>
                              <th className="audit-num" title="Fraction in sim log">Sim Freq</th>
                              <th className="audit-num" title="Sim − Real in percentage points">Δ Freq</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(xlogData.activity_freq_table || []).map((row,i) => {
                              const diff = row.sim_freq - row.real_freq;
                              return (
                                <tr key={i}>
                                  <td style={{fontSize:'0.72rem',color:'#475569'}}>{row.activity}</td>
                                  <td className="audit-num">{row.real_count.toLocaleString()}</td>
                                  <td className="audit-num">{row.sim_count.toLocaleString()}</td>
                                  <td className="audit-num">{(row.real_freq*100).toFixed(1)}%</td>
                                  <td className="audit-num">{(row.sim_freq*100).toFixed(1)}%</td>
                                  <td className={`audit-num cmp-diff ${pctCls(diff*100)}`}>
                                    {diff >= 0 ? '+' : ''}{(diff*100).toFixed(1)}pp
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </details>
                    <details>
                      <summary style={{fontSize:'0.78rem',fontWeight:600,cursor:'pointer',color:'#475569'}}>Object Type Count Comparison</summary>
                      <div style={{overflowX:'auto',marginTop:'0.5rem'}}>
                        <table className="conf-detail-table" style={{width:'100%'}}>
                          <thead>
                            <tr>
                              <th style={{textAlign:'left',fontSize:'0.72rem'}}>Object Type</th>
                              <th className="audit-num">Real Count</th>
                              <th className="audit-num">Sim Count</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(xlogData.object_type_table || []).map((row,i) => (
                              <tr key={i}>
                                <td style={{fontSize:'0.72rem',color:'#475569'}}>{row.object_type}</td>
                                <td className="audit-num">{row.real_count.toLocaleString()}</td>
                                <td className="audit-num">{row.sim_count.toLocaleString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                    </>)}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

          {/* ── Multi-Seed Variance Analysis ── */}
          <Collapsible className="eval-section" title="Multi-Seed Variance Analysis" defaultOpen={false}>
            <p style={{fontSize:'0.8rem',color:'#64748b',marginBottom:'0.75rem'}}>
              Runs the simulation with multiple random seeds and reports mean ± std for key metrics,
              quantifying reproducibility and sensitivity to seed choice.
            </p>
            <div style={{display:'flex',gap:'0.5rem',alignItems:'center',flexWrap:'wrap',marginBottom:'0.75rem'}}>
              <label style={{fontSize:'0.78rem',color:'#475569',fontWeight:600}}>Seeds (comma-separated):</label>
              <input
                value={multiSeeds}
                onChange={e => setMultiSeeds(e.target.value)}
                style={{padding:'0.3rem 0.5rem',fontSize:'0.8rem',border:'1px solid #e2e8f0',borderRadius:'4px',width:'220px'}}
                placeholder="42, 99, 123, 456, 789"
              />
              <button className="simulate-button"
                style={{width:'auto',padding:'0.4rem 1rem',fontSize:'0.82rem',
                        background: multiLoading ? '#94a3b8' : '#6366f1'}}
                onClick={runMultiSeed} disabled={multiLoading || !safeStartActivities.length}>
                {multiLoading ? 'Running…' : 'Run Multi-Seed Analysis'}
              </button>
            </div>
            {!safeStartActivities.length && (
              <p style={{fontSize:'0.78rem',color:'#ca8a04'}}>Start activities not detected — load a discovery result first.</p>
            )}
            {multiError && <p style={{color:'#dc2626',fontSize:'0.8rem'}}>{multiError}</p>}
            {multiData && (
              <div style={{display:'flex',flexDirection:'column',gap:'1rem'}}>
                <div style={{overflowX:'auto'}}>
                  <table className="conf-detail-table" style={{width:'100%'}}>
                    <thead>
                      <tr>
                        <th title="Simulation metric name" style={{textAlign:'left',fontSize:'0.72rem'}}>Metric</th>
                        <th className="audit-num" title="Mean value across all seeds">Mean</th>
                        <th className="audit-num" title="Standard deviation across seeds — lower = more stable">Std Dev</th>
                        <th className="audit-num" title="Lowest value observed across all seeds">Min</th>
                        <th className="audit-num" title="Highest value observed across all seeds">Max</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(multiData.summary || {}).map(([key, s]) => (
                        <tr key={key}>
                          <td style={{fontSize:'0.72rem',color:'#475569'}}>{key.replace(/_/g,' ')}</td>
                          <td className="audit-num">{fmtNum(s.mean)}</td>
                          <td className="audit-num">{fmtNum(s.std)}</td>
                          <td className="audit-num">{fmtNum(s.min)}</td>
                          <td className="audit-num">{fmtNum(s.max)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {Object.keys(multiData.constraint_summary || {}).length > 0 && (
                  <details>
                    <summary style={{fontSize:'0.78rem',fontWeight:600,cursor:'pointer',color:'#475569'}}>Per-Constraint Fulfillment Rate (across seeds)</summary>
                    <table className="conf-detail-table" style={{width:'100%',marginTop:'0.5rem'}}>
                      <thead>
                        <tr>
                          <th title="Declarative constraint identifier" style={{textAlign:'left',fontSize:'0.72rem'}}>Constraint</th>
                          <th className="audit-num" title="Mean fulfillment rate across all seeds (Fulfilled ÷ (Fulfilled + Violated))">Mean Rate</th>
                          <th className="audit-num" title="Standard deviation of fulfillment rate across seeds — lower = more consistent">Std Dev</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(multiData.constraint_summary).map(([ck, s]) => (
                          <tr key={ck}>
                            <td style={{fontSize:'0.7rem',fontFamily:'monospace',color:'#475569'}}>{ck}</td>
                            <td className="audit-num">
                              <span style={{color: s.mean == null ? '#94a3b8' : s.mean >= 0.9 ? '#16a34a' : s.mean >= 0.7 ? '#ca8a04' : '#dc2626', fontWeight:600}}>
                                {s.mean != null ? fmtPct(s.mean) : '—'}
                              </span>
                            </td>
                            <td className="audit-num">{s.std != null ? `±${fmtPct(s.std)}` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
                <details>
                  <summary style={{fontSize:'0.78rem',fontWeight:600,cursor:'pointer',color:'#475569'}}>Per-Seed Breakdown</summary>
                  <div style={{overflowX:'auto',marginTop:'0.5rem'}}>
                    <table className="conf-detail-table" style={{width:'100%'}}>
                      <thead>
                        <tr>
                          <th className="audit-num" title="Random seed used for this simulation run">Seed</th>
                          <th className="audit-num" title="Total number of events fired in this run">Events</th>
                          <th className="audit-num" title="Total number of objects instantiated in this run">Objects</th>
                          <th className="audit-num" title="Number of object traces that completed (lifecycle ended)">Traces</th>
                          <th className="audit-num" title="Number of response-constraint obligations that were fulfilled">Obl. Fulfilled</th>
                          <th className="audit-num" title="Number of response-constraint obligations that were violated (case closed before target fired)">Obl. Violated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(multiData.runs || []).map(r => (
                          <tr key={r.seed}>
                            <td className="audit-num" style={{fontWeight:600}}>{r.seed}</td>
                            <td className="audit-num">{r.events_count.toLocaleString()}</td>
                            <td className="audit-num">{r.objects_count.toLocaleString()}</td>
                            <td className="audit-num">{r.completed_traces.toLocaleString()}</td>
                            <td className="audit-num" style={{color:'#16a34a'}}>{r.obligations_fulfilled}</td>
                            <td className="audit-num" style={{color: r.obligations_violated > 0 ? '#dc2626' : '#16a34a'}}>{r.obligations_violated}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            )}
          </Collapsible>
        </>
      )}

      {evalTab === 'log-comparison' && (
        <>
          {/* ── N-Gram Distance ── */}
          {inputEventLogFile && (() => {
        const ngdColor = v => v == null ? '#64748b' : v <= 0.1 ? '#16a34a' : v <= 0.3 ? '#d97706' : '#dc2626';
        const freqTable = xlogData?.activity_freq_table || [];
        const wmapeEventCount = (() => {
          const totalReal = freqTable.reduce((s, r) => s + (r.real_count || 0), 0);
          if (totalReal === 0) return null;
          const sumAbsErr = freqTable.reduce((s, r) => s + Math.abs((r.sim_count || 0) - (r.real_count || 0)), 0);
          return sumAbsErr / totalReal;
        })();
        return (
          <div style={{background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:'8px', padding:'0.65rem 0.75rem', marginBottom:'0.75rem'}}>
            <div style={{display:'flex', alignItems:'center', gap:'0.5rem', marginBottom:'0.4rem', flexWrap:'wrap'}}>
              <span style={{fontSize:'0.72rem', fontWeight:700, color:'#475569', whiteSpace:'nowrap'}}>
                N-Gram Distance (NGD, n=2)
              </span>
              <span style={{fontSize:'0.65rem', color:'#94a3b8'}}>
                consecutive activity pairs (bigrams) in object traces · sim vs real log
              </span>
              {ngdLoading && <span style={{marginLeft:'auto', fontSize:'0.7rem', color:'#94a3b8', whiteSpace:'nowrap'}}>Computing…</span>}
            </div>
            {ngdError && <p style={{color:'#dc2626', fontSize:'0.7rem', margin:'0 0 0.4rem'}}>{ngdError}</p>}
            {ngdData && (
              <div style={{display:'flex', gap:'0.5rem', marginBottom:'0.5rem', flexWrap:'wrap', alignItems:'flex-start'}}>
                <div className="compare-metric-card" style={{minWidth:'100px'}}>
                  <div className="compare-metric-label">NGD<InfoTip text="N-Gram Distance (n=2): counts every consecutive activity pair (bigram) in each object's trace — e.g. for an object appearing in Create→Approve→Pay, the bigrams are (Create→Approve) and (Approve→Pay). Compares how often each bigram occurs in sim vs real. Low NGD = the simulator produces realistic activity orderings; high NGD = transitions between activities differ from the real log. (Chapela-Campa et al., 2023)" /></div>
                  <div className="compare-metric-asis" style={{color: ngdColor(ngdData.ngd)}}>{ngdData.ngd.toFixed(4)}</div>
                </div>
                <div className="compare-metric-card" style={{minWidth:'90px'}}>
                  <div className="compare-metric-label">Unique bigrams<InfoTip text="Number of distinct activity bigrams (consecutive pairs) observed across both logs." /></div>
                  <div className="compare-metric-asis">{ngdData.uniqueNgrams}</div>
                </div>
                <div className="compare-metric-card" style={{minWidth:'90px'}}>
                  <div className="compare-metric-label">Real bigrams<InfoTip text="Total number of activity bigrams in the real (input) log." /></div>
                  <div className="compare-metric-asis">{ngdData.totalRealNgrams.toLocaleString()}</div>
                </div>
                <div className="compare-metric-card" style={{minWidth:'90px'}}>
                  <div className="compare-metric-label">Sim bigrams<InfoTip text="Total number of activity bigrams in the simulated log." /></div>
                  <div className="compare-metric-asis">{ngdData.totalSimNgrams.toLocaleString()}</div>
                </div>
                {wmapeEventCount != null && (
                  <div className="compare-metric-card" style={{minWidth:'110px'}}>
                    <div className="compare-metric-label">WMAPE (event count)<InfoTip text="Weighted Mean Absolute Percentage Error over per-activity event counts: Σ|sim−real| ÷ Σreal. Measures how closely the simulated activity frequencies match the real log. Lower is better." /></div>
                    <div className="compare-metric-asis" style={{color: wmapeEventCount <= 0.2 ? '#16a34a' : wmapeEventCount <= 0.5 ? '#d97706' : '#dc2626'}}>{(wmapeEventCount * 100).toFixed(1)}%</div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

          {/* ── Object Cardinality Fidelity ── */}
          {inputEventLogFile && (
            <div style={{background:'#f8fafc', border:'1px solid #e2e8f0', borderRadius:'8px', padding:'0.65rem 0.75rem', marginBottom:'0.75rem'}}>
              <div style={{display:'flex', alignItems:'center', gap:'0.5rem', marginBottom:'0.4rem', flexWrap:'wrap'}}>
                <span style={{fontSize:'0.72rem', fontWeight:700, color:'#475569', whiteSpace:'nowrap'}}>
                  Object Cardinality Fidelity
                </span>
                <span style={{fontSize:'0.65rem', color:'#94a3b8'}}>
                  objects per event — sim vs real log
                </span>
                {cardFidLoading && <span style={{marginLeft:'auto', fontSize:'0.7rem', color:'#94a3b8', whiteSpace:'nowrap'}}>Computing…</span>}
              </div>
              {cardFidError && <p style={{color:'#dc2626', fontSize:'0.7rem', margin:'0 0 0.4rem'}}>{cardFidError}</p>}
              {cardFidAsis?.table && (
                <table style={{width:'100%', borderCollapse:'collapse', fontSize:'0.71rem', color:'#334155'}}>
                  <thead>
                    <tr style={{background:'#f1f5f9', borderBottom:'1px solid #e2e8f0'}}>
                      <th style={{textAlign:'left', padding:'0.2rem 0.4rem', fontWeight:600}}>Activity</th>
                      <th style={{textAlign:'right', padding:'0.2rem 0.4rem', fontWeight:600}}>Real mean</th>
                      <th style={{textAlign:'right', padding:'0.2rem 0.4rem', fontWeight:600}}>Sim mean</th>
                      <th style={{textAlign:'right', padding:'0.2rem 0.4rem', fontWeight:600}}>Δ mean</th>
                      <th style={{textAlign:'right', padding:'0.2rem 0.4rem', fontWeight:600}}>Real n</th>
                      <th style={{textAlign:'right', padding:'0.2rem 0.4rem', fontWeight:600}}>Sim n</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cardFidAsis.table.map((row, i) => {
                      const absDiff = row.mean_diff != null ? Math.abs(row.mean_diff) : null;
                      const diffColor = absDiff == null ? '#64748b' : absDiff < 0.5 ? '#16a34a' : absDiff < 1.5 ? '#d97706' : '#dc2626';
                      return (
                        <tr key={i} style={{borderBottom:'1px solid #f1f5f9'}}>
                          <td style={{padding:'0.2rem 0.4rem'}}>{row.activity}</td>
                          <td style={{textAlign:'right', padding:'0.2rem 0.4rem'}}>{row.real?.mean?.toFixed(2) ?? '—'}</td>
                          <td style={{textAlign:'right', padding:'0.2rem 0.4rem'}}>{row.sim?.mean?.toFixed(2) ?? '—'}</td>
                          <td style={{textAlign:'right', padding:'0.2rem 0.4rem', color:diffColor, fontWeight:600}}>
                            {row.mean_diff != null ? (row.mean_diff >= 0 ? '+' : '') + row.mean_diff.toFixed(2) : '—'}
                          </td>
                          <td style={{textAlign:'right', padding:'0.2rem 0.4rem', color:'#64748b'}}>{row.real?.count ?? '—'}</td>
                          <td style={{textAlign:'right', padding:'0.2rem 0.4rem', color:'#64748b'}}>{row.sim?.count ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}

      {/* Coverage tab */}
      {evalTab === 'coverage' && (
        <OCCoveragePanel results={rAsis} model={activeModel || modelBase} discoveryResults={discoveryResults} logResults={inputLogCovResults} />
      )}

        </>
      )}
    </div>
  );
}

function EvaluationTab({ results, discoveryResults, activeModel, serviceTimeMode, simActivityObjectCounts, onConformanceSaved, onScoresComputed, eventLogFiles, handleFileUpload, inputLogConfResults, inputEventLogFile }) {
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

  const modeLabel = { minimum: 'Minimum [min–P25]', p25: 'P25 [min–P50]', p50: 'P50 IQR [P25–P75]', p75: 'P75 [P50–max]', mean: 'Full mean' };

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
                  {Math.floor(evalElapsed/60).toString().padStart(2,'0')}:{(evalElapsed%60).toString().padStart(2,'0')}
                </span>
              )}
              <span className="eval-progress-count">{doneCount} / {EVAL_STEPS.length}</span>
            </span>
          </div>
          <div className="eval-progress-steps">
            {EVAL_STEPS.map(s => (
              <span key={s.key} className={`eval-step-chip ${stepsDone[s.key] ? 'eval-step-done' : stepsLoading[s.key] ? 'eval-step-loading' : 'eval-step-pending'}`}>
                {stepsDone[s.key] ? '✓ ' : stepsLoading[s.key] ? '' : '○ '}{s.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Simulation Result ── */}
      {Object.keys(simMetrics).length > 0 && (
        <Collapsible className="eval-section" title="Simulation Result" defaultOpen={true}>
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
              onScoresComputed={scores => { setInlineConfScores(scores); onScoresComputed?.(scores); }}
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
                    <th title="Activity name">Activity</th>
                    <th title="Mean service duration from the input event log">Log mean</th>
                    <th title="Mean service duration from the simulation output">Sim mean</th>
                    <th title="Absolute percentage difference between log mean and sim mean: |Sim − Log| ÷ Log × 100%">|Δ|%</th>
                    {simDurs && Object.keys(simDurs).length > 0 && <>
                      <th title="Mean service duration discovered from the simulation output OCEL (post-hoc measurement)">Discovered mean</th>
                      <th title="Absolute percentage difference between log mean and discovered mean">Log vs Disc |Δ|%</th>
                    </>}
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

        {/* Activity Timeline — removed from evaluation; see Time collapsible in Results tab */}
      </Collapsible>

      {/* ── Constraint Analysis ── */}
      <ConstraintAnalysis activeModel={activeModel} results={results} />

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

// ── EditableCell — click to edit, blur/enter to save ─────────────────────────
function EditableCell({ value, onSave, type='text', options=null, style={}, placeholder='' }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const inputRef = React.useRef(null);

  const start = () => { setDraft(value ?? ''); setEditing(true); };
  const commit = () => {
    setEditing(false);
    const parsed = type === 'number' ? (draft === '' ? null : Number(draft)) : draft;
    if (parsed !== value) onSave(parsed);
  };
  const keyDown = e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); };
  React.useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);

  if (!editing) return (
    <span onClick={start} style={{cursor:'pointer',borderBottom:'1px dashed #94a3b8',minWidth:'1em',display:'inline-block',...style}}
      title="Click to edit">
      {value ?? <span style={{color:'#94a3b8'}}>—</span>}
    </span>
  );

  if (options) return (
    <select ref={inputRef} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={keyDown}
      style={{fontSize:'inherit',padding:'1px 2px',border:'1px solid #6366f1',borderRadius:'3px',background:'white'}}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );

  return (
    <input ref={inputRef} type={type} value={draft} placeholder={placeholder}
      onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={keyDown}
      style={{fontSize:'inherit',padding:'1px 3px',border:'1px solid #6366f1',borderRadius:'3px',
        width: type==='number' ? '70px' : '120px', background:'white'}} />
  );
}


// ── Sort helpers shared by all Behavior panels ───────────────────────────────
function useSortState() {
  const [s, setS] = React.useState({col:null,dir:null});
  const cycle = col => setS(p => p.col!==col ? {col,dir:'asc'} : p.dir==='asc' ? {col,dir:'desc'} : {col:null,dir:null});
  const set = (col, dir) => setS(col ? {col, dir} : {col:null, dir:null});
  return [s, cycle, set];
}
function sortedBy(arr, s, val) {
  if (!s.col) return arr;
  return [...arr].sort((a,b) => {
    const va=val(a,s.col), vb=val(b,s.col);
    const isNum = v => v!==''&&v!=null&&!isNaN(+v);
    const cmp = isNum(va)&&isNum(vb) ? +va - +vb : String(va??'').localeCompare(String(vb??''));
    return s.dir==='asc' ? cmp : -cmp;
  });
}
function SortHdr({col, s, cycle, children, style={}}) {
  const active = s.col===col;
  const icon = active&&s.dir==='asc' ? '▲' : active&&s.dir==='desc' ? '▼' : '⇅';
  return (
    <span onClick={()=>cycle(col)} title="Click to sort" style={{cursor:'pointer',userSelect:'none',display:'inline-flex',alignItems:'center',gap:'2px',...style}}>
      {children}<span style={{fontSize:'0.6em',opacity:active?1:0.4,color:active?'#6366f1':'#94a3b8'}}>{icon}</span>
    </span>
  );
}
function SortSelect({s, set, columns}) {  const val = s.col ? `${s.col}:${s.dir}` : 'log';
  const active = !!s.col;
  return (
    <div style={{display:'flex',alignItems:'center',gap:'0.3rem',padding:'0.3rem 0.5rem',
      background:'#f8fafc',border:'1px solid',borderColor:active?'#6366f1':'#e2e8f0',
      borderRadius:'6px',fontSize:'0.75rem',flexShrink:0}}>
      <span style={{color:'#64748b',fontWeight:600,flexShrink:0}}>Sort:</span>
      <select value={val}
        onChange={e => { const v=e.target.value; if(v==='log') set(null); else { const [col,dir]=v.split(':'); set(col,dir); } }}
        style={{fontSize:'0.73rem',border:'1px solid',borderRadius:'3px',padding:'1px 3px',
          background:active?'#eff6ff':'white',borderColor:active?'#6366f1':'#cbd5e1'}}>
        <option value="log">Event Log order</option>
        <optgroup label="Sort by column">
          {columns.flatMap(({col,label}) => [
            <option key={col+':asc'} value={col+':asc'}>{label} ↑ (A–Z / Low–High)</option>,
            <option key={col+':desc'} value={col+':desc'}>{label} ↓ (Z–A / High–Low)</option>,
          ])}
        </optgroup>
      </select>
    </div>
  );
}
function ColTip({ text, children }) {
  const [pos, setPos] = React.useState(null);
  return (
    <span style={{display:'inline-flex',alignItems:'center',gap:'2px'}}
      onMouseEnter={e => setPos({x:e.clientX,y:e.clientY})}
      onMouseMove={e => setPos({x:e.clientX,y:e.clientY})}
      onMouseLeave={() => setPos(null)}>
      {children}
      <span style={{cursor:'help',fontSize:'0.6em',fontWeight:700,color:'#94a3b8',border:'1px solid #cbd5e1',
        borderRadius:'50%',lineHeight:'13px',display:'inline-block',width:'13px',height:'13px',
        textAlign:'center',background:'white',userSelect:'none',flexShrink:0}}>?</span>
      {pos && ReactDOM.createPortal(
        <div style={{position:'fixed',left:Math.min(pos.x+12,window.innerWidth-256),
          top:Math.max(pos.y-10,4),background:'#1e293b',color:'white',fontSize:'0.72rem',
          padding:'0.35rem 0.5rem',borderRadius:'5px',whiteSpace:'pre-line',maxWidth:'240px',
          zIndex:9999,lineHeight:1.4,pointerEvents:'none',boxShadow:'0 2px 8px rgba(0,0,0,0.25)'}}>
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}

// ── BehaviorLegend — ? toggle button with inline popover ─────────────────────
function BehaviorLegend({ items }) {
  const [open, setOpen] = React.useState(false);
  return (
    <span style={{display:'inline-block',position:'relative',verticalAlign:'middle',marginLeft:'0.4rem'}}>
      <button onClick={() => setOpen(o => !o)}
        style={{fontSize:'0.7rem',padding:'0 5px',border:'1px solid #cbd5e1',borderRadius:'3px',
          background: open ? '#eff6ff' : 'white', color: open ? '#6366f1' : '#64748b',
          cursor:'pointer',lineHeight:'16px',fontWeight:600}}>
        ?
      </button>
      {open && (
        <div style={{
          position:'absolute',top:'calc(100% + 4px)',left:0,zIndex:200,
          background:'white',border:'1px solid #e2e8f0',borderRadius:'8px',
          boxShadow:'0 4px 20px rgba(0,0,0,0.12)',padding:'0.6rem 0.8rem',
          minWidth:'260px',maxWidth:'360px',fontSize:'0.74rem',color:'#475569',
        }}>
          <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:'0.2rem 0.6rem'}}>
            {items.map(([term, desc]) => (
              <React.Fragment key={term}>
                <span style={{fontWeight:700,color:'#1e293b',whiteSpace:'nowrap'}}>{term}</span>
                <span>{desc}</span>
              </React.Fragment>
            ))}
          </div>
          <button onClick={() => setOpen(false)}
            style={{marginTop:'0.4rem',fontSize:'0.7rem',padding:'1px 6px',border:'1px solid #e2e8f0',
              borderRadius:'3px',background:'#f8fafc',cursor:'pointer',color:'#64748b',float:'right'}}>
            close
          </button>
        </div>
      )}
    </span>
  );
}

// ── ModelInfoPopup — ℹ guide button for Base Model / Scenario Builder tabs ────
function ModelInfoPopup({ ocdeclareFile, eventLogFile, isScenario }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} style={{position:'relative',display:'inline-block',marginBottom:'0.6rem'}}>
      <button onClick={() => setOpen(o => !o)}
        style={{display:'inline-flex',alignItems:'center',gap:'0.3rem',fontSize:'0.75rem',
          padding:'3px 11px',border:'1px solid #bfdbfe',borderRadius:'20px',
          background:open?'#dbeafe':'#eff6ff',color:open?'#1d4ed8':'#3b82f6',
          cursor:'pointer',fontWeight:600}}>
        ℹ Model Guide
      </button>
      {open && (
        <div style={{position:'absolute',top:'calc(100% + 6px)',left:0,zIndex:300,
          background:'white',border:'1px solid #e2e8f0',borderRadius:'8px',
          boxShadow:'0 4px 24px rgba(0,0,0,0.13)',padding:'0.75rem 1rem',
          width:'370px',fontSize:'0.78rem',color:'#475569',lineHeight:1.6}}>
          <div style={{fontWeight:700,color:'#1e293b',marginBottom:'0.4rem',fontSize:'0.82rem'}}>Model Guide</div>
          <p style={{margin:'0 0 0.5rem'}}>
            The model is loaded from previously discovered constraints from{' '}
            <strong style={{color:'#1e293b'}}>{ocdeclareFile || '—'}</strong>{' '}
            based on <strong style={{color:'#1e293b'}}>{eventLogFile || '—'}</strong>.
          </p>
          <ul style={{margin:'0',paddingLeft:'1.1rem'}}>
            <li>To edit, click on the respective field.</li>
            <li>To add constraints, configure in the <strong>Constraints</strong> section.</li>
            <li>To add activities, configure in the <strong>Activities</strong> section.</li>
            <li>To add objects, configure in the <strong>Object Creation/Deactivation</strong> section.</li>
            <li>To remove constraints, activities or objects, click the removal button in their section.</li>
          </ul>
          {isScenario && (
            <p style={{margin:'0.5rem 0 0',paddingTop:'0.5rem',borderTop:'1px solid #f1f5f9'}}>
              To run, go to the <strong>Results</strong> tab and configure <strong>Stop Conditions</strong> and <strong>Random Seed</strong>, then press{' '}
              <strong>▶ Run Base Model</strong> or <strong>▶ Run Alternative Model</strong>.
            </p>
          )}
          <div style={{textAlign:'right',marginTop:'0.5rem'}}>
            <button onClick={() => setOpen(false)}
              style={{fontSize:'0.7rem',padding:'1px 8px',border:'1px solid #e2e8f0',
                borderRadius:'3px',background:'#f8fafc',cursor:'pointer',color:'#64748b'}}>
              close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ToBeDiffPanel — shows what changed between modelAsIs and modelToBe ────────
function ToBeDiffPanel({ modelAsIs, modelToBe, probMatrixBase, probMatrixToBe, startActivitiesAsIs, startActivitiesToBe }) {
  if (!modelAsIs || !modelToBe) return null;

  const chips = [];
  const chip = (label, kind) => chips.push({ label, kind }); // kind: 'add'|'remove'|'change'

  const asis = modelAsIs, tobe = modelToBe;
  const asActs = asis.activities || [], toActs = tobe.activities || [];
  const asActMap = Object.fromEntries(asActs.map(a => [a.name, a]));
  const toActMap = Object.fromEntries(toActs.map(a => [a.name, a]));

  // Activities added / removed
  toActs.forEach(a => { if (!asActMap[a.name]) chip(`+${a.name}`, 'add'); });
  asActs.forEach(a => { if (!toActMap[a.name]) chip(`−${a.name}`, 'remove'); });

  // Bindings changed
  toActs.forEach(a => {
    const asA = asActMap[a.name];
    if (!asA) return;
    const asBindings = Object.fromEntries((asA.bindings||[]).map(b=>[b.object_type,b]));
    const toBindings = Object.fromEntries((a.bindings||[]).map(b=>[b.object_type,b]));
    Object.entries(toBindings).forEach(([ot,b]) => {
      const ab = asBindings[ot];
      if (!ab) { chip(`${a.name}: +${ot}`, 'add'); return; }
      const diffs = [];
      if (b.creates !== ab.creates) diffs.push(`creates ${ab.creates}→${b.creates}`);
      if (b.deactivates !== ab.deactivates) diffs.push(`deactivates ${ab.deactivates}→${b.deactivates}`);
      if ((b.min_count||1) !== (ab.min_count||1)) diffs.push(`min ${ab.min_count||1}→${b.min_count||1}`);
      if ((b.max_count||null) !== (ab.max_count||null)) diffs.push(`max ${ab.max_count??'∞'}→${b.max_count??'∞'}`);
      if (diffs.length) chip(`${a.name}/${ot}: ${diffs.join(', ')}`, 'change');
    });
    Object.keys(asBindings).forEach(ot => { if (!toBindings[ot]) chip(`${a.name}: −${ot}`, 'remove'); });
  });

  // Constraints
  const conKey = c => `${c.constraint_type}|${c.source_activity||c.source}|${c.target_activity||c.target}|${c.scope?.object_type||''}`;
  const asCons = new Set((asis.constraints||[]).map(conKey));
  const toCons = new Set((tobe.constraints||[]).map(conKey));
  (tobe.constraints||[]).forEach(c => { if (!asCons.has(conKey(c))) chip(`+constraint ${c.constraint_type}(${c.source_activity}→${c.target_activity})`, 'add'); });
  (asis.constraints||[]).forEach(c => { if (!toCons.has(conKey(c))) chip(`−constraint ${c.constraint_type}(${c.source_activity}→${c.target_activity})`, 'remove'); });
  // nmin/nmax changes on existing constraints
  (tobe.constraints||[]).forEach(c => {
    const asC = (asis.constraints||[]).find(x => conKey(x) === conKey(c));
    if (!asC) return;
    const diffs = [];
    if ((c.nmin??1) !== (asC.nmin??1)) diffs.push(`nmin ${asC.nmin??1}→${c.nmin??1}`);
    if ((c.nmax??null) !== (asC.nmax??null)) diffs.push(`nmax ${asC.nmax??'∞'}→${c.nmax??'∞'}`);
    if (diffs.length) chip(`~${c.constraint_type}(${c.source_activity}→${c.target_activity}): ${diffs.join(', ')}`, 'change');
  });

  // Timing
  const asTiming = asis.activity_durations || {}, toTiming = tobe.activity_durations || {};
  Object.entries(toTiming).forEach(([act, d]) => {
    const ad = asTiming[act];
    if (!ad) { chip(`+timing ${act}`, 'add'); return; }
    const diffs = [];
    if ((d.dist_type||'lognormal') !== (ad.dist_type||'lognormal')) diffs.push(`dist ${ad.dist_type}→${d.dist_type}`);
    if (Math.abs((d.mean_seconds||0) - (ad.mean_seconds||0)) > 1) diffs.push(`mean ${Math.round(ad.mean_seconds||0)}→${Math.round(d.mean_seconds||0)}s`);
    if (Math.abs((d.std_seconds||0) - (ad.std_seconds||0)) > 1) diffs.push(`std ${Math.round(ad.std_seconds||0)}→${Math.round(d.std_seconds||0)}s`);
    if (diffs.length) chip(`~${act}: ${diffs.join(', ')}`, 'change');
  });

  // Probabilities
  if (probMatrixBase && probMatrixToBe) {
    Object.entries(probMatrixToBe).forEach(([src, tgts]) => {
      Object.entries(tgts||{}).forEach(([tgt, p]) => {
        const bp = (probMatrixBase[src]||{})[tgt] || 0;
        if (Math.abs(p - bp) > 0.01) chip(`~P(${src}→${tgt}) ${(bp*100).toFixed(0)}%→${(p*100).toFixed(0)}%`, 'change');
      });
    });
  }

  // O2O rules
  const o2oKey = r => `${r.source_type}|${r.target_type}`;
  const asO2O = Object.fromEntries((asis.o2o_rules||[]).map(r=>[o2oKey(r),r]));
  const toO2O = Object.fromEntries((tobe.o2o_rules||[]).map(r=>[o2oKey(r),r]));
  Object.entries(toO2O).forEach(([k,r]) => {
    if (!asO2O[k]) { chip(`+Obj-to-Obj ${r.source_type}→${r.target_type}`, 'add'); return; }
    const ar = asO2O[k]; const diffs = [];
    if ((r.min_links||0) !== (ar.min_links||0)) diffs.push(`min ${ar.min_links}→${r.min_links}`);
    if ((r.max_links??null) !== (ar.max_links??null)) diffs.push(`max ${ar.max_links??'∞'}→${r.max_links??'∞'}`);
    if (diffs.length) chip(`~Obj-to-Obj ${r.source_type}→${r.target_type}: ${diffs.join(', ')}`, 'change');
  });
  Object.keys(asO2O).forEach(k => { if (!toO2O[k]) { const r=asO2O[k]; chip(`−Obj-to-Obj ${r.source_type}→${r.target_type}`, 'remove'); }});

  // Resource types / pool sizes
  const asRes = new Set(asis.resource_types||[]), toRes = new Set(tobe.resource_types||[]);
  toRes.forEach(r => { if (!asRes.has(r)) chip(`+immutable ${r}`, 'add'); });
  asRes.forEach(r => { if (!toRes.has(r)) chip(`−immutable ${r}`, 'remove'); });
  (tobe.resource_types||[]).forEach(r => {
    const asp = (asis.resource_pool_sizes||{})[r], top = (tobe.resource_pool_sizes||{})[r];
    if (asp != null && top != null && asp !== top) chip(`~pool ${r}: ${asp}→${top}`, 'change');
  });

  // Start activities
  const asStart = new Set(startActivitiesAsIs||[]), toStart = new Set(startActivitiesToBe||[]);
  [...toStart].forEach(a => { if (!asStart.has(a)) chip(`+start ${a}`, 'add'); });
  [...asStart].forEach(a => { if (!toStart.has(a)) chip(`−start ${a}`, 'remove'); });

  const colors = { add:'#16a34a', remove:'#dc2626', change:'#d97706' };
  const bg = { add:'#f0fdf4', remove:'#fff1f2', change:'#fffbeb' };
  const border = { add:'#86efac', remove:'#fca5a5', change:'#fde68a' };

  return (
    <div style={{marginBottom:'0.75rem',padding:'0.5rem 0.75rem',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'7px',fontSize:'0.74rem'}}>
      <span style={{fontWeight:700,color:'#475569',marginRight:'0.5rem'}}>Changes vs Base Model:</span>
      {chips.length === 0
        ? <span style={{color:'#94a3b8'}}>No changes from Base Model</span>
        : <span style={{display:'inline-flex',gap:'0.3rem',flexWrap:'wrap'}}>
            {chips.map((c,i) => (
              <span key={i} style={{padding:'1px 7px',borderRadius:'10px',fontWeight:500,
                color:colors[c.kind],background:bg[c.kind],border:`1px solid ${border[c.kind]}`}}>
                {c.label}
              </span>
            ))}
          </span>
      }
    </div>
  );
}

// ── Constraint ↔ probability helpers ─────────────────────────────────────────
function syncProbMatrixForNewActivities(matrix, allActNames, newActs) {
  const updated = {...matrix};
  // Add each new activity as a source row (equal dist to all other activities).
  // Skip if onActivityAdded already populated it.
  newActs.forEach(name => {
    if (!(name in updated)) {
      const others = allActNames.filter(a => a !== name);
      const eq = others.length > 0 ? 1 / others.length : 1;
      const row = {};
      others.forEach(a => { row[a] = eq; });
      updated[name] = row;
    }
  });
  // Add each new activity as a target in all existing source rows at 0%.
  // Existing probabilities are not touched — user sets the new transitions explicitly.
  Object.keys(updated).forEach(src => {
    const missing = newActs.filter(a => a !== src && !Object.prototype.hasOwnProperty.call(updated[src] || {}, a));
    if (missing.length === 0) return;
    const row = {...(updated[src] || {})};
    missing.forEach(newAct => { row[newAct] = 0; });
    updated[src] = row;
  });
  return updated;
}

function applyConstraintsToProbMatrix(matrix, constraints) {
  if (!constraints || constraints.length === 0) return matrix;
  let m = {...matrix};
  constraints.forEach(c => {
    const { constraint_type: ct, source_activity: src, target_activity: tgt } = c;
    if (!src || !tgt) return;
    if (ct === 'chain_response' || ct === 'chain_succession') {
      m[src] = {[tgt]: 1.0};
    } else if (ct === 'not_chain_succession') {
      if (m[src]) {
        const row = {...m[src]};
        delete row[tgt];
        const total = Object.values(row).reduce((s, v) => s + v, 0);
        if (total > 1e-9) Object.keys(row).forEach(k => { row[k] /= total; });
        m[src] = row;
      }
    }
  });
  return m;
}

// ── BehaviorProbabilitiesPanel ────────────────────────────────────────────────
function BehaviorProbabilitiesPanel({ probMatrix, editMode, onUpdate, filters={}, onFiltersChange, allActivityNames, constraints=[] }) {
  const allSources = React.useMemo(() => {
    const keys = Object.keys(probMatrix || {});
    if (!allActivityNames) return keys;
    return [...new Set([...allActivityNames, ...keys])];
  }, [probMatrix, allActivityNames]);
  const filtSrc = filters.from_activity || '';
  const filtTgt = filters.to_activity || '';
  const [sortProb, cycleProb, setSortProb] = useSortState();

  const forcedSrcs = React.useMemo(() => {
    const m = {};
    (constraints || []).forEach(c => {
      if ((c.constraint_type === 'chain_response' || c.constraint_type === 'chain_succession') && c.source_activity && c.target_activity) {
        if (!m[c.source_activity]) m[c.source_activity] = new Set();
        m[c.source_activity].add(c.target_activity);
      }
    });
    return m;
  }, [constraints]);

  return (
    <div>
      <div className="behavior-section-title">Transition Probabilities
        <BehaviorLegend items={[
          ['From → To','Source and destination activity for this transition'],
          ['Probability','Fraction of times this transition is taken when the source fires (0–100%)'],
          ['Slider','Drag to adjust; other transitions in the same row scale proportionally to keep the total at 100%'],
          ['Note','Probabilities below 0.1% are hidden. The simulator adds a small epsilon so 0% transitions are never fully blocked.'],
        ]}/>
        {editMode && <span style={{fontSize:'0.72rem',color:'#6366f1',fontWeight:400,marginLeft:'0.5rem'}}>— drag slider or click value; row normalizes automatically</span>}
      </div>
      <div style={{display:'flex',gap:'0.4rem',alignItems:'stretch',marginBottom:'0.5rem'}}>
        <SortSelect s={sortProb} set={setSortProb} columns={[{col:'from',label:'From activity'}]}/>
        <TableFilterBar
          dimensions={[
            {key:'from_activity', label:'From', options: allSources},
            {key:'to_activity',   label:'To',   options: allSources},
          ]}
          filters={filters}
          onFiltersChange={onFiltersChange}
          style={{marginBottom:0,flex:1}}
        />
      </div>
      {allSources.length > 0 ? (
        <table className="behavior-table">
          <thead><tr>
            <th><ColTip text="Source activity — the activity that just fired to trigger this transition.">From</ColTip></th>
            <th><ColTip text="Destination activity — where the process continues next.">To</ColTip></th>
            <th style={{minWidth:'160px'}}><ColTip text="Fraction of times this transition is taken when the From activity fires (0–100%). All outgoing transitions sum to 100%.">Probability</ColTip></th>
          </tr></thead>
          <tbody>
            {sortedBy(allSources.filter(src => !filtSrc || src === filtSrc), sortProb, src => src).flatMap(src => {
              const targets = (probMatrix || {})[src] || {};
              const visEntries = Object.entries(targets).filter(([tgt, p]) => p >= 0 && Object.prototype.hasOwnProperty.call(targets, tgt) && (!filtTgt || tgt === filtTgt));
              const isSrcForced = !!forcedSrcs[src];
              if (visEntries.length === 0) {
                return [
                  <tr key={src+'-empty'}>
                    <td style={{fontWeight:600}}>{src}</td>
                    <td colSpan={2} style={{color:'#94a3b8',fontSize:'0.78rem',fontStyle:'italic'}}>— no outgoing transitions —</td>
                  </tr>
                ];
              }
              return visEntries.map(([tgt, p], i) => {
                const pct = (p * 100).toFixed(1);
                const isForced = isSrcForced && forcedSrcs[src].has(tgt);
                const isZero = p < 0.001;
                const updateProb = (newPct) => {
                  if (isForced) return;
                  const newVal = Math.min(1, Math.max(0, parseFloat(newPct)||0) / 100);
                  const row = {...targets};
                  const delta = newVal - (row[tgt]||0);
                  row[tgt] = newVal;
                  const others = visEntries.map(([k])=>k).filter(k=>k!==tgt);
                  const otherSum = others.reduce((s,k)=>s+(row[k]||0),0);
                  if (otherSum > 1e-9) others.forEach(k => { row[k] = Math.max(0,(row[k]||0) - delta*(row[k]/otherSum)); });
                  onUpdate(src, row);
                };
                return (
                  <tr key={src+'-'+tgt} style={isZero ? {opacity:0.5} : undefined}>
                    {i===0 ? <td rowSpan={visEntries.length} style={{fontWeight:600}}>{src}</td> : null}
                    <td style={{fontSize:'0.82rem'}}>{tgt}</td>
                    <td>
                      <div style={{display:'flex',alignItems:'center',gap:'0.4rem'}}>
                        <span style={{minWidth:'38px',fontSize:'0.82rem',fontWeight:600,color: isForced ? '#7c3aed' : '#1e293b'}}>
                          {editMode && !isForced ? <EditableCell value={pct} type="number" placeholder="0" onSave={updateProb}/> : pct+'%'}
                        </span>
                        {editMode && !isForced && <input type="range" min={0} max={100} step={0.5} value={parseFloat(pct)}
                          onChange={e=>updateProb(e.target.value)}
                          style={{flex:1,minWidth:'80px',maxWidth:'140px',accentColor:'#6366f1',cursor:'pointer'}}/>}
                        {editMode && isForced && <span title="Forced by chain_response / chain_succession constraint" style={{fontSize:'0.65rem',color:'#7c3aed',background:'#f3f0ff',border:'1px solid #c4b5fd',borderRadius:'3px',padding:'1px 5px',whiteSpace:'nowrap'}}>forced</span>}
                        {!editMode && <div style={{flex:1,height:'6px',background:'#e2e8f0',borderRadius:'3px',overflow:'hidden',maxWidth:'140px'}}>
                          <div style={{height:'100%',width:pct+'%',background: isForced ? '#7c3aed' : '#6366f1',borderRadius:'3px'}}/>
                        </div>}
                      </div>
                    </td>
                  </tr>
                );
              });
            })}
          </tbody>
        </table>
      ) : <p className="behavior-empty">No probability data.</p>}
    </div>
  );
}

// ── BehaviorActivitiesPanel ───────────────────────────────────────────────────
function BehaviorActivitiesPanel({ model, editMode, onUpdate, startActivities, onStartActivitiesChange, filters, onFiltersChange, foldable, onActivityAdded, onActivityDeleted }) {
  const [expandedRows, setExpandedRows] = React.useState(new Set());
  const [newActName, setNewActName] = React.useState('');
  const [newObjTypeName, setNewObjTypeName] = React.useState('');
  const [newBindings, setNewBindings] = React.useState({}); // actName → {ot, creates, deact}
  const [sortAct, cycleAct, setSortAct] = useSortState();
  const [folded, setFolded] = React.useState(true);

  const acts = model.activities || [];
  const allObjTypesRaw = (model.object_types || []).map(t => typeof t === 'string' ? t : t.name);
  const bindingObjTypes = [...new Set(acts.flatMap(a => (a.bindings||[]).map(b => b.object_type).filter(Boolean)))];
  const allObjTypes = [...new Set([...allObjTypesRaw, ...bindingObjTypes])].sort();
  const resSet = new Set(model.resource_types || []);
  const startSet = new Set(startActivities || []);

  const actFilters = filters || {};
  const visObjTypes = actFilters.object_type ? allObjTypes.filter(t => t === actFilters.object_type) : allObjTypes;
  const filteredActs = actFilters.activity ? acts.filter(a => a.name === actFilters.activity) : acts;
  const foldFiltered = foldable && folded ? filteredActs.filter(a => startSet.has(a.name)) : filteredActs;
  const visActs = sortedBy(foldFiltered, sortAct, (a) => a.name);

  const toggle = row => setExpandedRows(prev => {
    const n = new Set(prev); n.has(row) ? n.delete(row) : n.add(row); return n;
  });

  const updateActs = newActs => onUpdate({...model, activities: newActs});
  const updateAct = (name, patch) => updateActs(acts.map(a => a.name === name ? {...a, ...patch} : a));

  const toggleBinding = (actName, ot, field) => {
    updateActs(acts.map(a => a.name !== actName ? a : {
      ...a, bindings: (a.bindings||[]).map(b => b.object_type === ot ? {...b, [field]: !b[field]} : b)
    }));
  };
  const updateBindingField = (actName, ot, field, val) => {
    updateActs(acts.map(a => a.name !== actName ? a : {
      ...a, bindings: (a.bindings||[]).map(b => b.object_type === ot ? {...b, [field]: val} : b)
    }));
  };
  const deleteBinding = (actName, ot) => {
    updateActs(acts.map(a => a.name !== actName ? a : {
      ...a, bindings: (a.bindings||[]).filter(b => b.object_type !== ot)
    }));
  };
  const addBinding = actName => {
    const nb = newBindings[actName] || {};
    if (!nb.ot) return;
    updateActs(acts.map(a => a.name !== actName ? a : {
      ...a, bindings: [...(a.bindings||[]), {object_type: nb.ot, min_count: 1, max_count: null, creates: !!nb.creates, deactivates: !!nb.deact}]
    }));
    setNewBindings(prev => ({...prev, [actName]: {ot: '', creates: false, deact: false}}));
  };
  const deleteActivity = name => {
    const newDurations = {...(model.activity_durations || {})};
    delete newDurations[name];
    onUpdate({...model, activities: acts.filter(a => a.name !== name), activity_durations: newDurations});
    setExpandedRows(prev => { const n = new Set(prev); n.delete(name); return n; });
    onActivityDeleted?.(name);
  };
  const addActivity = () => {
    const name = newActName.trim();
    if (!name || acts.some(a => a.name === name)) return;
    const updatedModel = {
      ...model,
      activities: [...acts, {name, bindings:[]}],
      activity_durations: {
        ...(model.activity_durations || {}),
        [name]: { dist_type: 'lognormal', mean_seconds: null, std_seconds: null, min_seconds: 0, max_seconds: null },
      },
    };
    onUpdate(updatedModel);
    onActivityAdded?.(name, acts.map(a => a.name));
    setNewActName('');
  };
  const addObjectType = () => {
    const name = newObjTypeName.trim();
    if (!name || allObjTypes.includes(name)) return;
    const existing = model.object_types || [];
    onUpdate({...model, object_types: [...existing, {name, attributes:{}}]});
    setNewObjTypeName('');
  };
  const deleteObjectType = ot => {
    const existing = model.object_types || [];
    onUpdate({...model, object_types: existing.filter(t => (typeof t==='string'?t:t.name) !== ot)});
  };
  const toggleStart = name => {
    const cur = startActivities || [];
    onStartActivitiesChange(cur.includes(name) ? cur.filter(a=>a!==name) : [...cur, name]);
  };

  const inp = s => ({fontSize:'0.75rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px',...(s||{})});

  // Per-object-type lifecycle lookup for column tooltips
  const otLifecycle = React.useMemo(() => {
    const lc = {};
    allObjTypes.forEach(ot => { lc[ot] = { creates: [], deactivates: [] }; });
    acts.forEach(a => (a.bindings||[]).forEach(b => {
      if (!lc[b.object_type]) return;
      if (b.creates)     lc[b.object_type].creates.push(a.name);
      if (b.deactivates) lc[b.object_type].deactivates.push(a.name);
    }));
    return lc;
  }, [acts, allObjTypes]);

  return (
    <div>
      <div className="behavior-section-title">List of Activities
        <BehaviorLegend items={[
          ['+','Activity creates a new object of that type when it fires'],
          ['−','Activity deactivates (ends lifecycle of) that object when it fires'],
          ['●','Activity involves this type but neither creates nor deactivates it'],
          ['★','Start activity — simulation begins here'],
          ['R (superscript)','Immutable object type — fixed pool size, never deactivated (e.g. trucks, workers)'],
        ]}/>
        {editMode && <HelpTip text="Click any cell to toggle creates / deactivates. Click ▶ to expand a row and edit detailed bindings." />}
        {foldable && (
          <button onClick={() => setFolded(f => !f)} style={{marginLeft:'auto',fontSize:'0.72rem',color:'#64748b',background:'none',border:'1px solid #e2e8f0',borderRadius:'4px',padding:'0.1rem 0.5rem',cursor:'pointer'}}>
            {folded ? '▶ show all' : '▼ show selected'}
          </button>
        )}
      </div>
      <div style={{display:'flex',gap:'0.4rem',alignItems:'stretch',marginBottom:'0.5rem'}}>
        <SortSelect s={sortAct} set={setSortAct} columns={[{col:'name',label:'Activity name'}]}/>
        <TableFilterBar
          dimensions={[
            {key:'activity', label:'Activity', options: acts.map(a=>a.name)},
            {key:'object_type', label:'Object Type', options: allObjTypes},
          ]}
          filters={actFilters}
          onFiltersChange={onFiltersChange}
          style={{marginBottom:0,flex:1}}
        />
      </div>
      <div style={{overflowX:'auto',border:'1.5px solid #1e293b',borderRadius:'6px'}}>
        <table className="behavior-table">
          <thead>
            <tr>
              {editMode && <th style={{width:'18px'}}/>}
              <th style={{textAlign:'left',verticalAlign:'bottom'}}>
                <div style={{display:'flex',flexDirection:'column',gap:'1px'}}>
                  <span style={{fontSize:'0.62rem',color:'#16a34a',fontWeight:700,lineHeight:1}}>+ creates</span>
                  <span style={{fontSize:'0.62rem',color:'#dc2626',fontWeight:700,lineHeight:1}}>− deactivates</span>
                  <span style={{fontSize:'0.62rem',color:'#64748b',fontWeight:700,lineHeight:1}}>● involved in activity</span>
                  <ColTip text="Activity name. Expand a row (▶) to view and edit its object type bindings.">Activity</ColTip>
                </div>
              </th>
              {editMode && <th style={{textAlign:'center',verticalAlign:'bottom',height:'90px',padding:'0 4px',whiteSpace:'nowrap'}}>
                <div style={{writingMode:'vertical-rl',transform:'rotate(180deg)',display:'inline-block',fontSize:'0.7rem',fontWeight:600,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.04em',lineHeight:1.1}}>
                  <ColTip text="★ marks whether this activity can start a new case. The simulation begins from a randomly chosen start activity.">Start activity</ColTip>
                </div>
              </th>}
              {visObjTypes.map(ot => {
                const lc = otLifecycle[ot] || { creates: [], deactivates: [] };
                const tipLines = [
                  lc.creates.length    ? `Created: ${lc.creates.join(', ')}`     : null,
                  lc.deactivates.length ? `Deactivated: ${lc.deactivates.join(', ')}` : null,
                ].filter(Boolean);
                const tipText = (tipLines.length ? tipLines.join('\n') : `No creates or deactivates for "${ot}"`) + '\n\nAdd/remove object types in the Object Creation/Deactivation tab.';
                return (
                  <th key={ot} style={{textAlign:'center',verticalAlign:'bottom',height:'90px',padding:'0 4px',whiteSpace:'nowrap'}}>
                    <div style={{writingMode:'vertical-rl',transform:'rotate(180deg)',display:'inline-block',fontSize:'0.75rem',fontWeight:600,lineHeight:1.1}}>
                      <ColTip text={tipText}>{ot}{resSet.has(ot) && <sup style={{color:'#7c3aed',fontSize:'0.65em'}}>R</sup>}</ColTip>
                    </div>
                  </th>
                );
              })}
              {editMode && <th style={{width:'20px',textAlign:'center',verticalAlign:'bottom',height:'90px',padding:'0 4px',borderLeft:'1px solid #cbd5e1'}}>
                <div style={{writingMode:'vertical-rl',transform:'rotate(180deg)',display:'inline-block',fontSize:'0.65rem',fontWeight:600,color:'#fca5a5',textTransform:'uppercase',letterSpacing:'0.04em',lineHeight:1.1,whiteSpace:'nowrap'}}>
                  Remove Activity
                </div>
              </th>}
            </tr>
          </thead>
          <tbody>
            {visActs.map(a => {
              const isExp = expandedRows.has(a.name);
              const colSpan = 1 + (editMode?2:0) + visObjTypes.length + (editMode?1:0);
              return (
                <React.Fragment key={a.name}>
                  <tr style={{background: isExp ? '#f8fafc' : undefined}}>
                    {editMode && (
                      <td style={{textAlign:'center',cursor:'pointer',color:'#6366f1',fontWeight:700,fontSize:'0.8rem'}}
                        onClick={() => toggle(a.name)}>{isExp ? '▼' : '▶'}</td>
                    )}
                    <td style={{fontWeight:600,whiteSpace:'nowrap'}}>{a.name}</td>
                    {editMode && (
                      <td style={{textAlign:'center'}}>
                        <button onClick={() => toggleStart(a.name)} title={startSet.has(a.name)?'Remove start':'Mark start'}
                          style={{background:'none',border:'none',cursor:'pointer',fontSize:'0.9rem',color:startSet.has(a.name)?'#d97706':'#cbd5e1',padding:0}}>★</button>
                      </td>
                    )}
                    {visObjTypes.map(ot => {
                      const b = (a.bindings||[]).find(b => b.object_type === ot);
                      if (!b) return <td key={ot}/>;
                      const creates = b.creates, deact = b.deactivates;
                      if (creates && deact) return (
                        <td key={ot} style={{textAlign:'center'}}>
                          <span style={{color:'#d97706',fontWeight:700,cursor:editMode?'pointer':'default'}} onClick={()=>editMode&&toggleBinding(a.name,ot,'creates')}>+</span>
                          <span style={{color:'#64748b'}}>/</span>
                          <span style={{color:'#dc2626',fontWeight:700,cursor:editMode?'pointer':'default'}} onClick={()=>editMode&&toggleBinding(a.name,ot,'deactivates')}>−</span>
                        </td>
                      );
                      if (creates) return <td key={ot} style={{textAlign:'center',color:'#16a34a',fontWeight:700,cursor:editMode?'pointer':'default'}} onClick={()=>editMode&&toggleBinding(a.name,ot,'creates')}>+</td>;
                      if (deact)   return <td key={ot} style={{textAlign:'center',color:'#dc2626',fontWeight:700,cursor:editMode?'pointer':'default'}} onClick={()=>editMode&&toggleBinding(a.name,ot,'deactivates')}>−</td>;
                      return <td key={ot} style={{textAlign:'center',color:'#64748b',fontSize:'1rem',fontWeight:700}}>●</td>;
                    })}
                    {editMode && (
                      <td style={{textAlign:'center',borderLeft:'1px solid #cbd5e1'}}>
                        <button onClick={()=>deleteActivity(a.name)} style={{background:'none',border:'none',color:'#dc2626',cursor:'pointer',fontWeight:700,fontSize:'0.8rem',padding:0}}>×</button>
                      </td>
                    )}
                  </tr>
                  {isExp && editMode && (
                    <tr>
                      <td colSpan={colSpan} style={{padding:'0.5rem 0.75rem',background:'#f1f5f9',borderBottom:'2px solid #e2e8f0'}}>
                        <div style={{fontSize:'0.78rem',fontWeight:600,color:'#475569',marginBottom:'0.3rem'}}>Bindings for <em>{a.name}</em></div>
                        <table style={{width:'100%',fontSize:'0.75rem',borderCollapse:'collapse',marginBottom:'0.4rem'}}>
                          <thead><tr style={{borderBottom:'1px solid #e2e8f0'}}>
                            <th style={{textAlign:'left',padding:'2px 4px'}}>Object Type</th>
                            <th style={{textAlign:'center',padding:'2px 4px'}}>Creates</th>
                            <th style={{textAlign:'center',padding:'2px 4px'}}>Deactivates</th>
                            <th style={{textAlign:'center',padding:'2px 4px'}}>Min</th>
                            <th style={{textAlign:'center',padding:'2px 4px'}}>Max</th>
                            <th/>
                          </tr></thead>
                          <tbody>
                            {(a.bindings||[]).map((b,bi) => (
                              <tr key={bi} style={{borderBottom:'1px solid #f1f5f9'}}>
                                <td style={{padding:'2px 4px',fontWeight:500}}>{b.object_type}</td>
                                <td style={{textAlign:'center',padding:'2px 4px'}}><input type="checkbox" checked={!!b.creates} onChange={()=>toggleBinding(a.name,b.object_type,'creates')}/></td>
                                <td style={{textAlign:'center',padding:'2px 4px'}}><input type="checkbox" checked={!!b.deactivates} onChange={()=>toggleBinding(a.name,b.object_type,'deactivates')}/></td>
                                <td style={{textAlign:'center',padding:'2px 4px'}}><input type="number" value={b.min_count??1} min={0} style={inp({width:'40px'})} onChange={e=>updateBindingField(a.name,b.object_type,'min_count',parseInt(e.target.value)||1)}/></td>
                                <td style={{textAlign:'center',padding:'2px 4px'}}><input type="number" value={b.max_count??''} placeholder="∞" min={0} style={inp({width:'40px'})} onChange={e=>updateBindingField(a.name,b.object_type,'max_count',e.target.value===''?null:parseInt(e.target.value))}/></td>
                                <td><button onClick={()=>deleteBinding(a.name,b.object_type)} style={{background:'none',border:'none',color:'#dc2626',cursor:'pointer',fontWeight:700}}>×</button></td>
                              </tr>
                            ))}
                            <tr>
                              <td style={{padding:'2px 4px'}}>
                                <select value={(newBindings[a.name]||{}).ot||''} onChange={e=>setNewBindings(p=>({...p,[a.name]:{...(p[a.name]||{}),ot:e.target.value}}))} style={inp()}>
                                  <option value="">Add type…</option>
                                  {allObjTypes.filter(t=>!(a.bindings||[]).some(b=>b.object_type===t)).map(t=><option key={t} value={t}>{t}</option>)}
                                </select>
                              </td>
                              <td style={{textAlign:'center',padding:'2px 4px'}}><input type="checkbox" checked={!!(newBindings[a.name]||{}).creates} onChange={e=>setNewBindings(p=>({...p,[a.name]:{...(p[a.name]||{}),creates:e.target.checked}}))} /></td>
                              <td style={{textAlign:'center',padding:'2px 4px'}}><input type="checkbox" checked={!!(newBindings[a.name]||{}).deact} onChange={e=>setNewBindings(p=>({...p,[a.name]:{...(p[a.name]||{}),deact:e.target.checked}}))} /></td>
                              <td colSpan={2}/>
                              <td><button onClick={()=>addBinding(a.name)} style={{fontSize:'0.75rem',padding:'1px 6px',background:'#1e293b',color:'white',border:'none',borderRadius:'3px',cursor:'pointer'}}>+ Add</button></td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {editMode && (
        <div style={{marginTop:'0.75rem',display:'flex',flexDirection:'column',gap:'0.5rem'}}>
          {/* Add activity */}
          <div style={{display:'flex',gap:'0.4rem',alignItems:'center'}}>
            <input value={newActName} onChange={e=>setNewActName(e.target.value)} placeholder="New activity name…"
              style={inp({width:'180px'})} onKeyDown={e=>e.key==='Enter'&&addActivity()}/>
            <button onClick={addActivity} style={{fontSize:'0.75rem',padding:'2px 8px',background:'#1e293b',color:'white',border:'none',borderRadius:'3px',cursor:'pointer'}}>+ Add Activity</button>
          </div>
          <div style={{fontSize:'0.7rem',color:'#64748b',fontStyle:'italic'}}>
            To add or remove object types, use the <strong>Object Creation/Deactivation</strong> tab.
          </div>
        </div>
      )}

      {!editMode && (
        <div style={{marginTop:'0.5rem',fontSize:'0.72rem',color:'#64748b',display:'flex',gap:'1rem'}}>
          <span><span style={{color:'#16a34a',fontWeight:700}}>+</span> creates</span>
          <span><span style={{color:'#dc2626',fontWeight:700}}>−</span> deactivates</span>
          <span><span style={{color:'#d97706',fontWeight:700}}>+/−</span> both</span>
          <span><sup style={{color:'#7c3aed'}}>R</sup> immutable object</span>
        </div>
      )}
    </div>
  );
}


const BEHAVIOR_CTYPES = ['precedence','not_precedence','response','not_coexistence','chain_precedence','chain_response',
  'responded_existence','absence','exactly','init','exclusive_choice','succession','chain_succession',
  'not_succession','not_chain_succession','alternate_response','alternate_precedence','alternate_succession'];
const BEHAVIOR_SCOPE_KINDS = ['each','any','all'];
const BEHAVIOR_SCOPE_KIND_OPTS = [
  {value:'each', label:'each — per individual object'},
  {value:'any',  label:'any — at least one object'},
  {value:'all',  label:'all — every object'},
];
const BEHAVIOR_EMPTY_CON = {constraint_type:'',source_activity:'',target_activity:'',scope:{kind:'each',object_type:''},nmin:1,nmax:null,guard:null};

function AddObjectTypeForm({ model, onUpdate }) {
  const [newName, setNewName] = React.useState('');
  const allOts = (model?.object_types || []).map(t => typeof t === 'string' ? t : t.name);
  const add = () => {
    const n = newName.trim();
    if (!n || allOts.includes(n)) return;
    onUpdate({ ...model, object_types: [...(model.object_types || []), n] });
    setNewName('');
  };
  const del = ot => {
    const activities = (model.activities || []).map(a => ({
      ...a, bindings: (a.bindings || []).filter(b => b.object_type !== ot)
    }));
    onUpdate({ ...model, object_types: (model.object_types || []).filter(t => (typeof t === 'string' ? t : t.name) !== ot), activities });
  };
  return (
    <div style={{marginTop:'0.75rem',padding:'0.5rem 0',borderTop:'1px solid #e2e8f0'}}>
      <div style={{fontSize:'0.72rem',fontWeight:700,color:'#64748b',marginBottom:'0.4rem'}}>Add / Remove Object Types</div>
      <div style={{display:'flex',gap:'0.4rem',alignItems:'center',flexWrap:'wrap',marginBottom:'0.4rem'}}>
        {allOts.map(ot => (
          <span key={ot} style={{fontSize:'0.72rem',background:'#f1f5f9',border:'1px solid #e2e8f0',borderRadius:'12px',padding:'1px 8px',display:'inline-flex',alignItems:'center',gap:'3px'}}>
            {ot}
            <button onClick={() => del(ot)} style={{background:'none',border:'none',color:'#dc2626',cursor:'pointer',fontWeight:700,padding:0,fontSize:'0.7rem',lineHeight:1}}>×</button>
          </span>
        ))}
      </div>
      <div style={{display:'flex',gap:'0.4rem',alignItems:'center'}}>
        <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New type…"
          style={{fontSize:'0.75rem',padding:'2px 6px',border:'1px solid #cbd5e1',borderRadius:'3px',width:'120px'}}
          onKeyDown={e => e.key === 'Enter' && add()}/>
        <button onClick={add} style={{fontSize:'0.72rem',padding:'2px 8px',background:'#475569',color:'white',border:'none',borderRadius:'3px',cursor:'pointer'}}>+ Add</button>
      </div>
    </div>
  );
}

function AddO2ORuleForm({ otNames, onAdd }) {
  const [src, setSrc] = React.useState('');
  const [tgt, setTgt] = React.useState('');
  const [min, setMin] = React.useState(0);
  const [max, setMax] = React.useState('');
  const [bidir, setBidir] = React.useState(true);
  const inp = s => ({fontSize:'0.75rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px',...(s||{})});
  const add = () => {
    if (!src || !tgt || src === tgt) return;
    onAdd({source_type:src, target_type:tgt, min_links:min||0, max_links:max===''?null:parseInt(max), bidirectional:bidir});
    setSrc(''); setTgt(''); setMin(0); setMax(''); setBidir(true);
  };
  return (
    <div style={{marginTop:'0.75rem',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'6px',padding:'0.6rem 0.75rem'}}>
      <div style={{fontWeight:600,fontSize:'0.78rem',color:'#475569',marginBottom:'0.4rem'}}>Add Object-to-Object Relationship</div>
      <div style={{display:'flex',gap:'0.4rem',flexWrap:'wrap',alignItems:'center'}}>
        <select value={src} onChange={e=>setSrc(e.target.value)} style={inp()}>
          <option value="">From…</option>{otNames.map(o=><option key={o} value={o}>{o}</option>)}
        </select>
        <span style={{color:'#94a3b8'}}>→</span>
        <select value={tgt} onChange={e=>setTgt(e.target.value)} style={inp()}>
          <option value="">To…</option>{otNames.map(o=><option key={o} value={o}>{o}</option>)}
        </select>
        <span style={{fontSize:'0.72rem',color:'#64748b'}}>min</span>
        <input type="number" value={min} min={0} onChange={e=>setMin(parseInt(e.target.value)||0)} style={inp({width:'45px'})}/>
        <span style={{fontSize:'0.72rem',color:'#64748b'}}>max</span>
        <input type="number" value={max} placeholder="∞" min={0} onChange={e=>setMax(e.target.value)} style={inp({width:'45px'})}/>
        <label style={{fontSize:'0.75rem',display:'flex',alignItems:'center',gap:'3px'}}>
          <input type="checkbox" checked={bidir} onChange={e=>setBidir(e.target.checked)}/> ↔ bidir
        </label>
        <button onClick={add} style={{padding:'2px 8px',fontSize:'0.75rem',background:'#1e293b',color:'white',border:'none',borderRadius:'3px',cursor:'pointer'}}>+ Add</button>
      </div>
    </div>
  );
}


function constraintDescription(con) {
  const A = con.source_activity || 'Activity A';
  const B = con.target_activity || 'Activity B';
  const nmin = con.nmin ?? 1;
  const nmax = con.nmax;
  const scopeKind = con.scope?.kind || 'each';
  const scopeOt = con.scope?.object_type || '';
  const scopeStr = scopeOt
    ? ` for ${scopeKind === 'each' ? 'each' : scopeKind === 'any' ? 'any' : 'all'} **${scopeOt}** instance`
    : '';
  const nStr = nmax == null
    ? (nmin > 1 ? ` at least **${nmin}** time${nmin !== 1 ? 's' : ''}` : '')
    : (nmin === nmax
        ? ` exactly **${nmin}** time${nmin !== 1 ? 's' : ''}`
        : ` between **${nmin}** and **${nmax}** times`);
  switch (con.constraint_type) {
    case 'precedence':
      return `**${A}** must occur${nStr || ' at least once'} before **${B}** is allowed to fire${scopeStr}.`;
    case 'not_precedence':
      return `**${B}** must NOT be preceded by **${A}**${scopeStr}. If **${B}** fires, **${A}** must not have occurred before it.`;
    case 'response':
      return `Every time **${A}** occurs, **${B}** must eventually follow${nStr}${scopeStr}.`;
    case 'not_coexistence':
      return `**${A}** and **${B}** cannot both occur in the same trace${scopeStr}. Only one of them may fire.`;
    case 'chain_precedence':
      return `**${B}** can only occur if **${A}** was the immediately preceding activity${scopeStr}. Nothing may come between them.`;
    case 'chain_response':
      return `Every time **${A}** occurs, **${B}** must be the very next activity${scopeStr}. Nothing may come between them.`;
    case 'responded_existence':
      return `If **${A}** occurs, **${B}** must also occur at some point${nStr}${scopeStr} — before or after.`;
    case 'exclusive_choice':
      return `Either **${A}** or **${B}** must occur, but not both${scopeStr}. Exactly one of them may fire in a trace.`;
    case 'succession':
      return `**${A}** must precede **${B}**${scopeStr}, AND whenever **${A}** occurs **${B}** must eventually follow. Combines precedence and response.`;
    case 'chain_succession':
      return `**${A}** and **${B}** must always occur consecutively${scopeStr} — **${A}** immediately followed by **${B}**, with nothing in between.`;
    case 'not_succession':
      return `Once **${A}** fires, **${B}** must not occur afterward${scopeStr}.`;
    case 'not_chain_succession':
      return `**${A}** cannot be immediately followed by **${B}**${scopeStr}. Another activity must come between them.`;
    case 'alternate_response':
      return `Each occurrence of **${A}** must be followed by **${B}** before **${A}** can occur again${scopeStr}. They must strictly alternate.`;
    case 'alternate_precedence':
      return `Each occurrence of **${B}** must be preceded by **${A}**, with no other **${B}** in between${scopeStr}.`;
    case 'alternate_succession':
      return `**${A}** and **${B}** must strictly alternate${scopeStr} — each **${A}** followed by **${B}** before the next **${A}**, and vice versa.`;
    case 'absence':
      return nmax != null
        ? `**${A}** must occur at most **${nmax}** time${nmax !== 1 ? 's' : ''}${scopeStr}.`
        : `**${A}** must NOT occur at all${scopeStr}.`;
    case 'exactly':
      return `**${A}** must occur exactly **${nmin}** time${nmin !== 1 ? 's' : ''}${scopeStr} — no more, no less.`;
    case 'init':
      return `**${A}** must be the very first activity to fire${scopeStr}. No other activity may precede it.`;
    default:
      return `Constraint of type "${con.constraint_type}" on **${A}**${scopeStr}.`;
  }
}

function renderConstraintDesc(text) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? <strong key={i} style={{color:'#1e293b'}}>{part}</strong> : part
  );
}

function BehaviorConstraintsPanel({ constraints, actNames, otNames, editMode, onUpdate, filters={}, onFiltersChange, activities=[], onUpdateActivities=null }) {
  const [newCon, setNewCon] = React.useState(BEHAVIOR_EMPTY_CON);
  const [conErrors, setConErrors] = React.useState({});
  const [sortCon, cycleCon, setSortCon] = useSortState();
  const isUnary = t => ['absence','exactly','init'].includes(t);

  const updateCon = (i, patch) => onUpdate(constraints.map((x,j) => j===i ? {...x,...patch} : x));
  const deleteCon = i => onUpdate(constraints.filter((_,j) => j!==i));
  const addCon = () => {
    const errs = {};
    if (!newCon.constraint_type) errs.constraint_type = true;
    if (!newCon.source_activity) errs.source_activity = true;
    if (!isUnary(newCon.constraint_type) && !newCon.target_activity) errs.target_activity = true;
    if (Object.keys(errs).length > 0) { setConErrors(errs); return; }
    setConErrors({});
    onUpdate([...constraints, {...newCon}]);

    // Auto-add missing object binding if scope type is set
    const scopeOt = newCon.scope?.object_type;
    if (scopeOt && onUpdateActivities && activities.length > 0) {
      const involvedActs = [newCon.source_activity, ...(!isUnary(newCon.constraint_type) ? [newCon.target_activity] : [])].filter(Boolean);
      let changed = false;
      const newActs = activities.map(a => {
        if (!involvedActs.includes(a.name)) return a;
        const hasBinding = (a.bindings||[]).some(b => b.object_type === scopeOt);
        if (hasBinding) return a;
        changed = true;
        return {...a, bindings: [...(a.bindings||[]), {object_type: scopeOt, min_count: 1, max_count: null, creates: false, deactivates: false}]};
      });
      if (changed) onUpdateActivities(newActs);
    }

    setNewCon(BEHAVIOR_EMPTY_CON);
  };

  const sel = (val, opts, onChange) => (
    <select value={val} onChange={e=>onChange(e.target.value)}
      style={{fontSize:'0.75rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px'}}>
      {opts.map(o=><option key={o} value={o}>{o.replace(/_/g,' ')}</option>)}
    </select>
  );

  // Apply filters — keep original indices so delete/update work correctly
  const visConstraints = constraints.reduce((acc, c, i) => {
    if (filters.activity && c.source_activity !== filters.activity && c.target_activity !== filters.activity) return acc;
    if (filters.object_type && (c.scope?.object_type || c.scope_object_type || '') !== filters.object_type) return acc;
    if (filters.constraint_type && c.constraint_type !== filters.constraint_type) return acc;
    acc.push({c, origIdx: i});
    return acc;
  }, []);
  const sortedConstraints = sortedBy(visConstraints, sortCon, (item, col) => {
    const {c} = item;
    if (col==='type') return c.constraint_type||'';
    if (col==='source') return c.source_activity||'';
    if (col==='target') return c.target_activity||'';
    if (col==='scope') return c.scope?.object_type||c.scope_object_type||'';
    return '';
  });

  const conTypes = [...new Set(constraints.map(c => c.constraint_type))].sort();
  const scopeTypes = [...new Set(constraints.map(c => c.scope?.object_type || c.scope_object_type || '').filter(Boolean))].sort();

  return (
    <div>
      <div className="behavior-section-title">{constraints.length} Constraints
        <BehaviorLegend items={[
          ['Type','The declarative constraint flavour (precedence, response, not_coexistence, chain variants, etc.)'],
          ['Source','The activity that triggers or must precede/follow'],
          ['Target','The activity being constrained relative to Source'],
          ['Object Type','The object type whose instances are tracked — constraint is evaluated per-instance of this type'],
          ['Scope (each/any/all)','each = constraint holds per individual object; any = at least one object satisfies it; all = every object must satisfy it'],
          ['n≥','Minimum number of source firings required before target may fire (nmin). Default 1.'],
          ['n≤','Maximum allowed source firings before target must have fired (nmax). Blank = no upper bound.'],
        ]}/>
        {editMode && <span style={{fontSize:'0.72rem',color:'#6366f1',fontWeight:400,marginLeft:'0.5rem'}}>— click cells to edit, × to delete</span>}
      </div>
      {onFiltersChange && (
        <div style={{display:'flex',gap:'0.4rem',alignItems:'stretch',marginBottom:'0.5rem'}}>
          <SortSelect s={sortCon} set={setSortCon} columns={[
            {col:'type',label:'Type'},{col:'source',label:'Source'},
            {col:'target',label:'Target'},{col:'scope',label:'Object Type'},
          ]}/>
          <TableFilterBar
            dimensions={[
              {key:'activity',        label:'Activity',         options: actNames},
              ...(scopeTypes.length ? [{key:'object_type', label:'Object Type', options: scopeTypes}] : []),
              ...(conTypes.length > 1 ? [{key:'constraint_type', label:'Type', options: conTypes}] : []),
            ]}
            filters={filters}
            onFiltersChange={onFiltersChange}
            style={{marginBottom:0,flex:1}}
          />
        </div>
      )}
      {constraints.length > 0 ? (
        <div style={{overflowX:'auto',border:'1.5px solid #1e293b',borderRadius:'6px'}}>
          <table className="behavior-table con-table">
            <thead>
              <tr>
                {editMode && <th style={{width:'24px'}}/>}
                <th><ColTip text="Declarative constraint flavour (precedence, response, not_coexistence, chain variants…). Hover a badge in a row for its full description.">Type</ColTip></th>
                <th><ColTip text="The activity that triggers or must precede/follow the target.">Source</ColTip></th>
                <th><ColTip text="The activity being constrained relative to Source. Blank for unary constraints (absence, exactly, init).">Target</ColTip></th>
                <th><ColTip text="The object type whose instances are tracked — constraint is evaluated per individual instance of this type.">Object Type</ColTip></th>
                <th><ColTip text="each = holds per individual object; any = at least one object satisfies it; all = every object must satisfy it.">Scope</ColTip></th>
                <th><ColTip text="Minimum Source firings required before Target may fire (nmin). Default 1.">n≥</ColTip></th>
                <th><ColTip text="Maximum Source firings before Target must have fired (nmax). Blank = no upper bound.">n≤</ColTip></th>
                {false && <th><ColTip text="Optional attribute guard (OC-Declare): scope objects not satisfying this predicate are exempt from this constraint.">Guard</ColTip></th>}
              </tr>
            </thead>
            <tbody>
              {sortedConstraints.map(({c, origIdx}) => {
                const scopeOt = c.scope?.object_type || c.scope_object_type || '';
                const scopeKind = c.scope?.kind || 'each';
                // One row per (object type, involvement) binding. A multi-type
                // constraint is ONE constraint with several object types, each
                // carrying its own involvement — collapsing them into a single
                // row hid exactly the part that makes the constraint multi-type.
                const binds = scopeBindings(c.scope);
                const rows = binds.length ? binds : [[scopeOt, scopeKind]];
                const isMulti = rows.length > 1;
                const rowBg = /^(response|chain_response|alternate_response)$/.test(c.constraint_type) ? '#f0fdf4'
                  : /^(precedence|chain_precedence|alternate_precedence)$/.test(c.constraint_type) ? '#eff6ff'
                  : undefined;
                const groupStyle = {
                  ...(rowBg ? {background:rowBg} : {}),
                  ...(isMulti ? {borderLeft:'3px solid #6366f1'} : {}),
                };
                const span = rows.length;
                return (
                  <React.Fragment key={origIdx}>
                  {rows.map(([bType, bInv], bIdx) => (
                  <tr key={bIdx} style={bIdx === 0 ? groupStyle : {...(rowBg?{background:rowBg}:{}), ...(isMulti?{borderLeft:'3px solid #6366f1'}:{})}}>
                    {bIdx === 0 && editMode && <td rowSpan={span}><button onClick={()=>deleteCon(origIdx)} style={{background:'none',border:'none',color:'#dc2626',cursor:'pointer',fontWeight:700,padding:'0 3px'}}>×</button></td>}
                    {bIdx === 0 && <td rowSpan={span}>{editMode ? sel(c.constraint_type, BEHAVIOR_CTYPES, v=>updateCon(origIdx,{constraint_type:v})) : (<><span className="con-type-badge">{c.constraint_type}</span>{isMulti && <span title={`Multi-type constraint: all ${span} bindings must hold jointly`} style={{marginLeft:'0.35rem',fontSize:'0.62rem',fontWeight:700,color:'#4338ca',background:'#eef2ff',border:'1px solid #c7d2fe',borderRadius:'3px',padding:'0 3px'}}>{span}×</span>}</>)}</td>}
                    {bIdx === 0 && <td rowSpan={span}>{editMode ? sel(c.source_activity||actNames[0]||'', actNames, v=>updateCon(origIdx,{source_activity:v})) : (c.source_activity||'—')}</td>}
                    {bIdx === 0 && <td rowSpan={span}>{editMode
                      ? (isUnary(c.constraint_type) ? <span style={{color:'#94a3b8',fontSize:'0.75rem'}}>—</span>
                        : sel(c.target_activity||actNames[0]||'', actNames, v=>updateCon(origIdx,{target_activity:v})))
                      : (c.target_activity||'—')}</td>}
                    <td>{(editMode && !isMulti)
                      ? <select value={scopeOt} onChange={e=>updateCon(origIdx,{scope:{...c.scope,object_type:e.target.value}})}
                          style={{fontSize:'0.75rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px'}}>
                          <option value="">—</option>{otNames.map(o=><option key={o} value={o}>{o}</option>)}
                        </select>
                      : <span style={{fontWeight:bType?500:400,color:bType?'#1e293b':'#94a3b8'}}>
                          {bType || '—'}
                        </span>}
                    </td>
                    <td>{(editMode && !isMulti)
                      ? <select value={scopeKind} onChange={e=>updateCon(origIdx,{scope:{...c.scope,kind:e.target.value}})}
                          style={{fontSize:'0.75rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px'}}>
                          {BEHAVIOR_SCOPE_KIND_OPTS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      : <span style={{color:'#64748b',fontSize:'0.78rem'}}>{bInv || '—'}</span>}</td>
                    {bIdx === 0 && <td rowSpan={span}>{editMode ? <EditableCell value={c.nmin??1} type="number" onSave={v=>updateCon(origIdx,{nmin:v})}/> : (c.nmin??'—')}</td>}
                    {bIdx === 0 && <td rowSpan={span}>{editMode ? <EditableCell value={c.nmax??''} type="number" placeholder="∞" onSave={v=>updateCon(origIdx,{nmax:v===''||v===null?null:Number(v)})}/> : (c.nmax??'—')}</td>}
                    {false && <td style={{minWidth:'10rem'}}>
                      {editMode ? (
                        c.guard ? (
                          <span style={{display:'flex',gap:'0.2rem',alignItems:'center',flexWrap:'wrap'}}>
                            <input style={{width:'4.5rem',fontSize:'0.72rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px'}} placeholder="attr"
                              value={c.guard.attribute||''} onChange={e=>updateCon(origIdx,{guard:{...c.guard,attribute:e.target.value}})}/>
                            <select style={{fontSize:'0.72rem',padding:'1px 2px',border:'1px solid #cbd5e1',borderRadius:'3px'}} value={c.guard.op||'=='} onChange={e=>updateCon(origIdx,{guard:{...c.guard,op:e.target.value}})}>
                              {['==','!=','>','<','>=','<='].map(o=><option key={o} value={o}>{o}</option>)}
                            </select>
                            <input style={{width:'3.5rem',fontSize:'0.72rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px'}} placeholder="val"
                              value={c.guard.value??''} onChange={e=>updateCon(origIdx,{guard:{...c.guard,value:e.target.value}})}/>
                            <button onClick={()=>updateCon(origIdx,{guard:null})} style={{background:'none',border:'none',color:'#dc2626',cursor:'pointer',fontWeight:700,padding:'0 2px'}}>×</button>
                          </span>
                        ) : (
                          <button onClick={()=>updateCon(origIdx,{guard:{attribute:'',op:'==',value:''}})}
                            style={{fontSize:'0.72rem',padding:'1px 6px',border:'1px solid #cbd5e1',borderRadius:'3px',background:'#f8fafc',cursor:'pointer',color:'#475569'}}>
                            + guard
                          </button>
                        )
                      ) : (
                        c.guard
                          ? <span style={{fontSize:'0.72rem',color:'#6366f1',fontFamily:'monospace'}}>{c.guard.attribute} {c.guard.op} {c.guard.value}</span>
                          : <span style={{color:'#94a3b8',fontSize:'0.72rem'}}>—</span>
                      )}
                    </td>}
                  </tr>
                  ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="behavior-empty">No constraints in model.</p>}

      {editMode && (
        <div style={{marginTop:'0.75rem',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'6px',padding:'0.6rem 0.75rem'}}>
          <div style={{fontWeight:600,fontSize:'0.78rem',color:'#475569',marginBottom:'0.4rem'}}>Add Constraint</div>
          <div style={{display:'flex',gap:'1rem',alignItems:'flex-start'}}>
            <div style={{display:'flex',gap:'0.4rem',flexWrap:'wrap',alignItems:'center',flex:1}}>
              <select value={newCon.constraint_type} onChange={e=>{setNewCon(n=>({...n,constraint_type:e.target.value}));setConErrors(p=>({...p,constraint_type:false}));}}
                style={{fontSize:'0.75rem',padding:'1px 3px',borderRadius:'3px',
                  border:`1px solid ${conErrors.constraint_type ? '#ef4444' : '#cbd5e1'}`,
                  color:newCon.constraint_type?'inherit':'#94a3b8'}}>
                <option value="">constraint…</option>
                {BEHAVIOR_CTYPES.map(o=><option key={o} value={o}>{o.replace(/_/g,' ')}</option>)}
              </select>
              <select value={newCon.source_activity} onChange={e=>{setNewCon(n=>({...n,source_activity:e.target.value}));setConErrors(p=>({...p,source_activity:false}));}}
                style={{fontSize:'0.75rem',padding:'1px 3px',borderRadius:'3px',
                  border:`1px solid ${conErrors.source_activity ? '#ef4444' : '#cbd5e1'}`}}>
                <option value="">Source…</option>{actNames.map(a=><option key={a} value={a}>{a}</option>)}
              </select>
              {!isUnary(newCon.constraint_type) && <>
                <span style={{color:'#94a3b8',fontSize:'0.78rem'}}>→</span>
                <select value={newCon.target_activity} onChange={e=>{setNewCon(n=>({...n,target_activity:e.target.value}));setConErrors(p=>({...p,target_activity:false}));}}
                  style={{fontSize:'0.75rem',padding:'1px 3px',borderRadius:'3px',
                    border:`1px solid ${conErrors.target_activity ? '#ef4444' : '#cbd5e1'}`}}>
                  <option value="">Target…</option>{actNames.map(a=><option key={a} value={a}>{a}</option>)}
                </select>
              </>}
              <span style={{color:'#94a3b8',fontSize:'0.75rem'}}>scope:</span>
              <select value={newCon.scope.kind} onChange={e=>setNewCon(n=>({...n,scope:{...n.scope,kind:e.target.value}}))}
                style={{fontSize:'0.75rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px'}}>
                {BEHAVIOR_SCOPE_KIND_OPTS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select value={newCon.scope.object_type||''} onChange={e=>setNewCon(n=>({...n,scope:{...n.scope,object_type:e.target.value}}))}
                style={{fontSize:'0.75rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px'}}>
                <option value="">Object…</option>{otNames.map(o=><option key={o} value={o}>{o}</option>)}
              </select>
              <span style={{color:'#94a3b8',fontSize:'0.75rem'}}>n≥</span>
              <input type="number" value={newCon.nmin??1} min={0} onChange={e=>setNewCon(n=>({...n,nmin:parseInt(e.target.value)||0}))}
                style={{width:'45px',fontSize:'0.75rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px'}}/>
              <span style={{color:'#94a3b8',fontSize:'0.75rem'}}>n≤</span>
              <input type="number" value={newCon.nmax??''} placeholder="∞" min={0} onChange={e=>setNewCon(n=>({...n,nmax:e.target.value===''?null:parseInt(e.target.value)}))}
                style={{width:'45px',fontSize:'0.75rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px'}}/>
              {false && newCon.guard ? (
                <span style={{display:'flex',gap:'0.2rem',alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.72rem',color:'#64748b'}}>guard: if</span>
                  <input style={{width:'4.5rem',fontSize:'0.72rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px'}} placeholder="attr"
                    value={newCon.guard.attribute||''} onChange={e=>setNewCon(n=>({...n,guard:{...n.guard,attribute:e.target.value}}))}/>
                  <select style={{fontSize:'0.72rem',padding:'1px 2px',border:'1px solid #cbd5e1',borderRadius:'3px'}} value={newCon.guard.op||'=='} onChange={e=>setNewCon(n=>({...n,guard:{...n.guard,op:e.target.value}}))}>
                    {['==','!=','>','<','>=','<='].map(o=><option key={o} value={o}>{o}</option>)}
                  </select>
                  <input style={{width:'3.5rem',fontSize:'0.72rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px'}} placeholder="val"
                    value={newCon.guard.value??''} onChange={e=>setNewCon(n=>({...n,guard:{...n.guard,value:e.target.value}}))}/>
                  <button onClick={()=>setNewCon(n=>({...n,guard:null}))} style={{background:'none',border:'none',color:'#dc2626',cursor:'pointer',fontWeight:700,padding:'0 2px'}}>×</button>
                </span>
              ) : (
                false && <button onClick={()=>setNewCon(n=>({...n,guard:{attribute:'',op:'==',value:''}}))}
                  style={{fontSize:'0.72rem',padding:'1px 6px',border:'1px solid #cbd5e1',borderRadius:'3px',background:'#f8fafc',cursor:'pointer',color:'#475569'}}>
                  + guard
                </button>
              )}
              <button onClick={addCon}
                style={{padding:'0.2rem 0.6rem',fontSize:'0.78rem',background:'#1e293b',color:'white',border:'none',borderRadius:'4px',cursor:'pointer'}}>
                + Add
              </button>
            </div>
            <div style={{minWidth:'200px',maxWidth:'280px',background:'#eff6ff',border:'1px solid #bfdbfe',
              borderRadius:'5px',padding:'0.5rem 0.7rem',fontSize:'0.75rem',color:'#475569',lineHeight:1.6,flexShrink:0}}>
              <div style={{fontWeight:600,color:'#6366f1',fontSize:'0.71rem',marginBottom:'0.3rem',textTransform:'uppercase',letterSpacing:'0.04em'}}>What this means</div>
              {renderConstraintDesc(constraintDescription(newCon))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ── TableFilter — reusable filter bar for behavior tab tables ─────────────────
// dimensions: array of { key, label, options: [string] }
// filters: { [key]: string }  ('' = show all)
// onFiltersChange: (newFilters) => void
function TableFilterBar({ dimensions, filters, onFiltersChange, style={} }) {
  if (!dimensions || dimensions.length === 0) return null;
  const active = Object.values(filters).some(v => v !== '');
  return (
    <div style={{display:'flex',gap:'0.5rem',flexWrap:'wrap',alignItems:'center',
      padding:'0.35rem 0.5rem',background:'#f8fafc',border:'1px solid #e2e8f0',
      borderRadius:'6px',marginBottom:'0.5rem',fontSize:'0.75rem',...style}}>
      <span style={{color:'#64748b',fontWeight:600,flexShrink:0}}>Filter:</span>
      {dimensions.map(dim => (
        <label key={dim.key} style={{display:'flex',alignItems:'center',gap:'0.25rem',color:'#475569'}}>
          <span style={{flexShrink:0}}>{dim.label}</span>
          <select value={filters[dim.key]||''} onChange={e=>onFiltersChange({...filters,[dim.key]:e.target.value})}
            style={{fontSize:'0.74rem',padding:'1px 3px',border:'1px solid #cbd5e1',borderRadius:'3px',
              background: filters[dim.key] ? '#eff6ff' : 'white',
              borderColor: filters[dim.key] ? '#6366f1' : '#cbd5e1'}}>
            <option value="">All</option>
            {dim.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      ))}
      {active && (
        <button onClick={() => onFiltersChange(Object.fromEntries(dimensions.map(d => [d.key, ''])))}
          style={{fontSize:'0.72rem',padding:'1px 6px',border:'1px solid #e2e8f0',borderRadius:'3px',
            background:'white',cursor:'pointer',color:'#64748b',marginLeft:'auto'}}>
          × Clear
        </button>
      )}
    </div>
  );
}

// useTableFilter — derive filtered data from filter state
// filterDefs: { [key]: (item, value) => bool }
function useTableFilter(initialDimensions) {
  const [filters, setFilters] = React.useState({});
  const applyFilters = (items, filterDefs) => {
    return items.filter(item =>
      Object.entries(filters).every(([key, val]) => {
        if (!val) return true;
        const fn = filterDefs[key];
        return fn ? fn(item, val) : true;
      })
    );
  };
  return { filters, setFilters, applyFilters };
}

function BehaviorTimePanel({ durations, editMode, onUpdate }) {
  const [showLegend, setShowLegend] = React.useState(false);
  const [hoverState, setHoverState] = React.useState(null); // {act, x, y}
  const { filters, setFilters, applyFilters } = useTableFilter();
  const [sortTime, cycleTime, setSortTime] = useSortState();

  const actNames = Object.keys(durations);
  const distTypes = [...new Set(Object.values(durations).map(d => d.dist_type).filter(Boolean))];
  const filterDimensions = [
    { key: 'activity', label: 'Activity', options: actNames },
    ...(distTypes.length > 1 ? [{ key: 'dist_type', label: 'Distribution', options: distTypes }] : []),
  ];
  const filteredEntries = applyFilters(Object.entries(durations), {
    activity: ([act]) => act,
    dist_type: ([, d]) => d.dist_type || '',
  });
  const entries = sortedBy(filteredEntries, sortTime, ([act, d], col) => {
    if (col==='activity') return act;
    if (col==='mean') return d.mean_seconds??'';
    if (col==='std') return d.std_seconds??'';
    if (col==='logmean') return d.log_mean_seconds??'';
    return '';
  });

  const fmtDur = s => {
    if (s == null) return '—';
    if (s < 60) return (Math.abs(s % 1) < 0.005 ? Math.round(s) : s.toFixed(2)) + 's';
    if (s < 3600) return Math.floor(s/60) + 'm ' + Math.floor(s%60) + 's';
    if (s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
    return Math.floor(s/86400) + 'd';
  };

  const buildChartPath = (mean, std, w, h, distType='lognormal') => {
    if (!mean || mean <= 0) return null;
    const pts = 60;
    const PAD = 4;
    const dtype = (distType || 'lognormal').toLowerCase();
    let xMax, ys;

    if (dtype === 'fixed') {
      // Vertical line at mean
      const meanX = PAD + (w - PAD*2) * 0.5;
      return { path: `M ${meanX},${h-PAD} L ${meanX},${PAD}`, meanX, modeX: meanX, isFixed: true };
    } else if (dtype === 'exponential') {
      xMax = mean * 5;
      const xs = Array.from({length: pts}, (_, i) => (i / (pts-1)) * xMax);
      ys = xs.map(x => (1/mean) * Math.exp(-x/mean));
    } else if (dtype === 'normal') {
      xMax = mean + std * 3.5;
      const xMin = Math.max(0, mean - std * 3.5);
      const xs = Array.from({length: pts}, (_, i) => xMin + (i / (pts-1)) * (xMax - xMin));
      ys = xs.map(x => Math.exp(-((x-mean)**2)/(2*std**2))) ;
      const range = xMax - xMin;
      const points2 = xs.map((x, i) => {
        const maxY2 = Math.max(...ys, 1e-10);
        const px = PAD + ((x - xMin) / range) * (w - PAD*2);
        const py = (h - PAD) - (ys[i] / maxY2) * (h - PAD*2);
        return `${px.toFixed(1)},${py.toFixed(1)}`;
      });
      const meanX = PAD + ((mean - xMin) / range) * (w - PAD*2);
      return { path: `M ${points2.join(' L ')}`, meanX, modeX: meanX };
    } else {
      // lognormal (default)
      xMax = mean * 4;
      const sigma = std > 0 ? Math.min(std / mean, 1.8) : 0.4;
      const mu = Math.log(Math.max(mean, 1));
      const xs = Array.from({length: pts}, (_, i) => (i / (pts-1)) * xMax);
      ys = xs.map(x => {
        if (x <= 0) return 0;
        const lx = Math.log(x);
        return Math.exp(-((lx-mu)**2)/(2*sigma**2)) / (x * sigma * Math.sqrt(2*Math.PI));
      });
      const maxY = Math.max(...ys, 1e-10);
      const points = xs.map((x, i) => {
        const px = PAD + (x / xMax) * (w - PAD*2);
        const py = (h - PAD) - (ys[i] / maxY) * (h - PAD*2);
        return `${px.toFixed(1)},${py.toFixed(1)}`;
      });
      const meanX = PAD + (mean / xMax) * (w - PAD*2);
      const mode = Math.exp(mu - sigma**2);
      const modeX = PAD + (Math.min(mode, xMax) / xMax) * (w - PAD*2);
      return { path: `M ${points.join(' L ')}`, meanX, modeX };
    }

    const maxY = Math.max(...ys, 1e-10);
    const xs2 = Array.from({length: pts}, (_, i) => (i / (pts-1)) * xMax);
    const points = xs2.map((x, i) => {
      const px = PAD + (x / xMax) * (w - PAD*2);
      const py = (h - PAD) - (ys[i] / maxY) * (h - PAD*2);
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    });
    const meanX = PAD + (mean / xMax) * (w - PAD*2);
    return { path: `M ${points.join(' L ')}`, meanX, modeX: meanX };
  };

  return (
    <div>
      <div style={{display:'flex',alignItems:'center',gap:'0.75rem',marginBottom:'0.5rem'}}>
        <div className="behavior-section-title" style={{margin:0}}>Time</div>
        <button onClick={() => setShowLegend(l => !l)}
          style={{fontSize:'0.72rem',padding:'0.15rem 0.5rem',border:'1px solid #cbd5e1',borderRadius:'4px',background:'white',cursor:'pointer',color:'#475569'}}>
          ? Legend
        </button>
        <span style={{fontSize:'0.72rem',color:'#94a3b8'}}>Hover over an activity name to see its distribution shape</span>
      </div>
      {showLegend && (
        <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'6px',padding:'0.6rem 0.8rem',marginBottom:'0.75rem',fontSize:'0.75rem',color:'#475569'}}>
          <strong>Column guide:</strong>
          <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:'0.15rem 0.75rem',marginTop:'0.3rem'}}>
            <span style={{fontWeight:600}}>Distribution</span><span>Sampling shape — lognormal (right-skewed, always positive) is the default; exponential/fixed also available</span>
            <span style={{fontWeight:600}}>Mean (s)</span><span>Simulation parameter μ — expected service duration in seconds; this drives simulation</span>
            <span style={{fontWeight:600}}>Std (s)</span><span>Simulation parameter σ — spread around the mean; not used for exponential or fixed</span>
            <span style={{fontWeight:600}}>Log Mean</span><span>Mean observed in the input event log (reference only — does not affect simulation)</span>
            <span style={{fontWeight:600}}>Log Min / Max</span><span>Min and max durations observed in the log (reference bounds)</span>
          </div>
        </div>
      )}
      {Object.keys(durations).length > 0 ? (<>
        <div style={{display:'flex',gap:'0.4rem',alignItems:'stretch',marginBottom:'0.5rem'}}>
          <SortSelect s={sortTime} set={setSortTime} columns={[
            {col:'activity',label:'Activity'},{col:'mean',label:'Mean (s)'},
            {col:'std',label:'Std (s)'},{col:'logmean',label:'Log Mean'},
          ]}/>
          <TableFilterBar dimensions={filterDimensions} filters={filters} onFiltersChange={setFilters} style={{marginBottom:0,flex:1}}/>
        </div>
        <table className="behavior-table">
          <thead>
            <tr>
              <th><ColTip text="Activity whose duration this row configures. Hover the name to preview its distribution shape.">Activity</ColTip></th>
              <th><ColTip text="Sampling shape used in simulation. Lognormal (default) is right-skewed and always positive — recommended for process durations.">Distribution</ColTip></th>
              <th><ColTip text="Simulation parameter μ — expected service duration in seconds. This is the primary driver of simulation timing.">Mean (s)</ColTip></th>
              <th><ColTip text="Simulation parameter σ — spread around the mean. Not used for exponential or fixed distributions.">Std (s)</ColTip></th>
              <th style={{color:'#94a3b8'}}><ColTip text="Mean duration observed in the input event log (reference only — does not affect simulation).">Log Mean</ColTip></th>
              <th style={{color:'#94a3b8'}}><ColTip text="Minimum duration observed in the event log (reference lower bound, does not affect simulation).">Log Min</ColTip></th>
              <th style={{color:'#94a3b8'}}><ColTip text="Maximum duration observed in the event log (reference upper bound, does not affect simulation).">Log Max</ColTip></th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([act, d]) => {
              const E = editMode;
              return (
              <tr key={act} style={{background: hoverState?.act===act ? '#f1f5f9' : undefined}}>
                <td
                  style={{cursor:'default',position:'relative'}}
                  onMouseEnter={e => setHoverState({act, x: e.clientX, y: e.clientY})}
                  onMouseMove={e => setHoverState(h => h?.act===act ? {...h, x:e.clientX, y:e.clientY} : h)}
                  onMouseLeave={() => setHoverState(null)}
                >
                  <span style={{borderBottom:'1px dashed #94a3b8'}}>{act}</span>
                </td>
                <td>{E ? <EditableCell value={d.dist_type||'lognormal'} onSave={v=>onUpdate(act,'dist_type',v)} options={['lognormal','normal','exponential','fixed']}/> : (d.dist_type||'—')}</td>
                <td>{E ? <EditableCell value={d.mean_seconds!=null?Math.round(d.mean_seconds):''} type="number" placeholder="3600" onSave={v=>onUpdate(act,'mean_seconds',v)}/> : (d.mean_seconds!=null?Math.round(d.mean_seconds):'—')}</td>
                <td>{E ? <EditableCell value={d.std_seconds!=null?Math.round(d.std_seconds):''} type="number" placeholder="600" onSave={v=>onUpdate(act,'std_seconds',v)}/> : (d.std_seconds!=null?Math.round(d.std_seconds):'—')}</td>
                <td style={{color:'#94a3b8'}}>{d.log_mean_seconds != null ? Math.round(d.log_mean_seconds) : '—'}</td>
                <td style={{color:'#94a3b8'}}>{d.min_seconds != null ? Math.round(d.min_seconds) : '—'}</td>
                <td style={{color:'#94a3b8'}}>{d.max_seconds != null ? Math.round(d.max_seconds) : '—'}</td>
              </tr>
              );
            })}
          </tbody>
        </table>

        {/* Hover popup — rendered via portal to escape table stacking context */}
        {hoverState && (() => {
          const d = durations[hoverState.act];
          if (!d) return null;
          const W = 260, H = 120;
          const chart = buildChartPath(d.mean_seconds, d.std_seconds, W, H - 30, d.dist_type);
          // Position: prefer right of cursor, flip left if near edge
          const px = Math.min(hoverState.x + 12, window.innerWidth - W - 16);
          const py = Math.min(hoverState.y - 10, window.innerHeight - H - 16);
          return ReactDOM.createPortal(
            <div style={{
              position:'fixed', left:px, top:py, width:W, zIndex:9999,
              background:'white', border:'1px solid #e2e8f0', borderRadius:'8px',
              boxShadow:'0 4px 20px rgba(0,0,0,0.12)', padding:'0.6rem 0.8rem',
              pointerEvents:'none',
            }}>
              <div style={{fontWeight:700,fontSize:'0.78rem',color:'#1e293b',marginBottom:'0.3rem',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{hoverState.act}</div>
              {chart ? (
                <svg width={W-16} height={H-30} style={{display:'block',marginBottom:'0.4rem'}}>
                  <path d={chart.path} fill="none" stroke="#6366f1" strokeWidth="2"/>
                  {/* mean line */}
                  <line x1={chart.meanX} y1={0} x2={chart.meanX} y2={H-30} stroke="#dc2626" strokeWidth="1" strokeDasharray="3,2"/>
                  {/* mode line */}
                  {chart.modeX > 4 && <line x1={chart.modeX} y1={0} x2={chart.modeX} y2={H-30} stroke="#16a34a" strokeWidth="1" strokeDasharray="3,2"/>}
                </svg>
              ) : (
                <div style={{height:'60px',display:'flex',alignItems:'center',justifyContent:'center',color:'#94a3b8',fontSize:'0.72rem'}}>No shape data</div>
              )}
              <div style={{fontSize:'0.7rem',color:'#64748b',display:'flex',gap:'1rem',flexWrap:'wrap'}}>
                <span style={{color:'#6366f1'}}>— curve ({d.dist_type || 'lognormal'})</span>
                <span style={{color:'#dc2626'}}>— mean {d.mean_seconds != null ? fmtDur(Math.round(d.mean_seconds)) : '—'}</span>
                {chart?.modeX > 4 && <span style={{color:'#16a34a'}}>— mode</span>}
                {d.std_seconds != null && <span style={{color:'#64748b'}}>σ={fmtDur(Math.round(d.std_seconds))}</span>}
              </div>
            </div>,
            document.body
          );
        })()}
      </>) : <p className="behavior-empty">No timing data discovered.</p>}
    </div>
  );
}

function CaseTrackerTable({ entries, totalCases, totalDone, overallRate, fmtDur, fmtTs, activeModel }) {
  const [expandedAct, setExpandedAct] = React.useState(null);

  return (
    <table className="metrics-table">
      <thead>
        <tr>
          <th style={{width:'1.2rem'}}></th>
          <th>Start Activity</th>
          <th title="Number of case instances started">Cases</th>
          <th title="Cases where all spawned objects reached their terminal activity">Completed</th>
          <th title="Completed / total cases">Rate</th>
          <th title="Mean time from start event to last event of all spawned objects">Avg Duration</th>
          <th title="Shortest case duration">Min</th>
          <th title="Longest case duration">Max</th>
          <th title="Median case duration">Median</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([act, v]) => {
          const rate = Math.round(v.completion_rate * 100);
          const rateColor = rate >= 90 ? '#16a34a' : rate >= 60 ? '#d97706' : '#dc2626';
          const isExpanded = expandedAct === act;
          const hasCases = v.cases && v.cases.length > 0;
          return (
            <React.Fragment key={act}>
              <tr
                style={{cursor: hasCases ? 'pointer' : 'default'}}
                onClick={() => hasCases && setExpandedAct(isExpanded ? null : act)}
              >
                <td style={{textAlign:'center', color:'#94a3b8', fontSize:'0.75rem', userSelect:'none'}}>
                  {hasCases ? (isExpanded ? '▾' : '▸') : ''}
                </td>
                <td className="metrics-act-name">
                  <ActivityConstraintTooltip activityName={act} constraints={activeModel?.constraints} />
                </td>
                <td>{v.case_count.toLocaleString()}</td>
                <td>{v.completed.toLocaleString()}</td>
                <td style={{color: rateColor, fontWeight: 600}}>{rate}%</td>
                <td>{fmtDur(v.mean_duration_s)}</td>
                <td>{fmtDur(v.min_duration_s)}</td>
                <td>{fmtDur(v.max_duration_s)}</td>
                <td>{fmtDur(v.median_duration_s)}</td>
              </tr>
              {isExpanded && hasCases && (
                <tr>
                  <td colSpan={9} style={{padding:'0 0 0.5rem 1.5rem', background:'#f8fafc'}}>
                    {v.cases_capped && (
                      <p style={{fontSize:'0.73rem', color:'#94a3b8', margin:'0.4rem 0 0.25rem'}}>
                        Showing first 500 cases.
                      </p>
                    )}
                    <div style={{overflowX:'auto', maxHeight:'320px', overflowY:'auto'}}>
                      <table className="metrics-table" style={{fontSize:'0.75rem', marginBottom:0}}>
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Start</th>
                            <th>End</th>
                            <th>Duration</th>
                            <th title="All objects of this case completed their lifecycle">Done</th>
                            <th>Activity sequence</th>
                          </tr>
                        </thead>
                        <tbody>
                          {v.cases.map((c, i) => (
                            <tr key={i}>
                              <td style={{color:'#94a3b8'}}>{i + 1}</td>
                              <td style={{whiteSpace:'nowrap'}}>{fmtTs(c.start_ts)}</td>
                              <td style={{whiteSpace:'nowrap'}}>{fmtTs(c.end_ts)}</td>
                              <td style={{whiteSpace:'nowrap'}}>{fmtDur(c.duration_s)}</td>
                              <td style={{textAlign:'center'}}>{c.completed ? '✓' : '—'}</td>
                              <td>
                                <div style={{display:'flex', flexWrap:'wrap', gap:'2px'}}>
                                  {c.events.map((e, j) => (
                                    <span key={j} style={{
                                      display:'inline-flex', alignItems:'center', gap:'3px',
                                      background:'#e2e8f0', borderRadius:'3px',
                                      padding:'1px 5px', fontSize:'0.7rem', whiteSpace:'nowrap',
                                    }}>
                                      <span style={{fontWeight:500}}>{e.activity}</span>
                                      {e.timestamp && (
                                        <span style={{color:'#94a3b8', fontSize:'0.65rem'}}>
                                          @{e.timestamp.replace('T',' ').replace(/\.\d+.*$/,'')}
                                        </span>
                                      )}
                                    </span>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
      {entries.length > 1 && (
        <tfoot>
          <tr style={{fontWeight:600, borderTop:'2px solid #e2e8f0'}}>
            <td></td>
            <td>Total</td>
            <td>{totalCases.toLocaleString()}</td>
            <td>{totalDone.toLocaleString()}</td>
            <td style={{color: overallRate>=90?'#16a34a':overallRate>=60?'#d97706':'#dc2626', fontWeight:600}}>{overallRate}%</td>
            <td colSpan={4}></td>
          </tr>
        </tfoot>
      )}
    </table>
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
  const [paramDiscElapsed,  setParamDiscElapsed]  = useState(null); // seconds; null = never run
  const paramDiscStartRef = useRef(null);
  const paramDiscTimerRef = useRef(null);
  const [ocelLoadElapsed,   setOcelLoadElapsed]   = useState(null);
  const ocelLoadStartRef  = useRef(null);
  const ocelLoadTimerRef  = useRef(null);
  
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
  const [ocdeclareProgress, setOcdeclareProgress] = useState({ phase: '', pct: 0 });
  const [ocdeclareLog, setOcdeclareLog] = useState([]);
  const [ocdeclareElapsed,  setOcdeclareElapsed]  = useState(null);
  const ocdeclareStartRef = useRef(null);
  const ocdeclareTimerRef = useRef(null);
  const ocdeclarePollingRef = useRef(null);

  // Simulation state
  const [availableActivities, setAvailableActivities] = useState([]);
  const [startActivityCandidates, setStartActivityCandidates] = useState([]);
  const [tobeStartActivities, setTobeStartActivities] = useState([]);
  const [tobeStartActivityCaps, setTobeStartActivityCaps] = useState({});
  const [baseStartFolded, setBaseStartFolded] = useState(false);
  const [altStartFolded, setAltStartFolded] = useState(false);
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
    maxCases: '',
    maxRuntimeValue: '',          // wall-clock budget in MINUTES; '' disables it
    seed: 42,
    startActivities: [],
    startActivitiesLocked: false, // true once user explicitly toggles ★
    startActivityCaps: {},        // {activityName: maxFires | ''} — per-activity cap
  });
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulatingMode, setSimulatingMode] = useState(null); // 'asis' | 'tobe' | null
  const [liveStepCount, setLiveStepCount] = useState(null);
  const [liveSimTime,   setLiveSimTime]   = useState(null); // simulated time in seconds
  const [liveTraces,    setLiveTraces]    = useState(null); // completed object traces
  const [liveCases,     setLiveCases]     = useState(null); // completed cases (start-activity firings)
  const [liveActiveObjects,   setLiveActiveObjects]   = useState(null);
  const [liveObligations,     setLiveObligations]     = useState(null);
  const [liveDeactivPerStep,  setLiveDeactivPerStep]  = useState(null);
  const [liveObligFulfilledPerStep, setLiveObligFulfilledPerStep] = useState(null);
  // Live throughput samples, one per status poll (~1s):
  //   { t, ev, ob, cum } = elapsed wall seconds, events/s, objects created/s,
  //   cumulative events. Rates are WALL-clock — this measures how fast the
  //   simulator is running, not how dense the simulated process is.
  //   objects_count is len(state.objects), which is never shrunk (deactivation
  //   only flips obj.active), so its delta is genuinely objects created.
  const [throughput, setThroughput] = useState([]);
  const throughputRef = useRef({ startMs: null, lastMs: null, lastEvents: 0, lastObjects: 0 });
  // Per-start-activity firing progress, shown only for activities that were
  // given a cap: { activity: {fired, cap} }. Sourced from the run's own
  // _start_event_count_by_activity, the same counter the cap is enforced on.
  const [liveStartCaps, setLiveStartCaps] = useState(null);
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
  const [activityPopup, setActivityPopup] = useState(null);
  const [healthResult, setHealthResult] = useState(null);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);
  const [blockingResult, setBlockingResult] = useState(null);
  const [isAnalyzingBlocking, setIsAnalyzingBlocking] = useState(false);
  const [pressureResult, setPressureResult] = useState(null);
  const [isRunningPressure, setIsRunningPressure] = useState(false);
  const [pinpointResult, setPinpointResult] = useState(null);
  const [isPinpointing, setIsPinpointing] = useState(false);
  const [dryRunResult, setDryRunResult] = useState(null);
  const [isDryRunning, setIsDryRunning] = useState(false);
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

  // ── Model warnings (activities with no bindings) ──────────────────────────
  const bindingWarnings = activeModel
    ? (activeModel.activities || []).filter(a => !(a.bindings?.length))
    : [];
  const hasModelWarnings = bindingWarnings.length > 0;

  // ── Lifecycle warnings: object types with no creating and/or no terminating
  // activity. Both ends matter. A type nothing creates never comes into
  // existence, so every activity requiring it is dead. A type nothing
  // deactivates never leaves the active set, so it accumulates without bound —
  // and once work-in-progress caps are active it pins at its ceiling and
  // locks out its creating activity, which cascades upstream and can starve
  // the start activities themselves.
  //
  // Every object type is checked, resource/permanent types included: they are
  // treated like any other object here, so a type that repeats forever needs
  // its deactivation point supplied explicitly in the model.
  const lifecycleIssues = React.useMemo(() => {
    const activities = activeModel?.activities || [];
    const creatingTypes = new Set();
    const deactivatingTypes = new Set();
    const allBoundTypes = new Set();
    activities.forEach(act => {
      (act.bindings || []).forEach(b => {
        if (!b.object_type) return;
        allBoundTypes.add(b.object_type);
        if (b.creates) creatingTypes.add(b.object_type);
        if (b.deactivates) deactivatingTypes.add(b.object_type);
      });
    });
    return [...allBoundTypes]
      .map(t => ({
        type: t,
        missingCreate: !creatingTypes.has(t),
        missingDeactivate: !deactivatingTypes.has(t),
      }))
      .filter(i => i.missingCreate || i.missingDeactivate)
      .sort((a, b) => a.type.localeCompare(b.type));
  }, [activeModel]);

  // Any issue that must block a run: activities with no bindings at all, or
  // object types missing a creates/deactivates end.
  const hasBlockingModelIssues = bindingWarnings.length > 0 || lifecycleIssues.length > 0;

  // ── Step 2.5: Timing discovery state ─────────────────────────────────────
  const [timingAnchors,       setTimingAnchors]       = useState({});
  const [timingMode,          setTimingMode]          = useState('single');
  const [timingSingleAct,     setTimingSingleAct]     = useState('');
  const [serviceTimeMode,     setServiceTimeMode]     = useState('minimum'); // 'minimum' | 'p25' | 'p50' | 'p75' | 'mean'
  const [discoveryDistType,   setDiscoveryDistType]   = useState('lognormal'); // distribution assigned to discovered activities
  const [isDiscoveringTiming, setIsDiscoveringTiming] = useState(false);
  const [timingDiscoveryResult, setTimingDiscoveryResult] = useState(null);
  const [timingDiscoveryFile,   setTimingDiscoveryFile]   = useState(null);
  const [timingError,           setTimingError]           = useState(null);

  // ── Workflow mode ─────────────────────────────────────────────────────────
  const [workflowMode, setWorkflowMode] = useState('external-ocel');
  const [landingDragOver, setLandingDragOver] = useState(false);
  const [paramDiscoveryEnabled, setParamDiscoveryEnabled] = useState({
    probability: true, lifecycle: true, time: true,
  });

  // ── External OC-Declare + OCEL tab state ──────────────────────────────────
  const [externalTab, setExternalTab] = useState('parameter'); // 'parameter' | 'behavior' | 'scenario' | 'results' | 'evaluation'
  const [behaviorSection, setBehaviorSection] = useState('activities'); // left nav in Model Behavior

  const [behaviorFilters, setBehaviorFilters] = useState({}); // { sectionKey: { dimKey: value } }
  const [scenarioBehaviorSection, setScenarioBehaviorSection] = useState('activities');

  const [scenarioBehaviorFilters, setScenarioBehaviorFilters] = useState({});
  const getBehaviorFilters = section => behaviorFilters[section] || {};
  const setBehaviorSectionFilters = (section, f) => setBehaviorFilters(prev => ({...prev, [section]: f}));
  const [modelBase, setModelBase] = useState(null);        // immutable discovered model snapshot (never edited)
  const [modelAsIs, setModelAsIs] = useState(null);        // editable as-is model (shown in Model Behavior)
  const [modelToBe, setModelToBe] = useState(null);        // editable to-be model (Scenario Builder)
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

  // Recovery: if discovery finished and modelAsIs is null due to the stale-ref race condition,
  // auto-initialize it from activeModel. isRunningDiscoveries guards against firing mid-discovery;
  // modelEdited guards against firing at startup before any discovery has run.
  const prevIsRunningDiscoveriesRef = React.useRef(false);
  React.useEffect(() => {
    const wasRunning = prevIsRunningDiscoveriesRef.current;
    prevIsRunningDiscoveriesRef.current = isRunningDiscoveries;
    const justFinished = wasRunning && !isRunningDiscoveries;
    const alreadyBroken = !wasRunning && !isRunningDiscoveries;
    if ((justFinished || alreadyBroken) && !modelAsIs && activeModel && modelEdited) {
      const snap = JSON.parse(JSON.stringify(activeModel));
      snap.start_activities = config.startActivities || [];
      setModelAsIs(snap);
      setModelToBe(JSON.parse(JSON.stringify(snap)));
      setModelBase(JSON.parse(JSON.stringify(snap)));
    }
  }, [isRunningDiscoveries, activeModel, modelEdited]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const [applyNminNmaxFromModelCheck, setApplyNminNmaxFromModelCheck] = useState(true);
  const [lifecycleResult, setLifecycleResult] = useState(null);   // {summary, method} or {error}
  const [lifecycleError, setLifecycleError] = useState(null);
  const [permanentResult, setPermanentResult] = useState(null);     // [{type, instance_count}]
  const [permanentError, setPermanentError] = useState(null);
  const [o2oResult, setO2oResult] = useState(null);               // {count}
  const [o2oError, setO2oError] = useState(null);
  const [permanentThreshold, setPermanentThreshold] = useState(50);
  const [suggestedPermanentThreshold, setSuggestedPermanentThreshold] = useState(null);

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
    // Start parameter discovery timer
    paramDiscStartRef.current = Date.now();
    setParamDiscElapsed(null);
    if (paramDiscTimerRef.current) clearInterval(paramDiscTimerRef.current);
    paramDiscTimerRef.current = setInterval(() => {
      setParamDiscElapsed(Math.floor((Date.now() - paramDiscStartRef.current) / 1000));
    }, 1000);

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
          setConfig(prev => prev.startActivitiesLocked || prev.startActivities.length > 0
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
      clearInterval(paramDiscTimerRef.current);
      paramDiscTimerRef.current = null;
      setParamDiscElapsed(Math.floor((Date.now() - (paramDiscStartRef.current || Date.now())) / 1000));
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

  // Auto-suggest permanent object threshold when the event log changes
  React.useEffect(() => {
    const file = ocdeclareDiscoveryConfig.eventLogFile;
    if (!file) { setSuggestedPermanentThreshold(null); return; }
    let cancelled = false;
    axios.post('/api/suggest-permanent-threshold', { eventLogFile: file })
      .then(res => {
        if (cancelled) return;
        const t = res.data?.suggested_threshold ?? null;
        setSuggestedPermanentThreshold(t);
        if (t != null) {
          setOcdeclareDiscoveryConfig(prev => ({ ...prev, resourceThreshold: t }));
          setPermanentThreshold(t);
        }
      })
      .catch(() => { if (!cancelled) setSuggestedPermanentThreshold(null); });
    return () => { cancelled = true; };
  }, [ocdeclareDiscoveryConfig.eventLogFile]);

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
        const model = normalizeModelOrientation(res.data.model);
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

  // Shared helper: start polling a discover-ocdeclare run and resolve when done.
  // onProgress(phase, pct) is called on each poll tick before completion.
  // Returns a promise that resolves to the server response data, or rejects on error.
  const pollOcdeclareRun = useCallback((runId, onProgress) => {
    return new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const res = await axios.get(`/api/discover-ocdeclare/status/${runId}`);
          const d = res.data;
          if (d.error && d.done) { reject(new Error(d.error)); return; }
          onProgress(d.phase || '', d.pct ?? 0, d.logs || []);
          if (d.done) { resolve(d); return; }
          ocdeclarePollingRef.current = setTimeout(tick, 1200);
        } catch (err) {
          reject(err);
        }
      };
      ocdeclarePollingRef.current = setTimeout(tick, 800);
    });
  }, []);

  const runOcdeclareDiscovery = async () => {
    setIsOcdeclareDiscovering(true);
    setOcdeclareDiscoveryError(null);
    setOcdeclareDiscoveryResults(null);
    setOcdeclareProgress({ phase: 'Starting', pct: 0 });
    setOcdeclareLog([]);
    // Start OC-Declare discovery timer
    ocdeclareStartRef.current = Date.now();
    setOcdeclareElapsed(null);
    if (ocdeclareTimerRef.current) clearInterval(ocdeclareTimerRef.current);
    ocdeclareTimerRef.current = setInterval(() => {
      setOcdeclareElapsed(Math.floor((Date.now() - ocdeclareStartRef.current) / 1000));
    }, 1000);

    try {
      const { data: { run_id } } = await axios.post('/api/discover-ocdeclare', ocdeclareDiscoveryConfig);
      const data = await pollOcdeclareRun(run_id, (phase, pct, logs) => {
        setOcdeclareProgress({ phase, pct });
        if (logs && logs.length > 0) setOcdeclareLog(logs);
      });

      if (data.success) {
        setOcdeclareDiscoveryResults(data);

        // Populate editor with the freshly discovered model immediately
        if (data.model && !Array.isArray(data.model)) {
          setActiveModel(normalizeModelOrientation(data.model));
          // Freshly discovered model → not yet edited by the user.
          setModelEdited(false);
        }

        // Reload available files (preserve current selections to avoid overwrite)
        await loadAvailableFiles({ preserveSelections: true });

        // Select the newly discovered model in the simulation config
        if (data.filename) {
          setConfig(prev => ({ ...prev, ocdeclareFile: data.filename }));
        }

        // Simulation parameters are discovered explicitly in the separate workflow.
      } else {
        setOcdeclareDiscoveryError(data.error || 'OC-Declare discovery failed');
      }
    } catch (err) {
      setOcdeclareDiscoveryError(err.response?.data?.error || err.message || 'Failed to run OC-Declare discovery');
      console.error('OC-Declare discovery error:', err);
    } finally {
      clearTimeout(ocdeclarePollingRef.current);
      setIsOcdeclareDiscovering(false);
      setOcdeclareProgress({ phase: '', pct: 0 });
      clearInterval(ocdeclareTimerRef.current);
      ocdeclareTimerRef.current = null;
      setOcdeclareElapsed(Math.floor((Date.now() - (ocdeclareStartRef.current || Date.now())) / 1000));
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
      // Apply the chosen distribution type to all discovered activities
      const rawMetrics = resp.data.metrics || {};
      const metrics = Object.fromEntries(
        Object.entries(rawMetrics).map(([act, v]) => [act, {...v, dist_type: discoveryDistType}])
      );
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

  const runPermanentObjectDiscovery = useCallback(async () => {
    setPermanentError(null);
    setPermanentResult(null);
    try {
      const res = await axios.post('/api/discover-resources', {
        eventLogFile: discoveryConfig.eventLogFile,
        resourceThreshold: permanentThreshold,
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
        setPermanentResult(res.data.resource_info);
      } else {
        setPermanentError(res.data.error || 'Discovery failed');
      }
    } catch (err) {
      setPermanentError(err.response?.data?.error || err.message);
    }
  }, [discoveryConfig.eventLogFile, permanentThreshold]);

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
    const simModel  = mode === 'asis' ? (modelAsIs ?? modelBase) : (modelToBe  ?? activeModel);
    const simMatrix = mode === 'asis' ? probMatrixBase : (probMatrixToBe ?? activeProbMatrix);
    setIsSimulating(true);
    setSimulatingMode(mode);
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

    // Reset live counters
    setLiveSimTime(null);
    setLiveTraces(null);
    setLiveCases(null);
    setLiveObligations(null);
    setLiveDeactivPerStep(null);
    setLiveObligFulfilledPerStep(null);
    prevPollRef.current = { deactivations: 0, obligFulfilled: 0, step: 0 };
    setThroughput([]);
    throughputRef.current = { startMs: Date.now(), lastMs: null, lastEvents: 0, lastObjects: 0 };
    setLiveStartCaps(null);

    // Start polling the live step counter every second
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(async () => {
      try {
        const r = await axios.get(`/api/simulate/status/${runId}`);
        setLiveStepCount(r.data.step_count ?? 0);
        setLiveTraces(r.data.completed_traces ?? 0);
        setLiveCases(r.data.completed_cases ?? null);
        setLiveActiveObjects(r.data.active_objects ?? null);
        setLiveObligations(r.data.total_obligations ?? null);
        // Only activities that were actually given a cap — an uncapped start
        // activity has nothing to count against, so it is left out entirely.
        {
          const caps   = r.data.start_activity_caps      || {};
          const counts = r.data.start_counts_by_activity || {};
          const capped = Object.keys(caps)
            .filter(a => caps[a] != null && caps[a] > 0)
            .sort()
            .map(a => ({ activity: a, fired: counts[a] ?? 0, cap: caps[a] }));
          setLiveStartCaps(capped.length ? capped : null);
        }
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

        // Throughput sample. Rates come from the delta between polls divided by
        // the actual wall gap, not the nominal 1s — a busy tab or a slow poll
        // stretches the interval, and dividing by 1 would understate the rate.
        {
          const tp = throughputRef.current;
          const nowMs = Date.now();
          const curEvents  = r.data.events_count  ?? 0;
          const curObjects = r.data.objects_count ?? 0;
          if (tp.lastMs != null) {
            const dt = (nowMs - tp.lastMs) / 1000;
            if (dt >= 0.25) {
              const sample = {
                t:   (nowMs - (tp.startMs ?? nowMs)) / 1000,
                ev:  Math.max(0, (curEvents  - tp.lastEvents)  / dt),
                ob:  Math.max(0, (curObjects - tp.lastObjects) / dt),
                cum: curEvents,
              };
              // Bounded buffer: a long run would otherwise grow without limit.
              setThroughput(prev => (prev.length >= 1800 ? [...prev.slice(1), sample] : [...prev, sample]));
              tp.lastMs = nowMs; tp.lastEvents = curEvents; tp.lastObjects = curObjects;
            }
          } else {
            tp.lastMs = nowMs; tp.lastEvents = curEvents; tp.lastObjects = curObjects;
            if (tp.startMs == null) tp.startMs = nowMs;
          }
        }
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
      const maxCases = config.maxCases !== '' && config.maxCases != null && parseInt(config.maxCases) > 0
        ? parseInt(config.maxCases)
        : null;
      // Wall-clock budget, entered in minutes, sent in seconds.
      const maxRuntimeS = config.maxRuntimeValue !== '' && config.maxRuntimeValue != null
        && parseFloat(config.maxRuntimeValue) > 0
        ? parseFloat(config.maxRuntimeValue) * 60
        : null;

      const simulationData = {
        ...config,
        maxEvents: effectiveMaxEvents,
        runId,
        eventLogFile: discoveryConfig.eventLogFile,
        maxSimTimeS,
        maxTraces,
        maxCases,
        maxRuntimeS,
        // Send model/probs for the chosen mode
        ...(simModel  ? { modelOverride:       simModel }  : {}),
        ...(simMatrix ? { probMatrixOverride: simMatrix } : {}),
        // Use per-model start activities
        ...(mode === 'tobe' ? {
          startActivities: tobeStartActivities.length > 0 ? tobeStartActivities : config.startActivities,
          startActivityCaps: tobeStartActivityCaps,
        } : {}),
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
      setSimulatingMode(null);
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

  const runPinpointBlocking = async () => {
    setIsPinpointing(true);
    setPinpointResult(null);
    try {
      const payload = {
        ...config,
        ...(activeModel ? { modelOverride: activeModel } : {}),
        steps: 200,
        maxRounds: 12,
      };
      const res = await axios.post('/api/pinpoint-blocking', payload);
      setPinpointResult(res.data);
    } catch (err) {
      setPinpointResult({ error: err.response?.data?.error || 'Pinpoint analysis failed.' });
    } finally {
      setIsPinpointing(false);
    }
  };

  const runDryRunStats = async () => {
    setIsDryRunning(true);
    setDryRunResult(null);
    try {
      const payload = {
        ...config,
        ...(activeModel ? { modelOverride: activeModel } : {}),
        steps: 500,
      };
      const res = await axios.post('/api/dry-run-stats', payload);
      setDryRunResult(res.data);
    } catch (err) {
      setDryRunResult({ error: err.response?.data?.error || 'Dry run failed.' });
    } finally {
      setIsDryRunning(false);
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

  // Mirror config.startActivities into all three model state objects whenever it changes.
  // This ensures the iteration log model_snapshot always has the correct start_activities.
  React.useEffect(() => {
    const acts = config.startActivities || [];
    setModelBase(m => m ? {...m, start_activities: acts} : m);
    setModelAsIs(m => m ? {...m, start_activities: acts} : m);
    setModelToBe(m => m ? {...m, start_activities: acts} : m);
  }, [config.startActivities]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Initialise tobeStartActivities from config.startActivities the first time it becomes non-empty.
  React.useEffect(() => {
    if (tobeStartActivities.length === 0 && config.startActivities.length > 0) {
      setTobeStartActivities([...config.startActivities]);
    }
  }, [config.startActivities]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync probMatrix when activities are added from any source (BehaviorPanel or ModelEditor).
  // Tracks previous names via ref so we only react to actual additions, not initial load.
  const prevActNamesAsIs = React.useRef(null);
  React.useEffect(() => {
    const actNames = (modelAsIs?.activities || []).map(a => a.name);
    const actKey = actNames.slice().sort().join('\0');
    if (prevActNamesAsIs.current === null) { prevActNamesAsIs.current = actKey; return; }
    if (actKey === prevActNamesAsIs.current) return;
    const prevNames = prevActNamesAsIs.current.split('\0').filter(Boolean);
    prevActNamesAsIs.current = actKey;
    const newActs = actNames.filter(n => !prevNames.includes(n));
    if (newActs.length === 0) return;
    setProbMatrixBase(m => syncProbMatrixForNewActivities(m, actNames, newActs));
  }, [modelAsIs?.activities]); // eslint-disable-line react-hooks/exhaustive-deps

  const prevActNamesToBe = React.useRef(null);
  React.useEffect(() => {
    const actNames = (modelToBe?.activities || []).map(a => a.name);
    const actKey = actNames.slice().sort().join('\0');
    if (prevActNamesToBe.current === null) { prevActNamesToBe.current = actKey; return; }
    if (actKey === prevActNamesToBe.current) return;
    const prevNames = prevActNamesToBe.current.split('\0').filter(Boolean);
    prevActNamesToBe.current = actKey;
    const newActs = actNames.filter(n => !prevNames.includes(n));
    if (newActs.length === 0) return;
    setProbMatrixToBe(m => syncProbMatrixForNewActivities(m, actNames, newActs));
  }, [modelToBe?.activities]); // eslint-disable-line react-hooks/exhaustive-deps
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
    // Guard: loadModelState (triggered by useEffect on ocdeclareFile change) is async.
    // If the user clicks "Discover" before it resolves, activeModel is null and
    // runLifecycleDerivation produces an incomplete model. Await it here if needed.
    if (!activeModelRef.current && config.ocdeclareFile) {
      await loadModelState(config.ocdeclareFile, discoveryConfig.eventLogFile);
    }
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
      // { key: 'resources', label: 'Permanent Objects',             fn: runPermanentObjectDiscovery },
      { key: 'timing',    label: 'Timing',                       fn: runTimingDiscovery },
      { key: 'o2o',       label: 'Object-to-Object Relationships',  fn: runO2ODiscovery },
      { key: 'startProb', label: 'Start Activity + Probability', fn: applyStartProbability },
    ];
    const steps = allSteps.filter(s => discoveryChecks[s.key]);
    const total = steps.length + 2; // +1 health check, +1 model check

    try {
      for (let i = 0; i < steps.length; i++) {
        setDiscoveryProgress({ current: i + 1, total, currentName: steps[i].label });
        await steps[i].fn();
      }

      // OC-Declare Model Check
      setDiscoveryProgress({ current: steps.length + 1, total, currentName: 'OC-Declare Model Check' });
      const modelForCheck = activeModelRef.current;
      const modelCheckResult = await runLogModelCheck(modelForCheck, discoveryConfig.eventLogFile);
      let modelAfterNmax = activeModelRef.current;
      if (modelCheckResult) {
        setLogConfResults(modelCheckResult);
        // Build observedNmax lookup regardless of checkbox — used for hints and apply
        const nmaxByLabel = {};
        modelCheckResult.constraintResults.forEach(r => {
          if (r.observedNmax != null) nmaxByLabel[r.label] = r.observedNmax;
          if (r.observedNmin != null) nmaxByLabel[`__nmin__${r.label}`] = r.observedNmin;
        });
        if (applyNminNmaxFromModelCheck && modelAfterNmax && !Array.isArray(modelAfterNmax)) {
          // OC-Declare paper: nmin=0,nmax=0 = negated existence constraint; nmin=1,nmax=∞ = standard existence form.
          const NEGATION_MAP = {
            response: 'not_succession', precedence: 'not_precedence',
            chain_response: 'not_chain_succession', chain_precedence: 'not_chain_succession',
            responded_existence: 'not_coexistence', coexistence: 'not_coexistence',
          };
          // Apply synchronously so the snapshot below captures the updated model
          const updatedConstraints = (modelAfterNmax.constraints || []).map(c => {
            const label = `${c.constraint_type}(${c.source_activity}→${c.target_activity})`;
            const result = modelCheckResult.constraintResults.find(r => r.label === label);
            if (!result || result.total === 0) return c;
            const newNmin = result.observedNmin != null ? result.observedNmin : c.nmin;
            const newNmax = result.observedNmax != null ? result.observedNmax : c.nmax;
            // Negated existence (0,0): remap constraint type to its not_* equivalent
            if (newNmin === 0 && newNmax === 0 && NEGATION_MAP[c.constraint_type]) {
              return { ...c, constraint_type: NEGATION_MAP[c.constraint_type], nmin: 0, nmax: null };
            }
            if (newNmin === c.nmin && newNmax === c.nmax) return c;
            return { ...c, nmin: newNmin, nmax: newNmax };
          });
          modelAfterNmax = { ...modelAfterNmax, constraints: updatedConstraints };
          setActiveModel(modelAfterNmax);
        }
      }

      setDiscoveryProgress({ current: steps.length + 2, total, currentName: 'Constraint Health Check' });
      await runHealthCheck();
      // Snapshot: use modelAfterNmax (has nmax applied if checkbox was on) rather than
      // activeModelRef.current which may still be the pre-setState stale value.
      const snapModel  = modelAfterNmax ? JSON.parse(JSON.stringify(modelAfterNmax)) : null;
      const snapMatrix = activeProbMatrixRef.current ? JSON.parse(JSON.stringify(activeProbMatrixRef.current)) : null;
      // Embed start_activities into all three model snapshots so they stay in sync
      if (snapModel) snapModel.start_activities = config.startActivities || [];
      setModelBase(snapModel);
      setModelAsIs(snapModel  ? {...JSON.parse(JSON.stringify(snapModel)), start_activities: config.startActivities || []}  : null);
      setModelToBe(snapModel  ? {...JSON.parse(JSON.stringify(snapModel)), start_activities: config.startActivities || []}  : null);
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
      runLifecycleDerivation, runPermanentObjectDiscovery, runTimingDiscovery, runO2ODiscovery,
      applyStartProbability, runHealthCheck, config.ocdeclareFile, loadModelState]);

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

  const autoDiscoverOCDeclare = useCallback(async (eventLogFilename) => {
    setIsOcdeclareDiscovering(true);
    setOcdeclareDiscoveryError(null);
    setOcdeclareDiscoveryResults(null);
    setOcdeclareProgress({ phase: 'Starting', pct: 0 });
    setOcdeclareLog([]);
    try {
      const payload = {
        eventLogFile:       eventLogFilename,
        noiseThreshold:     0.2,
        arcTypes:           ['EF', 'EP', 'AS'],
        reduction:          'Lossless',
        lifecycleThreshold: 0.5,
        resourceThreshold:  50.0,
      };
      const { data: { run_id } } = await axios.post('/api/discover-ocdeclare', payload);
      const data = await pollOcdeclareRun(run_id, (phase, pct, logs) => {
        setOcdeclareProgress({ phase, pct });
        if (logs && logs.length > 0) setOcdeclareLog(logs);
      });
      if (data.success) {
        setOcdeclareDiscoveryResults(data);
        await loadAvailableFiles({ preserveSelections: true });
        if (data.filename) {
          setConfig(prev => ({ ...prev, ocdeclareFile: data.filename }));
        }
      } else {
        setOcdeclareDiscoveryError(data.error || 'OC-Declare discovery failed');
      }
    } catch (err) {
      setOcdeclareDiscoveryError(err.response?.data?.error || err.message || 'OC-Declare discovery failed');
    } finally {
      clearTimeout(ocdeclarePollingRef.current);
      setIsOcdeclareDiscovering(false);
      setOcdeclareProgress({ phase: '', pct: 0 });
    }
  }, [loadAvailableFiles, pollOcdeclareRun]);

  const handleFileUpload = useCallback(async (file, type) => {
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', type);
    if (type === 'eventlog') {
      ocelLoadStartRef.current = Date.now();
      setOcelLoadElapsed(null);
      if (ocelLoadTimerRef.current) clearInterval(ocelLoadTimerRef.current);
      ocelLoadTimerRef.current = setInterval(() => {
        setOcelLoadElapsed(Math.floor((Date.now() - ocelLoadStartRef.current) / 1000));
      }, 1000);
    }
    try {
      const res = await axios.post('/api/upload-file', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (res.data.success) {
        await loadAvailableFiles({ preserveSelections: true });
        const filename = res.data.filename;
        if (type === 'eventlog') {
          clearInterval(ocelLoadTimerRef.current);
          ocelLoadTimerRef.current = null;
          setOcelLoadElapsed(Math.floor((Date.now() - (ocelLoadStartRef.current || Date.now())) / 1000));
          handleDiscoveryConfigChange('eventLogFile', filename);
          if (workflowMode === 'external-ocel') {
            setTimeout(() => runDiscovery(filename), 0);
          }
        } else if (type === 'ocdeclare') {
          handleConfigChange('ocdeclareFile', filename);
        } else if (type === 'parameters') {
          handleLoadParameters(filename);
        }
      } else {
        if (type === 'eventlog') { clearInterval(ocelLoadTimerRef.current); ocelLoadTimerRef.current = null; }
        alert(`Upload failed: ${res.data.error || 'Unknown error'}`);
      }
    } catch (err) {
      if (type === 'eventlog') { clearInterval(ocelLoadTimerRef.current); ocelLoadTimerRef.current = null; }
      alert(`Upload failed: ${err.response?.data?.error || err.message}`);
    }
  }, [loadAvailableFiles, handleDiscoveryConfigChange, handleConfigChange, handleLoadParameters, workflowMode, runDiscovery, autoDiscoverOCDeclare]);

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
            const lbl = `${c.constraint_type}(${src}→${tgt})${c.scope ? ' ' + formatScope(c.scope) : ''} nmin=${c.nmin ?? 1}`;
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
        const lbl = `${c1.constraint_type}(${c1.source_activity || c1.source}→${c1.target_activity || c1.target})${c1.scope ? ' ' + formatScope(c1.scope) : ''}`;
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
        onChangeMode={null}
      />

      <header className="header" style={{textAlign:'center', marginTop:'2rem', padding:'1.5rem 1rem 1rem'}}>
        <h1>Declarative OC Simulator</h1>
        <p>Object-centric declarative process simulation</p>
      </header>

      {/* ── Model info banner — between header and tab bar ── */}
      {workflowMode === 'external-ocel' && (externalTab === 'behavior' || externalTab === 'scenario') && (
        <div style={{margin:'0.5rem 1.5rem 0',background:'#eff6ff',border:'1px solid #bfdbfe',
          borderRadius:'8px',padding:'0.6rem 1rem',fontSize:'0.78rem',color:'#475569',lineHeight:1.6}}>
          <p style={{margin:'0 0 0.3rem'}}>
            The model is loaded from previously discovered constraints from{' '}
            <strong style={{color:'#1e293b'}}>{config.ocdeclareFile || '—'}</strong>{' '}
            based on <strong style={{color:'#1e293b'}}>{discoveryConfig.eventLogFile || '—'}</strong>.
            {' '}To edit, click on the respective field.
          </p>
          <p style={{margin:'0'}}>
            To add constraints, configure in the <strong>Constraints</strong> section.{' '}
            To add activities, configure in the <strong>Activities</strong> section.{' '}
            To add objects, configure in the <strong>Object Creation/Deactivation</strong> section.{' '}
            To remove constraints, activities or objects, click the removal button in their section.
          </p>
          {externalTab === 'scenario' && (
            <p style={{margin:'0.35rem 0 0',paddingTop:'0.35rem',borderTop:'1px solid #bfdbfe'}}>
              To run, go to the <strong>Results</strong> tab and configure <strong>Stop Conditions</strong> and <strong>Random Seed</strong>, then press{' '}
              <strong>▶ Run Base Model</strong> or <strong>▶ Run Alternative Model</strong>.
            </p>
          )}
        </div>
      )}

      {/* ── Main tab bar — only shown after landing page is complete ── */}
      {workflowMode === 'external-ocel' && externalTab !== 'parameter' && (
        <div className="main-tab-bar">
          {[
            { key: 'behavior',   label: 'Base Model' },
            { key: 'scenario',   label: 'Alternative Model' },
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

      {/* ── Mode selector removed — always external-ocel ── */}

      <div className="workflow-container">
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
              {paramDiscElapsed != null && (
                <p className="sim-elapsed-timer" style={{fontSize:'0.82rem',marginTop:'0.25rem'}}>
                  {Math.floor(paramDiscElapsed/60).toString().padStart(2,'0')}:{(paramDiscElapsed%60).toString().padStart(2,'0')}
                </p>
              )}
            </div>
          )}

          {discoveryResults && !isDiscovering && (
            <div className="discovery-results">
              <h3>Discovery Complete{paramDiscElapsed != null && <span style={{fontSize:'0.82rem',fontWeight:400,color:'#94a3b8',marginLeft:'0.5em'}}>· {paramDiscElapsed}s</span>}</h3>

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
                      <table className="activity-count-table">
                        <thead>
                          <tr>
                            <th>Activity</th>
                            <th>Occurrences</th>
                            {discoveryResults.trace_end_prob && <th title="Probability this activity is last in an object trace (higher = more likely end)">P(end)</th>}
                            {discoveryResults.activity_repeat_stats && (
                              <>
                                <th title="Fewest times this activity fired on a single object">Min /obj</th>
                                <th title="Average times this activity fired per object">Mean /obj</th>
                                <th title="Most times this activity fired on a single object">Max /obj</th>
                              </>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {discoveryResults.activities
                            .slice()
                            .sort((a, b) => (discoveryResults.activity_counts[b] || 0) - (discoveryResults.activity_counts[a] || 0))
                            .map(activity => {
                              const rs = discoveryResults.activity_repeat_stats?.[activity];
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
                                  {discoveryResults.activity_repeat_stats && (
                                    <>
                                      <td className="activity-count-num">{rs ? rs.min : '—'}</td>
                                      <td className="activity-count-num">{rs ? rs.mean : '—'}</td>
                                      <td className="activity-count-num">{rs ? rs.max : '—'}</td>
                                    </>
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
                          {ocelLoadElapsed != null && <span style={{marginLeft:'0.5em',color:'#94a3b8'}}>· OCEL loaded in {ocelLoadElapsed}s</span>}
                          {paramDiscElapsed != null && <span style={{marginLeft:'0.5em',color:'#94a3b8'}}>· params in {paramDiscElapsed}s</span>}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Drop prompt */}
                  {!discoveryConfig.eventLogFile && (
                    <div className="ocel-drop-prompt">
                      <div className="ocel-drop-label">Drop event log here</div>
                      <div className="ocel-drop-sub">or click to browse (.json, .jsonocel, .xml, .csv)</div>
                      {eventLogFiles && eventLogFiles.length > 0 && (
                        <div onClick={e => e.stopPropagation()} style={{marginTop:'0.75rem'}}>
                          <select
                            defaultValue=""
                            style={{fontSize:'0.8rem',padding:'0.3rem 0.5rem',borderRadius:'6px',border:'1px solid #cbd5e1',background:'#fff',color:'#334155',maxWidth:'320px',width:'100%'}}
                            onChange={e => {
                              if (e.target.value) {
                                handleDiscoveryConfigChange('eventLogFile', e.target.value);
                                setTimeout(() => runDiscovery(e.target.value), 0);
                              }
                            }}
                          >
                            <option value="">— or select existing file —</option>
                            {eventLogFiles.map(f => <option key={f} value={f}>{f}</option>)}
                          </select>
                        </div>
                      )}
                    </div>
                  )}
                  {discoveryConfig.eventLogFile && isDiscovering && (
                    <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:'0.75rem',padding:'1rem 0'}}>
                      <div className="spinner"></div>
                      <span style={{fontSize:'0.85rem',color:'#64748b'}}>Analysing log…</span>
                      {paramDiscElapsed != null && (
                        <span className="sim-elapsed-timer" style={{fontSize:'0.82rem'}}>
                          {Math.floor(paramDiscElapsed/60).toString().padStart(2,'0')}:{(paramDiscElapsed%60).toString().padStart(2,'0')}
                        </span>
                      )}
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
                        {/* Timing mode + distribution type */}
                        <div className="landing-option-group">
                          <label className="landing-option-label">Timing Discovery</label>
                          <div style={{display:'flex',flexDirection:'column',gap:'0.25rem'}}>
                            {[
                              { value: 'minimum', label: 'Minimum',    desc: 'Mean of [min…P25] — conservative, strips tail' },
                              { value: 'p25',     label: 'P25',        desc: 'Mean of [min…P50] — slightly broader' },
                              { value: 'p50',     label: 'P50 (IQR)',  desc: 'Mean of [P25…P75] — ignores extremes' },
                              { value: 'p75',     label: 'P75',        desc: 'Mean of [P50…max] — upper bound' },
                              { value: 'mean',    label: 'Full mean',  desc: 'Mean of entire distribution' },
                            ].map(opt => (
                              <label key={opt.value} style={{display:'flex',alignItems:'flex-start',gap:'0.4rem',fontSize:'0.82rem',cursor:'pointer'}}>
                                <input type="radio" name="landingTimingMode" value={opt.value}
                                  checked={serviceTimeMode === opt.value}
                                  onChange={() => setServiceTimeMode(opt.value)}
                                  style={{marginTop:'2px'}}/>
                                <span>
                                  <span style={{fontWeight:600}}>{opt.label}</span>
                                  <span style={{color:'#94a3b8',fontSize:'0.7rem',marginLeft:'0.3rem'}}>{opt.desc}</span>
                                </span>
                              </label>
                            ))}
                          </div>
                          <div style={{marginTop:'0.5rem',borderTop:'1px solid #f1f5f9',paddingTop:'0.4rem'}}>
                            <label className="landing-option-label" style={{fontSize:'0.78rem',marginBottom:'0.25rem'}}>Distribution shape</label>
                            {(() => {
                              const DIST_OPTS = [
                                {value:'lognormal',   label:'Lognormal',   short:'Right-skewed, always positive',
                                  detail:'Most realistic for service times: most events are quick, occasional long ones. Both mean and std affect the shape. Always samples ≥ 0.'},
                                {value:'normal',      label:'Normal',       short:'Symmetric bell curve',
                                  detail:'Symmetric around the mean — equal chance of being faster or slower. Can sample negative values if std is large relative to mean; use only when durations are tightly clustered.'},
                                {value:'exponential', label:'Exponential',  short:'Memoryless decay, mean only',
                                  detail:'Only the mean matters (std is ignored). Models processes where most instances are very short and a few are very long. Good for inter-arrival times.'},
                                {value:'fixed',       label:'Fixed',        short:'Exact deterministic value',
                                  detail:'Every firing takes exactly mean_seconds. No randomness at all. Use when you want perfectly uniform timing or as a baseline comparison.'},
                              ];
                              const hovered = DIST_OPTS.find(o => o.value === discoveryDistType);
                              return (
                                <>
                                  <div style={{display:'flex',gap:'0.35rem',flexWrap:'wrap'}}>
                                    {DIST_OPTS.map(opt => (
                                      <label key={opt.value}
                                        style={{display:'flex',alignItems:'center',gap:'0.25rem',fontSize:'0.78rem',cursor:'pointer',
                                          background: discoveryDistType===opt.value ? '#eff6ff' : '#f8fafc',
                                          border:`1px solid ${discoveryDistType===opt.value?'#6366f1':'#e2e8f0'}`,
                                          borderRadius:'4px',padding:'2px 8px',transition:'all 0.1s'}}>
                                        <input type="radio" name="discoveryDist" value={opt.value}
                                          checked={discoveryDistType===opt.value}
                                          onChange={()=>setDiscoveryDistType(opt.value)}
                                          style={{display:'none'}}/>
                                        <span style={{fontWeight: discoveryDistType===opt.value ? 600 : 400}}>{opt.label}</span>
                                      </label>
                                    ))}
                                  </div>
                                  {hovered && (
                                    <div style={{marginTop:'0.35rem',fontSize:'0.72rem',color:'#475569',
                                      background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'5px',
                                      padding:'0.35rem 0.6rem',lineHeight:1.4}}>
                                      <span style={{fontWeight:600,color:'#1e293b'}}>{hovered.label}: </span>
                                      <span style={{color:'#64748b'}}>{hovered.short}. </span>
                                      {hovered.detail}
                                    </div>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </div>

                        {/* Permanent object threshold — commented out */}
                        {false && <div className="landing-option-group">
                          <label className="landing-option-label" style={{display:'flex',alignItems:'center',gap:'0.35rem'}}>
                            Permanent Object Threshold
                            {/* ? popup with repeat stats */}
                            {discoveryResults?.object_type_stats && (() => {
                              const ots = discoveryResults.object_type_stats;
                              const types = Object.keys(ots).filter(t => ots[t]?.max_reuse != null).sort();
                              // Suggested threshold: lowest max_reuse across all object types
                              // (the object type that repeats the least at its maximum)
                              const minMax = types.reduce((best, t) => {
                                const m = ots[t]?.max_reuse;
                                return (m != null && m < best) ? m : best;
                              }, Infinity);
                              const suggested = minMax === Infinity ? null : minMax;
                              return (
                                <span style={{position:'relative',display:'inline-block'}}>
                                  <span
                                    style={{display:'inline-flex',alignItems:'center',justifyContent:'center',
                                      width:'15px',height:'15px',borderRadius:'50%',fontSize:'0.68rem',
                                      background:'#e2e8f0',color:'#475569',cursor:'help',fontWeight:700,
                                      lineHeight:1,userSelect:'none'}}
                                    onMouseEnter={e=>{const t=e.currentTarget.nextSibling;if(t)t.style.display='block';}}
                                    onMouseLeave={e=>{const t=e.currentTarget.nextSibling;if(t)t.style.display='none';}}
                                  >?</span>
                                  <div style={{display:'none',position:'absolute',top:'calc(100% + 4px)',left:'-8px',
                                    zIndex:300,background:'white',border:'1px solid #e2e8f0',borderRadius:'8px',
                                    boxShadow:'0 4px 20px rgba(0,0,0,0.12)',padding:'0.6rem 0.8rem',
                                    minWidth:'280px',maxWidth:'360px',fontSize:'0.74rem',color:'#475569'}}>
                                    <div style={{fontWeight:700,color:'#1e293b',marginBottom:'0.3rem',fontSize:'0.78rem'}}>
                                      Permanent Object Threshold
                                    </div>
                                    <p style={{margin:'0 0 0.4rem',lineHeight:1.4}}>
                                      Object types whose instances are reused ≥ threshold times are treated as <strong>permanent objects</strong> (pre-populated pool, never deactivated). Min/obj = least reused instance; Max/obj = most reused instance.
                                    </p>
                                    {suggested != null && (
                                      <div style={{background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:'5px',
                                        padding:'0.3rem 0.5rem',marginBottom:'0.4rem',fontSize:'0.73rem',color:'#1d4ed8'}}>
                                        Suggested: <strong>{suggested}</strong> — lowest max reuse across all object types
                                        <button onClick={()=>setPermanentThreshold(suggested)}
                                          style={{marginLeft:'0.5rem',fontSize:'0.7rem',padding:'1px 6px',
                                            background:'#1d4ed8',color:'white',border:'none',borderRadius:'3px',cursor:'pointer'}}>
                                          Apply
                                        </button>
                                      </div>
                                    )}
                                    <div style={{fontWeight:600,color:'#475569',fontSize:'0.72rem',marginBottom:'0.25rem',
                                      borderBottom:'1px solid #f1f5f9',paddingBottom:'0.2rem',
                                      display:'grid',gridTemplateColumns:'1fr auto auto',gap:'0 0.75rem'}}>
                                      <span>Object Type</span><span>Min/obj</span><span>Max/obj</span>
                                    </div>
                                    <div style={{maxHeight:'160px',overflowY:'auto'}}>
                                      {types.map(t => {
                                        const r = ots[t];
                                        const isHighlighted = r?.max_reuse != null && r.max_reuse >= permanentThreshold;
                                        return (
                                          <div key={t} style={{display:'grid',gridTemplateColumns:'1fr auto auto',
                                            gap:'0 0.75rem',padding:'1px 0',
                                            color: isHighlighted ? '#16a34a' : '#475569',
                                            fontWeight: isHighlighted ? 600 : 400}}>
                                            <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t}</span>
                                            <span style={{textAlign:'right'}}>{r?.min_reuse ?? '—'}</span>
                                            <span style={{textAlign:'right'}}>{r?.max_reuse ?? '—'}</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                    <div style={{fontSize:'0.68rem',color:'#94a3b8',marginTop:'0.3rem'}}>
                                      Green = max/obj ≥ current threshold ({permanentThreshold})
                                    </div>
                                  </div>
                                </span>
                              );
                            })()}
                          </label>
                          <input type="number" min={1} value={permanentThreshold}
                            onChange={e => setPermanentThreshold(Math.max(1, parseInt(e.target.value)||1))}
                            style={{width:'80px',padding:'0.25rem 0.4rem',border:'1px solid #cbd5e1',borderRadius:'5px',fontSize:'0.82rem'}} />
                          <div style={{fontSize:'0.7rem',color:'#94a3b8',marginTop:'0.2rem'}}>max same-activity repetitions/instance</div>
                        </div>}

                        {/* Model check options */}
                        {config.ocdeclareFile && (
                          <div className="landing-option-group" style={{borderTop:'1px solid #e2e8f0',paddingTop:'0.75rem',marginTop:'0.25rem'}}>
                            <label className="landing-option-label">OC-Declare Model Check</label>
                            <label style={{display:'flex',alignItems:'center',gap:'0.4rem',fontSize:'0.78rem',cursor:'pointer',marginTop:'0.25rem'}}
                              title="Applies observed nmin/nmax bounds from the log to each constraint. Existence constraints (nmin=1, nmax=∞) get nmin=1 applied explicitly. Constraints never observed after their source (nmin=0, nmax=0) are remapped to their negated form (e.g. response → not_succession). Other bounds are applied as counting constraints.">
                              <input type="checkbox" checked={applyNminNmaxFromModelCheck}
                                onChange={e => setApplyNminNmaxFromModelCheck(e.target.checked)} />
                              Apply nmin/nmax from log to constraints
                            </label>
                            <div style={{fontSize:'0.7rem',color:'#94a3b8',marginTop:'0.2rem'}}>Sets bounds from log counts; (0,0) → negated form, (1,∞) → existence form, others → counting</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Hidden file input */}
                  <input ref={ocelFileRef} type="file" accept=".json,.jsonocel,.xml,.csv" style={{display:'none'}}
                    onChange={e => { if (e.target.files[0]) handleFileUpload(e.target.files[0], 'eventlog'); e.target.value=''; }} />
                </div>

                {/* OC-Declare step: load file or run discovery */}
                {discoveryConfig.eventLogFile && (
                  <div className="landing-ocdecl-section">
                    <div style={{fontWeight:600,fontSize:'0.85rem',color:'#1e293b',marginBottom:'0.6rem'}}>
                      OC-Declare Constraints
                    </div>
                    {config.ocdeclareFile ? (
                      <div className="ocel-drop-zone loaded" style={{minHeight:'70px',padding:'1rem 1.25rem',cursor:'default'}}>
                        <div className="ocel-drop-zone-info">
                          <div className="file-name">{config.ocdeclareFile}</div>
                          <div className="file-meta" style={{color:'#15803d'}}>
                            {ocdeclareDiscoveryResults
                              ? `✓ Discovered · ${ocdeclareDiscoveryResults?.stats?.num_constraints ?? ''} constraints`
                              : '✓ OC-Declare model loaded'}
                            {ocdeclareElapsed != null && ocdeclareDiscoveryResults && (
                              <span style={{color:'#94a3b8',fontWeight:400,marginLeft:'0.4em'}}>· {ocdeclareElapsed}s</span>
                            )}
                          </div>
                        </div>
                        {ocdeclareDiscoveryResults && (
                          <div style={{marginTop:'0.6rem',fontSize:'0.72rem',color:'#64748b',fontStyle:'italic'}}>
                            Discovered using the algorithm by Küsters &amp; van der Aalst (2025) —{' '}
                            <em>OC-DECLARE: Discovering Object-Centric Declarative Patterns with Synchronization</em>.
                            Default options: noise threshold 0.2, lossless reduction, arrow types AS/EF/EP.
                          </div>
                        )}
                        {ocdeclareDiscoveryResults?.filename && (
                          <div style={{marginTop:'0.5rem'}}>
                            <a
                              href={`/api/download-ocdeclare/${encodeURIComponent(ocdeclareDiscoveryResults.filename)}`}
                              download={ocdeclareDiscoveryResults.filename}
                              style={{fontSize:'0.72rem',color:'#6366f1',textDecoration:'none',fontWeight:600}}
                            >
                              Download OC-Declare File
                            </a>
                          </div>
                        )}
                      </div>
                    ) : isOcdeclareDiscovering ? (
                      <div className="ocel-drop-zone" style={{minHeight:'70px',padding:'1rem 1.25rem',cursor:'default'}}>
                        <div style={{display:'flex',flexDirection:'column',gap:'0.5rem'}}>
                          <div style={{display:'flex',alignItems:'center',gap:'0.75rem'}}>
                            <div className="spinner spinner-sm" />
                            <div>
                              <div style={{fontWeight:600,color:'#6366f1',fontSize:'0.9rem'}}>Discovering OC-Declare constraints…</div>
                              <div style={{fontSize:'0.75rem',color:'#94a3b8',marginTop:'0.15rem'}}>
                                {ocdeclareProgress.phase || 'Starting'}
                              </div>
                            </div>
                            <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:'0.75rem'}}>
                              {ocdeclareElapsed != null && (
                                <span className="sim-elapsed-timer" style={{fontSize:'0.82rem'}}>
                                  {Math.floor(ocdeclareElapsed/60).toString().padStart(2,'0')}:{(ocdeclareElapsed%60).toString().padStart(2,'0')}
                                </span>
                              )}
                              <span style={{fontSize:'0.8rem',color:'#6366f1',fontWeight:600}}>
                                {ocdeclareProgress.pct}%
                              </span>
                            </div>
                          </div>
                          <div style={{height:'5px',background:'#e2e8f0',borderRadius:'3px',overflow:'hidden'}}>
                            <div style={{height:'100%',background:'#6366f1',borderRadius:'3px',transition:'width 0.4s ease',width:`${ocdeclareProgress.pct}%`}} />
                          </div>
                          {ocdeclareLog.length > 0 && (
                            <div style={{marginTop:'0.25rem',background:'#0f172a',borderRadius:'5px',padding:'0.4rem 0.6rem',fontFamily:'monospace',fontSize:'0.7rem',lineHeight:'1.5',color:'#94a3b8'}}>
                              {ocdeclareLog.slice(-5).map((entry, i) => (
                                <div key={i} style={{whiteSpace:'pre-wrap',wordBreak:'break-all'}}>
                                  <span style={{color:'#475569',marginRight:'0.5em'}}>{entry.t}</span>
                                  <span style={{color: entry.msg.startsWith('[') ? '#a5b4fc' : entry.msg.startsWith('After') || entry.msg.startsWith('Discovery') ? '#86efac' : '#cbd5e1'}}>{entry.msg}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <>
                        {ocdeclareDiscoveryError && (
                          <div style={{color:'#dc2626',fontSize:'0.82rem',background:'#fef2f2',border:'1px solid #fecaca',borderRadius:'6px',padding:'0.5rem 0.75rem',marginBottom:'0.6rem'}}>
                            <span style={{fontWeight:600}}>⚠ Discovery failed: </span>{ocdeclareDiscoveryError}
                          </div>
                        )}
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'1rem'}}>
                          <div
                            className="ocel-drop-zone"
                            style={{cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:'0.4rem',minHeight:'100px',padding:'1.25rem'}}
                            onClick={() => ocdeclFileRef.current?.click()}
                          >
                            <div style={{fontWeight:600,fontSize:'0.88rem'}}>Load OC-Declare File</div>
                            <div style={{fontSize:'0.73rem',color:'#64748b',textAlign:'center'}}>Upload a pre-prepared OC-Declare model (.json)</div>
                          </div>
                          <div
                            className="ocel-drop-zone"
                            style={{cursor:'default',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:'0.6rem',minHeight:'100px',padding:'1.25rem'}}
                          >
                            <button className="simulate-button" style={{fontSize:'0.85rem',padding:'0.45rem 1rem'}}
                              onClick={() => autoDiscoverOCDeclare(discoveryConfig.eventLogFile)}>
                              ▶ Run Discovery
                            </button>
                            <div style={{fontSize:'0.73rem',color:'#64748b',textAlign:'center'}}>
                              Küsters &amp; van der Aalst (2025) algorithm<br/>with default options
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                    <input ref={ocdeclFileRef} type="file" accept=".json" style={{display:'none'}}
                      onChange={e => { if (e.target.files[0]) handleFileUpload(e.target.files[0], 'ocdeclare'); e.target.value=''; }} />
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
                    handleConfigChange('ocdeclareFile', '');
                    handleDiscoveryConfigChange('eventLogFile', '');
                    setDiscoveryResults(null);
                    setExternalTab('parameter');
                  }}>
                    ← Start Over
                  </button>
                  <button
                    className="simulate-button"
                    disabled={!discoveryConfig.eventLogFile || !config.ocdeclareFile || isOcdeclareDiscovering || isRunningDiscoveries || isDiscovering || !(discoveryConfig.startActivityProbSelected?.length > 0)}
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
                    { label: 'Events Analyzed', val: discoveryResults?.total_events?.toLocaleString(),            source: 'OCEL log' },
                    { label: 'Object Traces',   val: discoveryResults?.log_object_trace_count?.toLocaleString(),  source: 'OCEL log' },
                    { label: 'Activity Types',  val: discoveryResults?.activity_count,                            source: 'OCEL log' },
                    { label: 'Transitions',     val: discoveryResults?.transition_count,                          source: 'OCEL log' },
                    { label: 'Constraints',     val: modelAsIs?.constraints?.length,                              source: 'OC-Declare' },
                    { label: 'Log Time Span',   val: (() => {
                        const s = discoveryResults?.ocel_time_span_s;
                        if (!s) return null;
                        if (s < 60) return (Math.abs(s % 1) < 0.005 ? Math.round(s) : s.toFixed(2)) + 's';
                        if (s < 3600) return Math.floor(s/60) + 'm';
                        if (s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
                        const d = Math.floor(s/86400); const h = Math.floor((s%86400)/3600);
                        return h > 0 ? d + 'd ' + h + 'h' : d + 'd';
                      })(), source: 'OCEL log' },
                  ].filter(c => c.val != null).map((c, i) => (
                    <div key={i} className="behavior-stat-card">
                      <div className="behavior-stat-val">{c.val}</div>
                      <div className="behavior-stat-label">{c.label}</div>
                      {c.source && (
                        <div style={{fontSize:'0.6rem',color: c.source === 'OC-Declare' ? '#6366f1' : '#94a3b8',marginTop:'2px',fontStyle:'italic'}}>
                          {c.source}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {!modelAsIs ? (
                  <div style={{padding:'2rem',textAlign:'center',color:'#94a3b8'}}>No model loaded yet.</div>
                ) : (<>
                  {/* Constraint Flow Graph — above model editors */}
                  {(modelAsIs.activities?.length > 0 || modelAsIs.constraints?.length > 0) && (
                    <div style={{marginBottom:'1rem',background:'white',border:'1px solid #e2e8f0',borderRadius:'10px',padding:'1rem'}}>
                      <div className="behavior-section-title" style={{marginBottom:'0.75rem'}}>
                        Constraint Flow <span style={{fontSize:'0.7rem',fontWeight:400,color:'#94a3b8'}}>— approximated possible routes</span>
                      </div>
                      <ConstraintFlowGraph
                        activities={modelAsIs.activities || []}
                        constraints={modelAsIs.constraints || []}
                        startActivities={config.startActivities || []}
                        probMatrix={probMatrixBase || {}}
                      />
                    </div>
                  )}
                  <div className="behavior-body">
                    <nav className="behavior-nav">
                      {[
                        ['activities',    'Activities'],
                        ['objects',       'Object Creation/Deactivation'],
                        ['constraints',   'Constraints'],
                        ['o2o',           'Object-to-Object Relationships'],
                        ['time',          'Time'],
                        ['probabilities', 'Probabilities'],
                      ].map(([key, label]) => (
                        <button key={key}
                          className={'behavior-nav-item' + (behaviorSection === key ? ' active' : '')}
                          onClick={() => setBehaviorSection(key)}>
                          {label}
                        </button>
                      ))}
                    </nav>

                    <div className="behavior-content">
                      {/* In edit mode, the same tables are shown with editable cells */}
                      {/* EditableCell components handle click-to-edit per value */}
                      {/* (No separate ModelEditor — editing is inline throughout) */}

                      {/* ── ACTIVITIES — matrix rows=activities, cols=object types ── */}
                      {behaviorSection === 'activities' && (
                        <BehaviorActivitiesPanel
                          model={modelAsIs}
                          editMode={true}
                          onUpdate={m => setModelAsIs(m)}
                          startActivities={config.startActivities || []}
                          onStartActivitiesChange={acts => setConfig(c => ({...c, startActivities: acts, startActivitiesLocked: true}))}
                          filters={getBehaviorFilters('activities')}
                          onFiltersChange={f => setBehaviorSectionFilters('activities', f)}
                          onActivityAdded={(name, existingNames) => {
                            const eq = existingNames.length > 0 ? 1 / existingNames.length : 1;
                            const row = {};
                            existingNames.forEach(a => { row[a] = eq; });
                            setProbMatrixBase(m => ({...m, [name]: row}));
                          }}
                          onActivityDeleted={name => setProbMatrixBase(m => {
                            const n = {...m};
                            delete n[name];
                            Object.keys(n).forEach(k => {
                              if (n[k] && n[k][name] !== undefined) {
                                const r = {...n[k]}; delete r[name]; n[k] = r;
                              }
                            });
                            return n;
                          })}
                        />
                      )}

                      {/* ── TIME ── */}
                      {behaviorSection === 'time' && (
                        <BehaviorTimePanel
                          durations={modelAsIs.activity_durations || {}}
                          editMode={true}
                          onUpdate={(act, field, val) => setModelAsIs(m => ({
                            ...m, activity_durations: {...(m.activity_durations||{}),
                              [act]: {...((m.activity_durations||{})[act]||{}), [field]: val}}
                          }))}
                        />
                      )}

                      {/* ── PROBABILITIES — with normalization sliders ── */}
                      {behaviorSection === 'probabilities' && (
                        <BehaviorProbabilitiesPanel
                          probMatrix={probMatrixBase}
                          editMode={true}
                          onUpdate={(src, row) => setProbMatrixBase(m => ({...m, [src]: row}))}
                          filters={getBehaviorFilters('probabilities')}
                          onFiltersChange={f => setBehaviorSectionFilters('probabilities', f)}
                          allActivityNames={(modelAsIs?.activities||[]).map(a=>a.name)}
                          constraints={modelAsIs?.constraints || []}
                        />
                      )}

                      {/* ── CONSTRAINTS ── */}
                      {behaviorSection === 'constraints' && (
                        <BehaviorConstraintsPanel
                          constraints={modelAsIs.constraints || []}
                          actNames={(modelAsIs.activities||[]).map(a=>a.name)}
                          otNames={(modelAsIs.object_types||[]).map(t=>typeof t==='string'?t:t.name)}
                          editMode={true}
                          onUpdate={cons => {
                            setModelAsIs(m => ({...m, constraints: cons}));
                            setProbMatrixBase(m => applyConstraintsToProbMatrix(m, cons));
                          }}
                          activities={modelAsIs.activities || []}
                          onUpdateActivities={acts => setModelAsIs(m => ({...m, activities: acts}))}
                          filters={getBehaviorFilters('constraints')}
                          onFiltersChange={f => setBehaviorSectionFilters('constraints', f)}
                        />
                      )}

                      {/* ── O2O RULES — cardinality matrix ── */}
                      {behaviorSection === 'o2o' && (() => {
                        const rules = modelAsIs.o2o_rules || [];
                        const otNames = (modelAsIs.object_types||[]).map(t => typeof t==='string'?t:t.name);
                        if (!rules.length) return <p className="behavior-empty">No object-to-object relationships discovered.</p>;

                        const cellMap = {};
                        otNames.forEach(a => { cellMap[a] = {}; });
                        rules.forEach(r => {
                          const cell = {min: r.min_links ?? 0, max: r.max_links, bidir: r.bidirectional};
                          if (!cellMap[r.source_type]) cellMap[r.source_type] = {};
                          cellMap[r.source_type][r.target_type] = cell;
                          if (r.bidirectional) {
                            if (!cellMap[r.target_type]) cellMap[r.target_type] = {};
                            cellMap[r.target_type][r.source_type] = cell;
                          }
                        });
                        const fmtCell = ({min, max}) => { const s = max == null ? '∞' : max; return (max !== null && min === max) ? String(min) : `${min}-${s}`; };
                        const involved = new Set(rules.flatMap(r => [r.source_type, r.target_type]));
                        const allCols = otNames.filter(t => involved.has(t));

                        // Filter
                        const o2oFilters = getBehaviorFilters('o2o');
                        const cols = o2oFilters.object_type ? allCols.filter(t => t === o2oFilters.object_type) : allCols;

                        return (
                          <div>
                            <div className="behavior-section-title">Object-to-Object Relationships
                              <BehaviorLegend items={[
                                ['Matrix cell','Shows min..max — the allowed number of links from a row-type object to a column-type object'],
                                ['min..max','e.g. 1..3 means each row-object must be linked to at least 1 and at most 3 column-objects'],
                                ['∞','No upper bound — any number of links allowed'],
                                ['↔ (purple)','Bidirectional — rule applies in both directions equally'],
                                ['→ (black)','One-way — rule applies only from row to column, not the reverse'],
                                ['Blank cell','No rule between these two object types in this direction'],
                              ]}/>
                              <span style={{fontSize:'0.72rem',color:'#6366f1',fontWeight:400,marginLeft:'0.5rem'}}>— click a cardinality to edit min or max</span>
                            </div>
                            <TableFilterBar
                              dimensions={[{key:'object_type', label:'Object Type', options: allCols}]}
                              filters={o2oFilters}
                              onFiltersChange={f => setBehaviorSectionFilters('o2o', f)}
                            />
                            <p style={{fontSize:'0.75rem',color:'#64748b',margin:'0 0 0.5rem'}}>
                              Each cell shows the cardinality from the row object to the column object.
                              <span style={{color:'#7c3aed',marginLeft:'0.5rem'}}>↔ bidirectional</span>
                              <span style={{color:'#1e293b',marginLeft:'0.75rem'}}>→ one-way (blank = no rule in that direction)</span>
                            </p>
                            <div style={{overflowX:'auto',marginBottom:'1rem'}}>
                              <table className="behavior-table">
                                <thead>
                                  <tr>
                                    <th style={{background:'#f8fafc'}}>From → To</th>
                                    {cols.map(c => <th key={c} style={{textAlign:'center'}}>{c}</th>)}
                                  </tr>
                                </thead>
                                <tbody>
                                  {cols.map(row => (
                                    <tr key={row}>
                                      <td style={{fontWeight:600,background:'#f8fafc',whiteSpace:'nowrap'}}>{row}</td>
                                      {cols.map(col => {
                                        const cell = cellMap[row]?.[col];
                                        if (row === col) return <td key={col} style={{background:'#f1f5f9',textAlign:'center',color:'#cbd5e1'}}>—</td>;
                                        const updateO2O = (field, val) => setModelAsIs(m => ({
                                          ...m, o2o_rules: (m.o2o_rules||[]).map(r => {
                                            const matches = r.source_type===row&&r.target_type===col || (r.bidirectional&&r.source_type===col&&r.target_type===row);
                                            return matches ? {...r, [field]: val===''?null:(parseFloat(val)||0)} : r;
                                          })
                                        }));
                                        return (
                                          <td key={col} style={{textAlign:'center',
                                            fontWeight: cell ? 600 : 400,
                                            color: cell ? (cell.bidir ? '#7c3aed' : '#1e293b') : '#e2e8f0'}}>
                                            {cell ? (
                                                <span style={{display:'inline-flex',alignItems:'center',gap:'4px',fontSize:'0.78rem'}}>
                                                  {fmtCell(cell)}
                                                  <span style={{fontSize:'0.7em'}}>{cell.bidir ? '↔' : '→'}</span>
                                                  <button onClick={()=>setModelAsIs(m=>({...m,o2o_rules:(m.o2o_rules||[]).filter(r=>!(r.source_type===row&&r.target_type===col)&&!(r.source_type===col&&r.target_type===row))}))} style={{background:'none',border:'none',color:'#dc2626',cursor:'pointer',fontWeight:700,padding:'0 1px',fontSize:'0.7rem',lineHeight:1}}>×</button>
                                                </span>
                                            ) : ''}</td>
                                        );
                                      })}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <O2ODiagram rules={rules} otNames={otNames} />
                            <AddO2ORuleForm otNames={otNames} onAdd={rule=>setModelAsIs(m=>({...m,o2o_rules:[...(m.o2o_rules||[]),rule]}))}/>
                          </div>
                        );
                      })()}

                      {/* ── OBJECT FLOWS ── */}
                      {behaviorSection === 'objects' && (
                        <div>
                          <div className="behavior-section-title">Object Creation/Deactivation
                            <BehaviorLegend items={[
                              // ['Permanent Objects','Object types that are pre-populated at simulation start, limited to a fixed pool size, and never deactivated (e.g. trucks, forklifts, workers). Pool size = number of simultaneously available instances.'],
                              // ['Attributes','Default values assigned to new object instances when they are first created. Only relevant if guards or attribute_updates use these fields.'],
                              ['Object Involvement track','Shows all activities that involve each object type, left to right in process order. + = creates, ✕ = deactivates.'],
                            ]}/>
                          </div>
                          {false && <div style={{display:'flex',gap:'2rem',flexWrap:'wrap',marginBottom:'1.5rem'}}>
                            <div style={{flex:1,minWidth:'180px'}}>
                              <div className="behavior-sub-title">Permanent Objects</div>
                              {(() => {
                                const allOts = (modelAsIs.object_types||[]).map(t=>typeof t==='string'?t:t.name);
                                const resTypes = modelAsIs.resource_types||[];
                                const displayTypes = allOts;
                                if (!displayTypes.length) return <p className="behavior-empty">No object types defined.</p>;
                                const toggleRes = ot => setModelAsIs(m => {
                                  const rt = m.resource_types||[];
                                  return {...m, resource_types: rt.includes(ot) ? rt.filter(t=>t!==ot) : [...rt, ot]};
                                });
                                return (
                                  <div style={{border:'1.5px solid #1e293b',borderRadius:'6px',overflow:'hidden'}}>
                                  <table className="behavior-table">
                                    <thead><tr><th style={{width:'20px'}}/><th>Type</th><th>Pool Size</th></tr></thead>
                                    <tbody>
                                      {displayTypes.map(r => {
                                        const isRes = resTypes.includes(r);
                                        return (
                                          <tr key={r} style={{opacity: !isRes ? 0.5 : 1}}>
                                            <td><input type="checkbox" checked={isRes} title={isRes?'Remove permanent object status':'Mark as permanent object (fixed pool, never deactivated)'} onChange={()=>toggleRes(r)}/></td>
                                            <td>{r}</td>
                                            <td>{isRes ? (<EditableCell value={(modelAsIs.resource_pool_sizes||{})[r]??1} type="number"
                                                  onSave={v=>setModelAsIs(m=>({...m,resource_pool_sizes:{...(m.resource_pool_sizes||{}),[r]:parseInt(v)||1}}))}/>)
                                              : <span style={{color:'#94a3b8',fontSize:'0.7rem'}}>—</span>}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                  </div>
                                );
                              })()}
                            </div>
                            <div style={{flex:1,minWidth:'180px'}}>
                              <div className="behavior-sub-title">Attributes</div>
                              {Object.keys(modelAsIs.attribute_schema||{}).length > 0 ? (
                                <table className="behavior-table">
                                  <thead><tr><th>Object Type</th><th>Attribute</th><th>Default</th></tr></thead>
                                  <tbody>
                                    {Object.entries(modelAsIs.attribute_schema||{}).flatMap(([ot, attrs]) =>
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
                          </div>}
                          <AddObjectTypeForm model={modelAsIs} onUpdate={m => setModelAsIs(m)} />
                          <div className="behavior-sub-title">Object Involvement</div>
                          <div style={{fontSize:'0.72rem',color:'#94a3b8',marginBottom:'0.5rem'}}>
                            Where objects get <span style={{color:'#4ade80',fontWeight:600}}>created</span> and involved and <span style={{color:'#f87171',fontWeight:600}}>deactivated</span>
                          </div>
                          {(() => {
                            const byType = {};
                            const actObjMap = {};
                            (modelAsIs.activities||[]).forEach(a => {
                              actObjMap[a.name] = (a.bindings||[]).filter(b=>b.object_type).map(b=>({type:b.object_type,creates:!!b.creates,deactivates:!!b.deactivates}));
                              (a.bindings||[]).forEach(b => {
                                (byType[b.object_type] = byType[b.object_type]||[]).push({act:a.name,creates:b.creates,deactivates:b.deactivates});
                              });
                            });
                            return Object.entries(byType).map(([ot, nodes]) => {
                              const sorted = [
                                ...nodes.filter(n => n.creates && !n.deactivates),
                                ...nodes.filter(n => n.creates && n.deactivates),
                                ...nodes.filter(n => !n.creates && !n.deactivates),
                                ...nodes.filter(n => !n.creates && n.deactivates),
                              ];
                              return (
                                <div key={ot} className="object-flow-type">
                                  <div className="object-flow-type-header">
                                    <span style={{fontSize:'0.7rem',fontWeight:400,color:'#94a3b8',marginRight:'0.25rem'}}>Object:</span>
                                    <span className="object-flow-type-name">{ot}</span>
                                  </div>
                                  <div style={{display:'flex',alignItems:'flex-start',gap:'0.5rem'}}>
                                    <span style={{fontSize:'0.7rem',fontWeight:400,color:'#94a3b8',paddingTop:'0.55rem',whiteSpace:'nowrap',flexShrink:0}}>Object flow:</span>
                                    <div className="object-flow-track">
                                      {sorted.map(n => (
                                        <div key={n.act}
                                          className={`flow-node${n.creates && n.deactivates ? ' flow-node-both' : n.creates ? ' flow-node-creates' : n.deactivates ? ' flow-node-deactivates' : ''}`}
                                          style={{cursor:'pointer'}}
                                          onClick={() => setActivityPopup({name:n.act, objects:actObjMap[n.act]||[]})}>
                                          <span className="flow-node-name">{n.act}</span>
                                          {n.creates && <span className="flow-node-badge flow-node-creates">+</span>}
                                          {n.deactivates && <span className="flow-node-badge flow-node-deactivates">✕</span>}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              );
                            });
                          })()}
                        </div>
                      )}

                    </div>
                  </div>
                </>)}
              </div>
            )}{/* end behavior tab */}

            {/* ── SCENARIO BUILDER TAB ── */}
            {externalTab === 'scenario' && (
              <div className="ext-ocel-tab-content">

                {/* Changes vs Base Model — top of tab */}
                {modelToBe && modelAsIs && (
                  <ToBeDiffPanel
                    modelAsIs={modelAsIs}
                    modelToBe={modelToBe}
                    probMatrixBase={probMatrixBase}
                    probMatrixToBe={probMatrixToBe}
                    startActivitiesAsIs={modelAsIs?.start_activities || []}
                    startActivitiesToBe={config.startActivities || []}
                  />
                )}
                {modelBase && modelToBe && (() => {
                  const diffC = (modelToBe.constraints||[]).length - (modelBase.constraints||[]).length;
                  const diffO = (modelToBe.o2o_rules||[]).length - (modelBase.o2o_rules||[]).length;
                  const baseActs = JSON.stringify((modelBase.activities||[]).map(a=>a.name).sort());
                  const tobeActs = JSON.stringify((modelToBe.activities||[]).map(a=>a.name).sort());
                  const actChanged = baseActs !== tobeActs;
                  if (diffC === 0 && diffO === 0 && !actChanged) return null;
                  return (
                    <div className="model-diff-summary" style={{marginBottom:'0.75rem'}}>
                      <div style={{fontSize:'0.72rem',fontWeight:700,color:'#92400e',marginBottom:'0.3rem'}}>Changes vs Base Model</div>
                      <div style={{display:'flex',gap:'0.5rem',flexWrap:'wrap'}}>
                        {diffC !== 0 && <span className={'diff-badge '+(diffC>0?'diff-add':'diff-rem')}>{diffC>0?'+':''}{diffC} constraints</span>}
                        {diffO !== 0 && <span className={'diff-badge '+(diffO>0?'diff-add':'diff-rem')}>{diffO>0?'+':''}{diffO} object-to-object relationships</span>}
                        {actChanged && <span className="diff-badge diff-mod">activities changed</span>}
                      </div>
                    </div>
                  );
                })()}

                {/* Constraint Flow Graph — above model editors */}
                {modelToBe && (modelToBe.activities?.length > 0 || modelToBe.constraints?.length > 0) && (
                  <div style={{marginBottom:'1rem',background:'white',border:'1px solid #e2e8f0',borderRadius:'10px',padding:'1rem'}}>
                    <div className="behavior-section-title" style={{marginBottom:'0.75rem'}}>
                      Constraint Flow <span style={{fontSize:'0.7rem',fontWeight:400,color:'#94a3b8'}}>— approximated possible routes</span>
                    </div>
                    <ConstraintFlowGraph
                      activities={modelToBe.activities || []}
                      constraints={modelToBe.constraints || []}
                      startActivities={config.startActivities || []}
                      probMatrix={probMatrixToBe || probMatrixBase || {}}
                    />
                  </div>
                )}

                <div className="scenario-layout">

                  {/* LEFT: Inline To-Be Model Editor */}
                  <div className="scenario-editor-col" style={{background:'white',border:'1px solid #e2e8f0',borderRadius:'10px',padding:'1rem'}}>
                    <div className="behavior-section-title" style={{marginBottom:'0.5rem'}}>
                        Alternative Model <span style={{fontSize:'0.72rem',fontWeight:400,color:'#94a3b8'}}>— always editable · click any value to change</span>
                    </div>
                    {modelToBe ? (<>
                      <div className="scenario-editor-layout">
                        <nav className="scenario-vertical-nav">
                          {[
                            ['activities','A','Activities'],
                            ['objects','F','Object Creation/Deactivation'],
                            ['constraints','C','Constraints'],
                            ['o2o','↔','O2O'],
                            ['time','T','Time'],
                            ['probabilities','%','Probabilities'],
                          ].map(([key,icon,label]) => (
                            <button key={key}
                              className={'scenario-nav-bubble' + (scenarioBehaviorSection===key?' active':'')}
                              onClick={() => setScenarioBehaviorSection(key)}>
                              <span className="bubble-icon">{icon}</span>
                              <span className="bubble-label">{label}</span>
                            </button>
                          ))}
                        </nav>
                        <div className="scenario-content">

                      {/* Activities */}
                      {scenarioBehaviorSection === 'activities' && (
                        <BehaviorActivitiesPanel
                          model={modelToBe}
                          editMode={true}
                          onUpdate={m => { setModelToBe(m); setActiveModel(m); handleModelEdit(m); }}
                          startActivities={config.startActivities || []}
                          onStartActivitiesChange={acts => setConfig(p => ({...p, startActivities: acts}))}
                          filters={scenarioBehaviorFilters['activities'] || {}}
                          onFiltersChange={f => setScenarioBehaviorFilters(p => ({...p, activities: f}))}
                          foldable={false}
                          onActivityAdded={(name, existingNames) => {
                            const eq = existingNames.length > 0 ? 1 / existingNames.length : 1;
                            const row = {};
                            existingNames.forEach(a => { row[a] = eq; });
                            setProbMatrixToBe(m => ({...m, [name]: row}));
                          }}
                          onActivityDeleted={name => setProbMatrixToBe(m => {
                            const n = {...m};
                            delete n[name];
                            Object.keys(n).forEach(k => {
                              if (n[k] && n[k][name] !== undefined) {
                                const r = {...n[k]}; delete r[name]; n[k] = r;
                              }
                            });
                            return n;
                          })}
                        />
                      )}

                      {/* Time */}
                      {scenarioBehaviorSection === 'time' && (
                        <BehaviorTimePanel
                          durations={modelToBe.activity_durations || {}}
                          editMode={true}
                          onUpdate={(act, field, val) => {
                            const m = {...modelToBe, activity_durations: {...(modelToBe.activity_durations||{}),
                              [act]: {...((modelToBe.activity_durations||{})[act]||{}), [field]: val}}};
                            setModelToBe(m); setActiveModel(m); handleModelEdit(m);
                          }}
                        />
                      )}

                      {/* Probabilities */}
                      {scenarioBehaviorSection === 'probabilities' && (
                        <BehaviorProbabilitiesPanel
                          probMatrix={probMatrixToBe}
                          editMode={true}
                          onUpdate={(src, row) => {
                            const newMatrix = {...probMatrixToBe, [src]: row};
                            setProbMatrixToBe(newMatrix);
                            setActiveProbMatrix(newMatrix);
                          }}
                          filters={scenarioBehaviorFilters['probabilities'] || {}}
                          onFiltersChange={f => setScenarioBehaviorFilters(p => ({...p, probabilities: f}))}
                          allActivityNames={(modelToBe?.activities||[]).map(a=>a.name)}
                          constraints={modelToBe?.constraints || []}
                        />
                      )}

                      {/* Constraints */}
                      {scenarioBehaviorSection === 'constraints' && (
                        <BehaviorConstraintsPanel
                          constraints={modelToBe.constraints || []}
                          actNames={(modelToBe.activities||[]).map(a=>a.name)}
                          otNames={(modelToBe.object_types||[]).map(t=>typeof t==='string'?t:t.name)}
                          editMode={true}
                          onUpdate={cons => {
                            const m = {...modelToBe, constraints: cons};
                            setModelToBe(m); setActiveModel(m); handleModelEdit(m);
                            setProbMatrixToBe(mx => applyConstraintsToProbMatrix(mx, cons));
                          }}
                          activities={modelToBe.activities || []}
                          onUpdateActivities={acts => { const m={...modelToBe,activities:acts}; setModelToBe(m); setActiveModel(m); handleModelEdit(m); }}
                          filters={scenarioBehaviorFilters['constraints']||{}}
                          onFiltersChange={f=>setScenarioBehaviorFilters(p=>({...p,constraints:f}))}
                        />
                      )}

                      {/* O2O Rules */}
                      {scenarioBehaviorSection === 'o2o' && (() => {
                        const rules = modelToBe.o2o_rules || [];
                        const otNames = (modelToBe.object_types||[]).map(t=>typeof t==='string'?t:t.name);
                        const cellMap = {};
                        otNames.forEach(a=>{cellMap[a]={};});
                        rules.forEach(r=>{
                          const cell={min:r.min_links??0,max:r.max_links,bidir:r.bidirectional};
                          if(!cellMap[r.source_type])cellMap[r.source_type]={};
                          cellMap[r.source_type][r.target_type]=cell;
                          if(r.bidirectional){if(!cellMap[r.target_type])cellMap[r.target_type]={};cellMap[r.target_type][r.source_type]=cell;}
                        });
                        const fmtCell=({min,max})=>{const s=max==null?'∞':max;return(max!==null&&min===max)?String(min):`${min}-${s}`;};
                        const involved=new Set(rules.flatMap(r=>[r.source_type,r.target_type]));
                        const oF=scenarioBehaviorFilters['o2o']||{};
                        const allCols=otNames.filter(t=>involved.has(t));
                        const cols=oF.object_type?allCols.filter(t=>t===oF.object_type):allCols;
                        const updateO2O=(row,col,field,val)=>{ const m={...modelToBe,o2o_rules:(modelToBe.o2o_rules||[]).map(r=>{const matches=r.source_type===row&&r.target_type===col||(r.bidirectional&&r.source_type===col&&r.target_type===row);return matches?{...r,[field]:val===''?null:(parseFloat(val)||0)}:r;})};setModelToBe(m);setActiveModel(m);handleModelEdit(m);};
                        if(!rules.length) return <p className="behavior-empty">No object-to-object relationships. Add one below.</p>;
                        return (
                          <div>
                            <div className="behavior-section-title">Object-to-Object Relationships<BehaviorLegend items={[['Matrix cell','min..max links from row to column object'],['↔','bidirectional'],['→','one-way']]}/></div>
                            <TableFilterBar dimensions={[{key:'object_type',label:'Object Type',options:allCols}]} filters={oF} onFiltersChange={f=>setScenarioBehaviorFilters(p=>({...p,o2o:f}))}/>
                            <p style={{fontSize:'0.75rem',color:'#64748b',margin:'0 0 0.5rem'}}><span style={{color:'#7c3aed'}}>↔ bidir</span><span style={{marginLeft:'0.75rem'}}>→ one-way</span></p>
                            <div style={{overflowX:'auto',marginBottom:'1rem'}}>
                              <table className="behavior-table">
                                <thead><tr><th style={{background:'#f8fafc'}}>From → To</th>{cols.map(c=><th key={c} style={{textAlign:'center'}}>{c}</th>)}</tr></thead>
                                <tbody>{cols.map(row=>(
                                  <tr key={row}>
                                    <td style={{fontWeight:600,background:'#f8fafc',whiteSpace:'nowrap'}}>{row}</td>
                                    {cols.map(col=>{
                                      const cell=cellMap[row]?.[col];
                                      if(row===col)return<td key={col} style={{background:'#f1f5f9',textAlign:'center',color:'#cbd5e1'}}>—</td>;
                                      return(<td key={col} style={{textAlign:'center',fontWeight:cell?600:400,color:cell?(cell.bidir?'#7c3aed':'#1e293b'):'#e2e8f0'}}>
                                        {cell?(<span style={{display:'inline-flex',alignItems:'center',gap:'4px',fontSize:'0.78rem'}}>
                                          {fmtCell(cell)}
                                          <span style={{fontSize:'0.7em'}}>{cell.bidir?'↔':'→'}</span>
                                          <button onClick={()=>{const m={...modelToBe,o2o_rules:(modelToBe.o2o_rules||[]).filter(r=>!(r.source_type===row&&r.target_type===col)&&!(r.source_type===col&&r.target_type===row))};setModelToBe(m);setActiveModel(m);handleModelEdit(m);}} style={{background:'none',border:'none',color:'#dc2626',cursor:'pointer',fontWeight:700,padding:'0 1px',fontSize:'0.7rem',lineHeight:1}}>×</button>
                                        </span>):''}</td>);
                                    })}
                                  </tr>
                                ))}</tbody>
                              </table>
                            </div>
                            <O2ODiagram rules={rules} otNames={otNames} />
                            <AddO2ORuleForm otNames={otNames} onAdd={rule=>{const m={...modelToBe,o2o_rules:[...(modelToBe.o2o_rules||[]),rule]};setModelToBe(m);setActiveModel(m);handleModelEdit(m);}}/>
                          </div>
                        );
                      })()}

                      {/* Object Flows */}
                      {scenarioBehaviorSection === 'objects' && (() => {
                        const allOts=(modelToBe.object_types||[]).map(t=>typeof t==='string'?t:t.name);
                        const resTypes=modelToBe.resource_types||[];
                        const toggleRes=ot=>{const rt=modelToBe.resource_types||[];const m={...modelToBe,resource_types:rt.includes(ot)?rt.filter(t=>t!==ot):[...rt,ot]};setModelToBe(m);setActiveModel(m);handleModelEdit(m);};
                        return (
                          <div>
                            <div className="behavior-section-title">Object Creation/Deactivation</div>
                            {false && <div style={{display:'flex',gap:'2rem',flexWrap:'wrap',marginBottom:'1.5rem'}}>
                              <div style={{flex:1,minWidth:'180px'}}>
                                <div className="behavior-sub-title">Permanent Objects</div>
                                {allOts.length===0?<p className="behavior-empty">No object types.</p>:(
                                  <div style={{border:'1.5px solid #1e293b',borderRadius:'6px',overflow:'hidden'}}>
                                  <table className="behavior-table">
                                    <thead><tr><th style={{width:'20px'}}/><th>Type</th><th>Pool Size</th></tr></thead>
                                    <tbody>{allOts.map(r=>{
                                      const isRes=resTypes.includes(r);
                                      return(<tr key={r} style={{opacity:!isRes?0.5:1}}>
                                        <td><input type="checkbox" checked={isRes} onChange={()=>toggleRes(r)}/></td>
                                        <td>{r}</td>
                                        <td>{isRes?<EditableCell value={(modelToBe.resource_pool_sizes||{})[r]??1} type="number" onSave={v=>{const m={...modelToBe,resource_pool_sizes:{...(modelToBe.resource_pool_sizes||{}),[r]:parseInt(v)||1}};setModelToBe(m);setActiveModel(m);handleModelEdit(m);}}/>:<span style={{color:'#94a3b8',fontSize:'0.7rem'}}>—</span>}</td>
                                      </tr>);
                                    })}</tbody>
                                  </table>
                                  </div>
                                )}
                              </div>
                            </div>}
                            <AddObjectTypeForm model={modelToBe} onUpdate={m=>{setModelToBe(m);setActiveModel(m);handleModelEdit(m);}} />
                            <div className="behavior-sub-title">Object Involvement</div>
                            <div style={{fontSize:'0.72rem',color:'#94a3b8',marginBottom:'0.5rem'}}>
                              Where objects get <span style={{color:'#4ade80',fontWeight:600}}>created</span> and involved and <span style={{color:'#f87171',fontWeight:600}}>deactivated</span>
                            </div>
                            {(() => {
                              const byType={};
                              const actObjMap={};
                              (modelToBe.activities||[]).forEach(a=>{
                                actObjMap[a.name]=(a.bindings||[]).filter(b=>b.object_type).map(b=>({type:b.object_type,creates:!!b.creates,deactivates:!!b.deactivates}));
                                (a.bindings||[]).forEach(b=>{(byType[b.object_type]=byType[b.object_type]||[]).push({act:a.name,creates:b.creates,deactivates:b.deactivates});});
                              });
                              return Object.entries(byType).map(([ot,nodes]) => {
                                const sorted = [
                                  ...nodes.filter(n => n.creates && !n.deactivates),
                                  ...nodes.filter(n => n.creates && n.deactivates),
                                  ...nodes.filter(n => !n.creates && !n.deactivates),
                                  ...nodes.filter(n => !n.creates && n.deactivates),
                                ];
                                return (
                                  <div key={ot} className="object-flow-type">
                                    <div className="object-flow-type-header">
                                      <span style={{fontSize:'0.7rem',fontWeight:400,color:'#94a3b8',marginRight:'0.25rem'}}>Object:</span>
                                      <span className="object-flow-type-name">{ot}</span>
                                    </div>
                                    <div style={{display:'flex',alignItems:'flex-start',gap:'0.5rem'}}>
                                      <span style={{fontSize:'0.7rem',fontWeight:400,color:'#94a3b8',paddingTop:'0.55rem',whiteSpace:'nowrap',flexShrink:0}}>Object flow:</span>
                                      <div className="object-flow-track">
                                        {sorted.map(n => (
                                          <div key={n.act}
                                            className={`flow-node${n.creates && n.deactivates ? ' flow-node-both' : n.creates ? ' flow-node-creates' : n.deactivates ? ' flow-node-deactivates' : ''}`}
                                            style={{cursor:'pointer'}}
                                            onClick={() => setActivityPopup({name:n.act, objects:actObjMap[n.act]||[]})}>
                                            <span className="flow-node-name">{n.act}</span>
                                            {n.creates && <span className="flow-node-badge flow-node-creates">+</span>}
                                            {n.deactivates && <span className="flow-node-badge flow-node-deactivates">✕</span>}
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                );
                              });
                            })()}
                          </div>
                        );
                      })()}
                        </div>{/* end scenario-content */}
                      </div>{/* end scenario-editor-layout */}
                    </>) : (
                      <div style={{color:'#94a3b8',fontSize:'0.85rem',padding:'2rem',textAlign:'center'}}>Run discoveries first to populate the model.</div>
                    )}

                    {/* Constraint Flow Graph — always shown when activities/constraints exist */}
                  </div>
                  {false && <Collapsible
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
                            title={<span className={hasErr?'health-title-error':hasWarn?'health-title-warn':'health-title-ok'}>Constraint Health Report</span>}
                            badge={badge} defaultOpen={hasErr||hasWarn}>
                            {healthResult.cycles?.length > 0 && <div className="health-section health-error"><div className="health-section-title">Cycles</div>{healthResult.cycles.map((cy,i)=><div key={i} className="health-item"><span className="health-badge-error">CYCLE</span>{cy.description}</div>)}</div>}
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
                                        {entry.cascade_note}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                    </Collapsible>}

                </div>
              </div>
            )}{/* end scenario tab */}

            {/* ── RESULTS TAB ── */}
            {externalTab === 'results' && (
              <div className="ext-ocel-tab-content">

                {/* Simulation controls */}
                <div style={{background:'white',border:'1px solid #e2e8f0',borderRadius:'10px',padding:'1rem',marginBottom:'1.25rem'}}>
                  <div className="behavior-section-title" style={{marginBottom:'0.75rem'}}>Simulation</div>

                  <ObjectLifecycleWarning issues={lifecycleIssues} />

                  {/* Run buttons + start activities — two-column layout aligned per model */}
                  <div style={{display:'flex',gap:'0.75rem',marginBottom:'1rem',alignItems:'flex-start'}}>

                    {/* ── Base Model ── */}
                    <div style={{flex:1,display:'flex',flexDirection:'column',gap:'0.5rem'}}>
                      {(() => {
                        const missing = (modelBase?.activities||[])
                          .map(a => a.name)
                          .filter(n => { const d = (modelBase?.activity_durations||{})[n]; return !d || !d.sample_count; });
                        const noTiming = missing.length > 0;
                        const blocked = noTiming || hasBlockingModelIssues;
                        return (<>
                          <button className="simulate-button" style={{fontSize:'0.9rem',padding:'0.7rem',background: simulatingMode==='asis' ? '#1e293b' : '#334155', opacity: (isSimulating && simulatingMode!=='asis') || blocked ? 0.45 : 1, cursor: blocked ? 'not-allowed' : 'pointer'}}
                            disabled={isSimulating || !modelBase || blocked}
                            title={noTiming ? `Cannot run: missing timing data for: ${missing.join(', ')}`
                              : lifecycleIssues.length > 0 ? `Cannot run: incomplete object lifecycle for ${lifecycleIssues.map(i => i.type).join(', ')}`
                              : undefined}
                            onClick={() => runSimulation('asis')}>
                            {simulatingMode==='asis' ? 'Running…' : '▶ Run Base Model'}
                          </button>
                          {noTiming && <div style={{fontSize:'0.72rem',color:'#dc2626',background:'#fef2f2',border:'1px solid #fecaca',borderRadius:'6px',padding:'0.35rem 0.6rem'}}>⚠ No timing data for: {missing.join(', ')}</div>}
                        </>);
                      })()}
                      <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'8px',padding:'0.6rem 0.75rem'}}>
                        <div style={{display:'flex',alignItems:'center',marginBottom:'0.4rem'}}>
                          <div style={{fontSize:'0.72rem',fontWeight:700,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.04em',flex:1}}>Start Activities</div>
                          <button onClick={() => setBaseStartFolded(f => !f)} style={{background:'none',border:'none',cursor:'pointer',fontSize:'0.7rem',color:'#94a3b8',padding:'0 2px',lineHeight:1}}>
                            {baseStartFolded ? '▶' : '▼'}
                          </button>
                        </div>
                        <div style={{display:'flex',gap:'0.35rem',flexWrap:'wrap',marginBottom:'0.4rem'}}>
                          {(() => {
                            const cands = startActivityCandidates.length > 0 ? startActivityCandidates
                              : (availableActivities.length > 0 ? availableActivities.map(a => ({activity:a,pct:null}))
                              : (modelBase?.activities||[]).map(a => ({activity:a.name,pct:null})));
                            const visible = baseStartFolded ? cands.filter(c => config.startActivities.includes(c.activity)) : cands;
                            return visible.map((c, i) => {
                              const sel = config.startActivities.includes(c.activity);
                              return (
                                <button key={c.activity}
                                  onClick={() => {
                                    const n = sel
                                      ? config.startActivities.filter(a => a !== c.activity)
                                      : [...config.startActivities, c.activity];
                                    setConfig(p => {
                                      const caps = {...(p.startActivityCaps||{})};
                                      if (sel) delete caps[c.activity];
                                      return {...p, startActivities: n, startActivityCaps: caps};
                                    });
                                  }}
                                  style={{
                                    padding:'0.25rem 0.6rem',fontSize:'0.8rem',borderRadius:'20px',
                                    border: sel ? '2px solid #334155' : '1px solid #cbd5e1',
                                    background: sel ? '#334155' : 'white',
                                    color: sel ? 'white' : '#475569',
                                    cursor:'pointer',fontWeight: sel ? 600 : 400,transition:'all 0.12s',
                                  }}>
                                  {i===0 && c.pct!==null && '★ '}{c.activity}
                                  {c.pct!==null && <span style={{opacity:0.7,fontSize:'0.72rem'}}> {c.pct}%</span>}
                                </button>
                              );
                            });
                          })()}
                        </div>
                        {config.startActivities.length > 0 && (
                          <div style={{display:'flex',flexDirection:'column',gap:'0.25rem'}}>
                            {config.startActivities.map(act => {
                              const logCount = discoveryResults?.activity_counts?.[act];
                              const capVal = config.startActivityCaps?.[act] ?? '';
                              return (
                                <div key={act} style={{display:'flex',alignItems:'center',gap:'0.4rem',fontSize:'0.8rem'}}>
                                  <span style={{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:'#334155',fontWeight:500}}>{act}</span>
                                  <input type="text" inputMode="numeric" placeholder="∞" value={capVal}
                                    onChange={e => {
                                      const raw = e.target.value.replace(/\D/g,'');
                                      setConfig(p => ({...p, startActivityCaps:{...(p.startActivityCaps||{}),[act]: raw===''?'':parseInt(raw)||1}}));
                                    }}
                                    style={{width:'52px',padding:'0.15rem 0.3rem',border:'1px solid #cbd5e1',borderRadius:'5px',fontSize:'0.8rem',textAlign:'right'}}
                                    title="Max times this activity may start (leave blank for unlimited)"
                                  />
                                  {logCount != null && (
                                    <span style={{fontSize:'0.72rem',color:'#94a3b8',whiteSpace:'nowrap'}} title="Times fired in input log">log: {logCount.toLocaleString()}</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* ── Alternative Model ── */}
                    <div style={{flex:1,display:'flex',flexDirection:'column',gap:'0.5rem'}}>
                      {(() => {
                        const missing = (modelToBe?.activities||[])
                          .map(a => a.name)
                          .filter(n => { const d = (modelToBe?.activity_durations||{})[n]; return !d || !d.sample_count; });
                        const noTiming = missing.length > 0;
                        const noBaseline = !resultsAsIs;
                        const blocked = noTiming || hasBlockingModelIssues;
                        const tooltipMsg = noTiming
                          ? `Cannot run: missing timing data for: ${missing.join(', ')}`
                          : lifecycleIssues.length > 0
                            ? `Cannot run: incomplete object lifecycle for ${lifecycleIssues.map(i => i.type).join(', ')}`
                          : noBaseline ? 'Run Base Model first to establish a baseline' : undefined;
                        return (<>
                          <button className="simulate-button" style={{fontSize:'0.9rem',padding:'0.7rem', background: simulatingMode==='tobe' ? '#1d4ed8' : '#2563eb', opacity: (isSimulating && simulatingMode!=='tobe') || blocked ? 0.45 : 1, cursor: blocked ? 'not-allowed' : 'pointer'}}
                            disabled={isSimulating || !modelToBe || tobeStartActivities.length === 0 || noBaseline || blocked}
                            title={tooltipMsg}
                            onClick={() => runSimulation('tobe')}>
                            {simulatingMode==='tobe' ? 'Running…' : '▶ Run Alternative Model'}
                          </button>
                          {noTiming && <div style={{fontSize:'0.72rem',color:'#dc2626',background:'#fef2f2',border:'1px solid #fecaca',borderRadius:'6px',padding:'0.35rem 0.6rem'}}>⚠ No timing data for: {missing.join(', ')}</div>}
                        </>);
                      })()}
                      <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'8px',padding:'0.6rem 0.75rem'}}>
                        <div style={{display:'flex',alignItems:'center',marginBottom:'0.4rem'}}>
                          <div style={{fontSize:'0.72rem',fontWeight:700,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.04em',flex:1}}>Start Activities</div>
                          <button onClick={() => setAltStartFolded(f => !f)} style={{background:'none',border:'none',cursor:'pointer',fontSize:'0.7rem',color:'#94a3b8',padding:'0 2px',lineHeight:1}}>
                            {altStartFolded ? '▶' : '▼'}
                          </button>
                        </div>
                        <div style={{display:'flex',gap:'0.35rem',flexWrap:'wrap',marginBottom:'0.4rem'}}>
                          {(() => {
                            const cands = startActivityCandidates.length > 0 ? startActivityCandidates
                              : (availableActivities.length > 0 ? availableActivities.map(a => ({activity:a,pct:null}))
                              : (modelToBe?.activities||[]).map(a => ({activity:a.name,pct:null})));
                            const visible = altStartFolded ? cands.filter(c => tobeStartActivities.includes(c.activity)) : cands;
                            return visible.map((c, i) => {
                              const sel = tobeStartActivities.includes(c.activity);
                              return (
                                <button key={c.activity}
                                  onClick={() => {
                                    const n = sel
                                      ? tobeStartActivities.filter(a => a !== c.activity)
                                      : [...tobeStartActivities, c.activity];
                                    setTobeStartActivities(n);
                                    if (sel) setTobeStartActivityCaps(prev => { const caps = {...prev}; delete caps[c.activity]; return caps; });
                                  }}
                                  style={{
                                    padding:'0.25rem 0.6rem',fontSize:'0.8rem',borderRadius:'20px',
                                    border: sel ? '2px solid #2563eb' : '1px solid #cbd5e1',
                                    background: sel ? '#2563eb' : 'white',
                                    color: sel ? 'white' : '#475569',
                                    cursor:'pointer',fontWeight: sel ? 600 : 400,transition:'all 0.12s',
                                  }}>
                                  {i===0 && c.pct!==null && '★ '}{c.activity}
                                  {c.pct!==null && <span style={{opacity:0.7,fontSize:'0.72rem'}}> {c.pct}%</span>}
                                </button>
                              );
                            });
                          })()}
                        </div>
                        {tobeStartActivities.length > 0 && (
                          <div style={{display:'flex',flexDirection:'column',gap:'0.25rem'}}>
                            {tobeStartActivities.map(act => {
                              const logCount = discoveryResults?.activity_counts?.[act];
                              const capVal = tobeStartActivityCaps?.[act] ?? '';
                              return (
                                <div key={act} style={{display:'flex',alignItems:'center',gap:'0.4rem',fontSize:'0.8rem'}}>
                                  <span style={{flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:'#2563eb',fontWeight:500}}>{act}</span>
                                  <input type="text" inputMode="numeric" placeholder="∞" value={capVal}
                                    onChange={e => {
                                      const raw = e.target.value.replace(/\D/g,'');
                                      setTobeStartActivityCaps(p => ({...p,[act]: raw===''?'':parseInt(raw)||1}));
                                    }}
                                    style={{width:'52px',padding:'0.15rem 0.3rem',border:'1px solid #cbd5e1',borderRadius:'5px',fontSize:'0.8rem',textAlign:'right'}}
                                    title="Max times this activity may start (leave blank for unlimited)"
                                  />
                                  {logCount != null && (
                                    <span style={{fontSize:'0.72rem',color:'#94a3b8',whiteSpace:'nowrap'}} title="Times fired in input log">log: {logCount.toLocaleString()}</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>

                  </div>

                  {/* Stop conditions */}
                  <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'8px',padding:'0.75rem 1rem',marginBottom:'0.75rem'}}>
                    <div style={{fontSize:'0.72rem',fontWeight:700,color:'#64748b',textTransform:'uppercase',letterSpacing:'0.04em',marginBottom:'0.5rem'}}>
                      Stop conditions
                    </div>
                    <div style={{display:'flex',flexDirection:'column',gap:'0.5rem'}}>
                      <div style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
                        <span style={{fontSize:'0.82rem',color:'#475569',minWidth:'110px'}}>Max events</span>
                        <input type="text" inputMode="numeric" value={config.maxSteps ?? ''}
                          placeholder="e.g. 500"
                          onChange={e => handleConfigChange('maxSteps', e.target.value === '' ? '' : parseInt(e.target.value.replace(/\D/,''))||1)}
                          disabled={isSimulating}
                          style={{width:'80px',padding:'0.25rem 0.4rem',border:'1px solid #cbd5e1',borderRadius:'5px',fontSize:'0.82rem'}} />
                        {discoveryResults?.total_events != null && (
                          <button
                            style={{fontSize:'0.7rem',color:'#6366f1',background:'none',border:'1px solid #c7d2fe',borderRadius:'4px',padding:'0.15rem 0.45rem',cursor:'pointer',whiteSpace:'nowrap'}}
                            onClick={() => handleConfigChange('maxSteps', discoveryResults.total_events)}
                            disabled={isSimulating}
                            title="Use log event count as limit"
                          >{discoveryResults.total_events.toLocaleString()} in log</button>
                        )}
                      </div>
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
                        {discoveryResults?.ocel_time_span_s != null && (() => {
                          const s = discoveryResults.ocel_time_span_s;
                          const unitToS = { seconds:1, minutes:60, hours:3600, days:86400, weeks:604800 };
                          const unitShort = { seconds:'s', minutes:'min', hours:'h', days:'d', weeks:'wk' };
                          const unit = config.maxSimTimeUnit ?? 'days';
                          const val = Math.round(s / unitToS[unit] * 10) / 10;
                          return (
                            <button
                          style={{fontSize:'0.7rem',color:'#6366f1',background:'none',border:'1px solid #c7d2fe',borderRadius:'4px',padding:'0.15rem 0.45rem',cursor:'pointer',whiteSpace:'nowrap'}}
                              onClick={() => handleConfigChange('maxSimTimeValue', val)}
                              disabled={isSimulating}
                              title="Use log duration as limit"
                            >
                              {val} {unitShort[unit] ?? unit} in log
                            </button>
                          );
                        })()}
                      </div>
                      <div style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
                        {/* "Start cases": the counter is state._start_event_count,
                            incremented when an event of a configured start
                            activity fires — cases begun, not finished. The API
                            field stays `completed_cases` (wire format, not
                            user-facing). */}
                        <span style={{fontSize:'0.82rem',color:'#475569',minWidth:'110px'}}>Start cases -Dev</span>
                        <input type="text" inputMode="numeric" value={config.maxCases ?? ''}
                          placeholder="e.g. 100"
                          onChange={e => handleConfigChange('maxCases', e.target.value === '' ? '' : parseInt(e.target.value.replace(/\D/,''))||1)}
                          disabled={isSimulating}
                          style={{width:'80px',padding:'0.25rem 0.4rem',border:'1px solid #cbd5e1',borderRadius:'5px',fontSize:'0.82rem'}} />
                        {(() => {
                          const logCaseCount = (config.startActivities || []).reduce((sum, act) => sum + (discoveryResults?.activity_counts?.[act] || 0), 0);
                          return logCaseCount > 0 ? (
                            <button
                              style={{fontSize:'0.7rem',color:'#6366f1',background:'none',border:'1px solid #c7d2fe',borderRadius:'4px',padding:'0.15rem 0.45rem',cursor:'pointer',whiteSpace:'nowrap'}}
                              onClick={() => handleConfigChange('maxCases', logCaseCount)}
                              disabled={isSimulating}
                              title="Use log case count as limit"
                            >{logCaseCount.toLocaleString()} in log</button>
                          ) : null;
                        })()}
                      </div>
                      <div style={{display:'flex',alignItems:'center',gap:'0.5rem'}}>
                        {/* Wall-clock budget. Unlike the limits above it is about
                            the machine, not the model — it stops mid-process
                            wherever the clock runs out. */}
                        <span style={{fontSize:'0.82rem',color:'#475569',minWidth:'110px'}}>Runtime</span>
                        <input type="text" inputMode="decimal" value={config.maxRuntimeValue ?? ''}
                          placeholder="e.g. 10"
                          onChange={e => handleConfigChange('maxRuntimeValue', e.target.value.replace(/[^\d.]/g,''))}
                          disabled={isSimulating}
                          style={{width:'80px',padding:'0.25rem 0.4rem',border:'1px solid #cbd5e1',borderRadius:'5px',fontSize:'0.82rem'}} />
                        <span style={{fontSize:'0.78rem',color:'#64748b'}}>minutes of real time</span>
                        <span
                          className="help-hint"
                          data-help="Caps how long you wait, not how much process is simulated. The run stops wherever it happens to be — the resulting event log is valid but partial."
                          aria-label="What does the runtime limit do?"
                          role="img"
                        >?</span>
                      </div>
                      <div style={{fontSize:'0.7rem',color:'#94a3b8',marginTop:'0.1rem'}}>Leave blank to disable. First reached stops simulation.</div>
                    </div>
                  </div>

                  {/* Seed */}
                  <div className="form-row" style={{marginBottom:'0.5rem'}}>
                    <div className="form-group">
                      <label>Random Seed</label>
                      <input type="number" value={config.seed} onChange={e => handleConfigChange('seed', parseInt(e.target.value))} disabled={isSimulating} />
                    </div>
                  </div>

                  {/* Progress */}
                  {isSimulating && (
                    <div className="loading-box" style={{padding:'1.5rem',marginTop:'0.75rem'}}>
                      <div className="spinner"></div>
                      {/* Simulated time leads: it is what the run is measured
                          in, and what the stop conditions are usually set on.
                          Completed events moved to the secondary line below,
                          where simulated time used to sit. */}
                      <p>Running… <span className="sim-step-counter">
                        {liveSimTime == null ? 'starting…' : (() => {
                          const s = liveSimTime;
                          const fmt = s < 60     ? `${Math.floor(s)}s`
                                    : s < 3600   ? `${Math.floor(s/60)}m ${Math.floor(s%60)}s`
                                    : s < 86400  ? `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`
                                    : `${Math.floor(s/86400)}d ${Math.floor((s%86400)/3600)}h`;
                          const cap = (config.maxSimTimeValue !== '' && config.maxSimTimeValue != null)
                            ? ` / ${config.maxSimTimeValue} ${config.maxSimTimeUnit ?? 'days'}` : '';
                          return `simulated time ${fmt}${cap}`;
                        })()}
                      </span></p>
                      <p className="sim-elapsed-timer" style={{fontSize:'0.82rem'}}>
                        {'completed events '}{(liveStepCount ?? 0).toLocaleString()}
                      </p>
                      {/* Start-cases readout — hidden from the tracker. The value
                          is still polled into liveCases and the "Start cases -Dev"
                          stop condition still works; this was only the live line.
                          Counts state._start_event_count, incremented in
                          SimulationState.record_event when an event of a configured
                          start activity is recorded. Re-enable by uncommenting.
                      {liveCases != null && liveCases > 0 && (
                        <p className="sim-elapsed-timer" style={{fontSize:'0.82rem'}}>
                          {'start cases -Dev: '}{liveCases.toLocaleString()}
                          {config.maxCases !== '' && config.maxCases != null ? ` / ${config.maxCases}` : ''}
                          <span
                            className="help-hint"
                            data-help="A case is one firing of a start activity — the event that opens a new process instance. The counter goes up by one each time an activity listed under Start Activities fires, so it counts cases begun, not cases finished."
                            aria-label="What is a start case?"
                            role="img"
                          >?</span>
                        </p>
                      )}
                      */}
                      <p className="sim-elapsed-timer">{(() => { const s=simElapsed??0; return `${Math.floor(s/60).toString().padStart(2,'0')}:${(s%60).toString().padStart(2,'0')}`; })()}</p>
                      {liveActiveObjects != null && (
                        <p className="sim-elapsed-timer" style={{fontSize:'0.82rem'}}>{liveActiveObjects.toLocaleString()} active objects</p>
                      )}
                      {liveObligations != null && (
                        <p className="sim-elapsed-timer" style={{fontSize:'0.82rem',color: liveObligations > 100 ? '#dc2626' : liveObligations > 20 ? '#d97706' : '#64748b'}}>
                          {liveObligations.toLocaleString()} pending obligations
                        </p>
                      )}
                      {liveStartCaps && (
                        <div className="start-cap-list">
                          {liveStartCaps.map(s => {
                            const pct = Math.min(100, (s.fired / s.cap) * 100);
                            const done = s.fired >= s.cap;
                            return (
                              <div key={s.activity} className={`start-cap${done ? ' start-cap--done' : ''}`}>
                                <span className="start-cap-name" title={s.activity}>{s.activity}</span>
                                <span className="start-cap-bar"><i style={{width:`${pct}%`}}></i></span>
                                <span className="start-cap-n">{s.fired.toLocaleString()} / {s.cap.toLocaleString()}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <SimThroughputChart samples={throughput} />
                      {/* Per-step deactivation / obligation-removal rates —
                          hidden from the tracker, kept here because the values
                          are still polled and are useful when diagnosing a run
                          that stalls. Re-enable by uncommenting.
                      {liveDeactivPerStep != null && (
                        <p className="sim-elapsed-timer" style={{fontSize:'0.78rem',color:'#64748b'}}>
                          {liveDeactivPerStep}/step deactivated · ✓ {liveObligFulfilledPerStep ?? 0}/step obligations removed
                        </p>
                      )}
                      */}
                      <button className="sim-stop-btn" onClick={stopSimulation}>Stop</button>
                    </div>
                  )}

                  {/* Completion banner */}
                  {!isSimulating && lastCompletedMode && (
                    <div style={{background:'#f0fdf4',border:'1px solid #86efac',borderRadius:'8px',padding:'0.9rem 1rem',display:'flex',alignItems:'center',justifyContent:'space-between',gap:'1rem',marginTop:'0.75rem'}}>
                      <div>
                        <div style={{fontWeight:700,color:'#166534',fontSize:'0.9rem'}}>
                          ✓ {lastCompletedMode === 'asis' ? 'Base Model' : 'Alternative Model'} simulation complete
                        </div>
                        {lastRunDuration != null && (
                          <div style={{fontSize:'0.75rem',color:'#15803d',marginTop:'0.15rem'}}>
                            {Math.floor(lastRunDuration/60).toString().padStart(2,'0')}:{(lastRunDuration%60).toString().padStart(2,'0')} wall-clock
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

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
                      label: 'Avg Object Trace Duration',
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
                      label: 'Avg Connected Object Trace Duration',
                      asis: resultsAsIs.avg_connected_trace_duration_s,
                      tobe: resultsToBe.avg_connected_trace_duration_s,
                      fmt: fmtDur,
                      lowerIsBetter: true,
                    },
                    {
                      label: 'Cases Started',
                      asis: Object.values(resultsAsIs.case_tracker||{}).reduce((s,v)=>s+v.case_count,0)||null,
                      tobe: Object.values(resultsToBe.case_tracker||{}).reduce((s,v)=>s+v.case_count,0)||null,
                      fmt: v => v == null ? '—' : v.toLocaleString(),
                      lowerIsBetter: null,
                    },
                    {
                      label: 'Avg Case Duration',
                      asis: (()=>{ const ct=resultsAsIs.case_tracker||{}; const w=Object.values(ct).reduce((s,v)=>s+(v.mean_duration_s!=null?v.mean_duration_s*v.case_count:0),0); const n=Object.values(ct).reduce((s,v)=>s+(v.mean_duration_s!=null?v.case_count:0),0); return n>0?w/n:null; })(),
                      tobe: (()=>{ const ct=resultsToBe.case_tracker||{}; const w=Object.values(ct).reduce((s,v)=>s+(v.mean_duration_s!=null?v.mean_duration_s*v.case_count:0),0); const n=Object.values(ct).reduce((s,v)=>s+(v.mean_duration_s!=null?v.case_count:0),0); return n>0?w/n:null; })(),
                      fmt: fmtDur,
                      lowerIsBetter: true,
                    },
                  ];
                  return (
                    <div className="results-comparison-header">
                      <div className="compare-metric-card" style={{paddingRight:'0.75rem'}}>
                        <div className="compare-metric-label" style={{visibility:'hidden'}}>·</div>
                        <div className="compare-metric-asis" style={{color:'#94a3b8',fontWeight:600}}>Base model</div>
                        <div className="compare-metric-tobe" style={{color:'#94a3b8'}}>Alternative Model</div>
                      </div>
                      {metrics.map((m) => {
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
                  {[{label:'Base Model', r:resultsAsIs, objTab:objTabAsIs, setObjTab:setObjTabAsIs}, {label:'Alternative Model', r:resultsToBe, objTab:objTabToBe, setObjTab:setObjTabToBe}].map(({label, r, objTab, setObjTab}) => (
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
                              <div className="stat-card" title="Total number of activity events fired during this simulation run."><div className="stat-value">{r.steps_executed}</div><div className="stat-label">Events Completed</div></div>
                              <div className={'stat-card'+(discoveredTypes.length>0&&coverage<discoveredTypes.length?' stat-card-warn':' stat-card-ok')} title={discoveredTypes.length>0?`${coverage} of ${discoveredTypes.length} activity types defined in the model fired at least once. Yellow = some types never fired.`:'Number of distinct activity types that fired.'}>
                                <div className="stat-value">{coverage}{discoveredTypes.length>0&&<span className="stat-value-denom"> / {discoveredTypes.length}</span>}</div>
                                <div className="stat-label">Activity Types</div>
                              </div>
                              <div className="stat-card" title="Total number of objects created across all object types during this simulation run."><div className="stat-value">{r.objects_count}</div><div className="stat-label">Objects</div></div>
                              {r.sim_time_s!=null&&<div className="stat-card" title="Total simulated time elapsed from the first to the last event in the simulation."><div className="stat-value">{(()=>{const s=r.sim_time_s;if(s<60)return Math.abs(s % 1) < 0.005 ? Math.round(s)+'s' : s.toFixed(2)+'s';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';const d=Math.floor(s/86400);return d+'d';})()}</div><div className="stat-label">Sim Time</div></div>}
                              {r.case_tracker && Object.keys(r.case_tracker).length > 0 && (()=>{
                                const ct = r.case_tracker;
                                const totalCases = Object.values(ct).reduce((s,v)=>s+v.case_count,0);
                                const weightedDur = Object.values(ct).reduce((s,v)=>s+(v.mean_duration_s!=null?v.mean_duration_s*v.case_count:0),0);
                                const countWithDur = Object.values(ct).reduce((s,v)=>s+(v.mean_duration_s!=null?v.case_count:0),0);
                                const avgDur = countWithDur > 0 ? weightedDur/countWithDur : null;
                                const fmtD = s => { if(s==null)return '—'; if(s<60)return Math.round(s)+'s'; if(s<3600)return Math.floor(s/60)+'m '+Math.floor(s%60)+'s'; if(s<86400)return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'; const d=Math.floor(s/86400);const h=Math.floor((s%86400)/3600);return h>0?d+'d '+h+'h':d+'d'; };
                                return (<>
                                  <div className="stat-card" title="Total number of process instances started — one per firing of a start activity. Each case groups all objects born from that single start event."><div className="stat-value">{totalCases.toLocaleString()}</div><div className="stat-label">Cases Started</div></div>
                                  {avgDur!=null&&<div className="stat-card" title="Mean time from a start-activity event to the last event of all non-immutable objects it spawned, weighted across all start activities."><div className="stat-value">{fmtD(avgDur)}</div><div className="stat-label">Avg Case Duration</div></div>}
                                </>);
                              })()}
                            </div>

                            {/* Verification Matrix */}
                            <VerificationMatrix
                              results={r}
                              discoveryResults={discoveryResults}
                              activeModel={activeModel}
                              modelBase={modelBase}
                            />

                            {/* Activity Distribution vs Log */}
                            {r.metrics?.activity_metrics && discoveryResults?.activity_counts && (() => {
                              const simMetrics = r.metrics.activity_metrics;
                              const logCounts = discoveryResults.activity_counts || {};
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
                                <Collapsible
                                  className="logs-box sim-compare-box"
                                  title="Activity Distribution vs Log"
                                  badge={null}
                                  defaultOpen={false}
                                  preview={
                                    <table className="metrics-table sim-compare-table">
                                      <thead>
                                        <tr>
                                          <th>Activity</th>
                                          <th title="Times fired in this simulation run">Sim count</th>
                                          <th title="Times fired in the input event log">Log count</th>
                                          <th title="Share of all simulated events">Sim %</th>
                                          <th title="Share of all log events">Log %</th>
                                          <th title="Sim % minus Log % — positive means over-represented in simulation">Diff {wmape != null && <span style={{fontWeight:400,fontSize:'0.7rem',color: wmape < 10 ? '#16a34a' : wmape < 25 ? '#ca8a04' : wmape < 50 ? '#ea580c' : '#dc2626'}}>WMAPE {wmape.toFixed(1)}%</span>}</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        <tr>
                                          <td><strong>All</strong></td>
                                          <td>{simTotal}</td>
                                          <td>{logTotal}</td>
                                          <td></td>
                                          <td></td>
                                          <td></td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  }
                                >
                                  <p className="sim-compare-hint">
                                    Proportional share of total events (simulation vs log). Difference column shows sim − log in percentage points.
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
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {allActs.map(act => {
                                        const simCount = simMetrics[act]?.execution_count ?? 0;
                                        const logCount = logCounts[act] ?? 0;
                                        const simPct = simTotal > 0 ? (simCount / simTotal * 100) : 0;
                                        const logPct = logTotal > 0 ? (logCount / logTotal * 100) : 0;
                                        const diff = simPct - logPct;
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
                                            <td className={`cmp-diff ${diffClass}`}>
                                              {simCount > 0 || logCount > 0 ? (diff >= 0 ? '+' : '') + diff.toFixed(1) + 'pp' : '—'}
                                            </td>
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
                              const audit = r.audit?.object_lifecycle_audit;
                              const auditVals = audit ? Object.values(audit) : [];
                              const sumCreated = auditVals.reduce((s, a) => s + (a.instance_count || 0), 0);
                              const sumActive  = auditVals.reduce((s, a) => s + (a.active_count   || 0), 0);
                              const sumDeact   = auditVals.reduce((s, a) => s + (a.deactivated_count || 0), 0);
                              return (
                                <Collapsible
                                  title="Object Creation/Deactivation"
                                  defaultOpen={false}
                                  preview={audit ? (
                                    <table className="behavior-table">
                                      <thead><tr><th>Type</th><th>Created</th><th>Active</th><th>Deactivated</th><th>Status</th></tr></thead>
                                      <tbody>
                                        <tr>
                                          <td><strong>All</strong></td>
                                          <td>{sumCreated}</td>
                                          <td>{sumActive}</td>
                                          <td>{sumDeact}</td>
                                          <td></td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  ) : null}
                                >
                                  {audit ? (
                                    <table className="behavior-table">
                                      <thead><tr><th>Type</th><th>Created</th><th>Active</th><th>Deactivated</th><th>Status</th></tr></thead>
                                      <tbody>{Object.entries(audit).map(([ot,a])=>(
                                        <tr key={ot}><td>{ot}</td><td>{a.instance_count}</td><td>{a.active_count}</td><td>{a.deactivated_count}</td><td><span className={`audit-badge audit-badge-${a.classification}`}>{a.classification}</span></td></tr>
                                      ))}</tbody>
                                    </table>
                                  ) : (
                                    <p style={{fontSize:'0.82rem',color:'#94a3b8'}}>No object lifecycle data available.</p>
                                  )}
                                </Collapsible>
                              );
                            })()}
                            {/* Dev measures */}
                            <Collapsible title="Dev measures" defaultOpen={false}>
                              {/* Case Tracker */}
                              {r.case_tracker && Object.keys(r.case_tracker).length > 0 && (() => {
                                const fmtDur = s => {
                                  if (s == null) return '—';
                                  if (s < 60) return Math.round(s) + 's';
                                  if (s < 3600) return Math.floor(s/60) + 'm ' + Math.floor(s%60) + 's';
                                  if (s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
                                  const d = Math.floor(s/86400); const h = Math.floor((s%86400)/3600);
                                  return h > 0 ? d + 'd ' + h + 'h' : d + 'd';
                                };
                                const fmtTs = ts => ts ? ts.replace('T', ' ').replace(/\.\d+.*$/, '') : '—';
                                const entries = Object.entries(r.case_tracker);
                                const totalCases = entries.reduce((s,[,v])=>s+v.case_count,0);
                                const totalDone = entries.reduce((s,[,v])=>s+v.completed,0);
                                const overallRate = totalCases > 0 ? Math.round(totalDone/totalCases*100) : 0;
                                return (
                                  <Collapsible
                                    title="Case Tracker"
                                    badge={`${totalDone}/${totalCases} complete`}
                                    defaultOpen={false}
                                  >
                                    <p style={{fontSize:'0.78rem',color:'#64748b',marginBottom:'0.6rem'}}>
                                      A case starts with each start-activity firing and ends when all non-immutable
                                      objects created by that event are deactivated. Click a row to expand individual cases.
                                    </p>
                                    <CaseTrackerTable
                                      entries={entries}
                                      totalCases={totalCases}
                                      totalDone={totalDone}
                                      overallRate={overallRate}
                                      fmtDur={fmtDur}
                                      fmtTs={fmtTs}
                                      activeModel={activeModel}
                                    />
                                  </Collapsible>
                                );
                              })()}

                              {/* Object Trace Completion */}
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
                                  <Collapsible title="Object Trace Completion" defaultOpen={false}>
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

                              {/* Object Timelines (#28) — per-object status changes from this run */}
                              {r.object_lifecycles?.length > 0 && (
                                <Collapsible
                                  title="Object Timelines"
                                  badge={`${r.object_lifecycles.length}${
                                    r.object_lifecycles_total > r.object_lifecycles.length
                                      ? ` of ${r.object_lifecycles_total}` : ''} objects`}
                                  defaultOpen={false}
                                >
                                  <p style={{fontSize:'0.78rem',color:'#64748b',marginBottom:'0.6rem'}}>
                                    Every status change an object went through: when it was created, which
                                    activity took it and when, when that activity finished, and when it was
                                    deactivated. The <em>Since previous</em> column shows the gap between
                                    entries — a gap before a <code>started</code> row is time the object spent
                                    idle while already eligible, which is what the source log records as
                                    waiting time.
                                  </p>
                                  <ObjectTimelines
                                    lifecycles={r.object_lifecycles}
                                    total={r.object_lifecycles_total}
                                  />
                                </Collapsible>
                              )}

                            </Collapsible>

                            {r.output_file && (
                              <div style={{marginTop:'0.75rem',display:'flex',gap:'0.5rem',flexWrap:'wrap'}}>
                                <a className="download-button"
                                  href={`/api/download/${encodeURIComponent(r.output_file)}`}
                                  download={r.output_file}>
                                  Download Event Log
                                </a>
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
                  onEventLogFileChange={(f) => setDiscoveryConfig(prev => ({ ...prev, eventLogFile: f }))}
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
                {false && <div className="form-group">
                  <label>
                    Permanent Object Threshold
                    <HelpTip text={'Object types whose average events/instance exceeds this are treated as permanent objects and never deactivated.\n\nHigh → almost nothing classified as permanent.\nLow → many types become permanent objects.\n\nAuto-detected from the log on load; you can override.'} />
                    <span className="help-text">avg events/instance above which type is a permanent object</span>
                  </label>
                  <input
                    type="number"
                    value={ocdeclareDiscoveryConfig.resourceThreshold}
                    onChange={(e) => handleOcdeclareDiscoveryConfigChange('resourceThreshold', parseFloat(e.target.value))}
                    min="1" step="5"
                    disabled={isOcdeclareDiscovering}
                  />
                  {suggestedPermanentThreshold != null && (
                    <div style={{fontSize:'0.7rem',color:'#2563eb',marginTop:'0.2rem'}}>
                      Auto-detected: {suggestedPermanentThreshold}
                    </div>
                  )}
                </div>}
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
            <div className="loading-box" style={{flexDirection:'column',gap:'0.6rem',alignItems:'stretch'}}>
              <div style={{display:'flex',alignItems:'center',gap:'0.75rem'}}>
                <div className="spinner"></div>
                <span>Discovering OC-Declare model… {ocdeclareProgress.phase || 'Starting'}</span>
                <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:'0.75rem'}}>
                  {ocdeclareElapsed != null && (
                    <span className="sim-elapsed-timer" style={{fontSize:'0.82rem'}}>
                      {Math.floor(ocdeclareElapsed/60).toString().padStart(2,'0')}:{(ocdeclareElapsed%60).toString().padStart(2,'0')}
                    </span>
                  )}
                  <span style={{fontWeight:600}}>{ocdeclareProgress.pct}%</span>
                </div>
              </div>
              <div style={{height:'6px',background:'#e2e8f0',borderRadius:'3px',overflow:'hidden'}}>
                <div style={{height:'100%',background:'#6366f1',borderRadius:'3px',transition:'width 0.4s ease',width:`${ocdeclareProgress.pct}%`}} />
              </div>
              {ocdeclareLog.length > 0 && (
                <div style={{background:'#0f172a',borderRadius:'5px',padding:'0.4rem 0.6rem',fontFamily:'monospace',fontSize:'0.7rem',lineHeight:'1.5',color:'#94a3b8'}}>
                  {ocdeclareLog.slice(-5).map((entry, i) => (
                    <div key={i} style={{whiteSpace:'pre-wrap',wordBreak:'break-all'}}>
                      <span style={{color:'#475569',marginRight:'0.5em'}}>{entry.t}</span>
                      <span style={{color: entry.msg.startsWith('[') ? '#a5b4fc' : entry.msg.startsWith('After') || entry.msg.startsWith('Discovery') ? '#86efac' : '#cbd5e1'}}>{entry.msg}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {ocdeclareDiscoveryResults && !isOcdeclareDiscovering && (
            <div className="ocdeclare-discovery-results">
              <h3>Model Discovered: {ocdeclareDiscoveryResults.filename}{ocdeclareElapsed != null && <span style={{fontSize:'0.82rem',fontWeight:400,color:'#94a3b8',marginLeft:'0.5em'}}>· {ocdeclareElapsed}s</span>}</h3>
              <div style={{marginBottom:'0.75rem'}}>
                <a
                  className="download-button"
                  href={`/api/download-ocdeclare/${encodeURIComponent(ocdeclareDiscoveryResults.filename)}`}
                  download={ocdeclareDiscoveryResults.filename}
                >
                  Download OC-Declare File
                </a>
              </div>
              
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
                  <div className="stat-label">Object-to-Object Relationships</div>
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
                          (scope: {formatScope(constraint.scope)})
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
          <Collapsible title="Session History" badge={sessionHistory.length} defaultOpen={false}>
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
        {false && workflowMode !== 'external-ocel' && (
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
                eventLogFile={discoveryConfig.eventLogFile || ''}
                tracePosition={discoveryResults?.trace_position || {}}
              />
            </div>
            <div className="model-editor-warnings-col">
              <ObjectLifecycleWarning issues={lifecycleIssues} />
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
                    {false && resources.length > 0 && (
                      <div className="object-info-group">
                        <div className="object-info-label">Permanent Objects (always active)</div>
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
        {false && workflowMode !== 'external-ocel' && (
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
                title={<span className={titleClass}>Constraint Health Report</span>}
                badge={badge}
                defaultOpen={hasErrors || hasWarnings}
              >
                {healthResult.cycles?.length > 0 && (
                  <div className="health-section health-error">
                    <div className="health-section-title">Dependency cycles (deadlock)</div>
                    {healthResult.cycles.map((cy, i) => (
                      <div key={i} className="health-item"><span className="health-badge-error">CYCLE</span>{cy.description}</div>
                    ))}
                  </div>
                )}
                {healthResult.permanently_blocked?.length > 0 && (
                  <div className="health-section health-error">
                    <div className="health-section-title">Activities never reaching the pool</div>
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

            {/* ── Pinpoint blocking constraints ── */}
            <div style={{marginTop:'1rem',borderTop:'1px solid #f1f5f9',paddingTop:'1rem'}}>
              <div style={{display:'flex',alignItems:'center',gap:'0.75rem',flexWrap:'wrap'}}>
                <button
                  className="auto-generate-btn"
                  style={{background:'#f8fafc',color:'#334155',border:'1px solid #e2e8f0'}}
                  disabled={isPinpointing || !activeModel || !config.startActivities?.length}
                  onClick={runPinpointBlocking}
                >
                  {isPinpointing ? 'Running…' : '▶ Pinpoint Blocking Constraints'}
                </button>
                <span style={{fontSize:'0.72rem',color:'#94a3b8'}}>
                  Iteratively removes the top-blocking constraint each round to show which constraints are responsible for blocking which activities
                </span>
              </div>

              {isPinpointing && (
                <div style={{display:'flex',alignItems:'center',gap:'0.5rem',fontSize:'0.82rem',color:'#64748b',marginTop:'0.5rem'}}>
                  <div className="spinner spinner-sm"></div> Analysing…
                </div>
              )}

              {pinpointResult && !pinpointResult.error && (() => {
                const rounds = pinpointResult.rounds || [];
                const remaining = pinpointResult.remaining_blocked || [];
                return (
                  <div style={{marginTop:'0.75rem'}}>
                    {rounds.length === 0 && (
                      <div style={{fontSize:'0.82rem',color:'#15803d',padding:'0.4rem 0'}}>
                        ✓ No blocking constraints found — all activities reached the pool.
                      </div>
                    )}
                    {rounds.map((r, i) => (
                      <div key={i} style={{marginBottom:'0.5rem',padding:'0.5rem 0.75rem',background: r.constraint ? '#f8fafc' : '#fff7ed',borderLeft:`3px solid ${r.constraint ? '#6366f1' : '#f97316'}`,borderRadius:'0 4px 4px 0',fontSize:'0.82rem'}}>
                        <div style={{display:'flex',alignItems:'baseline',gap:'0.5rem',marginBottom:'0.2rem'}}>
                          <span style={{fontSize:'0.7rem',color:'#94a3b8',minWidth:'3rem'}}>Round {r.round}</span>
                          {r.constraint
                            ? <code style={{fontWeight:600,color:'#4338ca',fontSize:'0.78rem'}}>{r.constraint}</code>
                            : <span style={{color:'#c2410c',fontWeight:600}}>no constraint rejection — object availability issue</span>
                          }
                          {r.block_count > 0 && (
                            <span style={{fontSize:'0.7rem',color:'#64748b',marginLeft:'auto'}}>{r.block_count}× blocked</span>
                          )}
                        </div>
                        {r.was_blocking?.length > 0 && (
                          <div style={{fontSize:'0.75rem',color:'#475569',marginLeft:'3.5rem'}}>
                            was blocking: {r.was_blocking.join(', ')}
                          </div>
                        )}
                      </div>
                    ))}
                    {remaining.length > 0 && (
                      <div style={{marginTop:'0.4rem',padding:'0.4rem 0.75rem',background:'#fef2f2',borderLeft:'3px solid #dc2626',borderRadius:'0 4px 4px 0',fontSize:'0.82rem'}}>
                        <span style={{fontWeight:600,color:'#b91c1c'}}>Still blocked after all removals:</span>{' '}
                        <span style={{color:'#475569'}}>{remaining.join(', ')}</span>
                      </div>
                    )}
                    {remaining.length === 0 && rounds.length > 0 && (
                      <div style={{fontSize:'0.75rem',color:'#15803d',marginTop:'0.25rem'}}>
                        ✓ All activities reach the pool after removing the {rounds.length} constraint{rounds.length !== 1 ? 's' : ''} above.
                      </div>
                    )}
                  </div>
                );
              })()}

              {pinpointResult?.error && (
                <div className="error-box" style={{marginTop:'0.5rem'}}>
                  <p>{pinpointResult.error}</p>
                </div>
              )}
            </div>

            {/* ── Dry Run Stats ── */}
            <div style={{marginTop:'1rem',borderTop:'1px solid #f1f5f9',paddingTop:'1rem'}}>
              <div style={{display:'flex',alignItems:'center',gap:'0.75rem',flexWrap:'wrap'}}>
                <button
                  className="auto-generate-btn"
                  style={{background:'#f8fafc',color:'#334155',border:'1px solid #e2e8f0'}}
                  disabled={isDryRunning || !activeModel || !config.startActivities?.length}
                  onClick={runDryRunStats}
                >
                  {isDryRunning ? 'Running…' : '▶ Dry Run Stats (500 steps)'}
                </button>
                <span style={{fontSize:'0.72rem',color:'#94a3b8'}}>
                  Collects the most-pooled activities and most-blocking constraints over a 500-step dry run
                </span>
              </div>

              {isDryRunning && (
                <div style={{display:'flex',alignItems:'center',gap:'0.5rem',fontSize:'0.82rem',color:'#64748b',marginTop:'0.5rem'}}>
                  <div className="spinner spinner-sm"></div> Running dry run…
                </div>
              )}

              {dryRunResult && !dryRunResult.error && (() => {
                const pooled = dryRunResult.most_pooled || [];
                const blocking = dryRunResult.top_blocking_constraints || [];
                const objects = dryRunResult.top_pooled_objects || [];
                const stalled = dryRunResult.most_stalled || [];
                const total = dryRunResult.total_steps || 1;
                const avgPool = dryRunResult.avg_pool_size ?? '—';
                const emptySteps = dryRunResult.empty_pool_steps ?? 0;
                return (
                  <div style={{marginTop:'0.75rem',fontSize:'0.82rem'}}>
                    <div style={{display:'flex',gap:'1.5rem',marginBottom:'0.5rem',color:'#64748b'}}>
                      <span>Steps: <b style={{color:'#1e293b'}}>{total}</b></span>
                      <span>Avg pool size: <b style={{color:'#1e293b'}}>{avgPool}</b></span>
                      <span>Empty-pool steps: <b style={{color: emptySteps > total * 0.1 ? '#b91c1c' : '#1e293b'}}>{emptySteps}</b></span>
                    </div>

                    {/* Most pooled activities */}
                    {pooled.length > 0 && (
                      <div style={{marginBottom:'0.75rem'}}>
                        <div style={{fontWeight:600,color:'#334155',marginBottom:'0.3rem'}}>Most-pooled activities</div>
                        <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.8rem'}}>
                          <thead>
                            <tr style={{background:'#f8fafc',color:'#64748b'}}>
                              <th style={{textAlign:'left',padding:'3px 6px',borderBottom:'1px solid #e2e8f0'}}>Activity</th>
                              <th style={{textAlign:'right',padding:'3px 6px',borderBottom:'1px solid #e2e8f0'}}>Pool appearances</th>
                              <th style={{textAlign:'right',padding:'3px 6px',borderBottom:'1px solid #e2e8f0'}}>% of steps</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pooled.map((r, i) => (
                              <tr key={i} style={{borderBottom:'1px solid #f1f5f9'}}>
                                <td style={{padding:'3px 6px',color:'#1e293b'}}>{r.activity}</td>
                                <td style={{padding:'3px 6px',textAlign:'right',color:'#475569'}}>{r.count}</td>
                                <td style={{padding:'3px 6px',textAlign:'right',color:'#64748b'}}>{r.pct}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Top blocking constraints */}
                    {blocking.length > 0 && (
                      <div style={{marginBottom:'0.75rem'}}>
                        <div style={{fontWeight:600,color:'#334155',marginBottom:'0.3rem'}}>Top blocking constraints</div>
                        <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.8rem'}}>
                          <thead>
                            <tr style={{background:'#f8fafc',color:'#64748b'}}>
                              <th style={{textAlign:'left',padding:'3px 6px',borderBottom:'1px solid #e2e8f0'}}>Constraint</th>
                              <th style={{textAlign:'right',padding:'3px 6px',borderBottom:'1px solid #e2e8f0'}}>Rejections</th>
                              <th style={{textAlign:'left',padding:'3px 6px',borderBottom:'1px solid #e2e8f0'}}>Affects</th>
                            </tr>
                          </thead>
                          <tbody>
                            {blocking.map((r, i) => (
                              <tr key={i} style={{borderBottom:'1px solid #f1f5f9'}}>
                                <td style={{padding:'3px 6px',color:'#1e293b',fontFamily:'monospace',fontSize:'0.77rem'}}>{r.label}</td>
                                <td style={{padding:'3px 6px',textAlign:'right',color:'#475569'}}>{r.count}</td>
                                <td style={{padding:'3px 6px',color:'#64748b'}}>{(r.affects || []).join(', ')}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* Top pooled objects */}
                    {objects.length > 0 && (
                      <div style={{marginBottom:'0.75rem'}}>
                        <div style={{fontWeight:600,color:'#334155',marginBottom:'0.3rem'}}>Most-pooled objects</div>
                        <div style={{display:'flex',flexWrap:'wrap',gap:'0.35rem'}}>
                          {objects.map((r, i) => (
                            <span key={i} style={{background:'#f1f5f9',border:'1px solid #e2e8f0',borderRadius:'4px',padding:'2px 7px',fontSize:'0.77rem',color:'#334155'}}>
                              {r.object_id} <span style={{color:'#94a3b8',marginLeft:'3px'}}>{r.count}×</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {blocking.length === 0 && pooled.length === 0 && (
                      <div style={{color:'#15803d',fontSize:'0.8rem'}}>No blocking constraints found during the dry run.</div>
                    )}
                  </div>
                );
              })()}

              {dryRunResult?.error && (
                <div className="error-box" style={{marginTop:'0.5rem'}}>
                  <p>{dryRunResult.error}</p>
                </div>
              )}
            </div>
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
              disabled={isSimulating || (workflowMode !== 'external-empty' && !discoveryResults) || !config.ocdeclareFile || config.startActivities.length === 0 || hasBlockingModelIssues}
              title={lifecycleIssues.length > 0
                ? `Cannot run: incomplete object lifecycle for ${lifecycleIssues.map(i => i.type).join(', ')}`
                : undefined}
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
            <ObjectLifecycleWarning issues={lifecycleIssues} />
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
                  {config.maxSteps ? `completed events ${liveStepCount ?? 0} / ${config.maxSteps}` : `completed events ${liveStepCount ?? 0}`}
                </span>
              </p>
              <button className="sim-stop-btn" onClick={stopSimulation}>
                Stop
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
                <Collapsible className="logs-box" title="Evaluation" badge={null} defaultOpen={false}>

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
                  title="Activity Distribution vs Log"
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
                            </tr>
                          </thead>
                          <tbody>
                            {allActs.map(act => {
                              const simCount = simMetrics[act]?.execution_count ?? 0;
                              const logCount = logCounts[act] ?? 0;
                              const simPct = simTotal > 0 ? (simCount / simTotal * 100) : 0;
                              const logPct = logTotal > 0 ? (logCount / logTotal * 100) : 0;
                              const diff = simPct - logPct;
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
                  title="Object Lifecycle Audit"
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
                  title="Activity Participation Audit"
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
                </div>
              )}

              {/* ── Timing Metrics Panel ── */}
              {results.metrics && (
                <>
                  {/* Per-Activity */}
                  {results.metrics.activity_metrics && Object.keys(results.metrics.activity_metrics).length > 0 && (
                    <Collapsible
                      className="logs-box timing-metrics-box"
                      title="Time"
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
                      title="Object Lifetimes"
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
                            {isLoadingObjMetrics ? 'Loading…' : 'Load Object Lifetimes'}
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
              title="Object Tracer"
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
            title="Run History"
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
                              <button className="rh-btn" onClick={() => window.open(`/api/download/${run.output_file}`, '_blank')} title="Download event log">Log</button>
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

  {/* Activity involvement popup */}
  {activityPopup && (
    <div
      style={{position:'fixed',inset:0,zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.25)'}}
      onClick={() => setActivityPopup(null)}
    >
      <div
        style={{background:'white',borderRadius:'10px',padding:'1.25rem 1.5rem',boxShadow:'0 8px 32px rgba(0,0,0,0.18)',minWidth:'260px',maxWidth:'380px',width:'90%'}}
        onClick={e => e.stopPropagation()}
      >
        <div style={{fontWeight:700,fontSize:'0.95rem',marginBottom:'0.75rem',color:'#1e293b'}}>{activityPopup.name}</div>
        <div style={{fontSize:'0.78rem',color:'#64748b',marginBottom:'0.5rem',fontWeight:600}}>Object Involvement</div>
        {activityPopup.objects.length === 0 ? (
          <div style={{fontSize:'0.8rem',color:'#94a3b8'}}>No object bindings.</div>
        ) : (
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:'0.82rem'}}>
            <thead>
              <tr style={{borderBottom:'1px solid #e2e8f0'}}>
                <th style={{textAlign:'left',padding:'0.25rem 0.4rem 0.35rem 0',color:'#64748b',fontWeight:600}}>Object Type</th>
                <th style={{textAlign:'center',padding:'0.25rem 0.4rem 0.35rem',color:'#16a34a',fontWeight:700}}>Creates</th>
                <th style={{textAlign:'center',padding:'0.25rem 0 0.35rem 0.4rem',color:'#dc2626',fontWeight:700}}>Deactivates</th>
              </tr>
            </thead>
            <tbody>
              {activityPopup.objects.map((o, i) => (
                <tr key={i} style={{borderBottom:'1px solid #f1f5f9'}}>
                  <td style={{padding:'0.3rem 0.4rem 0.3rem 0',color:'#1e293b'}}>{o.type}</td>
                  <td style={{textAlign:'center',padding:'0.3rem 0.4rem'}}>{o.creates ? <span style={{color:'#16a34a',fontWeight:700}}>✓</span> : <span style={{color:'#cbd5e1'}}>—</span>}</td>
                  <td style={{textAlign:'center',padding:'0.3rem 0 0.3rem 0.4rem'}}>{o.deactivates ? <span style={{color:'#dc2626',fontWeight:700}}>✓</span> : <span style={{color:'#cbd5e1'}}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button
          style={{marginTop:'0.85rem',fontSize:'0.75rem',color:'#64748b',background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'6px',padding:'0.3rem 0.8rem',cursor:'pointer'}}
          onClick={() => setActivityPopup(null)}
        >Close</button>
      </div>
    </div>
  )}
  </div>
  );
}

export default App;
