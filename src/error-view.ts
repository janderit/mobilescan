/**
 * Camera error screen: the warning status icon whose label names the cause,
 * back and retry. No text. The shell hands `render` the error kind.
 */

import * as icons from './icons';
import type { CameraErrorKind } from './camera';
import { el, iconButton } from './ui';

export const CAMERA_ERROR_LABELS: Record<CameraErrorKind, string> = {
  denied: 'Kamerazugriff verweigert',
  unavailable: 'Keine Kamera verfügbar',
  insecure: 'Kamera nur über eine sichere Verbindung verfügbar',
};

export interface ErrorViewCallbacks {
  /** Back button. */
  onBack: () => void;
  /** Retry button: open the camera again. */
  onRetry: () => void;
}

export interface ErrorViewState {
  kind: CameraErrorKind;
}

export class ErrorView {
  readonly element: HTMLElement;

  private readonly status: HTMLElement;

  constructor(callbacks: ErrorViewCallbacks) {
    this.status = el('div', 'error-icon');
    this.status.innerHTML = icons.warning;
    this.status.setAttribute('role', 'status');
    this.status.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    const back = iconButton(icons.arrowLeft, 'Zurück', 'dark camera-back');
    back.addEventListener('click', () => callbacks.onBack());
    const retry = iconButton(icons.refresh, 'Kamera erneut versuchen', 'primary');
    retry.addEventListener('click', () => callbacks.onRetry());
    this.element = el('section', 'screen screen-error', back, this.status, retry);
  }

  render(state: ErrorViewState): void {
    this.status.setAttribute('aria-label', CAMERA_ERROR_LABELS[state.kind]);
  }
}
