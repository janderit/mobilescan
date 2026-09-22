/** Small DOM helpers shared by the views. */

export function iconButton(icon: string, label: string, className = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-button ${className}`.trim();
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  button.querySelector('svg')?.setAttribute('aria-hidden', 'true');
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
