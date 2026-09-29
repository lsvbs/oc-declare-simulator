import React, { useEffect, useId, useState } from 'react';
import axios from 'axios';
import './NotebookEvaluation.css';

const number = value => value == null ? 'Undefined' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
const percent = value => value == null ? 'Undefined' : `${(value * 100).toFixed(2)}%`;
const list = value => value?.length ? value.join(', ') : 'None';
const col = (key, label, format = number) => ({ key, label, format });
const textCol = (key, label) => col(key, label, v => v ?? '—');
const measureScales = {
  confidence: '0–100% · Higher means greater conformance.',
  coverageSummary: '0–7 axes fully covered · Not a conformance score.',
  coverage: '0–100% per axis · Higher means more coverage.',
  wmape: 'Closer to 0% = more similar means/std · Can exceed 100%.',
  wasserstein: 'Closer to 0 h = more similar timing distributions.',
  kl: 'Closer to 0 = more similar proportions · No fixed upper limit.',
  ngd: '0–1 · 0 = matching n-gram proportions; 1 = maximum difference.',
};
function MeasureScale({ measure }) {
  return <p className="notebook-measure-scale">{measureScales[measure]}</p>;
}
const coverageLabels = {
  'Activity coverage': 'Activities', 'Object-type coverage': 'Object types',
  'Source-activation coverage': 'Source activations', 'Non-vacuous activation coverage': 'Non-vacuous activations',
  'Object-presence coverage': 'Object presence', 'Finite-boundary coverage': 'Finite boundaries',
  'Matching-event coverage': 'Matching events',
};
const coverageDescriptions = {
  'Activity coverage': 'The share of model activities that appear in the log.',
  'Object-type coverage': 'The share of model object types with at least one object in the log.',
  'Source-activation coverage': 'The share of model constraints whose source activity occurs at least once in the log.',
  'Non-vacuous activation coverage': 'The share of model constraints with at least one source event where an object binding can actually be evaluated.',
  'Object-presence coverage': 'The average share of source events containing all referenced object types, across constraints activated in the log.',
  'Finite-boundary coverage': 'The average share of finite count bounds reached exactly, across constraints with evaluated object bindings.',
  'Matching-event coverage': 'The share of constraints requiring a match that have at least one observed matching event.',
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

function SummaryCard({ title, note, rows, scale }) {
  return <section className="notebook-summary-card" aria-label={title}>
    <h3>{title}</h3>
    {note && <p className="notebook-summary-note">{note}</p>}
    <dl>{rows.map(({ label, value, emphasis }) => <div key={label} className={`notebook-summary-value${emphasis ? ' is-emphasized' : ''}`}>
      <dt>{label}</dt><dd>{value}</dd>
    </div>)}</dl>
    {scale && <MeasureScale measure={scale} />}
  </section>;
}

function EvaluationSummary({ state, label }) {
  const { report, loading } = state;
  const modelScores = report?.conformance?.status === 'ok' ? report.conformance : null;
  const comparison = report?.comparison?.status === 'ok' ? report : null;
  const timing = comparison?.timing?.status === 'ok' ? comparison.timing : null;
  const wmape = timing?.wmape?.status === 'ok' ? timing.wmape : null;
  const wasserstein = timing?.wasserstein?.status === 'ok' ? timing.wasserstein : null;
  const ngd = comparison?.ngd?.status === 'ok' ? comparison.ngd.summary : null;
  const display = (value, format = number) => loading ? '…' : format(value);
  const fullCoverage = role => {
    const values = Object.keys(coverageLabels).map(category => modelScores?.[role]?.coverage?.[category]);
    if (!values.some(Number.isFinite)) return null;
    return `${values.filter(value => value === 1).length} / ${values.length}`;
  };
  return <section className="notebook-summary" aria-label={label ? `${label} evaluation summary` : 'Evaluation summary'} aria-busy={Boolean(loading)}>
    {label && <h3 className="notebook-summary-heading">{label}</h3>}
    <div className="notebook-summary-primary">
      <SummaryCard title="Global Confidence" scale="confidence" rows={[
        { label: 'Input', value: display(modelScores?.input?.confidence?.global_confidence, percent) },
        { label: 'Simulated', value: display(modelScores?.simulated?.confidence?.global_confidence, percent), emphasis: true },
      ]} />
      <SummaryCard title="Coverage" note="Axes at 100%" scale="coverageSummary" rows={['input', 'simulated'].map(role => ({
        label: role === 'input' ? 'Input' : 'Simulated',
        value: display(fullCoverage(role), value => value ?? 'Undefined'),
      }))} />
      <SummaryCard title="WMAPE" note="Simulated vs input" scale="wmape" rows={[
        { label: 'Mean', value: display(wmape?.mean, percent) },
        { label: 'Std', value: display(wmape?.std, percent) },
      ]} />
      <SummaryCard title="Wasserstein-1" scale="wasserstein" rows={[
        { label: 'Weighted W1', value: display(wasserstein?.W1_weighted_hours, value => value == null ? 'Undefined' : `${Number(value).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`), emphasis: true },
      ]} />
    </div>
    <div className="notebook-summary-comparison">
      {[['activities', 'events'], ['objects', 'objects']].map(([key, title]) => {
        const kl = comparison?.kl?.[key]?.status === 'ok' ? comparison.kl[key] : null;
        return <SummaryCard key={key} title={`KL divergence · ${title}`} note="Bits" scale="kl" rows={[
          { label: 'Input → simulated', value: display(kl?.['KL_input||simulated_bits']) },
          { label: 'Simulated → input', value: display(kl?.['KL_simulated||input_bits']) },
        ]} />;
      })}
      <SummaryCard title="NGD" scale="ngd" rows={[
        { label: '2-gram', value: display(ngd?.NGD_2gram_relative) },
        { label: '3-gram', value: display(ngd?.NGD_3gram_relative) },
      ]} />
    </div>
  </section>;
}

function Unavailable({ result }) {
  return <p className="notebook-notice" role="status">{result?.reason || 'This measure is unavailable for these inputs.'}</p>;
}

function Conformance({ result }) {
  if (result?.status !== 'ok') return <Unavailable result={result} />;
  const roles = ['input', 'simulated'].filter(role => result[role]);
  return <><MeasureScale measure="confidence" /><Table label="Global confidence" rows={roles.map(role => ({
    role: role === 'input' ? 'Input log' : 'Simulated log',
    global_confidence: result[role].confidence.global_confidence,
  }))} columns={[textCol('role', 'Log'), col('global_confidence', 'Global confidence', percent)]} /></>;
}

function CoverageRadar({ result, roles, categories }) {
  const [activeAxis, setActiveAxis] = useState(null);
  const tooltipId = useId();
  const cx = 280, cy = 210, radius = 128;
  const point = (i, value, r = radius) => {
    const angle = -Math.PI / 2 + i * Math.PI * 2 / categories.length;
    return [cx + Math.cos(angle) * r * value, cy + Math.sin(angle) * r * value];
  };
  const colors = { input: '#64748b', simulated: '#2563eb' };
  const tooltipPoint = activeAxis == null ? null : point(categories.indexOf(activeAxis), 1, radius + 25);
  return <figure className="notebook-radar">
    <div className="notebook-radar-plot">
    <svg viewBox="0 0 560 410" role="group" aria-label="Coverage radar comparing input and simulated logs on seven axes from zero to one hundred percent">
      <title>Coverage of the loaded model</title>
      <desc>Each axis shows the same diagnostic value as the coverage table. Undefined values are omitted, leaving gaps.</desc>
      {[.25, .5, .75, 1].map(level => <g key={level}>
        <polygon points={categories.map((_, i) => point(i, level).join(',')).join(' ')} fill="none" stroke="#cbd5e1" />
        <text x={cx + 5} y={cy - radius * level + 12} fontSize="10" fill="#64748b">{level * 100}%</text>
      </g>)}
      {categories.map((category, i) => {
        const [x, y] = point(i, 1), [lx, ly] = point(i, 1, radius + 25);
        return <g key={category} className="notebook-radar-axis" tabIndex={0} role="group"
          aria-label={category} aria-describedby={activeAxis === category ? tooltipId : undefined}
          onMouseEnter={() => setActiveAxis(category)} onMouseLeave={() => setActiveAxis(null)}
          onFocus={() => setActiveAxis(category)} onBlur={() => setActiveAxis(null)}
          onClick={() => setActiveAxis(category)}
          onKeyDown={event => { if (event.key === 'Escape') setActiveAxis(null); }}>
          <line x1={cx} y1={cy} x2={x} y2={y} stroke="transparent" strokeWidth="14" />
          <line x1={cx} y1={cy} x2={x} y2={y} stroke="#cbd5e1" />
          <text x={lx} y={ly} pointerEvents="bounding-box" dominantBaseline="middle" textAnchor={Math.abs(lx - cx) < 5 ? 'middle' : lx > cx ? 'start' : 'end'} fontSize="11" fill="#334155">{coverageLabels[category]}</text>
        </g>;
      })}
      {roles.map(role => {
        const values = categories.map(category => result[role].coverage[category]);
        const points = values.map((v, i) => v == null ? null : point(i, v));
        return <g key={role} stroke={colors[role]} fill={colors[role]}>
          {points.every(Boolean) && <polygon points={points.map(p => p.join(',')).join(' ')} fillOpacity=".07" stroke="none" pointerEvents="none" />}
          {points.map((p, i) => {
            const next = points[(i + 1) % points.length];
            return p && <g key={categories[i]}>
              {next && <line x1={p[0]} y1={p[1]} x2={next[0]} y2={next[1]} strokeWidth="2" strokeDasharray={role === 'input' ? '5 3' : undefined} pointerEvents="none" />}
              <circle cx={p[0]} cy={p[1]} r={role === 'input' ? 4 : 2.5}><title>{role}: {categories[i]} · {percent(values[i])}</title></circle>
            </g>;
          })}
        </g>;
      })}
      {roles.map((role, i) => <g key={role} transform={`translate(${180 + i * 125},390)`}>
        <line x1="0" x2="22" stroke={colors[role]} strokeWidth="3" strokeDasharray={role === 'input' ? '5 3' : undefined} />
        <text x="30" y="4" fontSize="12" fill="#334155">{role === 'input' ? 'Input' : 'Simulated'}</text>
      </g>)}
    </svg>
    {tooltipPoint && <div id={tooltipId} role="tooltip" className="notebook-radar-tooltip" style={{
      left: `clamp(8px, calc(${tooltipPoint[0] / 560 * 100}% - 130px), max(8px, calc(100% - 268px)))`,
      top: `${tooltipPoint[1] / 410 * 100}%`,
      transform: tooltipPoint[1] > cy ? 'translateY(calc(-100% - 12px))' : 'translateY(12px)',
    }}><strong>{coverageLabels[activeAxis]}</strong>{coverageDescriptions[activeAxis]}</div>}
    </div>
    <figcaption className="notebook-note">Scale: 0–100%. Hover over or focus an axis for its meaning. Undefined values leave gaps; they are not plotted as zero.</figcaption>
  </figure>;
}

function Coverage({ result }) {
  if (result?.status !== 'ok') return <Unavailable result={result} />;
  const roles = ['input', 'simulated'].filter(role => result[role]);
  const categories = Object.keys(coverageLabels);
  return <>
    <p className="notebook-note">Seven separate diagnostics describe which parts of the model were observed. The notebook does not combine these into an overall score. Coverage does not imply conformance.</p>
    <CoverageRadar result={result} roles={roles} categories={categories} />
    <MeasureScale measure="coverage" />
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
    {w.status === 'ok' ? <>
      <Cards items={[[ 'WMAPE · mean', w.mean, percent], ['WMAPE · standard deviation', w.std, percent], ['Activities compared', w.activities_compared]]} />
      <MeasureScale measure="wmape" />
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
    {d.status === 'ok' ? <>
      <Cards items={[[ 'Weighted W1 (hours)', d.W1_weighted_hours], ['Unweighted W1 (hours)', d.W1_unweighted_hours],
        ['Median W1 (hours)', d.W1_median_hours], ['Activities scored', d.activities_scored],
        ['Input sample coverage', d.input_selected_sample_coverage, percent], ['Simulated sample coverage', d.simulated_selected_sample_coverage, percent]]} />
      <MeasureScale measure="wasserstein" />
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
    <MeasureScale measure="kl" />
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
    <h3>NGD</h3>
    <p className="notebook-note">Relative n-gram distance. Objects without events are excluded.</p>
    {report.ngd?.status === 'ok' ? <>
      <Cards items={[[ 'NGD · 2-gram', report.ngd.summary.NGD_2gram_relative], ['NGD · 3-gram', report.ngd.summary.NGD_3gram_relative]]} />
      <MeasureScale measure="ngd" />
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

function useEvaluationReport({ outputFile, inputFile, model, mode, revision, enabled }) {
  const [state, setState] = useState({});
  const requestKey = enabled && outputFile
    ? JSON.stringify({ outputFile, eventLogFile: inputFile || null, modelOverride: model, serviceTimeMode: mode, anchorActivities: [] })
    : null;
  useEffect(() => {
    if (!requestKey) return;
    const controller = new AbortController();
    setState({ requestKey, revision, loading: true });
    axios.post('/api/evaluation/notebook', JSON.parse(requestKey), { signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setState({ requestKey, revision, report: response.data }); })
      .catch(error => { if (!controller.signal.aborted) setState({ requestKey, revision, error: error.response?.data?.error || error.message }); });
    return () => controller.abort();
  }, [requestKey, revision]);
  if (!requestKey) return {};
  return state.requestKey === requestKey && state.revision === revision ? state : { loading: true };
}

function RunEvaluation({ title, outputFile, state, tab }) {
  const report = state.report;
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${outputFile.replace(/\.[^.]+$/, '')}_evaluation.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <article className="notebook-run" aria-label={title}>
    <div className="notebook-run-heading"><h3>{outputFile}</h3>
      {report && <button onClick={download}>Download results</button>}
    </div>
    {state.loading && <p role="status">Calculating measures from the complete saved logs…</p>}
    {state.error && <p className="notebook-error" role="alert">{state.error}</p>}
    {report && <>
      <div className="notebook-log-counts">
        {report.logs.input && <p><strong>Input:</strong> {number(report.logs.input.events)} events · {number(report.logs.input.objects)} objects</p>}
        <p><strong>Simulated:</strong> {number(report.logs.simulated.events)} events · {number(report.logs.simulated.objects)} objects</p>
      </div>
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
  const referenceRun = resultsAsIs || (!resultsToBe ? results : null);
  const referenceState = useEvaluationReport({
    outputFile: referenceRun?.output_file, inputFile: inputEventLogFile,
    model: resultsAsIs ? (modelAsIs || modelBase || activeModel) : (activeModel || modelBase),
    mode, revision: evalRunCount, enabled,
  });
  const alternativeState = useEvaluationReport({
    outputFile: resultsToBe?.output_file, inputFile: inputEventLogFile,
    model: modelToBe || activeModel || modelBase, mode, revision: evalRunCount, enabled,
  });
  const showRunLabels = Boolean(referenceRun?.output_file && resultsToBe?.output_file);
  if (!enabled) return null;
  return <div className="notebook-evaluation">
    <div className="notebook-heading"><div><h2>Evaluation</h2><p>Measures aligned with evaluationmeasures.ipynb</p></div>
      {onRerunEvaluation && <button onClick={onRerunEvaluation}>Re-run evaluation</button>}
    </div>
    {referenceRun?.output_file && <EvaluationSummary state={referenceState} label={showRunLabels ? 'Base Model' : undefined} />}
    {resultsToBe?.output_file && <EvaluationSummary state={alternativeState} label={showRunLabels ? 'Alternative Model' : undefined} />}
    <div className="notebook-controls">
      <label>Reference log<select value={inputEventLogFile || ''} onChange={e => onEventLogFileChange?.(e.target.value)}>
        <option value="">Select an input log</option>
        {[...new Set([inputEventLogFile, ...eventLogFiles].filter(Boolean))].map(file => <option key={file} value={file}>{file}</option>)}
      </select></label>
      <label>Timing window<select value={mode} onChange={e => setMode(e.target.value)}>
        <option value="minimum">Minimum · lowest sample</option><option value="p25">P25 · lowest 25%</option><option value="p50">P50 · lowest 50%</option><option value="mean">Full mean · all samples</option>
      </select></label>
    </div>
    <nav aria-label="Evaluation measures">{[['conformance', 'Conformance'], ['coverage', 'Coverage'], ['time', 'Time'], ['log-comparison', 'Log comparison']].map(([key, label]) =>
      <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>
    )}</nav>
    <p className="notebook-note">{tab === 'conformance'
      ? 'Global Confidence measures as defined by Küsters & van der Aalst (2025).'
      : tab === 'coverage' ? 'Self defined coverage measures'
        : tab === 'time' ? 'Timing measures on the discovered time distributions of both input and simulated event log'
          : 'Log comparison using KL divergence (Kullback & Leibler, 1951; Camargo et al., 2020) and NGD (Chapela-Campa et al., 2024).'}</p>
    {referenceRun?.output_file && <RunEvaluation title={resultsAsIs ? 'As-Is simulation' : 'Simulation'} outputFile={referenceRun.output_file}
      state={referenceState} tab={tab} />}
    {resultsToBe?.output_file && <RunEvaluation title="To-Be simulation" outputFile={resultsToBe.output_file}
      state={alternativeState} tab={tab} />}
  </div>;
}
