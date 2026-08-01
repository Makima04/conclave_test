import { describe, it, expect, vi } from 'vitest';
import {
  createExtensionManager,
  normalizeManifest,
  isRemoteExtensionEntryAllowed,
} from './ExtensionManager.js';
import { createCapabilityCatalog } from '../capabilities/CapabilityCatalog.js';
import { createCapabilityRegistry } from '../capabilities/CapabilityRegistry.js';

describe('normalizeManifest', () => {
  it('accepts ST-style js field as entry and capabilities alias', () => {
    const record = normalizeManifest({
      display_name: 'Demo',
      loading_order: 3,
      js: 'index.js',
      capability_ids: ['ext.demo'],
      requiresReload: true,
    });
    expect(record.name).toBe('Demo');
    expect(record.entry).toBe('index.js');
    expect(record.loading_order).toBe(3);
    expect(record.capabilityIds).toEqual(['ext.demo']);
    expect(record.requiresReloadOnChange).toBe(true);
  });

  it('prefers name + entry over display_name + js', () => {
    const record = normalizeManifest({
      name: 'foo',
      display_name: 'Foo Display',
      entry: 'main.js',
      js: 'index.js',
      capabilities: ['ext.foo'],
    });
    expect(record.name).toBe('foo');
    expect(record.entry).toBe('main.js');
    expect(record.capabilityIds).toEqual(['ext.foo']);
  });
});

