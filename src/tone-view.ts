/**
 * Brightness/contrast view (v0.3): the frame region of the capture, one
 * slider, segmented [brightness|contrast|temperature], a grayscale toggle,
 * [back] and [confirm].
 *
 * The preview is a CSS filter chain on the display canvas, so dragging the
 * slider costs no pixel work. The temperature step is an inline SVG
 * feColorMatrix referenced by url(); its values are updated while dragging.
 * The caller bakes the values on confirm.
 *
 * The native range input runs a linear 0..1000 scale; `toneFraction` and its
 * inverse map it to the selected value with neutral at the centre (v0.8).
 *
 * Auto (v0.8): the wand button measures the paper background and the print
 * in the frame region (`detect.ts`) and sets grayscale, brightness and
 * contrast so the page becomes black on white, as a pending edit.
 *
 * Zoom (v0.9): the stage is a `FrameStage`, so the frame region can be
 * pinched, panned and double-tapped; the filter chain applies to the stage
 * canvas as before. The zoom resets whenever the view opens.
 */

import * as icons from './icons';
import type { Capture } from './model';
import { sampleImage } from './canvas';
import { detectTone, toneWorkingLayout } from './detect';
import { FrameStage } from './frame-stage';
import {
  NEUTRAL_TONE,
  TONE_KEYS,
  TONE_RANGES,
  clampTone,
  temperatureMatrix,
  toneFilter,
  toneFraction,
  toneFromFraction,
  type Tone,
  type ToneKey,
} from './tone';
import { iconButton, segmentButton } from './ui';
import type { ZoomState } from './zoom';

export interface ToneViewCallbacks {
  /** Back: discard the pending values. */
  onCancel(): void;
  /** Confirm with the pending values (may be neutral: the caller then leaves the image alone). */
  onConfirm(tone: Tone): void;
  /** Auto-detect could not measure the page: show the brief warning notice. */
  onNotice(): void;
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
/** Resolution of the native range input (linear; the value mapping is piecewise). */
const SLIDER_STEPS = 1000;
const SVG_NS = 'http://www.w3.org/2000/svg';

export class ToneView {
  readonly element: HTMLElement;

  private readonly stage: FrameStage;
  private readonly canvas: HTMLCanvasElement;
  private readonly slider: HTMLInputElement;
  private readonly sliderWrap: HTMLElement;
  private readonly keyButtons: Record<ToneKey, HTMLButtonElement>;
  private readonly grayscaleButton: HTMLButtonElement;
  private readonly temperatureMatrixEl: SVGFEColorMatrixElement;

  private capture: Capture | null = null;
  private tone: Tone = { ...NEUTRAL_TONE };
  private key: ToneKey = 'brightness';
  private open_ = false;

  constructor(private readonly callbacks: ToneViewCallbacks) {
    this.stage = new FrameStage('captured-canvas tone-canvas');
    this.canvas = this.stage.canvas;

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
    this.slider.min = '0';
    this.slider.max = String(SLIDER_STEPS);
    this.slider.step = '1';
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

    const auto = iconButton(icons.magicWand, 'Automatisch anpassen', 'compact');
    auto.addEventListener('click', () => this.autoDetect());

    const confirm = iconButton(icons.check, 'Bestätigen', 'primary compact');
    confirm.addEventListener('click', () => this.confirm());

    const bar = document.createElement('div');
    bar.className = 'button-bar button-bar-compact';
    bar.append(back, segmented, this.grayscaleButton, auto, confirm);

    this.element = document.createElement('section');
    this.element.className = 'screen screen-tone';
    this.element.append(defs, this.stage.element, this.sliderWrap, bar);
    this.element.hidden = true;
  }

  /** Shows the frame region of the capture with neutral values, brightness selected, fitted view. */
  open(capture: Capture): void {
    this.capture = capture;
    this.tone = { ...NEUTRAL_TONE };
    this.key = 'brightness';
    this.open_ = true;
    this.element.hidden = false;
    this.stage.show(capture);
    this.renderKey();
  }

  /** Hides the view and drops the display copy. Never touches the capture. */
  close(): void {
    this.open_ = false;
    this.capture = null;
    this.element.hidden = true;
    this.canvas.style.filter = '';
    this.stage.clear();
  }

  /** The zoom state of the stage, for tests. */
  get zoom(): ZoomState {
    return this.stage.zoom;
  }

  // ---- controls --------------------------------------------------------

  private setKey(key: ToneKey): void {
    this.key = key;
    this.renderKey();
  }

  private onSliderInput(): void {
    if (!this.open_) return;
    const value = toneFromFraction(this.key, this.slider.valueAsNumber / SLIDER_STEPS);
    this.tone = { ...this.tone, [this.key]: clampTone(this.key, value) };
    this.renderPreview();
  }

  /**
   * Measures the source image (not the preview, so a second tap gives the
   * same result) and sets the pending values to black on white.
   */
  private autoDetect(): void {
    const capture = this.capture;
    if (!this.open_ || !capture) return;
    let tone: Tone | null;
    try {
      const layout = toneWorkingLayout(capture.frame);
      tone = detectTone(sampleImage(capture.image, layout.transform, layout.width, layout.height));
    } catch {
      tone = null;
    }
    if (!tone) {
      this.callbacks.onNotice();
      return;
    }
    this.tone = tone;
    this.renderKey();
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
    this.slider.value = String(Math.round(toneFraction(this.key, this.tone[this.key]) * SLIDER_STEPS));
    this.slider.setAttribute('aria-label', KEY_LABELS[this.key]);
    this.slider.setAttribute('aria-valuemin', String(range.min));
    this.slider.setAttribute('aria-valuemax', String(range.max));
    this.slider.setAttribute('aria-valuenow', String(this.tone[this.key]));
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
    this.slider.setAttribute('aria-valuenow', String(this.tone[this.key]));
  }
}
