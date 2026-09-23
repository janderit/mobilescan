/** Small DOM helpers shared by the views. */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An SVG element with the given attributes. */
export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** A pointer event's position in CSS pixels relative to `element`'s top-left corner. */
export function pointIn(element: Element, event: PointerEvent): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/** An HTML element with a class and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

export function iconButton(icon: string, label: string, className = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-button ${className}`.trim();
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  button.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  return button;
}

/**
 * An on/off switch (`role="switch"`, `aria-checked`): a track with a knob
 * that carries the icon, so the meaning stays icon-only. The caller sets
 * `aria-checked`.
 */
export function switchButton(icon: string, label: string, className = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `switch ${className}`.trim();
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-checked', 'false');
  const knob = document.createElement('span');
  knob.className = 'switch-knob';
  knob.innerHTML = icon;
  knob.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  const track = document.createElement('span');
  track.className = 'switch-track';
  track.append(knob);
  button.append(track);
  return button;
}

/** A radio-style icon button for a segmented control. */
export function segmentButton(icon: string, label: string, onSelect: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  button.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  button.addEventListener('click', onSelect);
  return button;
}

/**
 * Resolves after the browser has painted the current DOM state: two animation
 * frames, so an overlay shown just before is on screen before heavy
 * synchronous work starts.
 */
export function afterPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** True when the user asked the OS for less motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
