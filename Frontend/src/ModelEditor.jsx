import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import './ModelEditor.css';

// ── O2O UML Diagram ───────────────────────────────────────────────────────────
const NODE_R   = 34;
const O2O_PALETTE = ['#667eea','#10b981','#f59e0b','#ef4444','#8b5cf6',
                     '#ec4899','#06b6d4','#84cc16','#f97316','#14b8a6'];

export function O2ODiagram({ rules, otNames }) {
  const [hovered, setHovered] = useState(null);
  const [positions, setPositions] = useState({});  // type -> {x, y}
  const dragging = useRef(null); // { type, startX, startY, origX, origY, svgRect }
  const svgRef = useRef(null);

  const types = useMemo(() => {
    const seen = new Set();
    rules.forEach(r => { seen.add(r.source_type); seen.add(r.target_type); });
    return otNames.filter(t => seen.has(t));
  }, [rules, otNames]);

  const n = types.length;

  const W = 620, H = Math.max(260, Math.min(420, 90 * Math.ceil(n / 2)));
  const cx = W / 2, cy = H / 2;
  const rx = Math.min(cx - NODE_R - 10, 230);
  const ry = Math.min(cy - NODE_R - 10, 160);

  // Seed initial positions from ellipse — only when the type list changes
  useEffect(() => {
    if (n === 0) return;
    setPositions(prev => {
      const next = {};
      types.forEach((t, i) => {
        if (prev[t]) {
          next[t] = prev[t]; // preserve manually dragged positions
        } else {
          const angle = (2 * Math.PI * i) / n - Math.PI / 2;
          next[t] = { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
        }
      });
      return next;
    });
  }, [types.join(','), n, cx, cy, rx, ry]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = positions;
  const colorOf = t => O2O_PALETTE[types.indexOf(t) % O2O_PALETTE.length];

  const pairCount = {};
  rules.forEach((r, i) => {
    const key = [r.source_type, r.target_type].sort().join('|||');
    if (!pairCount[key]) pairCount[key] = [];
    pairCount[key].push(i);
  });

  // ── Drag handlers ────────────────────────────────────────────────────────
  const onNodePointerDown = useCallback((e, type) => {
    e.preventDefault();
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = W / rect.width;
    const scaleY = H / rect.height;
    dragging.current = {
      type,
      startX: e.clientX,
      startY: e.clientY,
      origX: pos[type]?.x ?? cx,
      origY: pos[type]?.y ?? cy,
      scaleX,
      scaleY,
    };
    svg.setPointerCapture(e.pointerId);
  }, [pos, cx, cy, W, H]);

  const onSvgPointerMove = useCallback((e) => {
    if (!dragging.current) return;
    const { type, startX, startY, origX, origY, scaleX, scaleY } = dragging.current;
    const nx = Math.max(NODE_R, Math.min(W - NODE_R, origX + (e.clientX - startX) * scaleX));
    const ny = Math.max(NODE_R, Math.min(H - NODE_R, origY + (e.clientY - startY) * scaleY));
    setPositions(prev => ({ ...prev, [type]: { x: nx, y: ny } }));
  }, [W, H]);

  const onSvgPointerUp = useCallback(() => {
    dragging.current = null;
  }, []);

  // ── Edge rendering ────────────────────────────────────────────────────────
  const renderEdge = (r, idx) => {
    const src = pos[r.source_type];
    const tgt = pos[r.target_type];
    if (!src || !tgt) return null;

    const isSelf = r.source_type === r.target_type;
    const key = [r.source_type, r.target_type].sort().join('|||');
    const siblings = pairCount[key] || [idx];
    const sibling_i = siblings.indexOf(idx);
    const isHov = hovered === idx;
    const stroke = isHov ? '#1e293b' : '#94a3b8';
    const strokeW = isHov ? 2 : 1.5;
    const label = `${r.min_links ?? 0}..${r.max_links ?? '*'}`;

    if (isSelf) {
      const lx = src.x, ly = src.y - NODE_R;
      const d = `M ${lx-16} ${ly} C ${lx-30} ${ly-40} ${lx+30} ${ly-40} ${lx+16} ${ly}`;
      return (
        <g key={idx} onMouseEnter={() => setHovered(idx)} onMouseLeave={() => setHovered(null)}>
          <path d={d} stroke={stroke} strokeWidth={strokeW} fill="none"
            markerEnd={r.bidirectional ? undefined : 'url(#o2o-arrow)'} />
          {r.bidirectional && <path d={d} stroke={stroke} strokeWidth={strokeW} fill="none"
            markerStart="url(#o2o-arrow-rev)" />}
          <text x={lx} y={ly-30} textAnchor="middle" fontSize="10"
            fill={isHov ? '#1e293b' : '#64748b'} fontWeight={isHov ? 700 : 400}>{label}</text>
        </g>
      );
    }

    const offset = (sibling_i - (siblings.length - 1) / 2) * 28;
    const dx = tgt.x - src.x, dy = tgt.y - src.y;
    const len = Math.sqrt(dx*dx + dy*dy) || 1;
    const mx = (src.x+tgt.x)/2 + (-dy/len)*offset;
    const my = (src.y+tgt.y)/2 + (dx/len)*offset;
    const srcA = Math.atan2(my-src.y, mx-src.x);
    const tgtA = Math.atan2(my-tgt.y, mx-tgt.x);
    const x1 = src.x + NODE_R*Math.cos(srcA), y1 = src.y + NODE_R*Math.sin(srcA);
    const x2 = tgt.x + NODE_R*Math.cos(tgtA), y2 = tgt.y + NODE_R*Math.sin(tgtA);
    const d = `M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`;
    const lmx = (x1+x2)/2 + (-dy/len)*offset*0.55;
    const lmy = (y1+y2)/2 + (dx/len)*offset*0.55;

    return (
      <g key={idx} onMouseEnter={() => setHovered(idx)} onMouseLeave={() => setHovered(null)}>
        <path d={d} stroke={stroke} strokeWidth={strokeW} fill="none"
          markerEnd="url(#o2o-arrow)"
          markerStart={r.bidirectional ? 'url(#o2o-arrow-rev)' : undefined} />
        <text x={lmx} y={lmy-4} textAnchor="middle" fontSize="10"
          fill={isHov ? '#1e293b' : '#64748b'} fontWeight={isHov ? 700 : 400}
          stroke="white" strokeWidth="3" paintOrder="stroke">{label}</text>
      </g>
    );
  };

  if (n === 0) return null;

  return (
    <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`}
      style={{ display: 'block', maxHeight: H, cursor: dragging.current ? 'grabbing' : 'default' }}
      onPointerMove={onSvgPointerMove}
      onPointerUp={onSvgPointerUp}
      onPointerLeave={onSvgPointerUp}
    >
      <defs>
        <marker id="o2o-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <polygon points="0 0, 7 3.5, 0 7" fill="#94a3b8" />
        </marker>
        <marker id="o2o-arrow-rev" markerWidth="7" markerHeight="7" refX="1" refY="3.5" orient="auto-start-reverse">
          <polygon points="0 0, 7 3.5, 0 7" fill="#94a3b8" />
        </marker>
      </defs>

      {rules.map((r, i) => renderEdge(r, i))}

      {types.map(t => {
        const p = pos[t];
        if (!p) return null;
        const color = colorOf(t);
        const label = t.length > 12 ? t.slice(0, 11) + '…' : t;
        return (
          <g key={t} style={{ cursor: 'grab' }}
            onPointerDown={e => onNodePointerDown(e, t)}>
            <circle cx={p.x} cy={p.y} r={NODE_R} fill={color} fillOpacity={0.15}
              stroke={color} strokeWidth={2} />
            <text x={p.x} y={p.y+4} textAnchor="middle" fontSize="11" fill={color}
              fontWeight="700" style={{ userSelect: 'none', pointerEvents: 'none' }}>{label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── HelpTip ──────────────────────────────────────────────────────────────────
function HelpTip({ text }) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="help-tip" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
      <span className="help-tip-icon">?</span>
      {visible && <span className="help-tip-popup">{text}</span>}
    </span>
  );
}

const CONSTRAINT_TYPES = [
  'precedence', 'not_precedence', 'response', 'not_coexistence',
  'chain_precedence', 'chain_response',
  'responded_existence',
  'absence', 'exactly', 'init',
  'exclusive_choice',
  'succession', 'chain_succession', 'not_succession', 'not_chain_succession',
  'alternate_response', 'alternate_precedence', 'alternate_succession',
];

const CONSTRAINT_HELP = {
  precedence:           'B is blocked until A has fired on the same scope object. nmin ≥ 1 (default) enforces this; nmax caps how many A-occurrences may precede B.',
  not_precedence:       'Once A fires on a scope object, B is permanently blocked for that object. B can still fire freely before A occurs.',
  response:             'If A fires on an object, B must eventually follow. Use n≤ to cap how many times B may fire per scope object.',
  not_coexistence:      'Mutual exclusion per scope object: once A fires, B is blocked; once B fires, A is blocked. At most one of the two activities can ever fire per object.',
  chain_precedence:     'B must be immediately preceded by A on the scope object — no other event for that object may occur in between.',
  chain_response:       'Once A fires, every other activity is blocked for the scope object until B fires next.',
  responded_existence:  'If A occurs, B must also occur (before or after). Post-hoc obligation only — not enforced eagerly during simulation.',
  absence:              'Activity must never occur (n≤ = 0) or at most n≤ times per scope object.',
  exactly:              'A must occur exactly n≥ times. Block further firings after n≥. Set source = target = the activity.',
  init:                 'A must be the first activity to fire. All other activities are blocked until A has fired at least once.',
  exclusive_choice:     'Exactly one of A or B may occur. Once one fires, the other is permanently blocked.',
  succession:           'A must precede B (Precedence) AND after every A, B must eventually follow (Response). Composed constraint.',
  chain_succession:     'A and B must occur consecutively (Chain Precedence ∧ Chain Response).',
  not_succession:       'After A fires, B must never follow.',
  not_chain_succession: 'B must not occur immediately after A.',
  alternate_response:   'Between each A and its matching B response, no other A may occur. Source cannot re-fire while "armed".',
  alternate_precedence: 'Each B must be preceded by A, with no other B in between. B is blocked when it would exceed the count of A firings.',
  alternate_succession: 'Alternating A then B with no repetitions (Alternate Response ∧ Alternate Precedence).',
};
const SCOPE_KINDS      = ['each', 'global', 'any', 'all'];

// nmin defaults to 1 so a manually added precedence constraint actually enforces
// "source before target" during simulation. nmin is only meaningful for
// precedence; the other constraint checks ignore it, so the default is harmless.
const EMPTY_CONSTRAINT = { constraint_type: 'precedence', source_activity: '', target_activity: '', scope: { kind: 'each', object_type: '' }, nmin: 1, nmax: null };
const EMPTY_O2O        = { source_type: '', target_type: '', min_links: 0, max_links: null, bidirectional: true };

export default function ModelEditor({
  model, probMatrix, onModelChange, onProbMatrixChange,
  sourceFile = '', parameterFiles = [], onLoadParameters, onSaveParameters,
  nmaxSuggestions = {}, eventLogFile = '',
  hideParameterButtons = false,
  startActivities = [],
  onStartActivitiesChange = null,
  onUseParameters = null,
}) {
  const [activeTab,      setActiveTab]      = useState('activities');
  const [collapsed,      setCollapsed]      = useState(true);
  const [expandedActs,   setExpandedActs]   = useState(new Set());
  const [expandedGuards, setExpandedGuards] = useState(new Set()); // `${ai}-${bi}`
  const [expandedEffects,setExpandedEffects]= useState(new Set()); // `${ai}-${bi}`
  const [selectedParamFile, setSelectedParamFile] = useState('');
  const [expandedProbs,  setExpandedProbs]  = useState(new Set());
  const [conFilter,      setConFilter]      = useState('');
  const [newCon,         setNewCon]         = useState(EMPTY_CONSTRAINT);
  const [newO2O,         setNewO2O]         = useState(EMPTY_O2O);
  const [editingConIdx,  setEditingConIdx]  = useState(null);
  const [showConSummary, setShowConSummary] = useState(new Set()); // activity names with popup visible
  // Per-activity "add binding" selected type: { [actName]: objectType }
  const [newBindingTypes, setNewBindingTypes] = useState({});

  if (!model || Array.isArray(model)) return null;

  const activities = model.activities  || [];
  const constraints = model.constraints || [];
  const o2oRules   = model.o2o_rules   || [];
  const objectTypes   = useMemo(() => model.object_types || [], [model.object_types]);
  const otNames       = useMemo(() => objectTypes.map(t => typeof t === 'string' ? t : t.name), [objectTypes]);
  const actNames      = useMemo(() => activities.map(a => a.name), [activities]);
  const resourceTypes = useMemo(() => model.resource_types || [], [model.resource_types]);

  // ── Activities helpers ────────────────────────────────────────────────────
  const toggleAct = (name) => setExpandedActs(prev => {
    const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n;
  });

  const updateBinding = (ai, bi, field, value) => {
    const newActs = activities.map((a, idx) => idx !== ai ? a : {
      ...a,
      bindings: (a.bindings || []).map((b, bidx) => bidx !== bi ? b : { ...b, [field]: value }),
    });
    onModelChange({ ...model, activities: newActs });
  };

  const deleteBinding = (ai, bi) => {
    const newActs = activities.map((a, idx) => idx !== ai ? a : {
      ...a,
      bindings: (a.bindings || []).filter((_, bidx) => bidx !== bi),
    });
    onModelChange({ ...model, activities: newActs });
  };

  const addBinding = (ai, actName) => {
    const chosen = newBindingTypes[actName] || otNames[0];
    if (!chosen) return;
    const newActs = activities.map((a, idx) => idx !== ai ? a : {
      ...a,
      bindings: [...(a.bindings || []), { object_type: chosen, min_count: 1, max_count: null, creates: false, deactivates: false }],
    });
    onModelChange({ ...model, activities: newActs });
  };

  const updateMaxConsecutive = (actName, rawValue) => {
    const cur = model.max_consecutive || {};
    if (rawValue === '' || rawValue === null || rawValue === undefined) {
      const { [actName]: _removed, ...rest } = cur;
      onModelChange({ ...model, max_consecutive: rest });
    } else {
      const n = parseInt(rawValue);
      if (!Number.isNaN(n) && n >= 1)
        onModelChange({ ...model, max_consecutive: { ...cur, [actName]: n } });
    }
  };

  const updateMaxConsecutivePerObject = (actName, rawValue) => {
    const cur = model.max_consecutive_per_object || {};
    if (rawValue === '' || rawValue === null || rawValue === undefined) {
      const { [actName]: _removed, ...rest } = cur;
      onModelChange({ ...model, max_consecutive_per_object: rest });
    } else {
      const n = parseInt(rawValue);
      if (!Number.isNaN(n) && n >= 1)
        onModelChange({ ...model, max_consecutive_per_object: { ...cur, [actName]: n } });
    }
  };

  // ── Constraint helpers ────────────────────────────────────────────────────
  const deleteConstraint = (idx) =>
    onModelChange({ ...model, constraints: constraints.filter((_, i) => i !== idx) });

  const updateConstraint = (idx, patch) => {
    const updated = constraints.map((c, i) => i === idx ? { ...c, ...patch } : c);
    onModelChange({ ...model, constraints: updated });
  };

  const addConstraint = () => {
    const isUnary = ['absence', 'exactly', 'init'].includes(newCon.constraint_type);
    if (isUnary) {
      if (!newCon.source_activity) return;
    } else {
      if (!newCon.source_activity || !newCon.target_activity) return;
    }
    if (newCon.scope.kind !== 'global' && !newCon.scope.object_type) return;
    onModelChange({ ...model, constraints: [...constraints, { ...newCon, support: 1.0, confidence: 1.0 }] });
    setNewCon(EMPTY_CONSTRAINT);
  };

  // ── O2O helpers ───────────────────────────────────────────────────────────
  const deleteO2O = (idx) =>
    onModelChange({ ...model, o2o_rules: o2oRules.filter((_, i) => i !== idx) });

  const addO2O = () => {
    if (!newO2O.source_type || !newO2O.target_type) return;
    onModelChange({ ...model, o2o_rules: [...o2oRules, { ...newO2O }] });
    setNewO2O(EMPTY_O2O);
  };

  // ── Probability helpers ───────────────────────────────────────────────────
  const toggleProb = (name) => setExpandedProbs(prev => {
    const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n;
  });

  const updateProbLinked = (src, tgt, newPct) => {
    const newVal = Math.max(0, Math.min(100, Number(newPct))) / 100;
    const row = { ...(probMatrix[src] || {}) };
    const oldVal = row[tgt] || 0;
    const delta = newVal - oldVal;
    if (Math.abs(delta) < 1e-9) return;

    const others = actNames.filter(a => a !== tgt);
    const otherSum = others.reduce((s, a) => s + (row[a] || 0), 0);
    row[tgt] = newVal;

    if (otherSum < 1e-9) {
      // All others are zero — spread reduction equally (clamped ≥ 0)
      const share = delta / Math.max(1, others.length);
      others.forEach(a => { row[a] = Math.max(0, (row[a] || 0) - share); });
    } else {
      // Reduce/increase others proportionally to their current weight
      others.forEach(a => {
        const proportion = (row[a] || 0) / otherSum;
        row[a] = Math.max(0, (row[a] || 0) - delta * proportion);
      });
    }
    onProbMatrixChange({ ...probMatrix, [src]: row });
  };

  const normalizeRow = (src) => {
    const row = probMatrix[src] || {};
    const total = Object.values(row).reduce((s, v) => s + v, 0);
    if (total <= 0) return;
    onProbMatrixChange({
      ...probMatrix,
      [src]: Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v / total])),
    });
  };

  const setUniform = (src) => {
    if (actNames.length === 0) return;
    const w = 1 / actNames.length;
    onProbMatrixChange({ ...probMatrix, [src]: Object.fromEntries(actNames.map(a => [a, w])) });
  };

  const toggleResourceType = (typeName) => {
    const isResource = resourceTypes.includes(typeName);
    const updated = isResource
      ? resourceTypes.filter(r => r !== typeName)
      : [...resourceTypes, typeName];
    // When disabling, also remove any pool size entry
    const poolSizes = model.resource_pool_sizes || {};
    if (isResource) {
      const { [typeName]: _removed, ...rest } = poolSizes;
      onModelChange({ ...model, resource_types: updated, resource_pool_sizes: rest });
    } else {
      onModelChange({ ...model, resource_types: updated });
    }
  };

  const updateResourcePoolSize = (typeName, rawValue) => {
    const poolSizes = model.resource_pool_sizes || {};
    const val = parseInt(rawValue, 10);
    if (!rawValue || isNaN(val) || val < 1) {
      const { [typeName]: _removed, ...rest } = poolSizes;
      onModelChange({ ...model, resource_pool_sizes: rest });
    } else {
      onModelChange({ ...model, resource_pool_sizes: { ...poolSizes, [typeName]: val } });
    }
  };

  // ── Tab definitions ───────────────────────────────────────────────────────
  const TABS = [
    { id: 'activities',   label: 'Activities',   count: activities.length },
    { id: 'constraints',  label: 'Constraints',  count: constraints.length },
    { id: 'o2o',          label: 'O2O Rules',    count: o2oRules.length },
    { id: 'attributes',   label: 'Attributes',   count: objectTypes.length },
    { id: 'resources',    label: 'Resources',    count: resourceTypes.length || null },
    { id: 'probabilities',label: 'Probabilities',count: null },
    { id: 'timing',       label: 'Timing',       count: null },
    { id: 'flow',         label: 'Object Flow',  count: null },
  ];

  const filteredConstraints = constraints.filter(c =>
    !conFilter ||
    c.source_activity?.toLowerCase().includes(conFilter.toLowerCase()) ||
    c.target_activity?.toLowerCase().includes(conFilter.toLowerCase())
  );

  // ── Timing helpers ────────────────────────────────────────────────────────
  const DIST_TYPES = ['lognormal', 'normal', 'exponential', 'fixed'];
  const timingData = model.activity_durations || {};

  const updateTiming = (actName, field, value) => {
    const cur = timingData[actName] || { dist_type: 'lognormal', mean_seconds: 3600, std_seconds: 600, min_seconds: 0 };
    const updated = { ...cur, [field]: value === '' ? null : value };
    onModelChange({ ...model, activity_durations: { ...timingData, [actName]: updated } });
  };

  const OCPA_FIELDS = [
    { key: 'sojourn_mean',  label: 'Sojourn (mean)' },
    { key: 'sojourn_std',   label: 'Sojourn (std)' },
    { key: 'waiting_mean',  label: 'Waiting (mean)' },
    { key: 'waiting_std',   label: 'Waiting (std)' },
    { key: 'sync_mean',     label: 'Sync (mean)' },
    { key: 'flow_mean',     label: 'Flow (mean)' },
    { key: 'pooling_mean',  label: 'Pooling (mean)' },
    { key: 'lagging_mean',  label: 'Lagging (mean)' },
  ];

  // ── Export / download current parameters ──────────────────────────────────
  // Bundles everything currently in the editor into one self-contained JSON.
  // The model fields use the schema the backend parser expects, so the file can
  // be dropped back into the ocdeclare input folder and reloaded. The edited
  // transition matrix is embedded under `transition_matrix` (ignored by the
  // parser on reload, but preserved so no tuned probability is lost).
  const buildExportObj = () => ({
    object_types: objectTypes,
    activities,
    constraints,
    o2o_rules: o2oRules,
    ...(model.attribute_schema && Object.keys(model.attribute_schema).length
      ? { attribute_schema: model.attribute_schema } : {}),
    ...(model.activity_durations && Object.keys(model.activity_durations).length
      ? { activity_durations: model.activity_durations } : {}),
    ...(model.max_consecutive && Object.keys(model.max_consecutive).length
      ? { max_consecutive: model.max_consecutive } : {}),
    ...(model.max_consecutive_per_object && Object.keys(model.max_consecutive_per_object).length
      ? { max_consecutive_per_object: model.max_consecutive_per_object } : {}),
    ...(resourceTypes.length
      ? { resource_types: resourceTypes } : {}),
    ...(model.resource_pool_sizes && Object.keys(model.resource_pool_sizes).length
      ? { resource_pool_sizes: model.resource_pool_sizes } : {}),
    ...(probMatrix && Object.keys(probMatrix).length
      ? { transition_matrix: probMatrix } : {}),
  });

  // Derive a "parameters_<source>_<timestamp>.json" name, mirroring the
  // discovery file naming (which is "discovered_<logbase>_<timestamp>.json").
  // We strip the "discovered_" prefix and the old discovery timestamp from the
  // source ocdeclare filename, then append a fresh timestamp.
  const deriveParamFilename = () => {
    const ts = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/-/g, '').replace(/:/g, '');
    let base = (sourceFile || '').replace(/\.json$/i, '');
    base = base.replace(/^discovered_/, '');
    base = base.replace(/_\d{8}_\d{6}$/, ''); // drop trailing discovery timestamp
    if (!base) base = 'model';
    return `parameters_${base}_${ts}.json`;
  };

  const downloadModel = () => {
    const exportObj = buildExportObj();
    const filename = deriveParamFilename();

    const json = JSON.stringify(exportObj, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Also persist into the server's parameters folder so it can be reloaded
    // later via the "Load parameters" picker.
    onSaveParameters?.(filename, exportObj);
  };

  const loadSelectedParams = () => {
    if (selectedParamFile) onLoadParameters?.(selectedParamFile);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="model-editor">
      {/* ── Header + Tabs ── */}
      <div className="model-editor-header">
        <div className="model-editor-title-row">
          <h3 className="model-editor-toggle">
            Model Editor
          </h3>
          {onUseParameters && (
            <button
              className="model-use-params-btn"
              onClick={onUseParameters}
              title="Go to Simulation tab"
            >
              ▶ Use Parameters
            </button>
          )}
          <div className="model-editor-actions">
            {/* Load saved parameters from IO/input/parameters */}
            <div className="model-params-loader">
              <select
                className="model-params-select"
                value={selectedParamFile}
                onChange={e => setSelectedParamFile(e.target.value)}
                title="Saved parameter files in IO/input/parameters"
              >
                <option value="">Load parameters…</option>
                {parameterFiles.map(f => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
              <button
                className="model-params-load-btn"
                onClick={loadSelectedParams}
                disabled={!selectedParamFile}
                title="Load the selected parameter file into the editor"
              >
                ⬆ Load
              </button>
            </div>
            <button
              className="model-download-btn"
              onClick={downloadModel}
              title="Download the current parameters (activities, bindings, constraints, O2O rules, timing, max-consecutive and edited probabilities) as a JSON file. A copy is also saved to IO/input/parameters so you can reload it later."
            >
              ⬇ Download JSON
            </button>
          </div>
        </div>
        <div className="editor-tabs">
            {TABS.map(t => (
              <button key={t.id}
                className={`editor-tab ${activeTab === t.id ? 'active' : ''}`}
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
                {t.count !== null && <span className="tab-count">{t.count}</span>}
              </button>
            ))}
          </div>
      </div>

      {/* ── Body ── */}
      <div className="editor-body">

        {/* ━━ ACTIVITIES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {activeTab === 'activities' && (
          <div className="activities-list">
            {/* ── Toolbar: global constraint toggle + parameter buttons ── */}
            <div className="activities-toolbar">
              <label className="act-con-summary-toggle" title="Show/hide constraint summary for each activity">
                <input
                  type="checkbox"
                  checked={showConSummary.size === activities.length && activities.length > 0}
                  ref={el => { if (el) el.indeterminate = showConSummary.size > 0 && showConSummary.size < activities.length; }}
                  onChange={e => {
                    if (e.target.checked) setShowConSummary(new Set(activities.map(a => a.name)));
                    else setShowConSummary(new Set());
                  }}
                />
                Show constraints
              </label>
              <div className="activities-toolbar-right">
                {!hideParameterButtons && (
                  <div className="model-params-loader">
                    <select className="model-params-select" value=""
                      onChange={e => { if (e.target.value) onLoadParameters?.(e.target.value); }}>
                      <option value="">Load Parameters…</option>
                      {parameterFiles.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                )}
                {!hideParameterButtons && (
                  <button className="model-download-btn" onClick={downloadModel}
                    title="Download current parameters as JSON">
                    Download Parameters
                  </button>
                )}
              </div>
            </div>
            {activities.length === 0 && <p className="empty-notice">No activities defined.</p>}
            {activities.map((act, ai) => (
              <div key={act.name} id={`activity-row-${act.name}`} className={`activity-row ${expandedActs.has(act.name) ? 'open' : ''}`}>
                <div className="activity-header" onClick={() => toggleAct(act.name)}>
                  <span className={`activity-expand ${expandedActs.has(act.name) ? 'open' : ''}`}>▶</span>
                  <span className="activity-name">{act.name}</span>
                  {onStartActivitiesChange && (
                    <button
                      className={`sa-toggle-label${startActivities.includes(act.name) ? ' active' : ''}`}
                      onClick={e => {
                        e.stopPropagation();
                        const next = startActivities.includes(act.name)
                          ? startActivities.filter(a => a !== act.name)
                          : [...startActivities, act.name];
                        onStartActivitiesChange(next);
                      }}
                      title={startActivities.includes(act.name) ? 'Remove as start activity' : 'Mark as start activity'}
                    >
                      {startActivities.includes(act.name) ? '★ start' : '☆ start'}
                    </button>
                  )}
                  {(act.bindings || []).length === 0 && (
                    <span className="binding-warning-badge" title="This activity has no object bindings and will never fire.">
                      ⚠ No bindings
                    </span>
                  )}
                  <label className="max-consec-label" onClick={e => e.stopPropagation()}>
                    max consec <HelpTip text="Maximum back-to-back firings globally (regardless of which object). Leave blank for no limit." />
                    <input
                      className="binding-num max-consec-input"
                      type="number" min={1}
                      value={(model.max_consecutive || {})[act.name] ?? ''}
                      placeholder="∞"
                      onChange={e => updateMaxConsecutive(act.name, e.target.value)}
                    />
                  </label>
                  <label className="max-consec-label" onClick={e => e.stopPropagation()}>
                    max consec/obj <HelpTip text="Maximum back-to-back firings on the same object. The same activity may still fire on a different object. Leave blank for no limit." />
                    <input
                      className="binding-num max-consec-input"
                      type="number" min={1}
                      value={(model.max_consecutive_per_object || {})[act.name] ?? ''}
                      placeholder="∞"
                      onChange={e => updateMaxConsecutivePerObject(act.name, e.target.value)}
                    />
                    {nmaxSuggestions[act.name] && nmaxSuggestions[act.name].suggested > 1 && (
                      <button
                        className="nmax-suggest-btn"
                        title={`Log suggests max ${nmaxSuggestions[act.name].suggested} (p95). Click to apply.`}
                        onClick={e => { e.stopPropagation(); updateMaxConsecutivePerObject(act.name, nmaxSuggestions[act.name].suggested); }}
                      >
                        p95:{nmaxSuggestions[act.name].suggested}
                      </button>
                    )}
                  </label>
                  <span className="activity-binding-count">
                    {(act.bindings || []).length} binding{(act.bindings || []).length !== 1 ? 's' : ''}
                  </span>
                </div>
                {expandedActs.has(act.name) && (
                  <div className="activity-bindings">
                    <div className="binding-header-row">
                      <span>Object Type</span>
                      <span>Min <HelpTip text="Minimum objects of this type required to fire the activity." /></span>
                      <span>Max <HelpTip text="Maximum objects that can participate. Leave blank for no upper limit." /></span>
                      <span>Creates <HelpTip text="Activity instantiates new objects of this type rather than reusing existing ones." /></span>
                      <span>Deactivates <HelpTip text="Participating objects are deactivated (removed from simulation) after firing." /></span>
                      <span title="Attribute guard">[guard]</span>
                      <span title="Attribute effects">[effects]</span>
                      <span></span>
                    </div>
                    {(act.bindings || []).length === 0 && (
                      <p className="binding-empty-warning">⚠ No object bindings — this activity will never be a candidate. Add a binding below.</p>
                    )}
                    {(act.bindings || []).map((b, bi) => {
                      const isResource = resourceTypes.includes(b.object_type);
                      return (
                      <div key={bi} className="binding-block">
                        <div className="binding-row">
                          <span className="binding-type-label">
                            {b.object_type}
                            {isResource && <span className="binding-resource-badge" title="Resource type — pool size is set in the Resources tab">R</span>}
                          </span>
                          <input
                            className="binding-num"
                            type="number" min={0}
                            value={b.min_count}
                            onChange={e => updateBinding(ai, bi, 'min_count', parseInt(e.target.value) || 0)}
                          />
                          <input
                            className="binding-num"
                            type="number" min={0}
                            value={b.max_count === null ? '' : b.max_count}
                            placeholder="∞"
                            onChange={e => updateBinding(ai, bi, 'max_count',
                              e.target.value === '' ? null : parseInt(e.target.value) || 0)}
                          />
                          <label className={`binding-toggle${isResource ? ' binding-toggle-disabled' : ''}`}
                            title={isResource ? 'Resources come from the pre-populated pool — they cannot be created by activities.' : ''}>
                            <input type="checkbox" checked={isResource ? false : !!b.creates}
                              disabled={isResource}
                              onChange={e => !isResource && updateBinding(ai, bi, 'creates', e.target.checked)} />
                            creates
                          </label>
                          <label className="binding-toggle">
                            <input type="checkbox" checked={!!(b.deactivates ?? b.consumes)}
                              onChange={e => updateBinding(ai, bi, 'deactivates', e.target.checked)} />
                            deactivates
                          </label>
                          <button
                            className={`binding-guard-btn${b.guard ? ' active' : ''}`}
                            title="Attribute guard: only pick objects satisfying this condition"
                            onClick={() => setExpandedGuards(prev => {
                              const n = new Set(prev); const k = `${ai}-${bi}`;
                              n.has(k) ? n.delete(k) : n.add(k); return n;
                            })}>
                            {b.guard ? '[guard ✓]' : '[guard]'}
                          </button>
                          <button
                            className={`binding-guard-btn${(b.attribute_updates?.length) ? ' active' : ''}`}
                            title="Effects: attribute updates applied when this activity fires"
                            onClick={() => setExpandedEffects(prev => {
                              const n = new Set(prev); const k = `${ai}-${bi}`;
                              n.has(k) ? n.delete(k) : n.add(k); return n;
                            })}>
                            {(b.attribute_updates?.length) ? '[effects ✓]' : '[effects]'}
                          </button>
                          <button className="row-delete-btn binding-delete-btn"
                            onClick={() => deleteBinding(ai, bi)} title="Remove binding">✕</button>
                        </div>

                        {/* ── Guard sub-row ── */}
                        {expandedGuards.has(`${ai}-${bi}`) && (
                          <div className="binding-guard-row">
                            <span className="binding-guard-label">Guard: if</span>
                            <input
                              className="guard-attr-input"
                              placeholder="attribute"
                              value={b.guard?.attribute || ''}
                              onChange={e => updateBinding(ai, bi, 'guard', { ...(b.guard || {attribute:'',op:'==',value:''}), attribute: e.target.value })}
                            />
                            <select
                              className="guard-op-select"
                              value={b.guard?.op || '=='}
                              onChange={e => updateBinding(ai, bi, 'guard', { ...(b.guard || {attribute:'',op:'==',value:''}), op: e.target.value })}>
                              {['==','!=','>','<','>=','<='].map(op => <option key={op} value={op}>{op}</option>)}
                            </select>
                            <input
                              className="guard-value-input"
                              placeholder="value"
                              value={b.guard?.value ?? ''}
                              onChange={e => {
                                const raw = e.target.value;
                                const val = raw === '' ? '' : (!isNaN(Number(raw)) ? Number(raw) : raw);
                                updateBinding(ai, bi, 'guard', { ...(b.guard || {attribute:'',op:'==',value:''}), value: val });
                              }}
                            />
                            <button className="row-delete-btn" title="Remove guard"
                              onClick={() => updateBinding(ai, bi, 'guard', null)}>✕</button>
                          </div>
                        )}

                        {/* ── Effects sub-rows ── */}
                        {expandedEffects.has(`${ai}-${bi}`) && (
                          <div className="binding-effects-section">
                            <span className="binding-guard-label">On fire:</span>
                            {(b.attribute_updates || []).map((upd, ui) => (
                              <div key={ui} className="binding-effects-row">
                                <input
                                  className="guard-attr-input"
                                  placeholder="attribute"
                                  value={upd.attribute || ''}
                                  onChange={e => {
                                    const updated = (b.attribute_updates || []).map((u, i) => i === ui ? { ...u, attribute: e.target.value } : u);
                                    updateBinding(ai, bi, 'attribute_updates', updated);
                                  }}
                                />
                                <select
                                  className="guard-op-select"
                                  value={upd.op || 'set'}
                                  onChange={e => {
                                    const updated = (b.attribute_updates || []).map((u, i) => i === ui ? { ...u, op: e.target.value } : u);
                                    updateBinding(ai, bi, 'attribute_updates', updated);
                                  }}>
                                  <option value="set">set</option>
                                  <option value="increment">increment</option>
                                  <option value="decrement">decrement</option>
                                </select>
                                <input
                                  className="guard-value-input"
                                  placeholder={upd.op === 'set' ? 'value' : 'by'}
                                  value={upd.op === 'set' ? (upd.value ?? '') : (upd.by ?? '')}
                                  onChange={e => {
                                    const raw = e.target.value;
                                    const num = raw === '' ? '' : (!isNaN(Number(raw)) ? Number(raw) : raw);
                                    const key = upd.op === 'set' ? 'value' : 'by';
                                    const updated = (b.attribute_updates || []).map((u, i) => i === ui ? { ...u, [key]: num } : u);
                                    updateBinding(ai, bi, 'attribute_updates', updated);
                                  }}
                                />
                                <button className="row-delete-btn" title="Remove effect"
                                  onClick={() => {
                                    const updated = (b.attribute_updates || []).filter((_, i) => i !== ui);
                                    updateBinding(ai, bi, 'attribute_updates', updated);
                                  }}>✕</button>
                              </div>
                            ))}
                            <button className="add-binding-btn" style={{ marginTop: '0.25rem' }}
                              onClick={() => {
                                const updated = [...(b.attribute_updates || []), { attribute: '', op: 'set', value: '' }];
                                updateBinding(ai, bi, 'attribute_updates', updated);
                              }}>+ Add effect</button>
                          </div>
                        )}
                      </div>
                      );
                    })}
                    {/* ── Add binding row ── */}
                    <div className="add-binding-row">
                      <select
                        className="add-binding-select"
                        value={newBindingTypes[act.name] || ''}
                        onChange={e => setNewBindingTypes(p => ({ ...p, [act.name]: e.target.value }))}
                      >
                        <option value="">object type…</option>
                        {otNames.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <button className="add-binding-btn"
                        disabled={!newBindingTypes[act.name] && otNames.length === 0}
                        onClick={() => addBinding(ai, act.name)}>
                        + Add binding
                      </button>
                    </div>
                  </div>
                )}
                {/* ── Constraint summary popup ── */}
                {showConSummary.has(act.name) && (() => {
                  const actName = act.name;
                  const cons = constraints || [];
                  const scopePart = c => c.scope?.object_type ? ` per ${c.scope.object_type}` : '';
                  const times = n => n == null ? '' : n === 1 ? 'once' : `${n} times`;
                  const nminPart = c => (c.nmin ?? 0) > 1 ? ` at least ${times(c.nmin)}` : '';
                  const nmaxPart = c => (c.nmax ?? null) !== null ? `, at most ${times(c.nmax)}` : '';

                  // All constraints where this activity is source or target
                  const involved = cons.filter(c =>
                    c.source_activity === actName || c.target_activity === actName
                  );

                  // Natural language per constraint type
                  const describe = (c) => {
                    const src = c.source_activity, tgt = c.target_activity;
                    const sp = scopePart(c);
                    const isSrc = src === actName;
                    const other = isSrc ? tgt : src;
                    const nmin = c.nmin ?? 1;
                    const nmax = c.nmax ?? null;
                    const timesMin = nmin === 1 ? 'once' : `${nmin} times`;
                    const timesMax = nmax != null ? (nmax === 1 ? 'once' : `${nmax} times`) : null;

                    switch (c.constraint_type) {
                      case 'precedence':
                        if (isSrc) {
                          // This activity must precede other
                          let t = `"${actName}" must happen at least ${timesMin}${sp} before "${other}" can happen`;
                          if (timesMax) t += `, and at most ${timesMax}${sp}`;
                          return t;
                        } else {
                          // Other must precede this
                          let t = `"${other}" must happen at least ${timesMin}${sp} before "${actName}" can happen`;
                          if (timesMax) t += `, and at most ${timesMax}${sp}`;
                          return t;
                        }
                      case 'chain_precedence':
                        if (isSrc) return `"${actName}" must occur immediately before every "${other}" firing${sp}`;
                        else return `"${other}" must occur immediately before every "${actName}" firing${sp}`;
                      case 'response':
                        if (isSrc) {
                          let t = `After "${actName}" fires, "${other}" must eventually follow${sp}`;
                          if (timesMax) t += ` (at most ${timesMax}${sp})`;
                          return t;
                        } else {
                          let t = `After "${other}" fires, "${actName}" must eventually follow${sp}`;
                          if (timesMax) t += ` (at most ${timesMax}${sp})`;
                          return t;
                        }
                      case 'chain_response':
                        if (isSrc) return `"${other}" must occur immediately after every "${actName}" firing${sp}`;
                        else return `"${actName}" must occur immediately after every "${other}" firing${sp}`;
                      case 'not_coexistence':
                        return `"${actName}" and "${other}" cannot both occur${sp} — once one fires the other is blocked`;
                      case 'not_precedence':
                        if (isSrc) return `Once "${actName}" fires${sp}, "${other}" is permanently blocked for that object`;
                        else return `Once "${other}" fires${sp}, "${actName}" is permanently blocked for that object`;
                      case 'not_succession':
                        if (isSrc) return `After "${actName}" fires, "${other}" must never follow${sp}`;
                        else return `After "${other}" fires, "${actName}" must never follow${sp}`;
                      case 'not_chain_succession':
                        if (isSrc) return `"${other}" must not occur immediately after "${actName}"${sp}`;
                        else return `"${actName}" must not occur immediately after "${other}"${sp}`;
                      case 'responded_existence':
                        if (isSrc) return `If "${actName}" occurs, "${other}" must also occur${sp} (before or after)`;
                        else return `If "${other}" occurs, "${actName}" must also occur${sp} (before or after)`;
                      case 'succession':
                        if (isSrc) {
                          let t = `"${actName}" must happen at least ${timesMin}${sp} before "${other}", and after "${actName}" fires "${other}" must eventually follow`;
                          if (timesMax) t += ` (source capped at ${timesMax}${sp})`;
                          return t;
                        } else {
                          let t = `"${other}" must happen at least ${timesMin}${sp} before "${actName}", and after "${other}" fires "${actName}" must eventually follow`;
                          if (timesMax) t += ` (source capped at ${timesMax}${sp})`;
                          return t;
                        }
                      case 'chain_succession':
                        if (isSrc) return `"${actName}" and "${other}" must always occur consecutively${sp}`;
                        else return `"${other}" and "${actName}" must always occur consecutively${sp}`;
                      case 'alternate_response':
                        if (isSrc) return `Between each "${actName}" and its matching "${other}", no other "${actName}" may occur${sp}`;
                        else return `Between each "${other}" and its matching "${actName}", no other "${other}" may occur${sp}`;
                      case 'alternate_precedence':
                        if (isSrc) return `Each "${other}" must be preceded by "${actName}" with no other "${other}" in between${sp}`;
                        else return `Each "${actName}" must be preceded by "${other}" with no other "${actName}" in between${sp}`;
                      case 'alternate_succession':
                        if (isSrc) return `"${actName}" and "${other}" must alternate without repetitions${sp}`;
                        else return `"${other}" and "${actName}" must alternate without repetitions${sp}`;
                      case 'exclusive_choice':
                        return `Exactly one of "${actName}" or "${other}" may occur${sp} — once one fires the other is blocked`;
                      case 'absence':
                        return `"${actName}" must never occur${nmax != null ? ` more than ${timesMax}` : ''}${sp}`;
                      case 'exactly':
                        return `"${actName}" must occur exactly ${timesMin}${sp}`;
                      case 'init':
                        return `"${actName}" must be the first activity to fire`;
                      default:
                        return `${c.constraint_type.replace(/_/g,' ')}: "${src}" → "${tgt}"${sp}`;
                    }
                  };

                  // Direction relative to focal actName:
                  // "before" = actName is target (other → actName)
                  // "after"  = actName is source (actName → other)
                  // "mutual" = symmetric
                  const classifyDirection = (c) => {
                    const mutual = ['not_coexistence', 'exclusive_choice', 'responded_existence',
                                    'chain_succession', 'alternate_succession', 'succession'].includes(c.constraint_type);
                    if (mutual) return 'mutual';
                    if (c.target_activity === actName) return 'before';
                    if (c.source_activity === actName) return 'after';
                    return 'mutual';
                  };

                  const renderActivityLink = (name) => {
                    const allActNames = activities.map(a => a.name);
                    if (allActNames.includes(name)) {
                      return (
                        <button className="act-hint-link" onClick={e => {
                          e.stopPropagation();
                          setExpandedActs(prev => { const n = new Set(prev); n.add(name); return n; });
                          setTimeout(() => {
                            document.getElementById(`activity-row-${name}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          }, 50);
                        }}>{name}</button>
                      );
                    }
                    return <span>{name}</span>;
                  };

                  // Cardinality label: shows nmin/nmax and scope object type with count
                  const cardLabel = (c) => {
                    const nmin = c.nmin ?? 1, nmax = c.nmax ?? null;
                    const scope = c.scope?.object_type;
                    if (!scope) return '';
                    const count = nmax != null
                      ? `${nmin}–${nmax}`
                      : nmin > 1 ? `${nmin}+` : '1';
                    const plural = (nmax != null && nmax > 1) || nmin > 1 ? 'objects' : 'object';
                    return `per ${count} ${scope} ${plural}`;
                  };

                  const ConstraintBadge = ({ c }) => (
                    <div className="con-hint-badge-wrap">
                      <span className={`constraint-type-badge ${c.constraint_type}`} style={{fontSize:'0.6rem'}}>
                        {c.constraint_type.replace(/_/g,' ')}
                      </span>
                      {cardLabel(c) && <span className="con-hint-card">{cardLabel(c)}</span>}
                    </div>
                  );

                  return (
                    <div className="act-con-summary">
                      {involved.length === 0 && (
                        <p className="act-con-summary-empty">No constraints involve this activity.</p>
                      )}
                      {involved.length > 0 && (
                        <table className="con-hint-table">
                          <thead>
                            <tr>
                              <th className="con-hint-left">Before</th>
                              <th className="con-hint-focal-col"><strong className="act-hint-focal">{actName}</strong></th>
                              <th className="con-hint-right">After</th>
                            </tr>
                          </thead>
                          <tbody>
                            {involved.map((c, i) => {
                              const dir = classifyDirection(c);
                              const other = c.source_activity === actName ? c.target_activity : c.source_activity;
                              return (
                                <tr key={i}>
                                  <td className="con-hint-left">
                                    {(dir === 'before' || dir === 'mutual') && (
                                      <div className="con-hint-side-wrap con-hint-side-left">
                                        {renderActivityLink(other)}
                                        <ConstraintBadge c={c} />
                                      </div>
                                    )}
                                  </td>
                                  <td className="con-hint-focal-col" />
                                  <td className="con-hint-right">
                                    {(dir === 'after' || dir === 'mutual') && (
                                      <div className="con-hint-side-wrap con-hint-side-right">
                                        <ConstraintBadge c={c} />
                                        {renderActivityLink(other)}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        )}

        {/* ━━ CONSTRAINTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {activeTab === 'constraints' && (
          <div>
            <div className="toolbar-row">
              <input
                className="filter-input"
                placeholder="Filter by activity name…"
                value={conFilter}
                onChange={e => setConFilter(e.target.value)}
              />
              <span className="filter-count">{filteredConstraints.length} / {constraints.length}</span>
            </div>

            <div className="constraints-list">
              {filteredConstraints.length === 0 && (
                <p className="empty-notice">No constraints match the filter.</p>
              )}
              {filteredConstraints.map((c, idx) => {
                const realIdx = constraints.indexOf(c);
                const isEditing = editingConIdx === realIdx;
                return (
                  <div key={idx} className={`constraint-row${isEditing ? ' constraint-row-editing' : ''}`}>
                    <span className={`constraint-type-badge ${c.constraint_type}`}>
                      {c.constraint_type.replace(/_/g, ' ')}
                    </span>
                    <span className="constraint-src">{c.source_activity}</span>
                    <span className="constraint-arrow">→</span>
                    <span className="constraint-tgt">{c.target_activity}</span>
                    {!isEditing ? (
                      <>
                        <span className="constraint-scope">
                          [{c.scope?.kind}{c.scope?.object_type ? ` ${c.scope.object_type}` : ''}]
                        </span>
                        {(c.constraint_type === 'precedence' || c.constraint_type === 'response') &&
                          ((c.nmin ?? 0) > 0 || (c.nmax ?? null) !== null) && (
                          <span className="constraint-card">
                            {(c.nmin ?? 0) > 0 ? `n≥${c.nmin}` : ''}{(c.nmax ?? null) !== null ? ` n≤${c.nmax}` : ''}
                          </span>
                        )}
                        <button className="row-edit-btn" onClick={() => setEditingConIdx(realIdx)} title="Edit constraint">✏</button>
                      </>
                    ) : (
                      <div className="constraint-edit-inline">
                        <label className="constraint-edit-label">scope type:
                          <select
                            className="constraint-edit-select"
                            value={c.scope?.object_type || ''}
                            onChange={e => updateConstraint(realIdx, { scope: { ...c.scope, object_type: e.target.value } })}
                          >
                            <option value="">—</option>
                            {otNames.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </label>
                        <label className="constraint-edit-label">n≥:
                          <input type="number" min={0} className="constraint-edit-num"
                            value={c.nmin ?? 0}
                            onChange={e => updateConstraint(realIdx, { nmin: e.target.value === '' ? 0 : parseInt(e.target.value, 10) })}
                          />
                        </label>
                        <label className="constraint-edit-label">n≤:
                          <input type="number" min={0} className="constraint-edit-num"
                            placeholder="∞"
                            value={c.nmax ?? ''}
                            onChange={e => updateConstraint(realIdx, { nmax: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
                          />
                        </label>
                        <button className="row-edit-btn" onClick={() => setEditingConIdx(null)} title="Done">✓</button>
                      </div>
                    )}
                    <button className="row-delete-btn" onClick={() => { deleteConstraint(realIdx); setEditingConIdx(null); }} title="Remove">✕</button>
                  </div>
                );
              })}
            </div>

            <div className="add-form">
              <select value={newCon.constraint_type}
                onChange={e => setNewCon(p => ({
                  ...p,
                  constraint_type: e.target.value,
                  nmin: e.target.value === 'precedence' ? 1 : e.target.value === 'exactly' ? 1 : 0,
                  nmax: e.target.value === 'absence' ? 0 : null,
                }))}>
                {CONSTRAINT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
              {CONSTRAINT_HELP[newCon.constraint_type] && (
                <HelpTip text={CONSTRAINT_HELP[newCon.constraint_type]} />
              )}
              {/* For unary constraints (absence, exactly, init): single activity picker */}
              {['absence', 'exactly', 'init'].includes(newCon.constraint_type) ? (
                <select value={newCon.source_activity}
                  onChange={e => setNewCon(p => ({ ...p, source_activity: e.target.value, target_activity: e.target.value }))}>
                  <option value="">activity…</option>
                  {actNames.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              ) : (
                <>
                  <select value={newCon.source_activity}
                    onChange={e => setNewCon(p => ({ ...p, source_activity: e.target.value }))}>
                    <option value="">source…</option>
                    {actNames.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                  <span className="add-form-sep">→</span>
                  <select value={newCon.target_activity}
                    onChange={e => setNewCon(p => ({ ...p, target_activity: e.target.value }))}>
                    <option value="">target…</option>
                    {actNames.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                </>
              )}
              <select value={newCon.scope.kind}
                onChange={e => setNewCon(p => ({ ...p, scope: { ...p.scope, kind: e.target.value, object_type: e.target.value === 'global' ? '' : p.scope.object_type } }))}>
                {SCOPE_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
              {newCon.scope.kind !== 'global' && (
                <select value={newCon.scope.object_type}
                  onChange={e => setNewCon(p => ({ ...p, scope: { ...p.scope, object_type: e.target.value } }))}>
                  <option value="">scope type…</option>
                  {otNames.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
              {(['precedence', 'response', 'absence', 'exactly'].includes(newCon.constraint_type)) && (
                <span className="card-inputs" title={
                  newCon.constraint_type === 'response'
                    ? 'n≤ caps how many times the target may fire per scope object (blank = no upper bound).'
                    : newCon.constraint_type === 'absence'
                    ? 'n≤ = 0 means never. Increase to allow at most n≤ occurrences.'
                    : newCon.constraint_type === 'exactly'
                    ? 'n≥ = exact required count. Activity is blocked after this many firings.'
                    : 'Cardinality bounds: nmin ≥ 1 enforces "source before target"; nmax optionally caps how many sources may precede the target (blank = no upper bound).'
                }>
                  {(newCon.constraint_type === 'precedence' || newCon.constraint_type === 'exactly') && (
                    <>
                      <label className="card-label">n≥</label>
                      <input
                        className="card-input"
                        type="number"
                        min="0"
                        value={newCon.nmin ?? 0}
                        onChange={e => setNewCon(p => ({ ...p, nmin: e.target.value === '' ? 0 : parseInt(e.target.value, 10) }))}
                      />
                    </>
                  )}
                  <label className="card-label">n≤</label>
                  <input
                    className="card-input"
                    type="number"
                    min="0"
                    placeholder="∞"
                    value={newCon.nmax ?? ''}
                    onChange={e => setNewCon(p => ({ ...p, nmax: e.target.value === '' ? null : parseInt(e.target.value, 10) }))}
                  />
                </span>
              )}
              <button className="add-form-btn" onClick={addConstraint}>+ Add</button>
            </div>
          </div>
        )}

        {/* ━━ O2O RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {activeTab === 'o2o' && (
          <div>
            <div className="o2o-list">
              {o2oRules.length === 0 && <p className="empty-notice">No O2O rules defined.</p>}
              {o2oRules.map((r, idx) => (
                <div key={idx} className="o2o-row">
                  <span className="o2o-src">{r.source_type}</span>
                  <span className={`o2o-dir ${r.bidirectional ? 'bi' : 'uni'}`}>
                    {r.bidirectional ? '↔' : '→'}
                  </span>
                  <span className="o2o-tgt">{r.target_type}</span>
                  <span className="o2o-cardinality">
                    min={r.min_links} max={r.max_links === null ? '∞' : r.max_links}
                  </span>
                  <label className="binding-toggle">
                    <input type="checkbox" checked={!!r.bidirectional}
                      onChange={e => {
                        const updated = o2oRules.map((x, i) =>
                          i === idx ? { ...x, bidirectional: e.target.checked } : x);
                        onModelChange({ ...model, o2o_rules: updated });
                      }} />
                    bidirectional
                  </label>
                  <button className="row-delete-btn" onClick={() => deleteO2O(idx)} title="Remove">✕</button>
                </div>
              ))}
            </div>

            <div className="add-form">
              <select value={newO2O.source_type}
                onChange={e => setNewO2O(p => ({ ...p, source_type: e.target.value }))}>
                <option value="">source type…</option>
                {otNames.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={newO2O.target_type}
                onChange={e => setNewO2O(p => ({ ...p, target_type: e.target.value }))}>
                <option value="">target type…</option>
                {otNames.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <label className="binding-toggle">
                <input type="checkbox" checked={newO2O.bidirectional}
                  onChange={e => setNewO2O(p => ({ ...p, bidirectional: e.target.checked }))} />
                bidirectional
              </label>
              <input className="binding-num" type="number" min={0} value={newO2O.min_links}
                placeholder="min"
                onChange={e => setNewO2O(p => ({ ...p, min_links: parseInt(e.target.value) || 0 }))} />
              <input className="binding-num" type="number" min={0}
                value={newO2O.max_links === null ? '' : newO2O.max_links}
                placeholder="max (∞)"
                onChange={e => setNewO2O(p => ({
                  ...p, max_links: e.target.value === '' ? null : parseInt(e.target.value) || 0
                }))} />
              <button className="add-form-btn" onClick={addO2O}>+ Add</button>
            </div>

            {o2oRules.length > 0 && (
              <div className="o2o-diagram-wrap">
                <O2ODiagram rules={o2oRules} otNames={otNames} />
              </div>
            )}

            {o2oRules.length > 0 && (
              <table className="o2o-preview-table">
                <thead>
                  <tr>
                    <th>Source type</th>
                    <th></th>
                    <th>Target type</th>
                    <th title="Minimum links between objects of these types">Min links</th>
                    <th title="Maximum links enforced during simulation">Max links</th>
                    <th title="Whether the link is navigable in both directions">Dir</th>
                  </tr>
                </thead>
                <tbody>
                  {o2oRules.map((r, i) => (
                    <tr key={i}>
                      <td className="o2o-type">{r.source_type}</td>
                      <td className="o2o-arrow">{r.bidirectional ? '↔' : '→'}</td>
                      <td className="o2o-type">{r.target_type}</td>
                      <td className="o2o-num">{r.min_links ?? '—'}</td>
                      <td className="o2o-num">{r.max_links ?? '∞'}</td>
                      <td className="o2o-dir">{r.bidirectional ? 'bi' : 'uni'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ━━ PROBABILITIES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {activeTab === 'probabilities' && (
          <div>
            <p className="prob-hint">
              Edit outgoing transition weights (%). Use <strong>Normalise</strong> to make a row sum
              to 100%, or <strong>Uniform</strong> to spread equally across all activities.
              The simulation adds a small epsilon to every weight, so 0% transitions are never
              completely blocked — set them very low rather than exactly 0 to reduce their frequency.
            </p>
            {actNames.length === 0 && <p className="empty-notice">No activities defined.</p>}
            {actNames.map(src => {
              const row      = probMatrix[src] || {};
              const rowTotal = actNames.reduce((s, a) => s + (row[a] || 0), 0);
              const isOpen   = expandedProbs.has(src);
              return (
                <div key={src} className={`prob-source-block ${isOpen ? 'open' : ''}`}>
                  <div className="prob-source-header" onClick={() => toggleProb(src)}>
                    <span className={`activity-expand ${isOpen ? 'open' : ''}`}>▶</span>
                    <span className="prob-source-name">{src}</span>
                    <span className={`prob-row-total ${Math.abs(rowTotal * 100 - 100) < 1 ? 'ok' : 'warn'}`}>
                      {(rowTotal * 100).toFixed(0)}%
                    </span>
                    {isOpen && (
                      <div className="prob-row-actions" onClick={e => e.stopPropagation()}>
                        <button className="prob-action-btn" onClick={() => normalizeRow(src)}>
                          Normalise <HelpTip text="Scale all outgoing weights so they sum to exactly 100%." />
                        </button>
                        <button className="prob-action-btn" onClick={() => setUniform(src)}>
                          Uniform <HelpTip text="Set equal weight for every activity (100% ÷ activity count)." />
                        </button>
                      </div>
                    )}
                  </div>
                  {isOpen && (
                    <div className="prob-targets">
                      {actNames.map(tgt => {
                        const val = row[tgt] || 0;
                        const pct = +(val * 100).toFixed(1);
                        return (
                          <div key={tgt} className="prob-target-row">
                            <span className="prob-target-name">→ {tgt}</span>
                            <input
                              type="range" min={0} max={100} step={0.5}
                              className="prob-slider"
                              value={pct}
                              onChange={e => updateProbLinked(src, tgt, e.target.value)}
                            />
                            <input
                              type="number" min={0} max={100} step={0.1}
                              className="prob-pct-input"
                              value={pct}
                              onChange={e => updateProbLinked(src, tgt, e.target.value)}
                            />
                            <span className="prob-pct-label">%</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}


        {/* ━━ ATTRIBUTES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {activeTab === 'attributes' && (
          <div>
            <p className="prob-hint">
              Attribute definitions and default values per object type. Definitions come from the
              input event log. Default values are the most common value observed in the log and are
              assigned to every newly created object of that type during simulation.
            </p>
            {objectTypes.length === 0 && <p className="empty-notice">No object types defined.</p>}
            {objectTypes.map((ot) => {
              const otName = typeof ot === 'string' ? ot : ot.name;
              const attrDefs = (typeof ot === 'object' ? ot.attributes : null) || [];
              const schema = (model.attribute_schema || {})[otName] || {};

              const updateDefault = (attrName, value) => {
                const newSchema = {
                  ...(model.attribute_schema || {}),
                  [otName]: { ...schema, [attrName]: value },
                };
                onModelChange({ ...model, attribute_schema: newSchema });
              };

              const addAttrDef = () => {
                const name = prompt('Attribute name:');
                if (!name) return;
                const type = prompt('Attribute type (string / float / integer / boolean):', 'string') || 'string';
                const newAttrDefs = [...attrDefs, { name, type }];
                const newOts = objectTypes.map(o => {
                  const n = typeof o === 'string' ? o : o.name;
                  if (n !== otName) return o;
                  return typeof o === 'string' ? { name: o, attributes: newAttrDefs } : { ...o, attributes: newAttrDefs };
                });
                onModelChange({ ...model, object_types: newOts });
              };

              const removeAttrDef = (attrName) => {
                const newAttrDefs = attrDefs.filter(a => a.name !== attrName);
                const newOts = objectTypes.map(o => {
                  const n = typeof o === 'string' ? o : o.name;
                  if (n !== otName) return o;
                  return typeof o === 'string' ? { name: o, attributes: newAttrDefs } : { ...o, attributes: newAttrDefs };
                });
                // Also remove from schema defaults
                const newSchema = { ...(model.attribute_schema || {}) };
                if (newSchema[otName]) {
                  const { [attrName]: _, ...rest } = newSchema[otName];
                  newSchema[otName] = rest;
                }
                onModelChange({ ...model, object_types: newOts, attribute_schema: newSchema });
              };

              return (
                <div key={otName} className="timing-row">
                  <div className="timing-act-name">{otName}</div>
                  {attrDefs.length === 0 && (
                    <span className="timing-no-data">no attributes defined</span>
                  )}
                  {attrDefs.map(ad => (
                    <div key={ad.name} className="attr-row">
                      <span className="attr-name">{ad.name}</span>
                      <span className="attr-type">({ad.type})</span>
                      <input
                        className="attr-default-input"
                        title={`Default value for ${ad.name}`}
                        value={schema[ad.name] ?? ''}
                        onChange={e => updateDefault(ad.name, e.target.value)}
                        placeholder="default value"
                      />
                      <button className="del-btn" title="Remove attribute" onClick={() => removeAttrDef(ad.name)}>✕</button>
                    </div>
                  ))}
                  <button className="add-btn" onClick={addAttrDef}>+ Add attribute</button>
                </div>
              );
            })}
          </div>
        )}

        {/* ━━ RESOURCES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {activeTab === 'resources' && (
          <div>
            <p className="prob-hint">
              Resource object types are <strong>permanently active</strong> and never deactivated — they
              represent shared infrastructure (employees, forklifts, trucks) reused across cases.
              Set a <strong>pool size</strong> to pre-populate N instances at simulation start, so
              activities that bind this type always find objects without a preceding <em>creates</em> step.
            </p>
            {otNames.length === 0 && <p className="empty-notice">No object types defined.</p>}
            <div className="resource-type-list">
              {otNames.map(typeName => {
                const isResource = resourceTypes.includes(typeName);
                const poolSize   = (model.resource_pool_sizes || {})[typeName] ?? '';
                return (
                  <div key={typeName} className={`resource-type-row ${isResource ? 'resource-active' : ''}`}>
                    <label className="resource-check-label">
                      <input
                        type="checkbox"
                        checked={isResource}
                        onChange={() => toggleResourceType(typeName)}
                      />
                      <span className="resource-type-name">{typeName}</span>
                    </label>
                    {isResource && (
                      <>
                        <span className="resource-badge">resource</span>
                        <label className="resource-pool-label">
                          pool size
                          <input
                            type="number"
                            min={1}
                            step={1}
                            className="resource-pool-input"
                            value={poolSize}
                            placeholder="1"
                            onChange={e => updateResourcePoolSize(typeName, e.target.value)}
                          />
                        </label>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ━━ TIMING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {activeTab === 'timing' && (
          <div>
            <p className="prob-hint">
              Edit per-activity time distributions. <strong>Mean</strong> and <strong>Std</strong> drive
              timestamp sampling during simulation. Metrics below each row (Sojourn, Waiting, etc.) are
              discovered reference values — they do not affect simulation directly.
              Run <em>Discover Time Distributions</em> (Step 2.5) to populate these from the event log.
            </p>
            {actNames.length === 0 && <p className="empty-notice">No activities defined.</p>}
            {actNames.map(act => {
              const td = timingData[act] || {};
              const hasData = !!td.mean_seconds;
              return (
                <div key={act} className="timing-row">
                  <div className="timing-act-name">
                    {act}
                    {!hasData && <span className="timing-no-data">no timing data</span>}
                  </div>
                  <div className="timing-controls">
                    <label className="timing-field-label">
                      Type <HelpTip text="Sampling distribution. Lognormal is recommended for durations (always positive, right-skewed)." />
                      <select
                        className="timing-select"
                        value={td.dist_type || 'lognormal'}
                        onChange={e => updateTiming(act, 'dist_type', e.target.value)}
                      >
                        {DIST_TYPES.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </label>
                    <label className="timing-field-label">
                      Mean (s) <HelpTip text="Average service duration in seconds." />
                      <input type="number" min={0} step={1} className="timing-num"
                        value={td.mean_seconds ?? ''}
                        placeholder="3600"
                        onChange={e => updateTiming(act, 'mean_seconds', e.target.value === '' ? null : parseFloat(e.target.value))} />
                    </label>
                    <label className="timing-field-label">
                      Std (s) <HelpTip text="Standard deviation of service duration in seconds. Not used for exponential or fixed." />
                      <input type="number" min={0} step={1} className="timing-num"
                        value={td.std_seconds ?? ''}
                        placeholder="600"
                        onChange={e => updateTiming(act, 'std_seconds', e.target.value === '' ? null : parseFloat(e.target.value))} />
                    </label>
                    <label className="timing-field-label">
                      Min (s) <HelpTip text="Hard lower bound on sampled duration (clamp)." />
                      <input type="number" min={0} step={1} className="timing-num"
                        value={td.min_seconds ?? ''}
                        placeholder="0"
                        onChange={e => updateTiming(act, 'min_seconds', e.target.value === '' ? null : parseFloat(e.target.value))} />
                    </label>
                    <label className="timing-field-label">
                      Max (s) <HelpTip text="Hard upper bound on sampled duration. Leave blank for no cap." />
                      <input type="number" min={0} step={1} className="timing-num"
                        value={td.max_seconds ?? ''}
                        placeholder="∞"
                        onChange={e => updateTiming(act, 'max_seconds', e.target.value === '' ? null : parseFloat(e.target.value))} />
                    </label>
                  </div>
                  {/* OCPA reference metrics */}
                  {OCPA_FIELDS.some(f => td[f.key] != null) && (
                    <div className="timing-ocpa-metrics">
                      {OCPA_FIELDS.filter(f => td[f.key] != null).map(f => (
                        <span key={f.key} className="timing-ocpa-chip">
                          {f.label}: <strong>{Math.round(td[f.key])}s</strong>
                        </span>
                      ))}
                      {td.sample_count != null && td.sample_count > 0 && (
                        <span className="timing-ocpa-chip timing-sample-count">n={td.sample_count}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ━━ OBJECT FLOW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {activeTab === 'flow' && (
          <div className="object-flow-tab">
            <p className="prob-hint">
              Per object type: the activities it participates in, where it is created and deactivated,
              and which transitions are possible (based on constraints and the probability matrix).
              Back-edges indicate the object can return to an earlier activity.
            </p>
            {otNames.length === 0 && <p className="empty-notice">No object types defined.</p>}
            {otNames.map(otype => {
              // Activities that have a binding for this type
              const involvedActs = activities.filter(a =>
                (a.bindings || []).some(b => b.object_type === otype)
              );
              if (involvedActs.length === 0) return null;

              const creatingActs    = involvedActs.filter(a => (a.bindings || []).some(b => b.object_type === otype && b.creates));
              const deactivatingActs = involvedActs.filter(a => (a.bindings || []).some(b => b.object_type === otype && (b.deactivates || b.consumes)));

              // Build a set of activity names in order they appear in the model
              const actOrder = activities.map(a => a.name);
              const sortedInvolved = involvedActs
                .slice()
                .sort((a, b) => actOrder.indexOf(a.name) - actOrder.indexOf(b.name));

              // Derive edges: from probMatrix, only between activities involved with this type
              const involvedNames = new Set(sortedInvolved.map(a => a.name));
              const edges = [];
              sortedInvolved.forEach(a => {
                const row = probMatrix[a.name] || {};
                Object.entries(row).forEach(([tgt, prob]) => {
                  if (involvedNames.has(tgt) && prob > 0.001) {
                    edges.push({ from: a.name, to: tgt, prob });
                  }
                });
              });

              // Detect back-edges: if target appears earlier in model order than source
              const nameIndex = {};
              sortedInvolved.forEach((a, i) => { nameIndex[a.name] = i; });
              const backEdges = new Set(
                edges
                  .filter(e => (nameIndex[e.to] ?? 999) < (nameIndex[e.from] ?? 999))
                  .map(e => `${e.from}→${e.to}`)
              );

              return (
                <div key={otype} className="object-flow-type">
                  <div className="object-flow-type-header">
                    <span className="object-flow-type-name">{otype}</span>
                    {resourceTypes.includes(otype) && (
                      <span className="binding-resource-badge" style={{marginLeft:'0.4rem'}}>Resource</span>
                    )}
                    <span className="object-flow-act-count">{sortedInvolved.length} activities</span>
                  </div>

                  <div className="object-flow-track">
                    {sortedInvolved.map((act, i) => {
                      const isCreating    = creatingActs.some(a => a.name === act.name);
                      const isDeactivating = deactivatingActs.some(a => a.name === act.name);
                      const outgoing = edges.filter(e => e.from === act.name);
                      const isLast = i === sortedInvolved.length - 1;

                      return (
                        <div key={act.name} className="object-flow-node-wrap">
                          <div className={`object-flow-node${isCreating ? ' flow-creates' : ''}${isDeactivating ? ' flow-deactivates' : ''}`}>
                            {isCreating && <span className="flow-node-badge flow-badge-create" title="Creates this object type">+</span>}
                            {isDeactivating && <span className="flow-node-badge flow-badge-deact" title="Deactivates this object type">✕</span>}
                            <button
                              className="flow-node-name"
                              onClick={() => {
                                setActiveTab('activities');
                                setExpandedActs(prev => { const n = new Set(prev); n.add(act.name); return n; });
                                setTimeout(() => {
                                  document.getElementById(`activity-row-${act.name}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                }, 50);
                              }}
                              title="Jump to this activity in the Activities tab"
                            >
                              {act.name}
                            </button>
                          </div>

                          {/* Outgoing transitions */}
                          {outgoing.length > 0 && (
                            <div className="object-flow-edges">
                              {outgoing.map(e => {
                                const isBack = backEdges.has(`${e.from}→${e.to}`);
                                return (
                                  <span
                                    key={e.to}
                                    className={`object-flow-edge${isBack ? ' flow-edge-back' : ''}`}
                                    title={`${e.from} → ${e.to}: ${(e.prob * 100).toFixed(1)}%${isBack ? ' (back-edge)' : ''}`}
                                  >
                                    {isBack ? '↩ ' : '→ '}{e.to}
                                    <span className="flow-edge-prob">{(e.prob * 100).toFixed(0)}%</span>
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {backEdges.size > 0 && (
                    <p className="object-flow-back-note">
                      ↩ Back-edges detected — this object type can revisit earlier activities.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

      </div>
    </div>
  );
}

