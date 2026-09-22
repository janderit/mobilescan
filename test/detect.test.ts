import { describe, expect, it } from 'vitest';
import {
  BAND_INSIDE,
  detectEdges,
  detectFrame,
  detectTone,
  frameFromCorners,
  frameWorkingLayout,
  luminanceHistogram,
  luminanceOf,
  paperLevels,
  repeatedMedianLine,
  toneForLevels,
  toneWorkingLayout,
  type WorkingLayout,
} from '../src/detect';
import { applyAffine, invertAffine, quadCorners, rotateVector, type Quad } from '../src/geometry';
import type { Frame, Point } from '../src/model';
import { toneLookups } from '../src/tone';

const IMAGE_W = 1200;
const IMAGE_H = 1600;

/** Luminance 0..1 at an image point, or null outside the image. */
type Scene = (p: Point) => number | null;

/** Renders a scene into the working image of a layout with 2x2 supersampling (like a real downscale). */
function renderWorking(layout: WorkingLayout, scene: Scene): ImageData {
  const { width, height } = layout;
  const back = invertAffine(layout.transform);
  const data = new Uint8ClampedArray(width * height * 4);
  const offsets = [0.25, 0.75];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let valid = true;
      for (const dy of offsets) {
        for (const dx of offsets) {
          const v = scene(applyAffine(back, { x: x + dx, y: y + dy }));
          if (v === null) valid = false;
          else sum += v;
        }
      }
      const i = (y * width + x) * 4;
      if (valid) {
        const g = Math.round((sum / 4) * 255);
        data[i] = g;
        data[i + 1] = g;
        data[i + 2] = g;
        data[i + 3] = 255;
      }
    }
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

const insideImage = (p: Point): boolean => p.x >= 0 && p.y >= 0 && p.x < IMAGE_W && p.y < IMAGE_H;

/** A bright rectangle (paper) on a dark table. */
function paperScene(paper: Frame, bright = 0.8, dark = 0.2): Scene {
  return (p) => {
    if (!insideImage(p)) return null;
    const local = rotateVector(p.x - paper.cx, p.y - paper.cy, -paper.angle);
    const inside = Math.abs(local.x) <= paper.width / 2 && Math.abs(local.y) <= paper.height / 2;
    return inside ? bright : dark;
  };
}

/** A bright convex quadrilateral (nw, ne, se, sw) on a dark table. */
function quadScene(quad: Quad, bright = 0.8, dark = 0.2): Scene {
  return (p) => {
    if (!insideImage(p)) return null;
    for (let i = 0; i < 4; i += 1) {
      const a = quad[i]!;
      const b = quad[(i + 1) % 4]!;
      if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < 0) return dark;
    }
    return bright;
  };
}

