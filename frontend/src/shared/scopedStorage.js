export function scopedLocalStorageKeys(prefix) {
  const keys = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

export function createScopedLocalStorage(namespace) {
  const prefix = `${namespace}localStorage:`;
  const storage = {
    get length() {
      return scopedLocalStorageKeys(prefix).length;
    },
    key(index) {
      return scopedLocalStorageKeys(prefix)[Number(index)]?.slice(prefix.length) ?? null;
    },
    getItem(key) {
      return window.localStorage.getItem(prefix + String(key));
    },
    setItem(key, value) {
      window.localStorage.setItem(prefix + String(key), String(value));
    },
    removeItem(key) {
      window.localStorage.removeItem(prefix + String(key));
    },
    clear() {
      scopedLocalStorageKeys(prefix).forEach(key => window.localStorage.removeItem(key));
    },
  };

  return new Proxy(storage, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property === 'string') return target.getItem(property);
      return undefined;
    },
    set(target, property, value) {
      if (typeof property !== 'string') return false;
      target.setItem(property, value);
      return true;
    },
    deleteProperty(target, property) {
      if (typeof property !== 'string') return false;
      target.removeItem(property);
      return true;
    },
  });
}

export function createScopedIndexedDB(namespace) {
  const prefix = `${namespace}indexedDB:`;
  return {
    open(name, version) {
      return window.indexedDB.open(prefix + String(name), version);
    },
    deleteDatabase(name) {
      return window.indexedDB.deleteDatabase(prefix + String(name));
    },
    cmp(first, second) {
      return window.indexedDB.cmp(first, second);
    },
    databases: window.indexedDB.databases
      ? () => window.indexedDB.databases()
      : undefined,
  };
}
