/**
 * Start screen: the title, the "Dokument scannen" button, the update slot
 * with the update button, the version line and the info link to the product
 * page (bottom right, opens outside the app). Pure presentation: the shell
 * hands `render` whether an update is known and every button reports to a
 * callback.
 */

import * as icons from './icons';
import { el, iconButton } from './ui';

export interface StartViewCallbacks {
  /** "Dokument scannen". */
  onStart: () => void;
  /** The update button. */
  onUpdate: () => void;
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
}

export class StartView {
  readonly element: HTMLElement;

  private readonly updateButton: HTMLButtonElement;

  constructor(options: StartViewOptions, callbacks: StartViewCallbacks) {
    const startButton = el('button', 'start-button', 'Dokument scannen');
    startButton.type = 'button';
    startButton.addEventListener('click', () => callbacks.onStart());
    // Update button: shown only when the server has a newer build. The slot
    // keeps its height so the layout does not jump when the button appears.
    this.updateButton = iconButton(icons.refresh, 'App aktualisieren', 'primary update-button');
    this.updateButton.hidden = true;
    this.updateButton.addEventListener('click', () => callbacks.onUpdate());
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
      el('div', 'update-slot', this.updateButton),
      version,
      info,
    );
  }

  render(state: StartViewState): void {
    this.updateButton.hidden = !state.updateAvailable;
  }
}
