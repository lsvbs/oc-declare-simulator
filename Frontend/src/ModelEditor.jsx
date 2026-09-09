import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import './ModelEditor.css';

// ── Scope formatter ───────────────────────────────────────────────────────────
function formatScope(scope) {
  if (!scope) return '';
  const bindings = scope.bindings || [];
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
function HelpTip({ text, children }) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="help-tip" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}
      style={children ? {display:'inline-flex',alignItems:'center',gap:'2px'} : undefined}>
      {children}
      <span className="help-tip-icon">?</span>
      {visible && <span className="help-tip-popup">{text}</span>}
    </span>
  );
}

// ── Sort helpers ──────────────────────────────────────────────────────────────
function useSortState() {
  const [s, setSt] = useState({col:null,dir:null});
  const cycle = col => setSt(p => p.col!==col ? {col,dir:'asc'} : p.dir==='asc' ? {col,dir:'desc'} : {col:null,dir:null});
  const set = (col, dir) => setSt(col ? {col, dir} : {col:null, dir:null});
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
function SortSelect({s, set, columns, tips}) {
  const val = s.col ? `${s.col}:${s.dir}` : 'log';
  const active = !!s.col;
  const tipContent = tips ? (
    <span>{columns.map((c, i) => (
      <span key={c.col}>{i > 0 && <><br/><br/></>}<strong>{c.label}:</strong> {tips[c.col]}</span>
    ))}</span>
  ) : null;
  return (
    <div style={{display:'inline-flex',alignItems:'center',gap:'0.3rem',padding:'0.3rem 0.5rem',
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
      {tipContent && <HelpTip text={tipContent}/>}
    </div>
  );
}

const CONSTRAINT_TYPES = [
  'precedence', 'not_precedence', 'response', 'not_coexistence',
  'chain_precedence', 'chain_response',
  'responded_existence',
  'absence',
  // 'exactly',  // removed
  // 'init',  // removed
  // 'exclusive_choice',  // removed
  // 'succession', 'chain_succession',  // removed
  'not_succession', 'not_chain_succession',
  // 'alternate_response', 'alternate_precedence', 'alternate_succession',  // removed
];

export const CONSTRAINT_HELP = {
  precedence:           'B is blocked until A has fired on the same scope object. nmin ≥ 1 (default) enforces this; nmax caps how many A-occurrences may precede B.',
  not_precedence:       'Once A fires on a scope object, B is permanently blocked for that object. B can still fire freely before A occurs.',
  response:             'If A fires on an object, B must eventually follow. Use n≤ to cap how many times B may fire per scope object.',
  not_coexistence:      'Mutual exclusion per scope object: once A fires, B is blocked; once B fires, A is blocked. At most one of the two activities can ever fire per object.',
  chain_precedence:     'B must be immediately preceded by A on the scope object — no other event for that object may occur in between.',
  chain_response:       'Once A fires, every other activity is blocked for the scope object until B fires next.',
  responded_existence:  'If A occurs, B must also occur (before or after). Post-hoc obligation only — not enforced eagerly during simulation.',
  absence:              'Activity must never occur (n≤ = 0) or at most n≤ times per scope object.',
  // exactly:           removed
  // init:              removed
  // exclusive_choice:  removed
  // succession:        removed
  // chain_succession:  removed
  not_succession:       'After A fires, B must never follow.',
  not_chain_succession: 'B must not occur immediately after A.',
  // alternate_response:   removed
  // alternate_precedence: removed
  // alternate_succession: removed
};
const SCOPE_KINDS      = ['each', 'any', 'all'];

// nmin defaults to 1 so a manually added precedence constraint actually enforces
// "source before target" during simulation. nmin is only meaningful for
// precedence; the other constraint checks ignore it, so the default is harmless.
const EMPTY_CONSTRAINT = { constraint_type: '', source_activity: '', target_activity: '', scope: { kind: 'each', object_type: '' }, nmin: 1, nmax: null, guard: null };
const EMPTY_O2O        = { source_type: '', target_type: '', min_links: 0, max_links: null, bidirectional: true };

function ObjectLifecycleSummary({ otNames, activities, resourceTypes }) {
  const lifecycle = {};
  otNames.forEach(t => { lifecycle[t] = { creates: [], deactivates: [] }; });
  (activities || []).forEach(act => {
    (act.bindings || []).forEach(b => {
      if (!b.object_type || !lifecycle[b.object_type]) return;
      if (b.creates) lifecycle[b.object_type].creates.push(act.name);
      if (b.deactivates) lifecycle[b.object_type].deactivates.push(act.name);
    });
  });
  return (
    <details style={{marginTop:'1rem'}} open>
      <summary style={{cursor:'pointer',fontSize:'0.82rem',fontWeight:600,color:'#475569',userSelect:'none',padding:'0.3rem 0'}}>
        Object Lifecycle Summary
      </summary>
      <table style={{width:'100%',fontSize:'0.78rem',borderCollapse:'collapse',marginTop:'0.5rem'}}>
        <thead>
          <tr style={{borderBottom:'2px solid #e2e8f0'}}>
            <th style={{textAlign:'left',padding:'0.25rem 0.4rem',color:'#475569',fontWeight:700}}>Object Type</th>
            <th style={{textAlign:'left',padding:'0.25rem 0.4rem',color:'#16a34a',fontWeight:700}}>Created by</th>
            <th style={{textAlign:'left',padding:'0.25rem 0.4rem',color:'#dc2626',fontWeight:700}}>Deactivated by</th>
          </tr>
        </thead>
        <tbody>
          {otNames.map(t => {
            const lc = lifecycle[t];
            const isRes = resourceTypes.includes(t);
            return (
              <tr key={t} style={{borderBottom:'1px solid #f1f5f9',background:isRes?'#f8fafc':undefined}}>
                <td style={{padding:'0.25rem 0.4rem',fontWeight:600,color:'#1e293b'}}>
                  {t}{isRes && <span style={{marginLeft:'0.3rem',fontSize:'0.68rem',color:'#7c3aed',fontWeight:700}}>R</span>}
                </td>
                <td style={{padding:'0.25rem 0.4rem',color:'#15803d'}}>
                  {isRes
                    ? lc.creates.length
                      ? <span><span style={{color:'#94a3b8',fontStyle:'italic'}}>pool</span>{' / '}{lc.creates.join(', ')}</span>
                      : <span style={{color:'#94a3b8',fontStyle:'italic'}}>pool</span>
                    : lc.creates.length
                      ? lc.creates.join(', ')
                      : <span style={{color:'#f97316',fontWeight:600}}>⚠ none</span>}
                </td>
                <td style={{padding:'0.25rem 0.4rem',color:'#dc2626'}}>
                  {isRes
                    ? lc.deactivates.length
                      ? lc.deactivates.join(', ')
                      : <span style={{color:'#94a3b8',fontStyle:'italic'}}>never</span>
                    : lc.deactivates.length
                      ? lc.deactivates.join(', ')
                      : <span style={{color:'#f97316',fontWeight:600}}>⚠ none</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

export default function ModelEditor({
  model, probMatrix, onModelChange, onProbMatrixChange,
  sourceFile = '', parameterFiles = [], onLoadParameters, onSaveParameters,
  nmaxSuggestions = {}, // kept for API compatibility but unused
  eventLogFile = '',
  hideParameterButtons = false,
  startActivities = [],
  onStartActivitiesChange = null,
  onUseParameters = null,
  tracePosition = {},
}) {
  const [activeTab,      setActiveTab]      = useState('activities');
  const [collapsed,      setCollapsed]      = useState(true);
  const [expandedActs,   setExpandedActs]   = useState(new Set());
  const [expandedGuards, setExpandedGuards] = useState(new Set()); // `${ai}-${bi}`
  const [expandedEffects,setExpandedEffects]= useState(new Set()); // `${ai}-${bi}`
  const [expandedEventCaps,setExpandedEventCaps]= useState(new Set()); // ai
  const [selectedParamFile, setSelectedParamFile] = useState('');
  const [expandedProbs,  setExpandedProbs]  = useState(new Set());
  const [conFilter,      setConFilter]      = useState('');
  const [newCon,         setNewCon]         = useState(EMPTY_CONSTRAINT);
  const [newO2O,         setNewO2O]         = useState(EMPTY_O2O);
  const [editingConIdx,  setEditingConIdx]  = useState(null);
  const [showConSummary, setShowConSummary] = useState(new Set()); // activity names with popup visible
  // Per-activity "add binding" selected type: { [actName]: objectType }
  const [newBindingTypes, setNewBindingTypes] = useState({});
  const [sortAct,  cycleAct,  setSortAct]  = useSortState();
  const [sortCon,  cycleCon,  setSortCon]  = useSortState();
  const [sortProb, cycleProb, setSortProb] = useSortState();
  const [sortTime, cycleTime, setSortTime] = useSortState();

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

  const updateActivityEventCaps = (actName, caps) => {
    const newActs = activities.map(a => a.name !== actName ? a : { ...a, event_attributes: caps });
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
    if (!newCon.constraint_type) return;
    const isUnary = ['absence'].includes(newCon.constraint_type);
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
    { id: 'o2o',          label: 'Obj-to-Obj', count: o2oRules.length },
    // { id: 'attributes',   label: 'Attributes',   count: objectTypes.length },
    // { id: 'resources',    label: 'Permanent Objects', count: resourceTypes.length || null },
    { id: 'probabilities',label: 'Probabilities',count: null },
    { id: 'timing',       label: 'Timing',       count: null },
    { id: 'flow',         label: 'Object Involvement',  count: null },
  ];

  // Pre-compute special filter sets
  const activitiesWithSelfLoop = useMemo(() => {
    const set = new Set();
    constraints.forEach(c => {
      if (c.source_activity && c.target_activity && c.source_activity === c.target_activity) {
        set.add(c.source_activity);
      }
    });
    return set;
  }, [constraints]);

  const activitiesWithMultipleResponsesBefore = useMemo(() => {
    // Activities that appear as target in 2+ response/chain_response constraints
    const counts = {};
    constraints.forEach(c => {
      if (['response','chain_response'].includes(c.constraint_type) && c.target_activity) {
        counts[c.target_activity] = (counts[c.target_activity] || 0) + 1;
      }
    });
    return new Set(Object.keys(counts).filter(a => counts[a] >= 2));
  }, [constraints]);

  const [conSpecialFilter, setConSpecialFilter] = useState(''); // '' | 'selfloop' | 'multi_response'
  const [groupByObjType, setGroupByObjType] = useState(false);

  const filteredConstraints = constraints.filter(c => {
    const textMatch = !conFilter ||
      c.source_activity?.toLowerCase().includes(conFilter.toLowerCase()) ||
      c.target_activity?.toLowerCase().includes(conFilter.toLowerCase());
    if (!textMatch) return false;
    if (conSpecialFilter === 'selfloop') {
      return c.source_activity === c.target_activity ||
        activitiesWithSelfLoop.has(c.source_activity) ||
        activitiesWithSelfLoop.has(c.target_activity);
    }
    if (conSpecialFilter === 'multi_response') {
      return activitiesWithMultipleResponsesBefore.has(c.source_activity) ||
        activitiesWithMultipleResponsesBefore.has(c.target_activity);
    }
    return true;
  });
  const sortedConstraints = (() => {
    // Topological BFS layers for Activity Order sort
    const inDeg = {}, outEdges = {}, allActs = new Set();
    constraints.forEach(c => {
      const src = c.source_activity, tgt = c.target_activity;
      if (!src || !tgt || src === tgt) return;
      allActs.add(src); allActs.add(tgt);
      outEdges[src] = outEdges[src] || [];
      outEdges[src].push(tgt);
      inDeg[tgt] = (inDeg[tgt] || 0) + 1;
      if (inDeg[src] === undefined) inDeg[src] = 0;
    });
    const actLayer = {};
    const bfsQ = [];
    for (const act of allActs) {
      if ((inDeg[act] || 0) === 0) { actLayer[act] = 0; bfsQ.push(act); }
    }
    for (let i = 0; i < bfsQ.length; i++) {
      const act = bfsQ[i];
      for (const tgt of (outEdges[act] || [])) {
        if (actLayer[tgt] === undefined || actLayer[tgt] < actLayer[act] + 1) {
          actLayer[tgt] = actLayer[act] + 1;
          bfsQ.push(tgt);
        }
      }
    }
    const conKey = (c, col) => {
      if (col === 'type') return c.constraint_type || '';
      if (col === 'source') return c.source_activity || '';
      if (col === 'target') return c.target_activity || '';
      if (col === 'scope') return c.scope?.object_type || '';
      if (col === 'activity_order') {
        const sl = String(actLayer[c.source_activity] ?? 999).padStart(4, '0');
        const tl = String(actLayer[c.target_activity] ?? 999).padStart(4, '0');
        return `${sl}.${tl}.${c.source_activity||''}.${c.target_activity||''}`;
      }
      return '';
    };
    const cmpFn = (a, b) => {
      if (!sortCon.col) return 0;
      const va = conKey(a, sortCon.col), vb = conKey(b, sortCon.col);
      const isNum = v => v !== '' && v != null && !isNaN(+v);
      const cmp = isNum(va) && isNum(vb) ? +va - +vb : String(va ?? '').localeCompare(String(vb ?? ''));
      return sortCon.dir === 'asc' ? cmp : -cmp;
    };
    if (groupByObjType) {
      return [...filteredConstraints].sort((a, b) => {
        const objCmp = (a.scope?.object_type || '').localeCompare(b.scope?.object_type || '');
        return objCmp !== 0 ? objCmp : cmpFn(a, b);
      });
    }
    return sortedBy(filteredConstraints, sortCon, conKey);
  })();

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
                Load
              </button>
            </div>
            <button
              className="model-download-btn"
              onClick={downloadModel}
              title="Download the current parameters (activities, bindings, constraints, object-to-object relationships, timing, max-consecutive and edited probabilities) as a JSON file. A copy is also saved to IO/input/parameters so you can reload it later."
            >
              Download JSON
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
              <label className="act-con-summary-toggle" title="Show/hide constraint summary for all activities">
                <input
                  type="checkbox"
                  checked={showConSummary.size === activities.length && activities.length > 0}
                  ref={el => { if (el) el.indeterminate = showConSummary.size > 0 && showConSummary.size < activities.length; }}
                  onChange={e => {
                    if (e.target.checked) setShowConSummary(new Set(activities.map(a => a.name)));
                    else setShowConSummary(new Set());
                  }}
                />
                Show all constraint summaries
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
            <p style={{fontSize:'0.78rem',color:'#64748b',margin:'0.25rem 0 0.5rem 0'}}>
              All activities in the model. Expand an activity to configure its object bindings.
            </p>
            <div style={{display:'flex',flexWrap:'wrap',gap:'0.5rem 1rem',fontSize:'0.72rem',color:'#64748b',
              background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:'6px',
              padding:'0.35rem 0.65rem',marginBottom:'0.5rem',alignItems:'center'}}>
              <span style={{fontWeight:700,color:'#94a3b8',fontSize:'0.65rem',textTransform:'uppercase',letterSpacing:'0.05em',marginRight:'0.25rem'}}>Legend:</span>
              <span><span style={{fontWeight:700,color:'#16a34a',marginRight:'3px'}}>+</span>Creates new objects of that type</span>
              <span><span style={{fontWeight:700,color:'#dc2626',marginRight:'3px'}}>−</span>Deactivates (ends lifecycle of) objects of that type</span>
              <span><span style={{fontWeight:700,color:'#f59e0b',marginRight:'3px'}}>★</span>Start activity — simulation begins here</span>
              <span><span style={{fontWeight:700,color:'#64748b',marginRight:'3px'}}>●</span>Activity involves this type (binding, no create/deactivate)</span>
            </div>
            {onStartActivitiesChange && activities.length > 0 && (
              <div style={{display:'flex',justifyContent:'flex-end',paddingRight:'0.5rem',marginBottom:'0.15rem'}}>
                <span style={{fontSize:'0.68rem',fontWeight:600,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.05em'}}>Start activity</span>
              </div>
            )}
            {activities.length === 0 && <p className="empty-notice">No activities defined.</p>}
            {activities.length > 0 && (
              <div style={{marginBottom:'0.4rem'}}>
                <SortSelect s={sortAct} set={setSortAct} columns={[{col:'name',label:'Activity name'}]}/>
              </div>
            )}
            {sortedBy(activities, sortAct, a => a.name).map((act, ai) => (
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
                  {/* (no parallel toggle removed — parallelism controlled via permanent object pool sizes) */}
                  {(act.bindings || []).length === 0 && (
                    <span className="binding-warning-badge" title="This activity has no object bindings and will never fire.">
                      ⚠ No bindings
                    </span>
                  )}
                  <span className="activity-binding-count">
                    {(act.bindings || []).length} binding{(act.bindings || []).length !== 1 ? 's' : ''}
                  </span>
                  <button
                    className={`binding-guard-btn${(act.event_attributes?.length) ? ' active' : ''}`}
                    title="Event captures: attribute values recorded into the event log when this activity fires"
                    onClick={e => {
                      e.stopPropagation();
                      if (!expandedActs.has(act.name)) toggleAct(act.name);
                      setExpandedEventCaps(prev => {
                        const n = new Set(prev); n.has(act.name) ? n.delete(act.name) : n.add(act.name); return n;
                      });
                    }}>
                    {(act.event_attributes?.length) ? '[event caps ✓]' : '[event caps]'}
                  </button>
                  <button
                    className={`binding-guard-btn${showConSummary.has(act.name) ? ' active' : ''}`}
                    title="Show constraint summary for this activity"
                    onClick={e => {
                      e.stopPropagation();
                      setShowConSummary(prev => {
                        const n = new Set(prev); n.has(act.name) ? n.delete(act.name) : n.add(act.name); return n;
                      });
                    }}>
                    {showConSummary.has(act.name) ? '[constraints ✓]' : '[constraints]'}
                  </button>
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
                            {isResource && <span className="binding-resource-badge" title="Immutable object type — fixed pool, never deactivated.">I</span>}
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
                            title={isResource ? 'Immutable objects come from the pre-populated pool — they cannot be created by activities and are never deactivated.' : ''}>
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
                                    const newOp = e.target.value;
                                    const updated = (b.attribute_updates || []).map((u, i) => {
                                      if (i !== ui) return u;
                                      const { value: _v, by: _b, ...rest } = u;
                                      return newOp === 'set' ? { ...rest, op: newOp, value: '' } : { ...rest, op: newOp, by: '' };
                                    });
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

                    {/* ── Event captures section ── */}
                    {expandedEventCaps.has(act.name) && (
                      <div className="binding-effects-section" style={{marginTop:'0.5rem'}}>
                        <span className="binding-guard-label" style={{marginBottom:'0.25rem',display:'block'}}>Event captures:</span>
                        {(act.event_attributes || []).map((cap, ci) => (
                          <div key={ci} className="binding-effects-row" style={{alignItems:'center',flexWrap:'wrap',gap:'0.35rem'}}>
                            <input
                              className="guard-attr-input"
                              placeholder="attr name"
                              value={cap.name || ''}
                              onChange={e => {
                                const caps = (act.event_attributes || []).map((c, i) => i === ci ? { ...c, name: e.target.value } : c);
                                updateActivityEventCaps(act.name, caps);
                              }}
                            />
                            <select
                              className="guard-op-select"
                              value={cap.source || 'static'}
                              onChange={e => {
                                const src = e.target.value;
                                const base = { name: cap.name || '', source: src };
                                const updated = src === 'static'
                                  ? { ...base, value: '' }
                                  : { ...base, object_type: '', attribute: '' };
                                const caps = (act.event_attributes || []).map((c, i) => i === ci ? updated : c);
                                updateActivityEventCaps(act.name, caps);
                              }}>
                              <option value="static">static</option>
                              <option value="object">object</option>
                            </select>
                            {(cap.source || 'static') === 'static' ? (
                              <input
                                className="guard-value-input"
                                placeholder="value"
                                value={cap.value ?? ''}
                                onChange={e => {
                                  const caps = (act.event_attributes || []).map((c, i) => i === ci ? { ...c, value: e.target.value } : c);
                                  updateActivityEventCaps(act.name, caps);
                                }}
                              />
                            ) : (
                              <>
                                <select
                                  className="guard-op-select"
                                  value={cap.object_type || ''}
                                  onChange={e => {
                                    const caps = (act.event_attributes || []).map((c, i) => i === ci ? { ...c, object_type: e.target.value } : c);
                                    updateActivityEventCaps(act.name, caps);
                                  }}>
                                  <option value="">type…</option>
                                  {otNames.map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                                <input
                                  className="guard-attr-input"
                                  placeholder="attribute"
                                  value={cap.attribute || ''}
                                  onChange={e => {
                                    const caps = (act.event_attributes || []).map((c, i) => i === ci ? { ...c, attribute: e.target.value } : c);
                                    updateActivityEventCaps(act.name, caps);
                                  }}
                                />
                              </>
                            )}
                            <button className="row-delete-btn" title="Remove capture"
                              onClick={() => {
                                const caps = (act.event_attributes || []).filter((_, i) => i !== ci);
                                updateActivityEventCaps(act.name, caps);
                              }}>✕</button>
                          </div>
                        ))}
                        <button className="add-binding-btn" style={{marginTop:'0.25rem'}}
                          onClick={() => {
                            const caps = [...(act.event_attributes || []), { name: '', source: 'static', value: '' }];
                            updateActivityEventCaps(act.name, caps);
                          }}>+ Add capture</button>
                      </div>
                    )}
                  </div>
                )}
                {/* ── Constraint summary popup ── */}
                {showConSummary.has(act.name) && (() => {
                  const actName = act.name;
                  const cons = constraints || [];
                  const scopePart = c => c.scope ? ` per ${(c.scope.bindings||[]).length > 1 ? c.scope.bindings.map(([t])=>t).join(', ') : c.scope.object_type}` : '';
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
                      // case 'succession':  // removed
                      //   ...
                      // case 'chain_succession':  // removed
                      //   ...
                      // case 'alternate_response':  // removed
                      //   ...
                      // case 'alternate_precedence':  // removed
                      //   ...
                      // case 'alternate_succession':  // removed
                      //   ...
                      // case 'exclusive_choice':  // removed
                      //   ...
                      case 'absence':
                        return `"${actName}" must never occur${nmax != null ? ` more than ${timesMax}` : ''}${sp}`;
                      // case 'exactly':  // removed
                      //   ...
                      // case 'init':  // removed
                      //   ...
                      default:
                        return `${c.constraint_type.replace(/_/g,' ')}: "${src}" → "${tgt}"${sp}`;
                    }
                  };

                  // Direction relative to focal actName:
                  // "before" = actName is target (other → actName)
                  // "after"  = actName is source (actName → other)
                  // "mutual" = symmetric
                  const classifyDirection = (c) => {
                    const mutual = ['not_coexistence', 'responded_existence'].includes(c.constraint_type);
                    // 'exclusive_choice', 'chain_succession', 'alternate_succession', 'succession' removed
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
                      <span
                        className={`constraint-type-badge ${c.constraint_type}`}
                        style={{fontSize:'0.6rem'}}
                        title={CONSTRAINT_HELP[c.constraint_type] || c.constraint_type.replace(/_/g,' ')}
                      >
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
            <div style={{fontSize:'0.95rem',fontWeight:600,marginBottom:'0.5rem'}}>{constraints.length} Constraints</div>
            <div style={{display:'flex',gap:'0.4rem',alignItems:'center',marginBottom:'0.4rem',flexWrap:'wrap'}}>
              <SortSelect s={sortCon} set={setSortCon} columns={[
                {col:'type',label:'Type'},{col:'source',label:'Source'},
                {col:'target',label:'Target'},{col:'activity_order',label:'Activity Order'},
              ]} tips={{
                type: 'Groups all constraints of the same type together (response, precedence, not_coexistence, etc.).',
                source: 'Alphabetical by source activity name.',
                target: 'Alphabetical by target activity name.',
                activity_order: 'Process-flow order: constraints from "entry" activities (no predecessors in the constraint graph) appear first, then activities reachable from them layer by layer, ending with activities that are only ever targets.',
              }}/>
              <div className="toolbar-row" style={{flex:1,marginBottom:0}}>
                <input
                  className="filter-input"
                  placeholder="Filter by activity name…"
                  value={conFilter}
                  onChange={e => setConFilter(e.target.value)}
                />
                <span className="filter-count">{filteredConstraints.length} / {constraints.length}</span>
              </div>
            </div>
            <div style={{display:'flex',gap:'0.4rem',flexWrap:'wrap',marginBottom:'0.5rem'}}>
              <button
                className={`con-filter-btn${conSpecialFilter === '' ? ' active' : ''}`}
                onClick={() => setConSpecialFilter('')}
              >All</button>
              <button
                className={`con-filter-btn${conSpecialFilter === 'selfloop' ? ' active' : ''}`}
                onClick={() => setConSpecialFilter(conSpecialFilter === 'selfloop' ? '' : 'selfloop')}
                title="Activities that have constraints where source and target are the same activity"
              >
                Self-loop constraints
                {activitiesWithSelfLoop.size > 0 && <span className="con-filter-badge">{activitiesWithSelfLoop.size}</span>}
              </button>
              <button
                className={`con-filter-btn${conSpecialFilter === 'multi_response' ? ' active' : ''}`}
                onClick={() => setConSpecialFilter(conSpecialFilter === 'multi_response' ? '' : 'multi_response')}
                title="Activities that are targets of 2+ response constraints"
              >
                Multiple responses before
                {activitiesWithMultipleResponsesBefore.size > 0 && <span className="con-filter-badge">{activitiesWithMultipleResponsesBefore.size}</span>}
              </button>
              <label title="When checked, constraints are grouped by their scope object type, shown in bordered boxes with the type name as a title. The selected sort applies within each group."
                className={`con-filter-btn${groupByObjType ? ' active' : ''}`}
                style={{display:'inline-flex',alignItems:'center',gap:'0.3rem',cursor:'pointer',userSelect:'none'}}>
                <input type="checkbox" checked={groupByObjType} onChange={e => setGroupByObjType(e.target.checked)}
                  style={{margin:0,accentColor:'#6366f1'}}/>
                Group by object type
              </label>
            </div>

            <div className="constraints-list">
              {filteredConstraints.length === 0 && (
                <p className="empty-notice">No constraints match the filter.</p>
              )}
              {(() => {
                const renderRow = (c, key) => {
                  const realIdx = constraints.indexOf(c);
                  const isEditing = editingConIdx === realIdx;
                  const rowBg = /^(response|chain_response)$/.test(c.constraint_type) ? '#f0fdf4'
                    : /^(precedence|chain_precedence)$/.test(c.constraint_type) ? '#eff6ff'
                    : undefined;
                  return (
                    <div key={key} className={`constraint-row${isEditing ? ' constraint-row-editing' : ''}`}
                      style={rowBg ? {background:rowBg} : undefined}>
                      <span
                        className={`constraint-type-badge ${c.constraint_type}`}
                        title={CONSTRAINT_HELP[c.constraint_type] || c.constraint_type.replace(/_/g, ' ')}
                      >
                        {c.constraint_type.replace(/_/g, ' ')}
                      </span>
                      <span className="constraint-src">{c.source_activity}</span>
                      <span className="constraint-arrow">→</span>
                      <span className="constraint-tgt">{c.target_activity}</span>
                      {!isEditing ? (
                        <>
                          <span className="constraint-scope">
                            [{formatScope(c.scope)}]
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
                          <label className="constraint-edit-label"><HelpTip text="each = constraint applies per individual object instance; any = at least one instance satisfies it; all = every instance must satisfy it.">scope kind:</HelpTip>
                            <select
                              className="constraint-edit-select"
                              value={c.scope?.kind || 'each'}
                              onChange={e => updateConstraint(realIdx, { scope: { ...c.scope, kind: e.target.value } })}
                            >
                              <option value="each">each — per individual object</option>
                              <option value="any">any — at least one object</option>
                              <option value="all">all — every object</option>
                            </select>
                          </label>
                          <label className="constraint-edit-label"><HelpTip text="The object type whose instances the constraint is evaluated against.">scope type:</HelpTip>
                            <select
                              className="constraint-edit-select"
                              value={c.scope?.object_type || ''}
                              onChange={e => updateConstraint(realIdx, { scope: { ...c.scope, object_type: e.target.value } })}
                            >
                              <option value="">—</option>
                              {otNames.map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </label>
                          <label className="constraint-edit-label"><HelpTip text="Minimum Source firings required before Target may fire (nmin). Default 0 = no minimum.">n≥:</HelpTip>
                            <input type="number" min={0} className="constraint-edit-num"
                              value={c.nmin ?? 0}
                              onChange={e => updateConstraint(realIdx, { nmin: e.target.value === '' ? 0 : parseInt(e.target.value, 10) })}
                            />
                          </label>
                          <label className="constraint-edit-label"><HelpTip text="Maximum Source firings before Target must have fired (nmax). Leave blank for no upper bound.">n≤:</HelpTip>
                            <input type="number" min={0} className="constraint-edit-num"
                              placeholder="∞"
                              value={c.nmax ?? ''}
                              onChange={e => updateConstraint(realIdx, { nmax: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
                            />
                          </label>
                          {false && <label className="constraint-edit-label">
                            <HelpTip text="Optional attribute guard (OC-Declare): scope objects not satisfying this predicate are exempt from this constraint. Same attribute/op/value format as binding guards.">guard:</HelpTip>
                            {false && c.guard ? (
                              <span style={{display:'flex',gap:'0.25rem',alignItems:'center'}}>
                                <input className="constraint-edit-num" style={{width:'5rem'}} placeholder="attribute"
                                  value={c.guard.attribute||''} onChange={e => updateConstraint(realIdx, { guard: {...c.guard, attribute: e.target.value} })} />
                                <select className="constraint-edit-select" style={{width:'3.5rem'}} value={c.guard.op||'=='} onChange={e => updateConstraint(realIdx, { guard: {...c.guard, op: e.target.value} })}>
                                  {['==','!=','>','<','>=','<='].map(o => <option key={o} value={o}>{o}</option>)}
                                </select>
                                <input className="constraint-edit-num" style={{width:'4rem'}} placeholder="value"
                                  value={c.guard.value??''} onChange={e => updateConstraint(realIdx, { guard: {...c.guard, value: e.target.value} })} />
                                <button className="row-delete-btn" title="Remove guard" onClick={() => updateConstraint(realIdx, { guard: null })}>✕</button>
                              </span>
                            ) : (
                              false && <button className="con-filter-btn" onClick={() => updateConstraint(realIdx, { guard: {attribute:'', op:'==', value:''} })}>+ add guard</button>
                            )}
                          </label>}
                          <button className="row-edit-btn" onClick={() => setEditingConIdx(null)} title="Done">✓</button>
                        </div>
                      )}
                      <button className="row-delete-btn" onClick={() => { deleteConstraint(realIdx); setEditingConIdx(null); }} title="Remove">✕</button>
                    </div>
                  );
                };
                if (groupByObjType) {
                  const groups = [];
                  sortedConstraints.forEach(c => {
                    const ot = c.scope?.object_type || '';
                    if (!groups.length || groups[groups.length - 1].ot !== ot) groups.push({ ot, items: [] });
                    groups[groups.length - 1].items.push(c);
                  });
                  return groups.map((g, gi) => (
                    <div key={gi} className="constraint-obj-group">
                      <span className="constraint-obj-group-label">{g.ot || '(no object type)'}</span>
                      {g.items.map((c, li) => renderRow(c, `g${gi}-${li}`))}
                    </div>
                  ));
                }
                return sortedConstraints.map((c, idx) => renderRow(c, idx));
              })()}
            </div>

            <div className="add-form-header">+ Add Constraint</div>
            <div className="add-form">
              <select value={newCon.constraint_type}
                onChange={e => setNewCon(p => ({
                  ...p,
                  constraint_type: e.target.value,
                  nmin: e.target.value === 'precedence' ? 1 : 0,
                  nmax: e.target.value === 'absence' ? 0 : null,
                }))}>
                <option value="">constraint…</option>
                {CONSTRAINT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
              {CONSTRAINT_HELP[newCon.constraint_type] && (
                <HelpTip text={CONSTRAINT_HELP[newCon.constraint_type]} />
              )}
              {/* For unary constraints (absence): single activity picker */}
              {['absence'].includes(newCon.constraint_type) ? (
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
                {SCOPE_KINDS.map(k => <option key={k} value={k}>{
                  k === 'each' ? 'each — per individual object' :
                  k === 'any'  ? 'any — at least one object' :
                  'all — every object'
                }</option>)}
              </select>
              {newCon.scope.kind !== 'global' && (
                <select value={newCon.scope.object_type}
                  onChange={e => setNewCon(p => ({ ...p, scope: { ...p.scope, object_type: e.target.value } }))}>
                  <option value="">scope type…</option>
                  {otNames.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
              {(['precedence', 'response', 'absence'].includes(newCon.constraint_type)) && (
                <span className="card-inputs" title={
                  newCon.constraint_type === 'response'
                    ? 'n≤ caps how many times the target may fire per scope object (blank = no upper bound).'
                    : newCon.constraint_type === 'absence'
                    ? 'n≤ = 0 means never. Increase to allow at most n≤ occurrences.'
                    : 'Cardinality bounds: nmin ≥ 1 enforces "source before target"; nmax optionally caps how many sources may precede the target (blank = no upper bound).'
                }>
                  {(newCon.constraint_type === 'precedence') && (
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
              {false && newCon.guard ? (
                <span style={{display:'flex',gap:'0.25rem',alignItems:'center',flexWrap:'wrap'}}>
                  <span style={{fontSize:'0.72rem',color:'#64748b'}}>guard: if</span>
                  <input className="card-input" style={{width:'5rem'}} placeholder="attribute"
                    value={newCon.guard.attribute||''} onChange={e => setNewCon(p => ({ ...p, guard: {...p.guard, attribute: e.target.value} }))} />
                  <select className="constraint-edit-select" style={{width:'3.5rem'}} value={newCon.guard.op||'=='} onChange={e => setNewCon(p => ({ ...p, guard: {...p.guard, op: e.target.value} }))}>
                    {['==','!=','>','<','>=','<='].map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                  <input className="card-input" style={{width:'4rem'}} placeholder="value"
                    value={newCon.guard.value??''} onChange={e => setNewCon(p => ({ ...p, guard: {...p.guard, value: e.target.value} }))} />
                  <button className="row-delete-btn" title="Remove guard" onClick={() => setNewCon(p => ({ ...p, guard: null }))}>✕</button>
                </span>
              ) : (
                false && <button className="con-filter-btn" onClick={() => setNewCon(p => ({ ...p, guard: {attribute:'', op:'==', value:''} }))}>+ guard</button>
              )}
              <button className="add-form-btn" onClick={addConstraint}>+ Add</button>
            </div>
          </div>
        )}

        {/* ━━ O2O RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {activeTab === 'o2o' && (
          <div>
            <div className="o2o-list">
              {o2oRules.length === 0 && <p className="empty-notice">No object-to-object relationships defined.</p>}
              {o2oRules.map((r, idx) => (
                <div key={idx} className="o2o-row">
                  <span className="o2o-src">{r.source_type}</span>
                  <span className={`o2o-dir ${r.bidirectional ? 'bi' : 'uni'}`}>
                    {r.bidirectional ? '↔' : '→'}
                  </span>
                  <span className="o2o-tgt">{r.target_type}</span>
                  <span className="o2o-cardinality">
                    max: {r.max_links === null ? '∞' : r.max_links}
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
              <input className="binding-num" type="number" min={0}
                value={newO2O.max_links === null ? '' : newO2O.max_links}
                placeholder="max links (∞)"
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

            {o2oRules.length > 0 && (() => {
              // Cardinality matrix: rows = from-type, cols = to-type
              const cellMap = {};
              otNames.forEach(a => { cellMap[a] = {}; });
              o2oRules.forEach(r => {
                const cell = { min: r.min_links ?? 0, max: r.max_links };
                if (cellMap[r.source_type]) cellMap[r.source_type][r.target_type] = cell;
                if (r.bidirectional && cellMap[r.target_type]) cellMap[r.target_type][r.source_type] = cell;
              });
              const involved = new Set(o2oRules.flatMap(r => [r.source_type, r.target_type]));
              const cols = otNames.filter(t => involved.has(t));
              const fmtCell = ({min, max}) => { const s = max == null ? '∞' : max; return (max !== null && min === max) ? String(min) : `${min}-${s}`; };
              return (
                <div style={{overflowX:'auto',marginTop:'1rem'}}>
                  <table className="o2o-preview-table">
                    <thead>
                      <tr>
                        <th style={{background:'#f8fafc',textAlign:'left'}}>From \ To</th>
                        {cols.map(c => <th key={c} style={{textAlign:'center'}}>{c}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {cols.map(row => (
                        <tr key={row}>
                          <td style={{fontWeight:600,background:'#f8fafc',whiteSpace:'nowrap'}}>{row}</td>
                          {cols.map(col => {
                            if (row === col) return <td key={col} style={{background:'#f1f5f9',textAlign:'center',color:'#cbd5e1'}}>—</td>;
                            const cell = cellMap[row]?.[col];
                            return (
                              <td key={col} style={{textAlign:'center',fontWeight:cell?600:400,color:cell?'#1e293b':'#e2e8f0'}}>
                                {cell ? fmtCell(cell) : ''}
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
            {actNames.length > 0 && (
              <div style={{marginBottom:'0.4rem'}}>
                <SortSelect s={sortProb} set={setSortProb} columns={[{col:'from',label:'From activity'}]}/>
              </div>
            )}
            {sortedBy(actNames, sortProb, n => n).map(src => {
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
        {false && activeTab === 'attributes' && (
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

              // Also show attrs discovered only in attribute_schema (no explicit type def)
              const defNames = new Set(attrDefs.map(a => a.name));
              const mergedAttrDefs = [
                ...attrDefs,
                ...Object.keys(schema)
                  .filter(n => !defNames.has(n))
                  .map(n => {
                    const v = schema[n];
                    const type = typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'float' : 'string';
                    return { name: n, type, _discovered: true };
                  }),
              ];

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
                  {mergedAttrDefs.length === 0 && (
                    <span className="timing-no-data">no attributes defined</span>
                  )}
                  {mergedAttrDefs.map(ad => (
                    <div key={ad.name} className="attr-row">
                      <span className="attr-name">{ad.name}</span>
                      <span className="attr-type" title={ad._discovered ? 'type inferred from discovered values' : undefined}>({ad.type}{ad._discovered ? ', discovered' : ''})</span>
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
        {false && activeTab === 'resources' && (
          <div>
            <p className="prob-hint">
              Permanent object types are <strong>permanently active</strong> and never deactivated — they
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
                        <span className="resource-badge">permanent</span>
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

            {/* ── Object lifecycle summary — derived from activities bindings ── */}
            {otNames.length > 0 && <ObjectLifecycleSummary otNames={otNames} activities={model.activities || []} resourceTypes={resourceTypes} />}
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
            <details style={{marginBottom:'0.75rem',border:'1px solid #e2e8f0',borderRadius:'6px',padding:'0.4rem 0.7rem',background:'#f8fafc'}}>
              <summary style={{cursor:'pointer',fontSize:'0.78rem',fontWeight:600,color:'#475569',userSelect:'none'}}>? Column legend</summary>
              <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:'0.15rem 0.75rem',marginTop:'0.4rem',fontSize:'0.75rem',color:'#475569'}}>
                <span style={{fontWeight:600}}>Distribution</span><span>Sampling shape used in simulation (lognormal, exponential, uniform)</span>
                <span style={{fontWeight:600}}>Mean</span><span>Simulation parameter μ — expected service duration in seconds</span>
                <span style={{fontWeight:600}}>Std</span><span>Simulation parameter σ — standard deviation of service duration</span>
                <span style={{fontWeight:600}}>Log Mean</span><span>Mean observed in the input event log (reference only)</span>
                <span style={{fontWeight:600}}>Log Std</span><span>Standard deviation observed in the log (reference only)</span>
                <span style={{fontWeight:600}}>Log Min / Max</span><span>Minimum and maximum observed in the log (reference bounds)</span>
              </div>
            </details>
            {actNames.length === 0 && <p className="empty-notice">No activities defined.</p>}
            {actNames.length > 0 && (
              <div style={{marginBottom:'0.4rem'}}>
                <SortSelect s={sortTime} set={setSortTime} columns={[
                  {col:'name',label:'Activity'},{col:'mean',label:'Mean (s)'},
                  {col:'std',label:'Std (s)'},{col:'logmean',label:'Log Mean'},
                ]}/>
              </div>
            )}
            {sortedBy(actNames, sortTime, (act, col) => {
              const td = timingData[act] || {};
              if (col==='name') return act;
              if (col==='mean') return td.mean_seconds??'';
              if (col==='std') return td.std_seconds??'';
              if (col==='logmean') return td.log_mean_seconds??'';
              return act;
            }).map(act => {
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
                        value={td.mean_seconds != null ? Math.round(td.mean_seconds) : ''}
                        placeholder="3600"
                        onChange={e => updateTiming(act, 'mean_seconds', e.target.value === '' ? null : parseFloat(e.target.value))} />
                    </label>
                    <label className="timing-field-label">
                      Std (s) <HelpTip text="Standard deviation of service duration in seconds. Not used for exponential or fixed." />
                      <input type="number" min={0} step={1} className="timing-num"
                        value={td.std_seconds != null ? Math.round(td.std_seconds) : ''}
                        placeholder="600"
                        onChange={e => updateTiming(act, 'std_seconds', e.target.value === '' ? null : parseFloat(e.target.value))} />
                    </label>
                    <label className="timing-field-label">
                      Min (s) <HelpTip text="Hard lower bound on sampled duration (clamp)." />
                      <input type="number" min={0} step={1} className="timing-num"
                        value={td.min_seconds != null ? Math.round(td.min_seconds) : ''}
                        placeholder="0"
                        onChange={e => updateTiming(act, 'min_seconds', e.target.value === '' ? null : parseFloat(e.target.value))} />
                    </label>
                    <label className="timing-field-label">
                      Max (s) <HelpTip text="Hard upper bound on sampled duration. Leave blank for no cap." />
                      <input type="number" min={0} step={1} className="timing-num"
                        value={td.max_seconds != null ? Math.round(td.max_seconds) : ''}
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

              // Topological sort: OCEL trace_position primary, constraint edges as structure, model order as tiebreaker
              const involvedNames = new Set(involvedActs.map(a => a.name));
              const modelOrder = activities.map(a => a.name);

              // Rank by OCEL trace position (avg position in log); fall back to model order index
              const ocelRank = (name) => {
                if (name in tracePosition) return tracePosition[name];
                return 1000 + modelOrder.indexOf(name);
              };

              const adj = {};
              const indegree = {};
              involvedActs.forEach(a => { adj[a.name] = []; indegree[a.name] = 0; });
              constraints.forEach(c => {
                if (!['precedence','chain_precedence'].includes(c.constraint_type)) return;
                if (!involvedNames.has(c.source_activity) || !involvedNames.has(c.target_activity)) return;
                if (!adj[c.source_activity].includes(c.target_activity)) {
                  adj[c.source_activity].push(c.target_activity);
                  indegree[c.target_activity]++;
                }
              });

              // Kahn's algorithm — ties broken by OCEL rank
              const byRank = (a, b) => ocelRank(a) - ocelRank(b);
              const queue = Object.keys(indegree).filter(n => indegree[n] === 0).sort(byRank);
              const sorted = [];
              while (queue.length > 0) {
                const node = queue.shift();
                sorted.push(node);
                adj[node].slice().sort(byRank).forEach(tgt => {
                  indegree[tgt]--;
                  if (indegree[tgt] === 0) {
                    const pos = queue.findIndex(n => byRank(n, tgt) > 0);
                    pos === -1 ? queue.push(tgt) : queue.splice(pos, 0, tgt);
                  }
                });
              }
              // Append any remaining (cycles) sorted by OCEL rank
              involvedActs
                .filter(a => !sorted.includes(a.name))
                .sort((a, b) => byRank(a.name, b.name))
                .forEach(a => sorted.push(a.name));

              // Pin creators first, deactivators last — preserve topo order within each group
              const creatorNames   = new Set(creatingActs.map(a => a.name));
              const deactivatorNames = new Set(deactivatingActs.map(a => a.name));
              const creators   = sorted.filter(n => creatorNames.has(n) && !deactivatorNames.has(n));
              const deactivators = sorted.filter(n => deactivatorNames.has(n) && !creatorNames.has(n));
              const middle     = sorted.filter(n => !creatorNames.has(n) && !deactivatorNames.has(n));
              const bothRoles  = sorted.filter(n => creatorNames.has(n) && deactivatorNames.has(n));
              const finalOrder = [...creators, ...bothRoles, ...middle, ...deactivators];

              const sortedInvolved = finalOrder.map(n => involvedActs.find(a => a.name === n)).filter(Boolean);

              // Derive edges from probMatrix
              const edges = [];
              sortedInvolved.forEach(a => {
                const row = probMatrix[a.name] || {};
                Object.entries(row).forEach(([tgt, prob]) => {
                  if (involvedNames.has(tgt) && prob > 0.001) {
                    edges.push({ from: a.name, to: tgt, prob });
                  }
                });
              });

              // Detect back-edges
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
                    <span style={{fontSize:'0.7rem',fontWeight:400,color:'#94a3b8',marginRight:'0.25rem'}}>Object:</span>
                    <span className="object-flow-type-name">{otype}</span>
                    {resourceTypes.includes(otype) && (
                      <span className="binding-resource-badge" style={{marginLeft:'0.4rem'}}>Immutable</span>
                    )}
                    <span className="object-flow-act-count">{sortedInvolved.length} activities</span>
                  </div>

                  <div style={{display:'flex',alignItems:'flex-start',gap:'0.5rem'}}>
                    <span style={{fontSize:'0.7rem',fontWeight:400,color:'#94a3b8',paddingTop:'0.55rem',whiteSpace:'nowrap',flexShrink:0}}>Object flow:</span>
                    <div className="object-flow-track">
                      {sortedInvolved.map((act, i) => {
                        const isCreating    = creatingActs.some(a => a.name === act.name);
                        const isDeactivating = deactivatingActs.some(a => a.name === act.name);
                        const outgoing = edges.filter(e => e.from === act.name);

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