describe('ExtensionManager activate/deactivate', () => {
  it('activates a preloaded module and runs activate hook', async () => {
    const activate = vi.fn(async (ctx) => {
      ctx.registerTeardown(vi.fn());
    });
    const deactivate = vi.fn();
    const mgr = createExtensionManager({
      loadEntry: async () => {
        throw new Error('should not load when module preloaded');
      },
    });
    mgr.register(
      {
        name: 'hello',
        loading_order: 1,
        entry: 'hello.js',
        hooks: { activate: 'activate', deactivate: 'deactivate' },
      },
      { module: { activate, deactivate } }
    );

    const record = await mgr.activate('hello');
    expect(record.active).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0][0].name).toBe('hello');

    await mgr.deactivate('hello');
    expect(record.active).toBe(false);
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  it('loads entry via loadEntry when module not preloaded', async () => {
    const activate = vi.fn();
    const loadEntry = vi.fn(async (entry) => {
      expect(entry).toBe('./ext.js');
      return { activate };
    });
    const mgr = createExtensionManager({ loadEntry });
    mgr.register({ name: 'loaded', entry: './ext.js', loading_order: 5 });
    await mgr.activate('loaded');
    expect(loadEntry).toHaveBeenCalled();
    expect(activate).toHaveBeenCalled();
    expect(mgr.get('loaded').active).toBe(true);
  });

  it('activateAll respects loading_order', async () => {
    const order = [];
    const mgr = createExtensionManager();
    mgr.register(
      { name: 'late', loading_order: 20 },
      {
        module: {
          activate: () => {
            order.push('late');
          },
        },
      }
    );
    mgr.register(
      { name: 'early', loading_order: 1 },
      {
        module: {
          activate: () => {
            order.push('early');
          },
        },
      }
    );
    await mgr.activateAll();
    expect(order).toEqual(['early', 'late']);
  });

  it('deactivate with requiresReload sets marker', async () => {
    const mgr = createExtensionManager();
    mgr.register(
      { name: 'reload-me', loading_order: 1, requiresReload: true },
      { module: { activate: () => {}, deactivate: () => {} } }
    );
    await mgr.activate('reload-me');
    expect(mgr.getRequiresReload()).toBe(false);
    await mgr.deactivate('reload-me');
    expect(mgr.getRequiresReload()).toBe(true);
    mgr.clearRequiresReload();
    expect(mgr.getRequiresReload()).toBe(false);
  });

  it('runs registered teardowns on deactivate (LIFO)', async () => {
    const calls = [];
    const mgr = createExtensionManager();
    mgr.register(
      { name: 'td', loading_order: 1 },
      {
        module: {
          activate(ctx) {
            ctx.registerTeardown(() => {
              calls.push('a');
            });
            ctx.registerTeardown(() => {
              calls.push('b');
            });
          },
        },
      }
    );
    await mgr.activate('td');
    await mgr.deactivate('td');
    expect(calls).toEqual(['b', 'a']);
  });

  it('idempotent activate when already active', async () => {
    const activate = vi.fn();
    const mgr = createExtensionManager();
    mgr.register({ name: 'once', loading_order: 1 }, { module: { activate } });
    await mgr.activate('once');
    await mgr.activate('once');
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('throws on unknown extension activate', async () => {
    const mgr = createExtensionManager();
    await expect(mgr.activate('nope')).rejects.toThrow(/unknown extension/);
  });
});

describe('ExtensionManager + CapabilityRegistry integration', () => {
  it('registers declared capability ids on catalog and notes registry', async () => {
    const catalog = createCapabilityCatalog({ surfaces: {} });
    const registry = createCapabilityRegistry({ catalog, strict: false });
    const noteSpy = vi.spyOn(registry, 'noteExtensionCaps');

    const mgr = createExtensionManager({ catalog, registry });
    mgr.register(
      {
        name: 'cap-ext',
        loading_order: 1,
        capabilities: ['ext.cap-ext'],
      },
      {
        module: {
          activate() {},
          capabilities: [
            {
              id: 'ext.cap-ext',
              kind: 'extension',
              requiredByDefault: false,
              install: () => ({
                status: 'ready',
                detail: 'from module',
                providedGlobals: [],
              }),
            },
          ],
        },
      }
    );

    await mgr.activate('cap-ext');
    const desc = catalog.get('ext.cap-ext');
    expect(desc).toBeTruthy();
    expect(desc.kind).toBe('extension');
    expect(noteSpy).toHaveBeenCalledWith('cap-ext', 'ext.cap-ext', 'ready');
    expect(registry.getReport().byId['ext.cap-ext'].status).toBe('ready');
    expect(registry.getReport().installed).toContain('ext.cap-ext');

    await mgr.deactivate('cap-ext');
    expect(catalog.get('ext.cap-ext')).toBeUndefined();
  });

  it('auto-synthesizes descriptor when module only declares capability ids', async () => {
    const catalog = createCapabilityCatalog({ surfaces: {} });
    const mgr = createExtensionManager({ catalog });
    mgr.register(
      { name: 'auto', loading_order: 1, capabilities: ['ext.auto'] },
      { module: { activate() {} } }
    );
    await mgr.activate('auto');
    const desc = catalog.get('ext.auto');
    expect(desc).toBeTruthy();
    const result = await desc.install();
    expect(result.status).toBe('ready');
    expect(result.detail).toMatch(/extension:auto/);
  });

  it('synthesizes install() when module capabilities entry lacks install', async () => {
    const catalog = createCapabilityCatalog({ surfaces: {} });
    const mgr = createExtensionManager({ catalog });
    mgr.register(
      { name: 'partial', loading_order: 1, capabilities: ['ext.partial'] },
      {
        module: {
          activate() {},
          capabilities: [{ id: 'ext.partial' }], // no install()
        },
      }
    );
    await expect(mgr.activate('partial')).resolves.toMatchObject({ active: true });
    expect(typeof catalog.get('ext.partial').install).toBe('function');
  });

  it('clears registry soft-notes on deactivate', async () => {
    const catalog = createCapabilityCatalog({ surfaces: {} });
    const registry = createCapabilityRegistry({ catalog, strict: false });
    const mgr = createExtensionManager({ catalog, registry });
    mgr.register(
      { name: 'noted', loading_order: 1, capabilities: ['ext.noted'] },
      { module: { activate() {} } }
    );
    await mgr.activate('noted');
    expect(registry.getReport().installed).toContain('ext.noted');
    expect(registry.getReport().byId['ext.noted'].status).toBe('ready');

    await mgr.deactivate('noted');
    expect(registry.getReport().installed).not.toContain('ext.noted');
    expect(registry.getReport().byId['ext.noted']).toBeUndefined();
  });
});

describe('ExtensionManager security + lifecycle edges', () => {
  it('denies remote https entry by default (Issue 1)', async () => {
    const loadEntry = vi.fn(async () => ({ activate() {} }));
    const mgr = createExtensionManager({ loadEntry });
    mgr.register({
      name: 'remote-bad',
      loading_order: 1,
      entry: 'https://evil.example/ext.js',
    });
    await expect(mgr.activate('remote-bad')).rejects.toThrow(/remote entry denied/);
    expect(loadEntry).not.toHaveBeenCalled();
  });

  it('denies protocol-relative entry by default', async () => {
    const loadEntry = vi.fn(async () => ({ activate() {} }));
    const mgr = createExtensionManager({ loadEntry });
    mgr.register({ name: 'proto', loading_order: 1, entry: '//cdn.example/x.js' });
    await expect(mgr.activate('proto')).rejects.toThrow(/remote entry denied/);
    expect(loadEntry).not.toHaveBeenCalled();
  });

  it('allows remote entry when allowRemoteEntry is true', async () => {
    const loadEntry = vi.fn(async () => ({ activate() {} }));
    const mgr = createExtensionManager({ loadEntry, allowRemoteEntry: true });
    mgr.register({
      name: 'remote-ok',
      loading_order: 1,
      entry: 'https://trusted.example/ext.js',
    });
    await mgr.activate('remote-ok');
    expect(loadEntry).toHaveBeenCalledWith('https://trusted.example/ext.js', expect.any(Object));
    expect(mgr.get('remote-ok').active).toBe(true);
  });

  it('isRemoteExtensionEntryAllowed reads feature flag', () => {
    const store = {
      getItem: (k) => (k === 'conclave:feature:allow_remote_extension_entry' ? '1' : null),
    };
    expect(isRemoteExtensionEntryAllowed(store)).toBe(true);
    expect(isRemoteExtensionEntryAllowed({ getItem: () => null })).toBe(false);
  });

  it('does not clobber built-in seed caps on activate/deactivate (Issue 2)', async () => {
    const catalog = createCapabilityCatalog({ surfaces: {} });
    const seedBefore = catalog.get('st.context');
    expect(seedBefore).toBeTruthy();
    expect(catalog.isSeed('st.context')).toBe(true);

    const mgr = createExtensionManager({ catalog });
    mgr.register(
      {
        name: 'evil',
        loading_order: 1,
        capabilities: ['st.context', 'ext.evil'],
      },
      {
        module: {
          activate() {},
          capabilities: [
            {
              id: 'st.context',
              kind: 'extension',
              requiredByDefault: false,
              install: () => ({ status: 'ready', detail: 'clobber' }),
            },
          ],
        },
      }
    );

    await mgr.activate('evil');
    // Seed intact; only ext.evil registered.
    expect(catalog.get('st.context')).toBe(seedBefore);
    expect(catalog.get('st.context').kind).not.toBe('extension');
    expect(catalog.get('ext.evil')).toBeTruthy();

    await mgr.deactivate('evil');
    expect(catalog.get('st.context')).toBe(seedBefore);
    expect(catalog.get('ext.evil')).toBeUndefined();
  });

  it('catalog.register refuses seed overwrite directly', () => {
    const catalog = createCapabilityCatalog({ surfaces: {} });
    expect(() =>
      catalog.register({
        id: 'st.context',
        kind: 'extension',
        requiredByDefault: false,
        install: () => ({ status: 'ready' }),
      })
    ).toThrow(/cannot overwrite built-in/);
    expect(catalog.unregister('st.context')).toBe(false);
    expect(catalog.get('st.context')).toBeTruthy();
  });

  it('runs teardowns when activate hook fails after registerTeardown (Issue 3)', async () => {
    const calls = [];
    const mgr = createExtensionManager();
    mgr.register(
      { name: 'fail-act', loading_order: 1 },
      {
        module: {
          activate(ctx) {
            ctx.registerTeardown(() => {
              calls.push('td');
            });
            throw new Error('activate boom');
          },
        },
      }
    );

    await expect(mgr.activate('fail-act')).rejects.toThrow(/activate boom/);
    const record = mgr.get('fail-act');
    expect(record.active).toBe(false);
    expect(record.teardowns).toHaveLength(0);
    expect(calls).toEqual(['td']);
  });

  it('deactivateAll runs in reverse loading_order', async () => {
    const order = [];
    const mgr = createExtensionManager();
    mgr.register(
      { name: 'a', loading_order: 1 },
      {
        module: {
          activate() {},
          deactivate() {
            order.push('a');
          },
        },
      }
    );
    mgr.register(
      { name: 'b', loading_order: 10 },
      {
        module: {
          activate() {},
          deactivate() {
            order.push('b');
          },
        },
      }
    );
    await mgr.activateAll();
    await mgr.deactivateAll();
    expect(order).toEqual(['b', 'a']);
  });

  it('register throws when replacing an active extension', async () => {
    const mgr = createExtensionManager();
    mgr.register({ name: 'live', loading_order: 1 }, { module: { activate() {} } });
    await mgr.activate('live');
    expect(() =>
      mgr.register({ name: 'live', loading_order: 2 }, { module: { activate() {} } })
    ).toThrow(/cannot replace active/);
  });
});
