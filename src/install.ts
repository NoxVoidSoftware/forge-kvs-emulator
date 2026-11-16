/**
 * Connects an emulator to the real `@forge/kvs` package.
 *
 * `@forge/kvs` sends each request through `globalThis.__forge_fetch__` with a
 * `{ type: 'kvs' }` descriptor (the Forge runtime provides that function in
 * production). Installing the emulator puts a function there that answers KVS
 * requests and passes every other request type to whatever was installed
 * before, so `@forge/api` mocks keep working.
 *
 * The function is looked up on every call, so it does not matter whether
 * `@forge/kvs` was imported before or after installing.
 */

import { KvsEmulator, type KvsEmulatorOptions } from './emulator.js';

type ForgeFetch = (descriptor: { type?: string } | undefined, path: string, init?: unknown) => Promise<Response>;

interface ForgeGlobals {
  __forge_fetch__?: ForgeFetch;
  __forge_runtime__?: { kvs?: unknown };
}

export interface InstalledKvsEmulator {
  emulator: KvsEmulator;
  /** Restores the previous `__forge_fetch__`. */
  uninstall(): void;
}

/**
 * Installs an emulator (an existing one, or a new one from `options`) as the
 * KVS backend of `@forge/kvs`.
 */
export function installKvsEmulator(emulatorOrOptions: KvsEmulator | KvsEmulatorOptions = {}): InstalledKvsEmulator {
  const emulator = emulatorOrOptions instanceof KvsEmulator ? emulatorOrOptions : new KvsEmulator(emulatorOrOptions);
  const globals = globalThis as unknown as ForgeGlobals;
  const previous = globals.__forge_fetch__;

  const hook: ForgeFetch = (descriptor, path, init) => {
    if (descriptor?.type === 'kvs') return emulator.fetch(path, init as Parameters<KvsEmulator['fetch']>[1]);
    if (previous) return previous(descriptor, path, init);
    return Promise.reject(
      new Error(`forge-kvs-emulator: no handler for a "${descriptor?.type ?? 'unknown'}" request to ${path}`)
    );
  };
  globals.__forge_fetch__ = hook;

  return {
    emulator,
    uninstall() {
      if (globals.__forge_fetch__ === hook) {
        if (previous) globals.__forge_fetch__ = previous;
        else delete globals.__forge_fetch__;
      }
    }
  };
}

/** Test lifecycle hooks of any runner (Vitest, Jest, Mocha, node:test). */
export interface LifecycleHooks {
  beforeAll?: (fn: () => void | Promise<void>) => void;
  beforeEach: (fn: () => void | Promise<void>) => void;
  afterAll: (fn: () => void | Promise<void>) => void;
}

/**
 * Installs one emulator for a test file and empties it before each test.
 *
 * ```ts
 * import { beforeEach, afterAll } from 'vitest';
 * const kvsEmulator = useKvsEmulator({ manifestPath: 'manifest.yml' }, { beforeEach, afterAll });
 * ```
 */
export function useKvsEmulator(options: KvsEmulatorOptions, hooks: LifecycleHooks): KvsEmulator {
  const installed = installKvsEmulator(options);
  hooks.beforeEach(() => installed.emulator.reset());
  hooks.afterAll(() => installed.uninstall());
  return installed.emulator;
}
