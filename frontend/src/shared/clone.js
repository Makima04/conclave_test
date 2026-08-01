export function clone(value) {
  if (value === undefined) return undefined;
  try {
    return window.structuredClone ? window.structuredClone(value) : JSON.parse(JSON.stringify(value));
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}
