import React, { useEffect, useState } from 'react';
import axios from 'axios';
import './NotebookEvaluation.css';

const number = value => value == null ? 'Undefined' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
const percent = value => value == null ? 'Undefined' : `${(value * 100).toFixed(2)}%`;
const list = value => value?.length ? value.join(', ') : 'None';
const col = (key, label, format = number) => ({ key, label, format });
const textCol = (key, label) => col(key, label, v => v ?? '—');
const coverageLabels = {
  'Activity coverage': 'Activities', 'Object-type coverage': 'Object types',
  'Source-activation coverage': 'Source activations', 'Non-vacuous activation coverage': 'Non-vacuous activations',
  'Object-presence coverage': 'Object presence', 'Finite-boundary coverage': 'Finite boundaries',
  'Matching-event coverage': 'Matching events',
};

function Table({ rows = [], columns, label }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [rows]);
  const pages = Math.ceil(rows.length / 50);
  const current = Math.min(page, Math.max(0, pages - 1));
  if (!rows.length) return <p className="notebook-note">No observations to display.</p>;
  return <>
    <div className="notebook-table-scroll">
      <table aria-label={label}>
        <thead><tr>{columns.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>{rows.slice(current * 50, (current + 1) * 50).map((r, i) => <tr key={i}>
          {columns.map(c => <td key={c.key}>{c.format(r[c.key])}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
    {pages > 1 && <div className="notebook-pagination">
      <button disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button>
      <span>Page {current + 1} of {pages} · {rows.length} rows</span>
      <button disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Next</button>
    </div>}
  </>;
}

function Cards({ items }) {
  return <div className="notebook-cards">{items.map(([label, value, format = number]) =>
    <div className="notebook-card" key={label}><span>{label}</span><strong>{format(value)}</strong></div>
  )}</div>;
}

function Unavailable({ result }) {
  return <p className="notebook-notice" role="status">{result?.reason || 'This measure is unavailable for these inputs.'}</p>;
}

function Conformance({ result }) {
  if (result?.status !== 'ok') return <Unavailable result={result} />;
  const roles = ['input', 'simulated'].filter(role => result[role]);
  return <>
    <p className="notebook-note">Both logs are evaluated against the same loaded model. EF/EP count strictly later/earlier events. DF/DP count the nearest later/earlier events after filtering the full object scope; AS has no time restriction. Logs are treated as completed, as in the notebook.</p>
    <h3>OC-Declare confidence and constraint violations</h3>
    <Table label="Confidence and violations" rows={roles.map(role => ({ role, ...result[role].confidence, ...result[role].violations }))}
      columns={[textCol('role', 'Log'), col('global_confidence', 'Global confidence', percent),
        col('mean_constraint_confidence', 'Mean constraint confidence', percent),
        col('n_constraints_affected', 'Constraints with violations'), col('n_constraints', 'Total constraints'),
        col('constraint_violation_rate', 'Constraint violation rate', percent),
        col('activation_violation_rate', 'Activation violation rate', percent),
        col('event_violation_rate', 'Event violation rate', percent),
        col('n_activations', 'Activations'), col('n_violating_activations', 'Failed activations'),
        col('n_inactive_constraints', 'Inactive constraints'), col('n_vacuous_activations', 'Vacuous activations')]} />
    <p className="notebook-note">Constraint violation rate is the number of constraints with at least one failed activation divided by all model constraints. The notebook’s activation and event rates are also shown separately. Each failed event–constraint activation counts once, even if several object combinations fail. A constraint with no activations has undefined confidence.</p>
    {roles.map(role => <details key={role}>
      <summary>Per-constraint results · {role}</summary>
      <Table label={`${role} constraints`} rows={result[role].constraints}
        columns={[col('constraint_id', '#'), textCol('arc', 'Arrow'), textCol('activates_on', 'Activation'),
          textCol('counts_activity', 'Counted activity'), textCol('each', 'Each'), textCol('all', 'All'), textCol('any', 'Any'),
          col('nmin', 'Minimum'), col('nmax', 'Maximum', v => v == null ? 'Unbounded' : number(v)),
          col('n_activations', 'Activations'), col('n_satisfied', 'Satisfied'), col('n_violating', 'Violated'),
          col('n_vacuous_activations', 'Vacuous'), col('confidence', 'Confidence', percent), col('violation_rate', 'Violation rate', percent)]} />
    </details>)}
  </>;
}

function CoverageRadar({ result, roles, categories }) {
  const cx = 280, cy = 210, radius = 128;
  const point = (i, value, r = radius) => {
    const angle = -Math.PI / 2 + i * Math.PI * 2 / categories.length;
    return [cx + Math.cos(angle) * r * value, cy + Math.sin(angle) * r * value];
  };
  const colors = { input: '#4338ca', simulated: '#0f766e' };
  return <figure className="notebook-radar">
    <svg viewBox="0 0 560 410" role="img" aria-label="Coverage radar comparing input and simulated logs on seven axes from zero to one hundred percent">
      <title>Coverage of the loaded model</title>
      <desc>Each axis shows the same diagnostic value as the coverage table. Undefined values are omitted, leaving gaps.</desc>
      {[.25, .5, .75, 1].map(level => <g key={level}>
        <polygon points={categories.map((_, i) => point(i, level).join(',')).join(' ')} fill="none" stroke="#cbd5e1" />
        <text x={cx + 5} y={cy - radius * level + 12} fontSize="10" fill="#64748b">{level * 100}%</text>
      </g>)}
      {categories.map((category, i) => {
        const [x, y] = point(i, 1), [lx, ly] = point(i, 1, radius + 25);
        return <g key={category}>
          <line x1={cx} y1={cy} x2={x} y2={y} stroke="#cbd5e1" />
          <text x={lx} y={ly} dominantBaseline="middle" textAnchor={Math.abs(lx - cx) < 5 ? 'middle' : lx > cx ? 'start' : 'end'} fontSize="11" fill="#334155">{coverageLabels[category]}</text>
        </g>;
      })}
      {roles.map(role => {
        const values = categories.map(category => result[role].coverage[category]);
        const points = values.map((v, i) => v == null ? null : point(i, v));
        return <g key={role} stroke={colors[role]} fill={colors[role]}>
          {points.every(Boolean) && <polygon points={points.map(p => p.join(',')).join(' ')} fillOpacity=".07" stroke="none" />}
          {points.map((p, i) => {
            const next = points[(i + 1) % points.length];
            return p && <g key={categories[i]}>
              {next && <line x1={p[0]} y1={p[1]} x2={next[0]} y2={next[1]} strokeWidth="2" strokeDasharray={role === 'simulated' ? '5 3' : undefined} />}
              <circle cx={p[0]} cy={p[1]} r={role === 'input' ? 4 : 2.5}><title>{role}: {categories[i]} · {percent(values[i])}</title></circle>
            </g>;
          })}
        </g>;
      })}
      {roles.map((role, i) => <g key={role} transform={`translate(${180 + i * 125},390)`}>
        <line x1="0" x2="22" stroke={colors[role]} strokeWidth="3" strokeDasharray={role === 'simulated' ? '5 3' : undefined} />
        <text x="30" y="4" fontSize="12" fill="#334155">{role === 'input' ? 'Input' : 'Simulated'}</text>
      </g>)}
    </svg>
    <figcaption className="notebook-note">Scale: 0–100%. Undefined values leave gaps; they are not plotted as zero.</figcaption>
  </figure>;
}

function Coverage({ result }) {
  if (result?.status !== 'ok') return <Unavailable result={result} />;
  const roles = ['input', 'simulated'].filter(role => result[role]);
  const categories = Object.keys(coverageLabels);
  return <>
    <p className="notebook-note">Seven separate diagnostics describe which parts of the model were observed. The notebook does not combine these into an overall score. Coverage does not imply conformance.</p>
    <CoverageRadar result={result} roles={roles} categories={categories} />
    <Table label="Coverage diagnostics" rows={categories.map(category => ({ category, ...Object.fromEntries(roles.map(role => [role, result[role].coverage[category]])) }))}
      columns={[textCol('category', 'Coverage category'), ...roles.map(role => col(role, role === 'input' ? 'Input' : 'Simulated', percent))]} />
    {roles.map(role => <details key={role}>
      <summary>Coverage by constraint · {role}</summary>
      <Table label={`${role} coverage details`} rows={result[role].coverage_details}
        columns={[col('constraint_id', '#'), textCol('arc', 'Arrow'), textCol('source_activity', 'Activation'),
          textCol('target_activity', 'Counted activity'), col('n_activations', 'Activations'),
          col('n_nonvacuous_activations', 'Non-vacuous'), col('object_presence_coverage', 'Object presence', percent),
          col('finite_boundary_coverage', 'Finite boundaries', percent), col('matching_event_coverage', 'Matching events', percent),
          col('observed_counts', 'Observed counts', list)]} />
    </details>)}
  </>;
}

function Timing({ report }) {
  if (report.comparison?.status !== 'ok') return <Unavailable result={report.comparison} />;
  const timing = report.timing;
  if (timing?.status !== 'ok') return <Unavailable result={timing} />;
  const w = timing.wmape, d = timing.wasserstein;
  return <>
    <p className="notebook-note">These are estimates from event gaps, not measured processing durations. Both logs are rediscovered with the selected window. WMAPE compares shared activity means and population standard deviations without event-count weighting.</p>
    {w.status === 'ok' ? <>
      <Cards items={[[ 'WMAPE · mean', w.mean, percent], ['WMAPE · standard deviation', w.std, percent], ['Activities compared', w.activities_compared]]} />
      <p className="notebook-note">Only in input: {list(w.only_in_input)}. Only in simulation: {list(w.only_in_simulated)}.</p>
      <details><summary>Estimated times by activity</summary>
        <Table label="Service-time estimates" rows={w.details}
          columns={[textCol('activity', 'Activity'), col('mean_h_input', 'Input mean (h)'), col('mean_h_simulated', 'Simulated mean (h)'),
            col('std_h_input', 'Input std (h)'), col('std_h_simulated', 'Simulated std (h)'),
            textCol('source_input', 'Input source'), textCol('source_simulated', 'Simulated source'),
            col('n_selected_input', 'Input samples'), col('n_selected_simulated', 'Simulated samples')]} />
      </details>
    </> : <Unavailable result={w} />}
    <h3>Wasserstein-1</h3>
    <p className="notebook-note">Uses all samples retained by the discovery window, with no second filtering step. The weighted result uses input selected-sample counts. Anchored activities are excluded.</p>
    {d.status === 'ok' ? <>
      <Cards items={[[ 'Weighted W1 (hours)', d.W1_weighted_hours], ['Unweighted W1 (hours)', d.W1_unweighted_hours],
        ['Median W1 (hours)', d.W1_median_hours], ['Activities scored', d.activities_scored],
        ['Input sample coverage', d.input_selected_sample_coverage, percent], ['Simulated sample coverage', d.simulated_selected_sample_coverage, percent]]} />
      <Table label="Wasserstein distances" rows={d.details}
        columns={[textCol('activity', 'Activity'), col('W1_hours', 'W1 (h)'), col('W1_norm', 'W1 / input mean'),
          col('n_input', 'Input samples'), col('n_simulated', 'Simulated samples'), textCol('window', 'Window'),
          textCol('source_input', 'Input source'), textCol('source_simulated', 'Simulated source')]} />
      {d.excluded.length > 0 && <details><summary>Excluded activities ({d.excluded.length})</summary>
        <Table label="Excluded timing activities" rows={d.excluded} columns={[textCol('activity', 'Activity'), textCol('reason', 'Reason')]} />
      </details>}
    </> : <Unavailable result={d} />}
  </>;
}

function LogComparison({ report }) {
  if (report.comparison?.status !== 'ok') return <Unavailable result={report.comparison} />;
  const labels = { activities: 'Activities', objects: 'Object types · declared objects' };
  return <>
    <h3>KL divergence</h3>
    <p className="notebook-note">Additive smoothing α = 0.5 over the union of categories, in bits. Objects without events count in the object comparison.</p>
    {Object.entries(labels).map(([key, label]) => {
      const data = report.kl[key];
      return <section key={key}><h4>{label}</h4>{data.status === 'ok' ? <>
        <Cards items={[[ 'Input → simulated (bits)', data['KL_input||simulated_bits']], ['Simulated → input (bits)', data['KL_simulated||input_bits']]]} />
        <p className="notebook-note">Only in input: {list(data.only_in_input)}. Only in simulation: {list(data.only_in_simulated)}.</p>
        <details><summary>Counts and contributions</summary><Table label={`${label} KL details`} rows={data.details}
          columns={[textCol('category', 'Category'), col('count_input', 'Input count'), col('count_simulated', 'Simulated count'),
            col('p_input_smoothed', 'Input probability'), col('p_simulated_smoothed', 'Simulated probability'), col('contribution_bits', 'Contribution (bits)')]} /></details>
      </> : <Unavailable result={data} />}</section>;
    })}
    <h3>Relative n-gram distance</h3>
    <p className="notebook-note">Object traces are padded at both ends. Distance is half the absolute difference between separately normalized n-gram frequencies. Equal timestamps are ordered by event ID. Objects without events are excluded.</p>
    {report.ngd?.status === 'ok' ? <>
      <Cards items={[[ 'NGD · 2-gram', report.ngd.summary.NGD_2gram_relative], ['NGD · 3-gram', report.ngd.summary.NGD_3gram_relative]]} />
      <Table label="N-gram distances" rows={report.ngd.details}
        columns={[col('n', 'n'), textCol('scope', 'Scope'), col('object_type', 'Object type', v => v ?? 'All observed types'),
          col('NGD_relative', 'Relative NGD'), col('traces_input', 'Input traces'), col('traces_simulated', 'Simulated traces'),
          col('ngrams_input', 'Input n-grams'), col('ngrams_simulated', 'Simulated n-grams'), textCol('status', 'Status')]} />
      <details><summary>Trace diagnostics</summary><Table label="Trace diagnostics"
        rows={Object.entries(report.ngd.diagnostics).map(([role, data]) => ({ role, ...data }))}
        columns={[textCol('role', 'Log'), col('timelines_with_timestamp_ties', 'Timelines with ties'),
          col('repeated_attachments_removed', 'Repeated attachments removed'), col('unattached_events', 'Unattached events excluded'), col('unused_objects', 'Objects without events')]} /></details>
    </> : <Unavailable result={report.ngd} />}
  </>;
}

function RunEvaluation({ title, outputFile, inputFile, model, mode, anchors, revision, tab }) {
  const [state, setState] = useState({ loading: true });
  const requestKey = JSON.stringify({ outputFile, eventLogFile: inputFile || null, modelOverride: model, serviceTimeMode: mode, anchorActivities: anchors });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    axios.post('/api/evaluation/notebook', JSON.parse(requestKey), { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setState({ report: response.data }); })
      .catch(error => { if (!controller.signal.aborted) setState({ error: error.response?.data?.error || error.message }); });
    return () => controller.abort();
  }, [requestKey, revision]);
  const report = state.report;
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${outputFile.replace(/\.[^.]+$/, '')}_evaluation.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <article className="notebook-run">
    <div className="notebook-run-heading"><div><h3>{title}</h3><p>{outputFile}</p></div>
      {report && <button onClick={download}>Download results</button>}
    </div>
    {state.loading && <p role="status">Calculating measures from the complete saved logs…</p>}
    {state.error && <p className="notebook-error" role="alert">{state.error}</p>}
    {report && <>
      <p className="notebook-note">{report.logs.input && <>Input: {number(report.logs.input.events)} events, {number(report.logs.input.objects)} objects. </>}
        Simulated: {number(report.logs.simulated.events)} events, {number(report.logs.simulated.objects)} objects.</p>
      {tab === 'conformance' && <Conformance result={report.conformance} />}
      {tab === 'coverage' && <Coverage result={report.conformance} />}
      {tab === 'time' && <Timing report={report} />}
      {tab === 'log-comparison' && <LogComparison report={report} />}
    </>}
  </article>;
}

export default function NotebookEvaluation({ resultsAsIs, resultsToBe, results, activeModel, modelBase, modelAsIs, modelToBe,
  inputEventLogFile, eventLogFiles = [], onEventLogFileChange, evalRunCount = 0, onRerunEvaluation, enabled = true }) {
  const [tab, setTab] = useState('conformance');
  const [mode, setMode] = useState('p25');
  const [anchorText, setAnchorText] = useState('[]');
  const [anchors, setAnchors] = useState([]);
  const [anchorError, setAnchorError] = useState(null);
  const referenceRun = resultsAsIs || (!resultsToBe ? results : null);
  const applyAnchors = () => {
    try {
      const parsed = JSON.parse(anchorText);
      if (!Array.isArray(parsed) || parsed.some(a => !a || typeof a !== 'object' || typeof a.name !== 'string')) throw new Error('Enter a list of anchors, each with an activity name.');
      setAnchors(parsed); setAnchorError(null);
    } catch (error) { setAnchorError(error.message); }
  };
  if (!enabled) return null;
  return <div className="notebook-evaluation">
    <div className="notebook-heading"><div><h2>Evaluation</h2><p>Measures aligned with evaluationmeasures.ipynb</p></div>
      {onRerunEvaluation && <button onClick={onRerunEvaluation}>Re-run evaluation</button>}
    </div>
    <div className="notebook-controls">
      <label>Reference log<select value={inputEventLogFile || ''} onChange={e => onEventLogFileChange?.(e.target.value)}>
        <option value="">Select an input log</option>
        {[...new Set([inputEventLogFile, ...eventLogFiles].filter(Boolean))].map(file => <option key={file} value={file}>{file}</option>)}
      </select></label>
      <label>Timing window<select value={mode} onChange={e => setMode(e.target.value)}>
        <option value="minimum">Minimum · lowest sample</option><option value="p25">P25 · lowest 25%</option><option value="p50">P50 · lowest 50%</option><option value="mean">Full mean · all samples</option>
      </select></label>
    </div>
    <details className="notebook-anchor-settings"><summary>Optional timing anchors</summary>
      <p className="notebook-note">Use the same ANCHOR_ACTIVITIES list as the notebook. Applied equally to both logs; anchored activities are excluded from Wasserstein-1.</p>
      <textarea aria-label="Timing anchors" value={anchorText} onChange={e => setAnchorText(e.target.value)} rows={3} />
      <button onClick={applyAnchors}>Apply anchors</button>{anchorError && <p role="alert" className="notebook-error">{anchorError}</p>}
    </details>
    <nav aria-label="Evaluation measures">{[['conformance', 'Conformance'], ['coverage', 'Coverage'], ['time', 'Time'], ['log-comparison', 'Log comparison']].map(([key, label]) =>
      <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>
    )}</nav>
    <p className="notebook-note">Model measures support EF, EP, AS, DF and DP with direct Each/All/Any involvement and the model’s current bounds. Every measure uses the full saved input and output logs. Undefined values remain undefined.</p>
    {referenceRun?.output_file && <RunEvaluation title={resultsAsIs ? 'As-Is simulation' : 'Simulation'} outputFile={referenceRun.output_file}
      inputFile={inputEventLogFile} model={resultsAsIs ? (modelAsIs || modelBase || activeModel) : (activeModel || modelBase)} mode={mode} anchors={anchors} revision={evalRunCount} tab={tab} />}
    {resultsToBe?.output_file && <RunEvaluation title="To-Be simulation" outputFile={resultsToBe.output_file}
      inputFile={inputEventLogFile} model={modelToBe || activeModel || modelBase} mode={mode} anchors={anchors} revision={evalRunCount} tab={tab} />}
  </div>;
}
