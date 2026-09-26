import React from 'react';

export default function RecentEventLog({ events, total }) {
  if (!Array.isArray(events)) {
    return <p className="recent-event-note">Run the simulation again to see its last 10 events.</p>;
  }
  if (events.length === 0) {
    return <p className="recent-event-note">No events completed in this run.</p>;
  }
  const traces = new Map();
  events.forEach(event => {
    event.objects.forEach(object => {
      if (!traces.has(object.object_id)) traces.set(object.object_id, { ...object, events: [] });
      traces.get(object.object_id).events.push(event);
    });
  });
  return (
    <div className="recent-event-log">
      <p className="recent-event-note">
        Last {events.length} of {total ?? events.length} completed events, in completion order.
        Timestamps are shown as recorded. Every participating object is listed.
      </p>
      <div className="recent-event-scroll" tabIndex={0} role="region" aria-label="Last completed events">
        <table className="recent-event-table">
          <thead><tr><th scope="col">Event</th><th scope="col">Timestamp</th><th scope="col">Activity</th><th scope="col">Objects involved</th></tr></thead>
          <tbody>
            {events.map(event => (
              <tr key={event.event_id}>
                <td><strong>#{event.sequence}</strong><br /><code>{event.event_id}</code></td>
                <td className="recent-event-time"><time dateTime={event.timestamp || undefined}>{event.timestamp?.replace('T', '\n') || 'Not recorded'}</time></td>
                <td>{event.activity}</td>
                <td>
                  {event.objects.length === 0 ? 'No objects' : (
                    <ul className="recent-event-objects">
                      {event.objects.map(object => (
                        <li key={object.object_id}>
                          <span>{object.object_type || 'Unknown type'}</span>: <code>{object.object_id}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {traces.size > 0 && (
        <details className="recent-object-traces">
          <summary>Traces by object within these events ({traces.size})</summary>
          <p className="recent-event-note">Only activity occurrences within the last {events.length} events are shown here.</p>
          <ul>
            {[...traces.values()].map(object => (
              <li key={object.object_id}>
                <div><strong>{object.object_type || 'Unknown type'}</strong>: <code>{object.object_id}</code></div>
                <div className="recent-object-sequence">
                  {object.events.map((event, index) => (
                    <React.Fragment key={event.event_id}>
                      {index > 0 && <span aria-hidden="true"> → </span>}
                      <span title={`${event.event_id} · ${event.timestamp || 'Time not recorded'}`}>
                        #{event.sequence} {event.activity}
                      </span>
                    </React.Fragment>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
