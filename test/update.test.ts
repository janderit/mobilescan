// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { UpdateService, isNewerBuild, parseBuildInfo } from '../src/update';

const current = { version: '0.6.0', build: 'abc1234' };

function response(body: unknown, ok = true): Response {
  return { ok, json: () => Promise.resolve(body) } as unknown as Response;
}

function service(overrides: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  return new UpdateService({
    current,
    url: '/app/version.json',
    fetch: vi.fn(() => Promise.resolve(response({ version: '0.7.0', build: 'def5678' }))),
    isOnline: () => true,
    serviceWorker: null,
    reload: vi.fn(),
    timeoutMs: 50,
    ...overrides,
  });
}

describe('parseBuildInfo / isNewerBuild', () => {
  it('accepts only objects with string version and build', () => {
    expect(parseBuildInfo({ version: '1', build: 'a' })).toEqual({ version: '1', build: 'a' });
    expect(parseBuildInfo({ version: 1, build: 'a' })).toBeNull();
    expect(parseBuildInfo('nope')).toBeNull();
    expect(parseBuildInfo(null)).toBeNull();
  });

  it('treats any difference in version or build as newer', () => {
    expect(isNewerBuild(current, current)).toBe(false);
    expect(isNewerBuild(current, { ...current, build: 'zzz' })).toBe(true);
    expect(isNewerBuild(current, { ...current, version: '0.6.1' })).toBe(true);
  });
});

describe('UpdateService.check', () => {
  it('reports an update when the server build differs', async () => {
    const fetch = vi.fn(() => Promise.resolve(response({ version: '0.7.0', build: 'def5678' })));
    await expect(service({ fetch }).check()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith('/app/version.json', { cache: 'no-store' });
  });

  it('reports nothing for the running build', async () => {
    const fetch = vi.fn(() => Promise.resolve(response(current)));
    await expect(service({ fetch }).check()).resolves.toBe(false);
  });

  it('does not touch the network while offline', async () => {
    const fetch = vi.fn();
    await expect(service({ fetch, isOnline: () => false }).check()).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats network errors, error responses and bad payloads as no update', async () => {
    await expect(service({ fetch: vi.fn(() => Promise.reject(new Error('down'))) }).check()).resolves.toBe(false);
    await expect(service({ fetch: vi.fn(() => Promise.resolve(response({}, false))) }).check()).resolves.toBe(false);
    await expect(service({ fetch: vi.fn(() => Promise.resolve(response({ version: 1 }))) }).check()).resolves.toBe(
      false,
    );
    const badJson = { ok: true, json: () => Promise.reject(new SyntaxError('bad')) } as unknown as Response;
    await expect(service({ fetch: vi.fn(() => Promise.resolve(badJson)) }).check()).resolves.toBe(false);
  });
});

/** Minimal service worker container + registration double. */
function fakeServiceWorker() {
  const container = new EventTarget() as ServiceWorkerContainer;
  const registration = new EventTarget() as ServiceWorkerRegistration & {
    waiting: ServiceWorker | null;
    installing: ServiceWorker | null;
  };
  registration.waiting = null;
  registration.installing = null;
  const update = vi.fn(() => Promise.resolve(registration));
  Object.assign(registration, { update });
  Object.assign(container, { getRegistration: () => Promise.resolve(registration) });
  const worker = (state: ServiceWorkerState) => {
    const w = new EventTarget() as ServiceWorker & { state: ServiceWorkerState };
    w.state = state;
    Object.assign(w, { postMessage: vi.fn() });
    return w;
  };
  const takeOver = () => container.dispatchEvent(new Event('controllerchange'));
  return { container, registration, update, worker, takeOver };
}

describe('UpdateService.apply', () => {
  it('reloads immediately without a service worker', async () => {
    const reload = vi.fn();
    await service({ reload, serviceWorker: null }).apply();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('tells an already waiting worker to skip waiting and reloads once it took over', async () => {
    const sw = fakeServiceWorker();
    const waiting = sw.worker('installed');
    sw.registration.waiting = waiting;
    const reload = vi.fn();
    const done = service({ reload, serviceWorker: sw.container }).apply();
    await Promise.resolve();
    await Promise.resolve();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();
    sw.takeOver();
    await done;
    expect(reload).toHaveBeenCalledOnce();
  });

  it('waits for a freshly found worker to install before activating it', async () => {
    const sw = fakeServiceWorker();
    const reload = vi.fn();
    const done = service({ reload, serviceWorker: sw.container }).apply();
    await Promise.resolve();
    await Promise.resolve();
    expect(sw.update).toHaveBeenCalledOnce();
    const installing = sw.worker('installing');
    sw.registration.installing = installing;
    sw.registration.dispatchEvent(new Event('updatefound'));
    expect(installing.postMessage).not.toHaveBeenCalled();
    installing.state = 'installed';
    installing.dispatchEvent(new Event('statechange'));
    expect(installing.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    sw.takeOver();
    await done;
    expect(reload).toHaveBeenCalledOnce();
  });

  it('falls back to a plain reload when no new worker shows up in time', async () => {
    const sw = fakeServiceWorker();
    const reload = vi.fn();
    await service({ reload, serviceWorker: sw.container, timeoutMs: 10 }).apply();
    expect(reload).toHaveBeenCalledOnce();
  });
});
