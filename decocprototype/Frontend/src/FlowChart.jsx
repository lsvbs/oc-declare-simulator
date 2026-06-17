import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import './FlowChart.css';

// ── Layout constants ──────────────────────────────────────────────────────────
const NODE_W      = 180;
const NODE_H_BASE = 56;   // height without metric subtitle
const NODE_H_TALL = 74;   // height with metric subtitle
const H_GAP   = 110;
const ROW_GAP = 40;
const PADDING = 60;
const LANE_H  = 50;
const MIN_ZOOM = 0.25, MAX_ZOOM = 2.0;

// Available metric options for the node-label dropdown
const NODE_METRIC_OPTIONS = [
  { value: 'off',               label: 'Off' },
  { value: 'mean_duration',     label: 'Mean duration' },
  { value: 'mean_wait_in_pool', label: 'Mean wait in pool' },
  { value: 'max_wait_in_pool',  label: 'Max wait in pool' },
  { value: 'execution_count',   label: 'Execution count' },
];

// ── Object-type colour palette (avoid indigo = base DFG colour) ───────────────
const TYPE_PALETTE = [
  '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1', '#14b8a6',
];
const typeColor = (_, idx) => TYPE_PALETTE[idx % TYPE_PALETTE.length];

// ── Build DFG transition map from activity sequences ─────────────────────────
function buildDFG(sequences) {
  const trans = {};
  for (const seq of sequences) {
    seq.forEach((name, i) => {
      if (i < seq.length - 1) {
        const key = `${name} → ${seq[i + 1]}`;
        trans[key] = (trans[key] || 0) + 1;
      }
    });
  }
  return trans;
}

// ── Adaptive layered layout (Sugiyama-lite) ──────────────────────────────────
// Columns (x) follow the flow depth; rows (y) branch out vertically so the graph
// is not forced onto a single line. Returns { pos, width, height }.
function computeLayeredLayout(ordered, trans, nodeH = NODE_H_BASE) {
  const idxOf = {};
  ordered.forEach((n, i) => { idxOf[n] = i; });

  // Forward adjacency only (idx[from] < idx[to]); back edges ignored for ranking.
  const preds = {}, backCount = { n: 0 };
  ordered.forEach(n => { preds[n] = []; });
  Object.keys(trans).forEach(key => {
    const [f, t] = key.split(' → ');
    if (f === t || idxOf[f] === undefined || idxOf[t] === undefined) return;
    if (idxOf[f] < idxOf[t]) preds[t].push(f);
    else backCount.n += 1;
  });

  // rank = longest forward path ending at the node (ordered is topo-ish).
  const rank = {};
  ordered.forEach(n => {
    rank[n] = preds[n].length ? Math.max(...preds[n].map(p => rank[p] + 1)) : 0;
  });

  // Group nodes by rank.
  const ranks = {};
  ordered.forEach(n => { (ranks[rank[n]] = ranks[rank[n]] || []).push(n); });
  const rankKeys = Object.keys(ranks).map(Number).sort((a, b) => a - b);

  const pitch = nodeH + ROW_GAP;
  const yOf = {};
  rankKeys.forEach(r => {
    const nodes = ranks[r];
    // Desired y = average of already-placed predecessors (reduces crossings).
    const items = nodes.map((n, i) => {
      const ps = preds[n];
      const d = (r === 0 || ps.length === 0)
        ? i * pitch
        : ps.reduce((s, p) => s + yOf[p], 0) / ps.length;
      return { n, d, i };
    });
    items.sort((a, b) => (a.d - b.d) || (a.i - b.i));
    let lastY = -Infinity;
    items.forEach(it => {
      const y = Math.max(it.d, lastY + pitch);
      yOf[it.n] = y;
      lastY = y;
    });
  });

  // Normalise y and reserve top space for back-arcs.
  const rawMin = Math.min(...ordered.map(n => yOf[n]));
  const topReserve = backCount.n ? LANE_H * Math.min(backCount.n, 5) + 20 : 24;
  const shift = (PADDING + topReserve) - rawMin;

  const pos = {};
  let maxX = 0, maxY = 0;
  ordered.forEach(n => {
    const x = PADDING + rank[n] * (NODE_W + H_GAP);
    const y = yOf[n] + shift;
    pos[n] = { x, y, width: NODE_W, height: nodeH };
    maxX = Math.max(maxX, x + NODE_W);
    maxY = Math.max(maxY, y + nodeH);
  });

  return { pos, width: maxX + PADDING, height: maxY + PADDING + 30 };
}


