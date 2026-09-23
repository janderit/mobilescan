// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app';
import { InstallPrompt, browserInstallEnvironment, type BeforeInstallPromptEvent, type InstallEnvironment } from '../src/install';

vi.mock('../src/camera', async () => {
  const actual = await vi.importActual<typeof import('../src/camera')>('../src/camera');
  return { ...actual, startCamera: vi.fn(), stopCamera: vi.fn() };
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake window: listeners are kept so the test can fire the install events. */
function fakeEnvironment(overrides: Partial<InstallEnvironment> = {}) {
  const listeners = new Map<string, (event: Event) => void>();
  const env: InstallEnvironment = {
    isStandalone: () => false,
    isIOS: () => false,
    addEventListener: (type, listener, options) => {
      listeners.set(type, listener);
      options?.signal?.addEventListener('abort', () => listeners.delete(type));
    },
    ...overrides,
  };
  return { env, fire: (type: string, event: Event) => listeners.get(type)?.(event) };
}

function installEvent(outcome: 'accepted' | 'dismissed' = 'accepted'): BeforeInstallPromptEvent {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent;
  event.prompt = vi.fn(() => Promise.resolve());
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

describe('InstallPrompt', () => {
  it('offers nothing while the app runs installed', () => {
    const { env, fire } = fakeEnvironment({ isStandalone: () => true, isIOS: () => true });
    const prompt = new InstallPrompt(env, () => {});
    expect(prompt.mode).toBe('none');
    fire('beforeinstallprompt', installEvent());
    expect(prompt.mode).toBe('none');
  });

  it('offers the native prompt once the browser has fired beforeinstallprompt', async () => {
    const { env, fire } = fakeEnvironment();
    const onChange = vi.fn();
    const prompt = new InstallPrompt(env, onChange);
    expect(prompt.mode).toBe('none');
    const event = installEvent();
    fire('beforeinstallprompt', event);
    expect(event.defaultPrevented).toBe(true);
    expect(prompt.mode).toBe('native');
    expect(onChange).toHaveBeenCalledTimes(1);

    await expect(prompt.prompt()).resolves.toBe(true);
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(prompt.mode).toBe('none');
  });

  it('hides the button after a dismissed prompt until the browser fires again', async () => {
    const { env, fire } = fakeEnvironment();
    const prompt = new InstallPrompt(env, () => {});
    fire('beforeinstallprompt', installEvent('dismissed'));
    await expect(prompt.prompt()).resolves.toBe(false);
    expect(prompt.mode).toBe('none');
    fire('beforeinstallprompt', installEvent());
    expect(prompt.mode).toBe('native');
  });

  it('treats a prompt that throws as dismissed', async () => {
    const { env, fire } = fakeEnvironment();
    const prompt = new InstallPrompt(env, () => {});
    const event = installEvent();
    event.prompt = vi.fn(() => Promise.reject(new Error('already used')));
    fire('beforeinstallprompt', event);
    await expect(prompt.prompt()).resolves.toBe(false);
    expect(prompt.mode).toBe('none');
  });

  it('offers the manual route on iOS and stops after appinstalled', () => {
    const { env, fire } = fakeEnvironment({ isIOS: () => true });
    const prompt = new InstallPrompt(env, () => {});
    expect(prompt.mode).toBe('manual');
    fire('appinstalled', new Event('appinstalled'));
    expect(prompt.mode).toBe('none');
  });

  it('prefers the native prompt over the manual route when both exist', () => {
    const { env, fire } = fakeEnvironment({ isIOS: () => true });
    const prompt = new InstallPrompt(env, () => {});
    fire('beforeinstallprompt', installEvent());
    expect(prompt.mode).toBe('native');
  });
});

describe('browserInstallEnvironment', () => {
  function fakeWindow(navigator: Partial<Navigator & { standalone?: boolean }>, standaloneMedia = false): Window {
    return {
      navigator: { userAgent: '', platform: '', maxTouchPoints: 0, ...navigator },
      matchMedia: (query: string) => ({ matches: standaloneMedia && query === '(display-mode: standalone)' }),
      addEventListener: () => {},
    } as unknown as Window;
  }

  it('reads standalone from the display mode or the iOS navigator flag', () => {
    expect(browserInstallEnvironment(fakeWindow({})).isStandalone()).toBe(false);
    expect(browserInstallEnvironment(fakeWindow({}, true)).isStandalone()).toBe(true);
    expect(browserInstallEnvironment(fakeWindow({ standalone: true })).isStandalone()).toBe(true);
  });

  it('recognises iPhones, iPads and iPadOS posing as a Mac with touch', () => {
    expect(browserInstallEnvironment(fakeWindow({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })).isIOS()).toBe(true);
    expect(browserInstallEnvironment(fakeWindow({ platform: 'MacIntel', maxTouchPoints: 5 })).isIOS()).toBe(true);
    expect(browserInstallEnvironment(fakeWindow({ platform: 'MacIntel', maxTouchPoints: 0 })).isIOS()).toBe(false);
    expect(browserInstallEnvironment(fakeWindow({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' })).isIOS()).toBe(false);
  });
});

describe('App install button', () => {
  let root: HTMLElement;
  let app: App | null = null;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.append(root);
  });

  afterEach(() => {
    app?.dispose();
    app = null;
    root.remove();
    vi.clearAllMocks();
  });

  const installButton = () => root.querySelector<HTMLButtonElement>('button[aria-label="App installieren"]')!;
  const help = () => root.querySelector<HTMLElement>('.install-help')!;

  it('stays hidden without an install environment', () => {
    app = new App(root, { version: '0', build: 'test' });
    expect(installButton().hidden).toBe(true);
  });

  it('appears with beforeinstallprompt and opens the native prompt', async () => {
    const { env, fire } = fakeEnvironment();
    app = new App(root, { version: '0', build: 'test', install: env });
    expect(installButton().hidden).toBe(true);
    const event = installEvent();
    fire('beforeinstallprompt', event);
    expect(installButton().hidden).toBe(false);
    installButton().click();
    await flush();
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(installButton().hidden).toBe(true);
    expect(help().hidden).toBe(true);
  });

  it('shows the iOS help card with the two steps and closes it again', () => {
    const { env } = fakeEnvironment({ isIOS: () => true });
    app = new App(root, { version: '0', build: 'test', install: env });
    expect(installButton().hidden).toBe(false);
    expect(help().hidden).toBe(true);
    installButton().click();
    expect(help().hidden).toBe(false);
    const captions = [...help().querySelectorAll('.install-step-caption')].map((c) => c.textContent);
    expect(captions).toEqual(['Teilen', 'Zum Home-Bildschirm']);
    help().querySelector<HTMLButtonElement>('button[aria-label="Schließen"]')!.click();
    expect(help().hidden).toBe(true);
    installButton().click();
    help().click();
    expect(help().hidden).toBe(true);
  });

  it('stops listening once disposed', () => {
    const { env, fire } = fakeEnvironment();
    app = new App(root, { version: '0', build: 'test', install: env });
    app.dispose();
    app = null;
    fire('beforeinstallprompt', installEvent());
    expect(installButton().hidden).toBe(true);
  });
});
