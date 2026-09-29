import React from 'react';

export default function ObjectLifecycleWarning({ issues, label }) {
  if (!issues?.length) return null;
  const noCreate = issues.filter(issue => issue.missingCreate);
  const noDeactivate = issues.filter(issue => issue.missingDeactivate);
  const sameActivity = issues.filter(issue => issue.sameActivity.length > 0);
  const names = list => list.map(issue => issue.type).join(', ');
  return (
    <div role="status" aria-label={`Object lifecycle warnings${label ? ` — ${label}` : ''}`}>
      {label && <strong>{label}</strong>}
      {sameActivity.length > 0 && (
        <div className="object-lifecycle-warning">
          <div className="object-lifecycle-warning-title">⚠ Create and deactivate on the same activity</div>
          {sameActivity.map(issue => (
            <div className="object-lifecycle-warning-group" key={issue.type}>
              <strong>{issue.type}</strong>: {issue.sameActivity.join(', ')}.
            </div>
          ))}
          <div>Objects created by these activities are also deactivated when the activity finishes.
            This can be intentional for objects that participate in only one event.</div>
        </div>
      )}
      {noCreate.length > 0 && (
        <div className="object-lifecycle-warning">
          <div className="object-lifecycle-warning-title">⚠ Missing create flag</div>
          <div><strong>{names(noCreate)}</strong> — no activity creates objects of these types.
            Activities requiring them may be unable to run unless objects are already available.</div>
        </div>
      )}
      {noDeactivate.length > 0 && (
        <div className="object-lifecycle-warning">
          <strong>⚠ Missing deactivate flag:</strong> {names(noDeactivate)}
        </div>
      )}
    </div>
  );
}
