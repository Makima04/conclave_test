import { describe, it, expect, vi } from 'vitest';
import { createExtensionManager, normalizeManifest } from './ExtensionManager.js';
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
});
