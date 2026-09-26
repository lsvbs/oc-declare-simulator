export function resolveStartActivityCaps(activities, overrides = {}, discovered = {}) {
  return Object.fromEntries(activities.map(activity => {
    const entered = overrides[activity];
    const value = entered == null || String(entered).trim() === '' ? discovered[activity] : entered;
    if (value == null) {
      throw new Error(`Enter a starting count for "${activity}"; no count was found in the log.`);
    }
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Starting count for "${activity}" must be a non-negative whole number.`);
    }
    return [activity, count];
  }));
}
