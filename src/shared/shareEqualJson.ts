/**
 * Retain unchanged subtrees when publishing a freshly read JSON projection.
 * Inputs are acyclic JSON-shaped DTOs (including optional undefined fields),
 * never class instances or mutable application state. Neither input is mutated.
 */
export function shareEqualJson<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(previous) !== Array.isArray(next)) return next;

  if (Array.isArray(next)) {
    const before = previous as unknown[];
    let equal = before.length === next.length;
    const shared = next.map((value, index) => {
      const retained = shareEqualJson(before[index], value);
      if (!Object.is(retained, before[index])) equal = false;
      return retained;
    });
    return (equal ? previous : shared) as T;
  }

  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let equal = Object.keys(before).length === keys.length;
  const shared = Object.fromEntries(keys.map(key => {
    const retained = shareEqualJson(before[key], after[key]);
    if (!Object.hasOwn(before, key) || !Object.is(retained, before[key])) equal = false;
    return [key, retained];
  }));
  return (equal ? previous : shared) as T;
}
