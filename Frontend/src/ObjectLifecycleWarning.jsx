import React from 'react';

function WarningBadge({ title, label, children }) {
  const id = React.useId();
  return (
    <div className="lifecycle-warning-badge">
      <button type="button" className="lifecycle-warning-trigger"
        aria-label={`${label ? `${label}: ` : ''}${title}`} aria-describedby={id}>
        <span aria-hidden="true">⚠</span><span className="lifecycle-warning-question" aria-hidden="true">?</span>
      </button>
      <div id={id} className="lifecycle-warning-popup" role="tooltip">
        <strong>{label ? `${label}: ` : ''}{title}</strong>
        {children}
      </div>
    </div>
  );
}

export default function ObjectLifecycleWarning({ issues, label }) {
  if (!issues?.length) return null;
  const noCreate = issues.filter(issue => issue.missingCreate);
  const noDeactivate = issues.filter(issue => issue.missingDeactivate);
  const sameActivity = issues.filter(issue => issue.sameActivity.length > 0);
  const names = list => list.map(issue => issue.type).join(', ');
  return (
    <div className="lifecycle-warning-badges" role="status" aria-label={`Object lifecycle warnings${label ? ` — ${label}` : ''}`}>
      {sameActivity.length > 0 && (
        <WarningBadge title="Create and deactivate on the same activity" label={label}>
          {sameActivity.map(issue => (
            <div key={issue.type}><strong>{issue.type}</strong>: {issue.sameActivity.join(', ')}.</div>
          ))}
          <div>Objects created by these activities are also deactivated when the activity finishes.
            This can be intentional for objects that participate in only one event.</div>
        </WarningBadge>
      )}
      {noCreate.length > 0 && (
        <WarningBadge title="Missing create flag" label={label}>
          <div><strong>{names(noCreate)}</strong> — no activity creates objects of these types.
            Activities requiring them may be unable to run unless objects are already available.</div>
        </WarningBadge>
      )}
      {noDeactivate.length > 0 && (
        <WarningBadge title="Missing deactivate flag" label={label}>
          <div>{names(noDeactivate)}</div>
        </WarningBadge>
      )}
    </div>
  );
}
