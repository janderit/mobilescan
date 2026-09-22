/**
 * Captured screen: the page header ([previous] "n/m" [next], v0.5), the
 * current page's frame region on a zoomable `FrameStage` (v0.9), the button
 * bar (back, share, edit, [+]), the edit popover and the share sheet with the
 * three-level compression control. Pure presentation: the app shell keeps the
 * open flags and the level in its state and hands them to `render`; every
 * button reports to a callback. A one-finger swipe over the fitted image
 * reports its direction; the shell decides whether to change the page.
 */

import * as icons from './icons';
import type { CompressionLevel } from './model';
import { el, iconButton } from './ui';
import { COMPRESSION_LEVELS } from './quality';
import { FrameStage } from './frame-stage';
import { swipeDirection, type SwipeDirection } from './swipe';

const LEVEL_ICONS: Record<CompressionLevel, string> = {
  small: icons.fileSmall,
  medium: icons.fileMedium,
  large: icons.fileLarge,
};

const LEVEL_LABELS: Record<CompressionLevel, string> = {
  small: 'Kleine Datei',
  medium: 'Mittlere Datei',
  large: 'Große Datei',
};

/** Short captions under the file icons; the sheet is not self-explanatory with icons alone. */
const LEVEL_CAPTIONS: Record<CompressionLevel, string> = {
  small: 'Klein',
  medium: 'Mittel',
  large: 'Groß',
};

/** Disabled look and no action, without removing the button from the focus order. */
function setDisabled(button: HTMLButtonElement, disabled: boolean): void {
  button.setAttribute('aria-disabled', String(disabled));
  button.disabled = disabled;
}

export interface CapturedViewCallbacks {
  /** Back button. */
  onBack: () => void;
  /** Share button: open the sheet. */
  onShare: () => void;
  /** A compression level was tapped in the sheet. */
  onSelectLevel: (level: CompressionLevel) => void;
  /** Sheet cancel or a tap on its backdrop. */
  onCloseSheet: () => void;
  /** Sheet confirm. */
  onConfirmShare: () => void;
  /** Edit button. */
  onToggleMenu: () => void;
  /** A tap on the popover backdrop. */
  onCloseMenu: () => void;
  /** Popover items. */
  onEdit: () => void;
  onTone: () => void;
  /** [+]. */
  onAddPage: () => void;
  /** Previous/next arrows, with the target index. */
  onShowPage: (index: number) => void;
  /** A horizontal swipe over the fitted image. */
  onSwipe: (direction: SwipeDirection) => void;
}

export interface CapturedViewState {
  /** Whether the captured screen is the current one; the popover and the sheet show only then. */
  active: boolean;
  count: number;
  current: number;
  /** At the page limit: [+] is disabled. */
  isFull: boolean;
  menuOpen: boolean;
  sheetOpen: boolean;
  level: CompressionLevel;
}

export class CapturedView {
  readonly element: HTMLElement;
  /** The zoomable stage showing the current page's frame region. */
  readonly stage: FrameStage;

  private readonly menuBackdrop: HTMLElement;
  private readonly sheetBackdrop: HTMLElement;
  private readonly editButton: HTMLButtonElement;
  private readonly addButton: HTMLButtonElement;
  private readonly pageHeader: HTMLElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly pagePosition: HTMLElement;
  private readonly levelButtons: Record<CompressionLevel, HTMLButtonElement>;

  /** Index of the page on screen as last rendered; the arrows navigate from it. */
  private current = 0;
  /** Start of a pointer drag over the stage, for swipe detection. */
  private swipeStart: { id: number; x: number; y: number } | null = null;