// ── Main component ────────────────────────────────────────────────────────────
function FlowChart({ activitySequence, objectTraces = {}, objectTypesMap = {}, activityMetrics = null }) {
  const canvasRef = useRef(null);
  const scrollRef = useRef(null);
  const posRef    = useRef({});
  const transRef  = useRef({});
  const listRef   = useRef([]);
  const dragRef   = useRef({ active: false, node: null, ox: 0, oy: 0 });
  const panRef    = useRef({ x: 0, y: 0 }); // canvas-space pan offset

  const [showBase,      setShowBase]      = useState(true);
  const [showForward,   setShowForward]   = useState(true);
  const [showBackloop,  setShowBackloop]  = useState(true);
  const [showSelfloop,  setShowSelfloop]  = useState(true);
  const [nodeMetric,    setNodeMetric]    = useState('mean_duration');
  const [activeObjIds,  setActiveObjIds]  = useState(new Set());
  const [expandedTypes, setExpandedTypes] = useState(new Set()); // empty = all collapsed
  const [overlayMode,   setOverlayMode]   = useState('aggregate'); // 'aggregate' | 'trace'
  const [zoom,          setZoom]          = useState(0.65);
  const [canvasDims,    setCanvasDims]    = useState({ w: 900, h: 300 });

  const changeZoom = useCallback(delta =>
    setZoom(z => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, parseFloat((z + delta).toFixed(2))))),
  []);

  // ── Group objects by type (only those with trace data) ───────────────────
  const typeGroups = useMemo(() => {
    const groups = {};
    Object.entries(objectTypesMap).forEach(([oid, otype]) => {
      (groups[otype] = groups[otype] || []).push(oid);
    });
    return groups;
  }, [objectTypesMap, objectTraces]);

  const orderedTypes = useMemo(() => Object.keys(typeGroups).sort(), [typeGroups]);
  const typeColorMap = useMemo(() => {
    const m = {};
    orderedTypes.forEach((t, i) => { m[t] = i; });
    return m;
  }, [orderedTypes]);

  // ── Canvas draw ──────────────────────────────────────────────────────────
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const pos  = posRef.current;
    const trans = transRef.current;
    const list = listRef.current;
    if (!list.length) return;

    const idxOf = {};
    list.forEach((n, i) => { idxOf[n] = i; });

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(panRef.current.x, panRef.current.y);

    // Draw arrows: fwdColor for left→right, backColor for arcs above, selfColor for loops
    const drawSet = (dfgTrans, fwdColor, backColor, selfColor, alpha, wScale, opts = {}) => {
      const { fwd: doFwd = true, back: doBack = true, self: doSelf = true } = opts;
      const selfLoops = [], fwd = [], back = [];
      Object.entries(dfgTrans).forEach(([key, count]) => {
        const [from, to] = key.split(' → ');
        if (!pos[from] || !pos[to]) return;
        if (from === to) { selfLoops.push({ from, count }); return; }
        const fi = idxOf[from] ?? 0, ti = idxOf[to] ?? 0;
        (fi < ti ? fwd : back).push({ from, to, count });
      });
      back.sort((a, b) =>
        (idxOf[b.from] - idxOf[b.to]) - (idxOf[a.from] - idxOf[a.to])
      );

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = '11px system-ui, sans-serif';

      // Self-loops
      if (doSelf) selfLoops.forEach(({ from, count }) => {
        const fp = pos[from]; if (!fp) return;
        const loopR = 22;
        const cx = fp.x + fp.width / 2, cy = fp.y - loopR - 6;
        ctx.beginPath(); ctx.arc(cx, cy, loopR, 0, Math.PI * 2);
        ctx.strokeStyle = selfColor; ctx.lineWidth = 2 * wScale; ctx.stroke();
        _drawHead(ctx, cx + 2, cy + loopR - 4, cx, cy + loopR, selfColor);
        ctx.fillStyle = selfColor; ctx.textAlign = 'center';
        ctx.fillText(`×${count}`, cx, cy - loopR - 4);
      });

      // Forward arrows
      if (doFwd) fwd.forEach(({ from, to, count }) => {
        const fp = pos[from], tp = pos[to]; if (!fp || !tp) return;
        const sx = fp.x + fp.width, sy = fp.y + fp.height / 2;
        const ex = tp.x,            ey = tp.y  + tp.height / 2;
        const dx = Math.max(40, (ex - sx) * 0.4);
        ctx.beginPath(); ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(sx + dx, sy, ex - dx, ey, ex, ey);
        ctx.strokeStyle = fwdColor;
        ctx.lineWidth = Math.min((1 + count * 0.2) * wScale, 5); ctx.stroke();
        _drawHead(ctx, ex - 10, ey, ex, ey, fwdColor);
        ctx.fillStyle = fwdColor; ctx.textAlign = 'center';
        ctx.fillText(`×${count}`, (sx + ex) / 2, (sy + ey) / 2 - 7);
      });

      // Backward arrows
      if (doBack) back.forEach(({ from, to, count }, lane) => {
        const fp = pos[from], tp = pos[to]; if (!fp || !tp) return;
        const sx = fp.x + fp.width / 2, sy = fp.y;
        const ex = tp.x + tp.width / 2, ey = tp.y;
        const apex = Math.min(sy, ey) - LANE_H * (lane + 1);
        ctx.beginPath(); ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(sx, apex, ex, apex, ex, ey);
        ctx.strokeStyle = backColor;
        ctx.lineWidth = Math.min((1 + count * 0.2) * wScale, 5); ctx.stroke();
        _drawHead(ctx, ex, ey - 10, ex, ey, backColor);
        ctx.fillStyle = backColor; ctx.textAlign = 'center';
        ctx.fillText(`×${count}`, (sx + ex) / 2, apex - 4);
      });

      ctx.restore();
    };

    // Per-object literal trace: draw one object's actual walk through activities,
    // offset perpendicular so multiple objects' paths stay distinguishable.
    // Routing is decided purely from the nodes' real layout positions (not the
    // global first-appearance order) so single traces never produce stray loops.
    const drawObjectTrace = (oid, offset, color, alpha) => {
      const trace = objectTraces[oid] || [];
      if (trace.length === 0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;

      for (let i = 0; i < trace.length - 1; i++) {
        const from = trace[i], to = trace[i + 1];
        const fp = pos[from], tp = pos[to];
        if (!fp || !tp) continue;

        // Self-loop: small circle above the node
        if (from === to) {
          const loopR = 20 + Math.abs(offset);
          const cx = fp.x + fp.width / 2, cy = fp.y - loopR - 6;
          ctx.beginPath(); ctx.arc(cx, cy, loopR, 0, Math.PI * 2); ctx.stroke();
          _drawHead(ctx, cx + 2, cy + loopR - 4, cx, cy + loopR, color);
          continue;
        }

        const goesRight = tp.x > fp.x + 1;
        const sameCol   = Math.abs(tp.x - fp.x) <= 1;

        if (goesRight) {
          // Forward: right edge of `from` → left edge of `to`
          const sx = fp.x + fp.width, sy = fp.y + fp.height / 2 + offset;
          const ex = tp.x,            ey = tp.y + tp.height / 2 + offset;
          const dx = Math.max(40, (ex - sx) * 0.5);
          ctx.beginPath(); ctx.moveTo(sx, sy);
          ctx.bezierCurveTo(sx + dx, sy, ex - dx, ey, ex, ey); ctx.stroke();
          _drawHead(ctx, ex - 10, ey, ex, ey, color);
        } else if (sameCol) {
          // Same column (different rows): bulge out to the right, edge → edge
          const sx = fp.x + fp.width, sy = fp.y + fp.height / 2 + offset;
          const ex = tp.x + tp.width, ey = tp.y + tp.height / 2 + offset;
          const bulge = 46 + Math.abs(offset);
          ctx.beginPath(); ctx.moveTo(sx, sy);
          ctx.bezierCurveTo(sx + bulge, sy, ex + bulge, ey, ex, ey); ctx.stroke();
          _drawHead(ctx, ex + 9, ey, ex, ey, color);
        } else {
          // Backward: arc above, top of `from` → top of `to`
          const sx = fp.x + fp.width / 2 + offset, sy = fp.y;
          const ex = tp.x + tp.width / 2 + offset, ey = tp.y;
          const apex = Math.min(sy, ey) - (LANE_H * 0.8 + Math.abs(offset) * 2);
          ctx.beginPath(); ctx.moveTo(sx, sy);
          ctx.bezierCurveTo(sx, apex, ex, apex, ex, ey); ctx.stroke();
          _drawHead(ctx, ex, ey - 10, ex, ey, color);
        }
      }

      // Ring the nodes this object actually visits so the path is easy to follow
      const visited = new Set(trace);
      ctx.lineWidth = 2.5;
      visited.forEach(name => {
        const p = pos[name]; if (!p) return;
        ctx.beginPath();
        _roundRect(ctx, p.x - 3, p.y - 3, p.width + 6, p.height + 6, 12);
        ctx.stroke();
      });

      ctx.restore();
    };

    // Base DFG: forward=indigo, backward=amber, self=violet
    if (showBase) {
      drawSet(trans, '#667eea', '#f59e0b', '#a78bfa', 1.0, 1.0,
        { fwd: showForward, back: showBackloop, self: showSelfloop });
    }

    // Per-object overlays
    if (activeObjIds.size > 0) {
      if (overlayMode === 'aggregate') {
        const byType = {};
        activeObjIds.forEach(oid => {
          const otype = objectTypesMap[oid]; if (!otype) return;
          (byType[otype] = byType[otype] || []).push(oid);
        });
        Object.entries(byType).forEach(([otype, oids]) => {
          const color = typeColor(otype, typeColorMap[otype] ?? 0);
          const dfg   = buildDFG(oids.map(oid => objectTraces[oid] || []));
          drawSet(dfg, color, color, color, 0.85, 0.65,
            { fwd: showForward, back: showBackloop, self: showSelfloop });
        });
      } else {
        // Per-object literal traces, each offset so parallel paths are visible
        const activeList = [...activeObjIds];
        activeList.forEach((oid, k) => {
          const color  = typeColor(objectTypesMap[oid], typeColorMap[objectTypesMap[oid]] ?? 0);
          const offset = (k - (activeList.length - 1) / 2) * 7;
          drawObjectTrace(oid, offset, color, 0.9);
        });
      }
    }

    // Nodes always on top
    const nodeH = nodeMetric === 'off' ? NODE_H_BASE : NODE_H_TALL;
    list.forEach(name => {
      const p = pos[name]; if (!p) return;
      ctx.shadowColor = 'rgba(102,126,234,0.18)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#667eea'; ctx.lineWidth = 2;
      ctx.beginPath(); _roundRect(ctx, p.x, p.y, p.width, p.height, 10);
      ctx.fill(); ctx.stroke();
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

      // Activity name — shift up when metric subtitle is shown
      const nameY = nodeMetric === 'off'
        ? p.y + p.height / 2
        : p.y + p.height / 2 - 9;
      ctx.fillStyle = '#1e293b'; ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      _wrapText(ctx, name, p.x + p.width / 2, nameY, p.width - 22, 15);

      // Metric subtitle
      if (nodeMetric !== 'off') {
        const m = activityMetrics && activityMetrics[name];
        let label = '—';
        if (m) {
          if (nodeMetric === 'mean_duration' && m.mean_duration_s != null)
            label = _fmtSeconds(m.mean_duration_s);
          else if (nodeMetric === 'mean_wait_in_pool' && m.mean_wait_in_pool_s != null)
            label = _fmtSeconds(m.mean_wait_in_pool_s);
          else if (nodeMetric === 'max_wait_in_pool' && m.max_wait_in_pool_s != null)
            label = _fmtSeconds(m.max_wait_in_pool_s);
          else if (nodeMetric === 'execution_count' && m.execution_count != null)
            label = `×${m.execution_count}`;
        }
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(label, p.x + p.width / 2, p.y + p.height / 2 + 10);
      }
    });

    ctx.restore(); // undo pan translate
  }, [showBase, showForward, showBackloop, showSelfloop, nodeMetric, activityMetrics, activeObjIds, overlayMode, objectTraces, objectTypesMap, typeColorMap]);

  // ── Layout initialisation ─────────────────────────────────────────────────
  // Edges are built from objectTraces so that left→right rank reflects the
  // actual object flow: if object X visits A then B, A is ranked left of B.
  useEffect(() => {
    if (!activitySequence?.length) return;

    // Collect unique activities in first-appearance order (stable topo seed).
    const seen = new Set(), ordered = [];
    activitySequence.forEach(name => {
      if (!seen.has(name)) { seen.add(name); ordered.push(name); }
    });

    // Build transition counts from per-object traces (object-flow edges).
    const trans = {};
    const allTraces = Object.values(objectTraces);
    if (allTraces.length > 0) {
      allTraces.forEach(seq => {
        seq.forEach((name, i) => {
          if (i < seq.length - 1) {
            const key = `${name} → ${seq[i + 1]}`;
            trans[key] = (trans[key] || 0) + 1;
          }
        });
      });
    } else {
      // Fallback: use the flat activity sequence when no object traces exist.
      activitySequence.forEach((name, i) => {
        if (i < activitySequence.length - 1) {
          const key = `${name} → ${activitySequence[i + 1]}`;
          trans[key] = (trans[key] || 0) + 1;
        }
      });
    }

    listRef.current = ordered; transRef.current = trans;

    const nodeH = nodeMetric === 'off' ? NODE_H_BASE : NODE_H_TALL;
    const { pos, width, height } = computeLayeredLayout(ordered, trans, nodeH);
    const canvas = canvasRef.current;
    canvas.width  = Math.max(900, width);
    canvas.height = Math.max(220, height);
    setCanvasDims({ w: canvas.width, h: canvas.height });

    posRef.current = pos;
    renderCanvas();
  }, [activitySequence, objectTraces, nodeMetric, renderCanvas]);

  useEffect(() => { renderCanvas(); }, [renderCanvas]);

  // ── Drag nodes / pan background ──────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;

    // Convert mouse event to canvas logical coordinates (accounts for zoom + pan).
    const toCanvas = e => {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (canvas.width  / r.width)  - panRef.current.x,
        y: (e.clientY - r.top)  * (canvas.height / r.height) - panRef.current.y,
      };
    };
    // Raw screen-space delta (zoom-scaled but NOT pan-offset — used for panning itself).
    const toRaw = e => ({
      x: e.clientX * (canvas.width  / canvas.getBoundingClientRect().width),
      y: e.clientY * (canvas.height / canvas.getBoundingClientRect().height),
    });
    const hitTest = ({ x, y }) => {
      for (const [name, p] of Object.entries(posRef.current))
        if (x >= p.x && x <= p.x + p.width && y >= p.y && y <= p.y + p.height) return name;
      return null;
    };

    const onDown = e => {
      const mp = toCanvas(e), hit = hitTest(mp);
      if (hit) {
        const p = posRef.current[hit];
        dragRef.current = { active: true, node: hit, ox: mp.x - p.x, oy: mp.y - p.y, panning: false };
        canvas.style.cursor = 'grabbing';
      } else {
        const raw = toRaw(e);
        dragRef.current = { active: true, node: null, ox: raw.x, oy: raw.y, panning: true };
        canvas.style.cursor = 'grabbing';
      }
      e.preventDefault();
    };

    const onMove = e => {
      const d = dragRef.current;
      if (!d.active) {
        canvas.style.cursor = hitTest(toCanvas(e)) ? 'grab' : 'move';
        return;
      }
      if (d.panning) {
        const raw = toRaw(e);
        panRef.current = { x: panRef.current.x + (raw.x - d.ox), y: panRef.current.y + (raw.y - d.oy) };
        dragRef.current.ox = raw.x;
        dragRef.current.oy = raw.y;
      } else {
        const mp = toCanvas(e);
        posRef.current[d.node] = { ...posRef.current[d.node], x: mp.x - d.ox, y: mp.y - d.oy };
      }
      renderCanvas();
    };

    const onUp = () => {
      dragRef.current.active = false;
      canvas.style.cursor = 'move';
    };

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup',   onUp);
    canvas.addEventListener('mouseleave', onUp);
    return () => {
      canvas.removeEventListener('mousedown', onDown);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseup',   onUp);
      canvas.removeEventListener('mouseleave', onUp);
    };
  }, [renderCanvas]);

  // ── Ctrl+scroll to zoom ──────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const onWheel = e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      changeZoom(e.deltaY < 0 ? 0.1 : -0.1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [changeZoom]);

  // ── Reset to the adaptive layered layout ─────────────────────────────────
  const resetLayout = useCallback(() => {
    const ordered = listRef.current; if (!ordered.length) return;
    const nodeH = nodeMetric === 'off' ? NODE_H_BASE : NODE_H_TALL;
    const { pos } = computeLayeredLayout(ordered, transRef.current, nodeH);
    posRef.current = pos;
    panRef.current = { x: 0, y: 0 };
    renderCanvas();
  }, [renderCanvas, nodeMetric]);

  // ── Object toggle helpers ─────────────────────────────────────────────────
  const toggleObj  = oid  => setActiveObjIds(prev => {
    const next = new Set(prev); next.has(oid) ? next.delete(oid) : next.add(oid); return next;
  });
  const toggleType = (oids, allActive) => setActiveObjIds(prev => {
    const next = new Set(prev);
    allActive ? oids.forEach(o => next.delete(o)) : oids.forEach(o => next.add(o));
    return next;
  });
  const toggleExpand = otype => setExpandedTypes(prev => {
    const next = new Set(prev); next.has(otype) ? next.delete(otype) : next.add(otype); return next;
  });

  const hasObjectData = Object.keys(typeGroups).length > 0;

  return (
    <div className="flow-chart-container">

      {/* ── Toolbar ── */}
      <div className="flow-chart-toolbar">
        <div className="flow-toolbar-left">
          <button className="flow-reset-btn" onClick={resetLayout}>↺ Reset</button>
          <span className="flow-hint">Drag background to pan · Drag nodes to reposition · Ctrl+scroll to zoom</span>
        </div>
        <div className="flow-toolbar-right">
          {hasObjectData && (
            <div className="flow-mode-switch" role="group" title="How to draw the selected object paths">
              <button
                className={`flow-mode-btn${overlayMode === 'aggregate' ? ' active' : ''}`}
                onClick={() => setOverlayMode('aggregate')}
                title="Merge each type's objects into one frequency graph"
              >Σ Aggregate</button>
              <button
                className={`flow-mode-btn${overlayMode === 'trace' ? ' active' : ''}`}
                onClick={() => setOverlayMode('trace')}
                title="Draw every selected object's individual path"
              >↪ Per-object</button>
            </div>
          )}
          <button className="flow-zoom-btn" onClick={() => changeZoom(-0.1)} title="Zoom out">−</button>
          <span className="flow-zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="flow-zoom-btn" onClick={() => changeZoom( 0.1)} title="Zoom in">+</button>
          <div className="flow-arrow-toggles" title="Show/hide arrow types in the DFG">
            <button
              className={`flow-toggle-btn${showBase ? ' active' : ''}`}
              onClick={() => setShowBase(v => !v)}
              title="Show / hide the aggregate directly-follows graph"
            >
              {showBase ? '◉' : '○'} DFG
            </button>
            <button
              className={`flow-toggle-btn${showForward ? ' active' : ''}`}
              onClick={() => setShowForward(v => !v)}
              title="Show / hide forward arrows"
              style={showForward ? { borderColor: '#667eea', color: '#667eea' } : {}}
            >
              → Fwd
            </button>
            <button
              className={`flow-toggle-btn${showBackloop ? ' active' : ''}`}
              onClick={() => setShowBackloop(v => !v)}
              title="Show / hide back-loop arrows"
              style={showBackloop ? { borderColor: '#f59e0b', color: '#f59e0b' } : {}}
            >
              ↩ Back
            </button>
            <button
              className={`flow-toggle-btn${showSelfloop ? ' active' : ''}`}
              onClick={() => setShowSelfloop(v => !v)}
              title="Show / hide self-loop arrows"
              style={showSelfloop ? { borderColor: '#a78bfa', color: '#a78bfa' } : {}}
            >
              ↺ Self
            </button>
          </div>
          <div className="flow-node-metric-wrap" title="Value shown inside each activity node">
            <label className="flow-node-metric-label">Node label:</label>
            <select
              className="flow-node-metric-select"
              value={nodeMetric}
              onChange={e => setNodeMetric(e.target.value)}
            >
              {NODE_METRIC_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ── Legend ── */}
      <div className="flow-legend">
        {showBase && <>
          <span className="legend-item"><span className="legend-swatch" style={{ background: '#667eea' }}></span>Forward</span>
          <span className="legend-item"><span className="legend-swatch" style={{ background: '#f59e0b' }}></span>Back-loop</span>
          <span className="legend-item"><span className="legend-swatch" style={{ background: '#a78bfa' }}></span>Self-loop</span>
          <span className="legend-item"><span className="legend-swatch legend-thick"></span>Thickness = frequency</span>
        </>}
        {activeObjIds.size > 0 && orderedTypes.map(otype => {
          const cnt = (typeGroups[otype] || []).filter(o => activeObjIds.has(o)).length;
          if (!cnt) return null;
          return (
            <span key={otype} className="legend-item">
              <span className="legend-swatch" style={{ background: typeColor(otype, typeColorMap[otype] ?? 0) }}></span>
              {otype} ({cnt})
            </span>
          );
        })}
        {activeObjIds.size > 0 && (
          <span className="legend-item legend-mode">
            {overlayMode === 'trace' ? '↪ individual object paths' : 'Σ merged per type'}
          </span>
        )}
      </div>

      {/* ── Object-type selector ── */}
      {hasObjectData ? (
        <div className="flow-object-selector">
          <span className="flow-obj-label">Highlight paths:</span>
          {orderedTypes.map(otype => {
            const oids = typeGroups[otype] || [];
            const color = typeColor(otype, typeColorMap[otype] ?? 0);
            const allActive  = oids.every(o => activeObjIds.has(o));
            const someActive = oids.some(o  => activeObjIds.has(o));
            const expanded   = expandedTypes.has(otype);
            return (
              <div key={otype} className="flow-type-group">
                <div className="flow-type-pill-row">
                  {/* Type button: click to toggle all instances of this type */}
                  <button
                    className={`flow-type-pill${someActive ? ' active' : ''}`}
                    style={someActive ? { borderColor: color, color, background: color + '22' } : {}}
                    onClick={() => toggleType(oids, allActive)}
                    title={`Toggle all ${otype} objects (${oids.length})`}
                  >
                    {otype}
                    <span className="flow-type-count">{oids.length}</span>
                  </button>
                  {/* Expand/collapse chevron */}
                  <button
                    className="flow-type-expand"
                    onClick={() => toggleExpand(otype)}
                    title={expanded ? 'Collapse instances' : 'Expand instances'}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                </div>
                {/* Individual instance buttons — only shown when expanded */}
                {expanded && (
                  <div className="flow-obj-pills">
                    {oids.map(oid => {
                      const active = activeObjIds.has(oid);
                      const shortId = oid.startsWith(otype + '_')
                        ? '#' + oid.slice(otype.length + 1)
                        : oid.length > 12 ? oid.slice(0, 10) + '…' : oid;
                      return (
                        <button
                          key={oid}
                          className={`flow-obj-pill${active ? ' active' : ''}`}
                          style={active ? { borderColor: color, color, background: color + '22' } : {}}
                          onClick={() => toggleObj(oid)}
                          title={oid}
                        >
                          {shortId}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        Object.keys(objectTraces).length === 0 && activitySequence?.length > 0 && (
          <p className="flow-no-traces">
            Re-run the simulation with the updated backend to see per-object path overlays.
          </p>
        )
      )}

      {/* ── Scrollable canvas area ── */}
      <div className="flow-canvas-scroll" ref={scrollRef}>
        <canvas
          ref={canvasRef}
          style={{ width: canvasDims.w * zoom, height: canvasDims.h * zoom, display: 'block' }}
        />
      </div>

    </div>
  );
}

// ── Drawing helpers ───────────────────────────────────────────────────────────
function _fmtSeconds(s) {
  if (s == null) return '—';
  if (s < 60)    return `${s.toFixed(0)}s`;
  if (s < 3600)  return `${(s / 60).toFixed(1)}min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
function _drawHead(ctx, fromX, fromY, toX, toY, color) {
  const len = 11, angle = Math.atan2(toY - fromY, toX - fromX);
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - len * Math.cos(angle - Math.PI / 6), toY - len * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - len * Math.cos(angle + Math.PI / 6), toY - len * Math.sin(angle + Math.PI / 6));
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
}
function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}
function _wrapText(ctx, text, cx, cy, maxW, lineH) {
  if (ctx.measureText(text).width <= maxW) { ctx.fillText(text, cx, cy); return; }
  const words = text.split(' '), mid = Math.ceil(words.length / 2);
  ctx.fillText(words.slice(0, mid).join(' '), cx, cy - lineH / 2);
  ctx.fillText(words.slice(mid).join(' '),    cx, cy + lineH / 2);
}

export default FlowChart;
