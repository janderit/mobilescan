/**
 * The start page's install offer: knows whether the app runs installed
 * (standalone) and, if not, how it can be installed on this browser. Chrome
 * on Android fires `beforeinstallprompt`; the event is kept and `prompt()`
 * opens the native install dialog. Safari and every other browser on iOS
 * have no install API, so there the offer opens an instruction overlay
 * (share, then "Zum Home-Bildschirm"). Elsewhere nothing is offered.
 * Depends on `window` only through the injectable `InstallEnvironment`;
 * the shell re-renders on `onChange` and shows the overlay for `manual`.
 */

/** The `beforeinstallprompt` event of Chromium browsers. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** How the app can be installed from this window; `none` also while it already runs installed. */
export type InstallMode = 'none' | 'native' | 'manual';

export interface InstallEnvironment {
  /** Whether this window is the installed app (display-mode standalone, or `navigator.standalone` on iOS). */
  isStandalone: () => boolean;
  /** iOS (and iPadOS, which reports itself as a Mac with touch): install only through the share sheet. */
  isIOS: () => boolean;
  addEventListener: (type: string, listener: (event: Event) => void, options?: AddEventListenerOptions) => void;
}

/** The browser's own answers, read at call time so tests and late changes see the truth. */
export function browserInstallEnvironment(win: Window = window): InstallEnvironment {
  return {
    isStandalone: () =>
      (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches) ||
      (win.navigator as Navigator & { standalone?: boolean }).standalone === true,
    isIOS: () => {
      const { userAgent, platform, maxTouchPoints } = win.navigator;
      return /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
    },
    addEventListener: (type, listener, options) => win.addEventListener(type, listener, options),
  };
}

export class InstallPrompt {
  private deferred: BeforeInstallPromptEvent | null = null;
  private installed: boolean;
  private readonly manual: boolean;

  constructor(
    private readonly env: InstallEnvironment,
    private readonly onChange: () => void,
    signal?: AbortSignal,
  ) {
    this.installed = env.isStandalone();
    this.manual = !this.installed && env.isIOS();
    const options: AddEventListenerOptions = signal ? { signal } : {};
    env.addEventListener(
      'beforeinstallprompt',
      (event) => {
        // Keep the event for the button; without preventDefault Chrome shows its own mini-infobar.
        event.preventDefault();
        this.deferred = event as BeforeInstallPromptEvent;
        this.onChange();
      },
      options,
    );
    env.addEventListener(
      'appinstalled',
      () => {
        this.deferred = null;
        this.installed = true;
        this.onChange();
      },
      options,
    );
  }

  get mode(): InstallMode {
    if (this.installed) return 'none';
    if (this.deferred) return 'native';
    if (this.manual) return 'manual';
    return 'none';
  }

  /**
   * Opens the native install dialog and resolves to whether the user
   * accepted. The event prompts only once, so the button goes until Chrome
   * fires a fresh event (it does after a dismissal, on a later visit).
   */
  async prompt(): Promise<boolean> {
    const event = this.deferred;
    if (!event) return false;
    this.deferred = null;
    this.onChange();
    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      if (outcome === 'accepted') {
        this.installed = true;
        this.onChange();
        return true;
      }
    } catch {
      // A prompt that cannot be shown (already used, not allowed): treat as dismissed.
    }
    return false;
  }
}
