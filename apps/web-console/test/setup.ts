import '@testing-library/jest-dom/vitest';

// In-memory localStorage when jsdom does not expose one (needed by the auth module).
if (typeof globalThis.localStorage === 'undefined') {
  const mk = (): Storage => {
    const store = new Map<string, string>();
    return {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, String(v)),
      removeItem: (k) => void store.delete(k),
      clear: () => store.clear(),
      key: (i) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } as Storage;
  };
  globalThis.localStorage = mk();
  globalThis.sessionStorage = mk();
}