function detect(frame: Frame, scene: Scene): Frame | null {
  const layout = frameWorkingLayout(frame);
  return detectFrame(renderWorking(layout, scene), layout, frame, IMAGE_W);
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const degrees = (rad: number): number => (rad * 180) / Math.PI;

describe('frame detection', () => {
  const paper: Frame = { cx: 600, cy: 800, width: 900, height: 1250, angle: 0 };
  /** A frame a little larger than the paper: every paper edge is 3 % inside it. */
  const around: Frame = { cx: 600, cy: 800, width: 954, height: 1325, angle: 0 };

  it('renders the working image in frame-local orientation at 800 px', () => {
    const layout = frameWorkingLayout(around);
    expect(Math.max(layout.frame.width, layout.frame.height)).toBeCloseTo(800, 6);
    expect(layout.width).toBeGreaterThan(layout.frame.width);
    // The frame centre lands in the working centre; the frame's nw corner at the frame rect origin.
    const centre = applyAffine(layout.transform, { x: around.cx, y: around.cy });
    expect(centre.x).toBeCloseTo(layout.width / 2, 6);
    expect(centre.y).toBeCloseTo(layout.height / 2, 6);
    const nw = applyAffine(layout.transform, quadCorners(around)[0]!);
    expect(nw.x).toBeCloseTo(layout.frame.x, 6);
    expect(nw.y).toBeCloseTo(layout.frame.y, 6);
  });

  it('snaps the frame onto a straight paper, corners within 2 px, as a plain rectangle', () => {
    const found = detect(around, paperScene(paper));
    expect(found).not.toBeNull();
    const truth = quadCorners(paper);
    quadCorners(found!).forEach((corner, i) => {
      expect(distance(corner, truth[i]!)).toBeLessThan(2);
    });
    expect(found!.corners).toBeUndefined();
    expect(Math.abs(degrees(found!.angle))).toBeLessThan(0.5);
  });

  it('ignores a dark paper on a bright table (only bright-to-dark from the inside counts)', () => {
    expect(detect(around, paperScene(paper, 0.3, 0.9))).toBeNull();
  });

  it('prefers an edge inside the frame over a stronger bright-to-dark step beyond it', () => {
    // Frame outside the paper at the bottom and right (paper edges 3 % inside
    // the frame), a dark strip (desk edge) starting 2 % outside the frame.
    const frame: Frame = { cx: 613, cy: 820, width: 954, height: 1325, angle: 0 };
    const scene: Scene = (p) => {
      if (!insideImage(p)) return null;
      const onPaper = Math.abs(p.x - paper.cx) <= paper.width / 2 && Math.abs(p.y - paper.cy) <= paper.height / 2;
      if (onPaper) return 0.75;
      const beyond = p.x > frame.cx + frame.width / 2 + 0.02 * frame.width || p.y > frame.cy + frame.height / 2 + 0.02 * frame.height;
      return beyond ? 0.05 : 0.5;
    };
    const found = detect(frame, scene);
    expect(found).not.toBeNull();
    const truth = quadCorners(paper);
    quadCorners(found!).forEach((corner, i) => {
      expect(distance(corner, truth[i]!)).toBeLessThan(2);
    });
  });

  it('ignores the dark table\'s edge against bright surroundings outside the paper', () => {
    // Paper (0.9) on a dark mat (0.2) that ends 3 % outside the frame, bright
    // surroundings (0.85) beyond it: the mat's outer edge is the stronger
    // step but runs dark-to-bright from the inside.
    const mat: Frame = { cx: 600, cy: 800, width: 1010, height: 1400, angle: 0 };
    const scene: Scene = (p) => {
      if (!insideImage(p)) return null;
      const onPaper = Math.abs(p.x - paper.cx) <= paper.width / 2 && Math.abs(p.y - paper.cy) <= paper.height / 2;
      const onMat = Math.abs(p.x - mat.cx) <= mat.width / 2 && Math.abs(p.y - mat.cy) <= mat.height / 2;
      return onPaper ? 0.9 : onMat ? 0.2 : 0.85;
    };
    const found = detect(around, scene);
    expect(found).not.toBeNull();
    const truth = quadCorners(paper);
    quadCorners(found!).forEach((corner, i) => {
      expect(distance(corner, truth[i]!)).toBeLessThan(2);
    });
  });

  it('detects a 5° rotated paper with the angle within 0.5° and corners within 2 px', () => {
    const tilted: Frame = { ...paper, angle: (5 * Math.PI) / 180 };
    const found = detect(around, paperScene(tilted));
    expect(found).not.toBeNull();
    expect(Math.abs(degrees(found!.angle) - 5)).toBeLessThan(0.5);
    const truth = quadCorners(tilted);
    quadCorners(found!).forEach((corner, i) => {
      expect(distance(corner, truth[i]!)).toBeLessThan(2);
    });
    expect(found!.corners).toBeUndefined();
  });

  it('keeps the detected rotation inside the skew range around the current base', () => {
    const tilted: Frame = { ...paper, angle: (5 * Math.PI) / 180 };
    // The same scene seen from a frame that was already turned by 90°: the
    // result stays within ±15° of that base.
    const turned: Frame = { cx: 600, cy: 800, width: 1325, height: 954, angle: -Math.PI / 2 };
    const found = detect(turned, paperScene(tilted));
    expect(found).not.toBeNull();
    expect(Math.abs(degrees(found!.angle + Math.PI / 2) - 5)).toBeLessThan(0.5);
    expect(found!.width).toBeCloseTo(1250, 0);
    expect(found!.height).toBeCloseTo(900, 0);
  });

  it('yields corner offsets for a page photographed at an angle (trapezoid)', () => {
    const truth: Quad = [
      { x: 200, y: 200 },
      { x: 1000, y: 230 },
      { x: 1080, y: 1420 },
      { x: 120, y: 1380 },
    ];
    const frame: Frame = { cx: 600, cy: 800, width: 1000, height: 1280, angle: 0 };
    const found = detect(frame, quadScene(truth));
    expect(found).not.toBeNull();
    expect(found!.corners).toBeDefined();
    quadCorners(found!).forEach((corner, i) => {
      expect(distance(corner, truth[i]!)).toBeLessThan(2);
    });
  });

  it('ignores a paper edge 30 % inside the frame and reports nothing found', () => {
    const small: Frame = { cx: 600, cy: 800, width: 400, height: 560, angle: 0 };
    const frame: Frame = { cx: 600, cy: 800, width: 1000, height: 1400, angle: 0 };
    // 30 % of the frame size on each side, well past the 15 % band.
    expect((frame.width - small.width) / 2 / frame.width).toBeGreaterThan(BAND_INSIDE);
    expect(detect(frame, paperScene(small))).toBeNull();
  });

  it('applies a partial result: one edge found, the other three kept', () => {
    // Paper fills the image except a dark strip at the top; the frame's top
    // edge sits a little above the paper's, the other frame edges lie on
    // uniform paper.
    const scene: Scene = (p) => (insideImage(p) ? (p.y < 300 ? 0.2 : 0.8) : null);
    const frame: Frame = { cx: 600, cy: 900, width: 1000, height: 1300, angle: 0 };
    const layout = frameWorkingLayout(frame);
    const edges = detectEdges(luminanceOf(renderWorking(layout, scene)), layout.frame);
    expect(edges.found).toBe(1);
    expect(edges.lines.n.found).toBe(true);
    expect(edges.lines.s.found).toBe(false);
    const found = detectFrame(renderWorking(layout, scene), layout, frame, IMAGE_W);
    expect(found).not.toBeNull();
    const corners = quadCorners(found!);
    expect(corners[0]!.y).toBeCloseTo(300, 0);
    expect(corners[1]!.y).toBeCloseTo(300, 0);
    expect(corners[2]!.y).toBeCloseTo(1550, 0);
    expect(corners[0]!.x).toBeCloseTo(100, 0);
    expect(corners[1]!.x).toBeCloseTo(1100, 0);
  });

  it('finds nothing on a uniform image', () => {
    expect(detect(around, (p) => (insideImage(p) ? 0.5 : null))).toBeNull();
  });

  it('prefers the paper edge over a stronger line of text further inside the band', () => {
    // A black text line 8 % of the page height below the top edge (well
    // inside the 20 % band), darker against the paper than the table is.
    const base = paperScene(paper, 0.9, 0.5);
    const scene: Scene = (p) => {
      const v = base(p);
      if (v === null) return null;
      const inText = p.y > 275 && p.y < 295 && Math.abs(p.x - 600) < 380;
      return inText ? 0.05 : v;
    };
    const found = detect(around, scene);
    expect(found).not.toBeNull();
    const truth = quadCorners(paper);
    quadCorners(found!).forEach((corner, i) => {
      expect(distance(corner, truth[i]!)).toBeLessThan(2);
    });
  });

  it('is robust to text crossing the band', () => {
    // Dark "text" blocks inside the paper, some of them within the band.
    const base = paperScene(paper);
    const scene: Scene = (p) => {
      const v = base(p);
      if (v === null) return null;
      const inText = ((Math.floor(p.y / 40) + Math.floor(p.x / 60)) % 3 === 0) && Math.abs(p.x - 600) < 380 && Math.abs(p.y - 800) < 560;
      return inText ? 0.15 : v;
    };
    const found = detect(around, scene);
    expect(found).not.toBeNull();
    const truth = quadCorners(paper);
    quadCorners(found!).forEach((corner, i) => {
      expect(distance(corner, truth[i]!)).toBeLessThan(2);
    });
  });
});

describe('repeated-median line fit', () => {
  it('recovers a line under 40 % outliers', () => {
    const samples: { t: number; u: number }[] = [];
    for (let i = 0; i < 50; i += 1) {
      const t = i * 4;
      samples.push({ t, u: i % 5 < 2 ? 500 + i * 7 : 100 + 0.05 * t });
    }
    const { a, b } = repeatedMedianLine(samples);
    expect(a).toBeCloseTo(100, 6);
    expect(b).toBeCloseTo(0.05, 6);
  });
});

describe('frame from corners', () => {
  it('drops residuals below 1.5 px and keeps larger ones as offsets', () => {
    const current: Frame = { cx: 600, cy: 800, width: 900, height: 1250, angle: 0 };
    const exact = quadCorners(current);
    expect(frameFromCorners(exact, current).corners).toBeUndefined();
    const nudged: Quad = [{ x: exact[0]!.x + 1, y: exact[0]!.y }, exact[1]!, exact[2]!, exact[3]!];
    expect(frameFromCorners(nudged, current).corners).toBeUndefined();
    const sheared: Quad = [{ x: exact[0]!.x + 40, y: exact[0]!.y }, exact[1]!, exact[2]!, exact[3]!];
    const result = frameFromCorners(sheared, current);
    expect(result.corners).toBeDefined();
    quadCorners(result).forEach((corner, i) => {
      expect(distance(corner, sheared[i]!)).toBeLessThan(1e-6);
    });
  });
});

describe('tone detection', () => {
  function twoLevel(background: number, text: number, textFraction = 0.1): ImageData {
    const width = 100;
    const height = 100;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      const g = i < textFraction * width * height ? text : background;
      data[i * 4] = g;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = g;
      data[i * 4 + 3] = 255;
    }
    return { data, width, height, colorSpace: 'srgb' } as ImageData;
  }

  it('maps a 0.7 background to white and 0.25 text to black', () => {
    const tone = detectTone(twoLevel(179, 64));
    expect(tone).not.toBeNull();
    expect(tone!.grayscale).toBe(true);
    expect(tone!.temperature).toBe(0);
    const lut = toneLookups(tone!).g;
    expect(Math.round(lut[179]! * 255)).toBe(255);
    expect(Math.round(lut[64]! * 255)).toBe(0);
    expect(tone!.contrast).toBeGreaterThan(2);
    expect(tone!.contrast).toBeLessThan(4);
  });

  it('assumes ink half a unit below the background on a blank page', () => {
    const levels = paperLevels(luminanceHistogram(twoLevel(179, 179)));
    expect(levels).not.toBeNull();
    expect(levels!.background).toBeCloseTo(179 / 255, 6);
    expect(levels!.text).toBeCloseTo(179 / 255 - 0.5, 6);
    const tone = detectTone(twoLevel(179, 179))!;
    const lut = toneLookups(tone).g;
    expect(Math.round(lut[179]! * 255)).toBe(255);
    // 179 - 0.5 * 255 = 51.5: the level just below the assumed ink maps to black.
    expect(Math.round(lut[51]! * 255)).toBe(0);
  });

  it('clamps to the slider ranges on a very dim photo', () => {
    const tone = toneForLevels(0.3, 0.28);
    expect(tone.brightness).toBe(1.5);
    expect(tone.contrast).toBe(4);
  });

  it('returns nothing for an empty (transparent) working image', () => {
    const data = new Uint8ClampedArray(16);
    expect(detectTone({ data, width: 2, height: 2, colorSpace: 'srgb' } as ImageData)).toBeNull();
  });

  it('measures only the inner 90 % of the frame at about 500 px', () => {
    const frame: Frame = { cx: 600, cy: 800, width: 900, height: 1250, angle: 0 };
    const layout = toneWorkingLayout(frame);
    expect(Math.max(layout.width, layout.height)).toBe(500);
    expect(layout.width / layout.height).toBeCloseTo(900 / 1250, 1);
    // The frame's own nw corner lies outside the working image (5 % margin skipped).
    const nw = applyAffine(layout.transform, quadCorners(frame)[0]!);
    expect(nw.x).toBeLessThan(0);
    expect(nw.y).toBeLessThan(0);
  });
});