  constructor(private readonly callbacks: CapturedViewCallbacks) {
    // The frame region on a zoomable stage. In the fitted view a one-finger
    // swipe over the image moves between pages like the arrows; zoomed in,
    // one finger pans instead.
    this.stage = new FrameStage('captured-canvas', {
      onPointerDown: (event) => this.onSwipeStart(event),
      onPointerEnd: (event) => this.onSwipeEnd(event),
      onGestureStart: () => {
        this.swipeStart = null;
      },
    });
    const back = iconButton(icons.arrowLeft, 'Zurück');
    back.addEventListener('click', () => callbacks.onBack());
    const shareButton = iconButton(icons.share, 'Teilen', 'primary');
    shareButton.addEventListener('click', () => callbacks.onShare());
    this.editButton = iconButton(icons.edit, 'Bearbeiten');
    this.editButton.setAttribute('aria-haspopup', 'menu');
    this.editButton.addEventListener('click', () => callbacks.onToggleMenu());
    this.addButton = iconButton(icons.addPage, 'Weitere Seite scannen');
    this.addButton.addEventListener('click', () => callbacks.onAddPage());

    // Page header: [previous] "n/m" [next], only with two or more pages.
    this.previousButton = iconButton(icons.chevronLeft, 'Vorherige Seite', 'compact page-arrow');
    this.previousButton.addEventListener('click', () => callbacks.onShowPage(this.current - 1));
    this.nextButton = iconButton(icons.chevronRight, 'Nächste Seite', 'compact page-arrow');
    this.nextButton.addEventListener('click', () => callbacks.onShowPage(this.current + 1));
    this.pagePosition = el('span', 'page-position');
    this.pagePosition.setAttribute('aria-live', 'polite');
    this.pageHeader = el('div', 'page-header', this.previousButton, this.pagePosition, this.nextButton);
    this.pageHeader.hidden = true;

    // Edit popover: crop/rotate, brightness/contrast.
    const cropItem = iconButton(icons.crop, 'Zuschneiden und drehen', 'compact');
    cropItem.setAttribute('role', 'menuitem');
    cropItem.addEventListener('click', () => callbacks.onEdit());
    const brightnessItem = iconButton(icons.brightness, 'Helligkeit und Kontrast', 'compact');
    brightnessItem.setAttribute('role', 'menuitem');
    brightnessItem.addEventListener('click', () => callbacks.onTone());
    const menu = el('div', 'popover', cropItem, brightnessItem);
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Bearbeiten');
    this.menuBackdrop = el('div', 'popover-backdrop', menu);
    this.menuBackdrop.addEventListener('click', (event) => {
      if (event.target === this.menuBackdrop) callbacks.onCloseMenu();
    });

    // Share sheet
    const segmented = el('div', 'segmented');
    segmented.setAttribute('role', 'radiogroup');
    segmented.setAttribute('aria-label', 'Dateigröße');
    this.levelButtons = {
      small: this.levelButton('small'),
      medium: this.levelButton('medium'),
      large: this.levelButton('large'),
    };
    for (const level of COMPRESSION_LEVELS) segmented.append(this.levelButtons[level]);
    const cancelButton = iconButton(icons.close, 'Abbrechen');
    cancelButton.addEventListener('click', () => callbacks.onCloseSheet());
    const confirmButton = iconButton(icons.check, 'Bestätigen', 'primary');
    confirmButton.addEventListener('click', () => callbacks.onConfirmShare());
    const sheet = el(
      'div',
      'sheet',
      el('div', 'sheet-handle'),
      segmented,
      el('div', 'button-bar', cancelButton, confirmButton),
    );
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Teilen');
    this.sheetBackdrop = el('div', 'sheet-backdrop', sheet);
    this.sheetBackdrop.addEventListener('click', (event) => {
      if (event.target === this.sheetBackdrop) callbacks.onCloseSheet();
    });

    this.element = el(
      'section',
      'screen screen-captured',
      this.pageHeader,
      this.stage.element,
      el('div', 'button-bar', back, shareButton, this.editButton, this.addButton),
      this.menuBackdrop,
      this.sheetBackdrop,
    );
  }

  /** Brings the header, the buttons, the popover and the sheet in line with the state. */
  render(state: CapturedViewState): void {
    const { active, count, current, isFull, menuOpen, sheetOpen, level } = state;
    this.current = current;
    this.sheetBackdrop.hidden = !(active && sheetOpen);
    this.menuBackdrop.hidden = !(active && menuOpen);
    this.editButton.setAttribute('aria-expanded', String(menuOpen));
    this.editButton.classList.toggle('primary', menuOpen);
    for (const l of COMPRESSION_LEVELS) {
      this.levelButtons[l].setAttribute('aria-checked', String(l === level));
    }
    // Page navigation above the image; hidden with a single page.
    this.pageHeader.hidden = count <= 1;
    this.pagePosition.textContent = count > 0 ? `${current + 1}/${count}` : '';
    setDisabled(this.previousButton, current <= 0);
    setDisabled(this.nextButton, current >= count - 1);
    setDisabled(this.addButton, isFull);
    if (active) this.stage.layout();
  }

  /** Releases the stage for good. */
  dispose(): void {
    this.stage.dispose();
  }

  private levelButton(level: CompressionLevel): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-label', LEVEL_LABELS[level]);
    button.innerHTML = LEVEL_ICONS[level];
    button.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    button.append(el('span', 'segmented-caption', LEVEL_CAPTIONS[level]));
    button.addEventListener('click', () => this.callbacks.onSelectLevel(level));
    return button;
  }

  private onSwipeStart(event: PointerEvent): void {
    if (!event.isPrimary) return;
    this.swipeStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  private onSwipeEnd(event: PointerEvent): void {
    const start = this.swipeStart;
    if (!start || event.pointerId !== start.id) return;
    this.swipeStart = null;
    const direction = swipeDirection(event.clientX - start.x, event.clientY - start.y);
    if (direction) this.callbacks.onSwipe(direction);
  }
}
