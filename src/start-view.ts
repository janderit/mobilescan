/**
 * Start screen: the title, the "Dokument scannen" button, the slot with the
 * update and the install button, the version line and the info link to the
 * product page (bottom right, opens outside the app), plus the install help
 * overlay for iOS (share, then "Zum Home-Bildschirm"; the third text
 * exception, since there is no install API to call). Pure presentation: the
 * shell hands `render` whether an update is known, how the app can be
 * installed and whether the help is open, and every button reports to a
 * callback.
 */

import * as icons from './icons';
import { el, iconButton } from './ui';
import type { InstallMode } from './install';

export interface StartViewCallbacks {
  /** "Dokument scannen". */
  onStart: () => void;
  /** The update button. */
  onUpdate: () => void;
  /** The install button (native prompt or the iOS help, the shell decides). */
  onInstall: () => void;
  /** Close button or backdrop of the install help. */
  onCloseInstallHelp: () => void;
}

/** The product page the info button opens (Impressum, Datenschutz, description). */
export const PRODUCT_PAGE_URL = 'https://mobilescan.app/';

export interface StartViewOptions {
  /** Build label shown under the buttons. */
  version: string;
  build: string;
}

export interface StartViewState {
  /** Whether the server has a newer build; shows the update button. */
  updateAvailable: boolean;
  /** How the app can be installed; `none` hides the install button. */
  installMode: InstallMode;
  /** Whether the iOS install help overlay is open. */
  installHelpOpen: boolean;
}

export class StartView {
  readonly element: HTMLElement;

  private readonly updateButton: HTMLButtonElement;
  private readonly installButton: HTMLButtonElement;
  private readonly installHelp: HTMLElement;

  constructor(options: StartViewOptions, callbacks: StartViewCallbacks) {
    const startButton = el('button', 'start-button', 'Dokument scannen');
    startButton.type = 'button';
    startButton.addEventListener('click', () => callbacks.onStart());
    // Update button: shown only when the server has a newer build. The slot
    // keeps its height so the layout does not jump when the button appears.
    this.updateButton = iconButton(icons.refresh, 'App aktualisieren', 'primary update-button');
    this.updateButton.hidden = true;
    this.updateButton.addEventListener('click', () => callbacks.onUpdate());
    // Install button: shown while the app runs in a browser tab that can
    // install it (Chrome's prompt) or explain how (iOS). Shares the slot.
    this.installButton = iconButton(icons.install, 'App installieren', 'install-button');
    this.installButton.hidden = true;
    this.installButton.addEventListener('click', () => callbacks.onInstall());
    this.installHelp = buildInstallHelp(callbacks);
    // Version line: makes it visible on the phone whether a new build has arrived.
    const version = el('p', 'app-version', `v${options.version} (${options.build})`);
    // Info link: a small icon-only link to the product page, opened in the
    // browser (a new tab, or outside the installed app), so the scan is not left.
    const info = document.createElement('a');
    info.className = 'icon-button info-button';
    info.href = PRODUCT_PAGE_URL;
    info.target = '_blank';
    info.rel = 'noopener';
    info.setAttribute('aria-label', 'Über MobileScan');
    info.innerHTML = icons.info;
    info.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    this.element = el(
      'section',
      'screen screen-start',
      el('h1', 'app-title', 'MobileScan'),
      startButton,
      el('div', 'update-slot', this.updateButton, this.installButton),
      version,
      info,
      this.installHelp,
    );
  }

  render(state: StartViewState): void {
    this.updateButton.hidden = !state.updateAvailable;
    this.installButton.hidden = state.installMode === 'none';
    this.installHelp.hidden = !state.installHelpOpen;
  }
}

/**
 * The iOS install help: a card over the start page with the two steps of
 * the share sheet route, each an icon with its caption, and a close button.
 * Tapping the backdrop closes it too.
 */
function buildInstallHelp(callbacks: StartViewCallbacks): HTMLElement {
  const step = (icon: string, caption: string): HTMLElement => {
    const glyph = el('span', 'install-step-icon');
    glyph.innerHTML = icon;
    glyph.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    return el('li', 'install-step', glyph, el('span', 'install-step-caption', caption));
  };
  const close = iconButton(icons.close, 'Schließen', 'compact install-help-close');
  close.addEventListener('click', () => callbacks.onCloseInstallHelp());
  const card = el(
    'div',
    'install-help-card',
    el('ol', 'install-steps', step(icons.iosShare, 'Teilen'), step(icons.addToHome, 'Zum Home-Bildschirm')),
    close,
  );
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'App installieren');
  const help = el('div', 'install-help', card);
  help.hidden = true;
  help.addEventListener('click', (event) => {
    if (event.target === help) callbacks.onCloseInstallHelp();
  });
  return help;
}
