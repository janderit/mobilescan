// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CropRotateView } from '../src/editor';
import { ToneView } from '../src/tone-view';
import { quadCorners } from '../src/geometry';
import { toneFraction, type Tone } from '../src/tone';
import type { Capture, Frame } from '../src/model';
import { stubCanvas, type CanvasStub } from './canvas-stub';
import * as detect from '../src/detect';

/**
 * The stubbed canvas hands back transparent pixels, so the real detection
 * finds nothing (the failure path). The success path substitutes the
 * detection results, since jsdom cannot render the working copy.
 */
vi.mock('../src/detect', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/detect')>();
  return { ...original, detectFrame: vi.fn(original.detectFrame), detectTone: vi.fn(original.detectTone) };
});

const real = await vi.importActual<typeof import('../src/detect')>('../src/detect');

const W = 3000;
const H = 4000;

function capture(frame: Partial<Frame> = {}): Capture {
  const image = document.createElement('canvas');
  image.width = W;
  image.height = H;
  return { image, frame: { cx: 1500, cy: 2000, width: 2000, height: 2800, angle: 0, ...frame } };
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}

describe('auto-detect in the crop/rotate view', () => {
  let stub: CanvasStub;
  let view: CropRotateView;
  let confirmed: Frame | null;
  let notices: number;

  beforeEach(() => {
    stub = stubCanvas();
    confirmed = null;
    notices = 0;
    view = new CropRotateView({
      onCancel: () => {},
      onConfirm: (f) => {
        confirmed = f;
      },
      onNotice: () => {
        notices += 1;
      },
    });
    document.body.append(view.element);
    const stage = view.element.querySelector<HTMLElement>('.edit-stage')!;
    Object.defineProperty(stage, 'clientWidth', { value: 360, configurable: true });
    Object.defineProperty(stage, 'clientHeight', { value: 480, configurable: true });
  });

  afterEach(() => {
    view.close();
    view.element.remove();
    stub.restore();
    vi.mocked(detect.detectFrame).mockReset();
    vi.mocked(detect.detectFrame).mockImplementation(real.detectFrame);
  });

  it('has the wand button between rotate 90 and confirm', () => {
    const labels = [...view.element.querySelectorAll('.button-bar > *')].map(
      (node) => node.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Zurück', 'Modus', 'Um 90° nach rechts drehen', 'Automatisch erkennen', 'Bestätigen']);
  });

  it('shows the notice and keeps the frame when nothing is found', () => {
    const c = capture();
    view.open(c);
    button(view.element, 'Automatisch erkennen').click();
    expect(notices).toBe(1);
    button(view.element, 'Bestätigen').click();
    expect(confirmed).toEqual(c.frame);
  });

  it('replaces the pending frame with the detected one, confirm hands it on, back discards it', () => {
    const c = capture();
    const detected: Frame = {
      cx: 1480,
      cy: 2010,
      width: 1900,
      height: 2700,
      angle: 0.05,
      corners: [
        { x: 12, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: -12, y: 0 },
      ],
    };
    vi.mocked(detect.detectFrame).mockReturnValueOnce(detected);
    view.open(c);
    button(view.element, 'Automatisch erkennen').click();
    expect(notices).toBe(0);
    // The overlay draws the detected quadrilateral: the polygon has the
    // detected frame's local corner geometry (scaled), sheared at nw and sw.
    const points = view.element
      .querySelector('polygon.edit-frame')!
      .getAttribute('points')!
      .split(' ')
      .map((pair) => pair.split(',').map(Number));
    expect(points[0]![0]).toBeGreaterThan(points[3]![0]! + 1);
    button(view.element, 'Bestätigen').click();
    expect(confirmed).toEqual(detected);
    expect(quadCorners(confirmed!)).toEqual(quadCorners(detected));
    // The capture itself is untouched until the caller bakes.
    expect(c.frame.angle).toBe(0);
  });

  it('measures the rectangle of the pending frame and passes it as the current frame', () => {
    const c = capture();
    view.open(c);
    button(view.element, 'Automatisch erkennen').click();
    const call = vi.mocked(detect.detectFrame).mock.calls[0]!;
    const layout = call[1];
    expect(Math.max(layout.frame.width, layout.frame.height)).toBeCloseTo(detect.DETECT_LONG_SIDE, 6);
    expect(call[2]).toEqual(c.frame);
    expect(call[3]).toBe(W);
  });
});

describe('auto-detect in the brightness/contrast view', () => {
  let stub: CanvasStub;
  let view: ToneView;
  let confirmed: Tone | null;
  let notices: number;

  function slider(): HTMLInputElement {
    return view.element.querySelector<HTMLInputElement>('input.tone-slider')!;
  }

  beforeEach(() => {
    stub = stubCanvas();
    confirmed = null;
    notices = 0;
    view = new ToneView(
      {
        onCancel: () => {},
        onConfirm: (t) => {
          confirmed = t;
        },
        onNotice: () => {
          notices += 1;
        },
      },
    );
    document.body.append(view.element);
  });

  afterEach(() => {
    view.close();
    view.element.remove();
    stub.restore();
    vi.mocked(detect.detectTone).mockReset();
    vi.mocked(detect.detectTone).mockImplementation(real.detectTone);
  });

  it('has the wand button between grayscale and confirm', () => {
    const labels = [...view.element.querySelectorAll('.button-bar > *')].map(
      (node) => node.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Zurück', 'Wert', 'Schwarzweiß', 'Automatisch anpassen', 'Bestätigen']);
  });

  it('shows the notice and keeps neutral values when nothing is measurable', () => {
    view.open(capture());
    button(view.element, 'Automatisch anpassen').click();
    expect(notices).toBe(1);
    button(view.element, 'Bestätigen').click();
    expect(confirmed).toEqual({ brightness: 1, contrast: 1, temperature: 0, grayscale: false });
  });

  it('sets the detected values as pending: preview filter, grayscale on, slider on the selected value', () => {
    const detected: Tone = { brightness: 1.05, contrast: 2.5, temperature: 0, grayscale: true };
    vi.mocked(detect.detectTone).mockReturnValue(detected);
    view.open(capture());
    button(view.element, 'Kontrast').click();
    button(view.element, 'Automatisch anpassen').click();
    expect(notices).toBe(0);
    const canvas = view.element.querySelector<HTMLCanvasElement>('canvas.tone-canvas')!;
    expect(canvas.style.filter).toBe('brightness(1.05) contrast(2.5) grayscale(1)');
    expect(button(view.element, 'Schwarzweiß').getAttribute('aria-pressed')).toBe('true');
    // Linear 0..1000 slider with the piecewise mapping: 2.5 sits at 75 %.
    expect(slider().value).toBe(String(Math.round(toneFraction('contrast', 2.5) * 1000)));
    expect(slider().value).toBe('750');
    // A second tap measures the source again and gives the same result.
    button(view.element, 'Automatisch anpassen').click();
    expect(vi.mocked(detect.detectTone)).toHaveBeenCalledTimes(2);
    expect(canvas.style.filter).toBe('brightness(1.05) contrast(2.5) grayscale(1)');
    button(view.element, 'Bestätigen').click();
    expect(confirmed).toEqual(detected);
  });

  it('drags the contrast slider to the right end for 4.0 and keeps the tick centred', () => {
    view.open(capture());
    button(view.element, 'Kontrast').click();
    const wrap = view.element.querySelector<HTMLElement>('.tone-slider-wrap')!;
    expect(wrap.style.getPropertyValue('--tick')).toBe('50%');
    expect(slider().value).toBe('500');
    slider().value = '1000';
    slider().dispatchEvent(new Event('input'));
    button(view.element, 'Bestätigen').click();
    expect(confirmed!.contrast).toBe(4);
    expect(wrap.style.getPropertyValue('--fill')).toBe('100%');
  });

  it('back after auto discards the values', () => {
    vi.mocked(detect.detectTone).mockReturnValue({ brightness: 1.1, contrast: 3, temperature: 0, grayscale: true });
    let cancelled = 0;
    const v = new ToneView({ onCancel: () => { cancelled += 1; }, onConfirm: () => {}, onNotice: () => {} });
    document.body.append(v.element);
    v.open(capture());
    button(v.element, 'Automatisch anpassen').click();
    button(v.element, 'Zurück').click();
    expect(cancelled).toBe(1);
    v.close();
    v.element.remove();
  });
});
