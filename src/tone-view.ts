/**
 * Brightness/contrast view (v0.3): the frame region of the capture, one
 * slider, segmented [brightness|contrast|temperature], a grayscale toggle,
 * [back] and [confirm].
 *
 * The preview is a CSS filter chain on the display canvas, so dragging the
 * slider costs no pixel work. The temperature step is an inline SVG
 * feColorMatrix referenced by url(); its values are updated while dragging.
 * The caller bakes the values on confirm.
 */

import * as icons from './icons';
import type { Capture } from './model';
import { releaseCanvas } from './canvas';
import { renderFrame } from './share';
import {
  NEUTRAL_TONE,
  TONE_KEYS,
  TONE_RANGES,
  clampTone,
  temperatureMatrix,
  toneFilter,
  toneFraction,
  type Tone,
  type ToneKey,
} from './tone';
import { iconButton, segmentButton } from './ui';

export interface ToneViewCallbacks {
  /** Back: discard the pending values. */
  onCancel(): void;
  /** Confirm with the pending values (may be neutral: the caller then leaves the image alone). */
  onConfirm(tone: Tone): void;
}

const KEY_ICONS: Record<ToneKey, string> = {
  brightness: icons.brightness,
  contrast: icons.contrast,
  temperature: icons.temperature,
};

const KEY_LABELS: Record<ToneKey, string> = {
  brightness: 'Helligkeit',
  contrast: 'Kontrast',
  temperature: 'Farbtemperatur',
};

const TEMPERATURE_FILTER_ID = 'tone-temperature';
const SVG_NS = 'http://www.w3.org/2000/svg';

export class ToneView {
  readonly element: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly slider: HTMLInputElement;
  private readonly sliderWrap: HTMLElement;
  private readonly keyButtons: Record<ToneKey, HTMLButtonElement>;
  private readonly grayscaleButton: HTMLButtonElement;
  private readonly temperatureMatrixEl: SVGFEColorMatrixElement;

  private tone: Tone = { ...NEUTRAL_TONE };
  private key: ToneKey = 'brightness';
  private open_ = false;

  constructor(
    private readonly callbacks: ToneViewCallbacks,
    private readonly previewMaxLongSide: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'captured-canvas tone-canvas';
    const stage = document.createElement('div');
    stage.className = 'captured-stage';
    stage.append(this.canvas);

    // Hidden SVG holding the temperature colour matrix for the preview filter.
    const defs = document.createElementNS(SVG_NS, 'svg');
    defs.setAttribute('class', 'tone-defs');
    defs.setAttribute('aria-hidden', 'true');
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', TEMPERATURE_FILTER_ID);
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    this.temperatureMatrixEl = document.createElementNS(SVG_NS, 'feColorMatrix');
    this.temperatureMatrixEl.setAttribute('type', 'matrix');
    this.temperatureMatrixEl.setAttribute('values', temperatureMatrix(0));
    filter.append(this.temperatureMatrixEl);
    defs.append(filter);

    this.slider = document.createElement('input');
    this.slider.type = 'range';
    this.slider.className = 'tone-slider';
    this.slider.addEventListener('input', () => this.onSliderInput());
    this.sliderWrap = document.createElement('div');
    this.sliderWrap.className = 'tone-slider-wrap';
    this.sliderWrap.append(this.slider);

    const back = iconButton(icons.arrowLeft, 'Zurück', 'compact');
    back.addEventListener('click', () => this.cancel());

    const segmented = document.createElement('div');
    segmented.className = 'segmented segmented-modes segmented-tone';
    segmented.setAttribute('role', 'radiogroup');
    segmented.setAttribute('aria-label', 'Wert');
    this.keyButtons = {} as Record<ToneKey, HTMLButtonElement>;
    for (const key of TONE_KEYS) {
      const button = segmentButton(KEY_ICONS[key], KEY_LABELS[key], () => this.setKey(key));
      this.keyButtons[key] = button;
      segmented.append(button);
    }

    this.grayscaleButton = iconButton(icons.grayscale, 'Schwarzweiß', 'compact');
    this.grayscaleButton.addEventListener('click', () => this.toggleGrayscale());

    const confirm = iconButton(icons.check, 'Bestätigen', 'primary compact');
    confirm.addEventListener('click', () => this.confirm());

    const bar = document.createElement('div');
    bar.className = 'button-bar button-bar-compact';
    bar.append(back, segmented, this.grayscaleButton, confirm);

    this.element = document.createElement('section');
    this.element.className = 'screen screen-tone';
    this.element.append(defs, stage, this.sliderWrap, bar);
    this.element.hidden = true;
  }

  /** Shows the frame region of the capture with neutral values, brightness selected. */
  open(capture: Capture): void {
    this.tone = { ...NEUTRAL_TONE };
    this.key = 'brightness';
    this.open_ = true;
    const source = renderFrame(capture, this.previewMaxLongSide);
    this.canvas.width = source.width;
    this.canvas.height = source.height;
    this.canvas.getContext('2d')?.drawImage(source, 0, 0);
    releaseCanvas(source);
    this.element.hidden = false;
    this.renderKey();
  }

  /** Hides the view and drops the display copy. Never touches the capture. */
  close(): void {
    this.open_ = false;
    this.element.hidden = true;
    this.canvas.style.filter = '';
    releaseCanvas(this.canvas);
  }

  // ---- controls --------------------------------------------------------

  private setKey(key: ToneKey): void {
    this.key = key;
    this.renderKey();
  }

  private onSliderInput(): void {
    if (!this.open_) return;
    this.tone = { ...this.tone, [this.key]: clampTone(this.key, this.slider.valueAsNumber) };
    this.renderPreview();
  }

  private toggleGrayscale(): void {
    if (!this.open_) return;
    this.tone = { ...this.tone, grayscale: !this.tone.grayscale };
    this.renderPreview();
  }

  private cancel(): void {
    this.callbacks.onCancel();
  }

  private confirm(): void {
    if (!this.open_) return;
    this.callbacks.onConfirm({ ...this.tone });
  }

  // ---- display ---------------------------------------------------------

  /** Points the slider at the selected value: range, tick and current position. */
  private renderKey(): void {
    for (const key of TONE_KEYS) {
      this.keyButtons[key].setAttribute('aria-checked', String(key === this.key));
    }
    const range = TONE_RANGES[this.key];
    this.slider.min = String(range.min);
    this.slider.max = String(range.max);
    this.slider.step = String(range.step);
    this.slider.value = String(this.tone[this.key]);
    this.slider.setAttribute('aria-label', KEY_LABELS[this.key]);
    this.sliderWrap.style.setProperty('--tick', `${toneFraction(this.key, range.neutral) * 100}%`);
    this.renderPreview();
  }

  private renderPreview(): void {
    this.temperatureMatrixEl.setAttribute('values', temperatureMatrix(this.tone.temperature));
    this.canvas.style.filter = toneFilter(this.tone, TEMPERATURE_FILTER_ID);
    this.grayscaleButton.setAttribute('aria-pressed', String(this.tone.grayscale));
    this.grayscaleButton.classList.toggle('primary', this.tone.grayscale);
    const fill = toneFraction(this.key, this.tone[this.key]) * 100;
    this.sliderWrap.style.setProperty('--fill', `${fill}%`);
  }
}
