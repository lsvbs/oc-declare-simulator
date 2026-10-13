export function logStopDefaults(config, log) {
  const unitSeconds = {seconds: 1, minutes: 60, hours: 3600, days: 86400, weeks: 604800};
  return {
    ...config,
    maxSteps: log?.total_events ?? '',
    maxSimTimeValue: log?.ocel_time_span_s == null ? ''
      : log.ocel_time_span_s / (unitSeconds[config.maxSimTimeUnit] ?? 86400),
  };
}

export function logStartCaps(activities, counts) {
  return Object.fromEntries(activities.filter(a => counts?.[a] != null).map(a => [a, counts[a]]));
}
