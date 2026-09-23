/**
 * Camera diagnostics page (/app/diagnose.html): starts the default rear
 * camera, prints the track's settings and capabilities and the device list,
 * lets each video input be opened by tap, and reports what `probeLenses`
 * would make of the default stream. A developer aid, no part of the app
 * shell; nothing is stored or sent. DOM.
 */

import { LensSwitchError, probeLenses, startCamera, stopCamera, type CameraSession, type LensControl } from './camera';

const root = document.getElementById('diagnose')!;
const video = document.createElement('video');
video.autoplay = true;
video.playsInline = true;
video.muted = true;
video.setAttribute('playsinline', '');

const controls = document.createElement('div');
const trackInfo = document.createElement('pre');
const probeInfo = document.createElement('pre');
const deviceList = document.createElement('div');
const deviceInfo = document.createElement('pre');
const log = document.createElement('pre');

function section(title: string, ...children: HTMLElement[]): void {
  const h = document.createElement('h2');
  h.textContent = title;
  root.append(h, ...children);
}

section('Stream', controls, video);
section('Aktueller Track', trackInfo);
const wideTest = document.createElement('button');
wideTest.textContent = 'Weitwinkel wählen wie die App';
const wideInfo = document.createElement('pre');
section('probeLenses auf dem Standardstream', probeInfo, wideTest, wideInfo);
section('Geräte (antippen zum Öffnen)', deviceList, deviceInfo);
section('Fehler', log);

let session: CameraSession | null = null;
let lensControl: LensControl | null = null;

function show(pre: HTMLElement, value: unknown): void {
  pre.textContent = JSON.stringify(value, null, 2);
}

function fail(where: string, error: unknown): void {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  const message = error instanceof Error ? error.message : String(error);
  log.textContent = `${log.textContent ?? ''}${where}: ${name} ${message}\n`;
}

function describeTrack(s: CameraSession): unknown {
  const track = s.stream.getVideoTracks()[0];
  if (!track) return { error: 'kein Video-Track' };
  return {
    label: track.label,
    session: { width: s.width, height: s.height, videoWidth: s.video.videoWidth, videoHeight: s.video.videoHeight },
    settings: track.getSettings(),
    capabilities: typeof track.getCapabilities === 'function' ? track.getCapabilities() : 'getCapabilities fehlt',
  };
}

async function open(deviceId?: string): Promise<void> {
  if (session) stopCamera(session);
  session = null;
  trackInfo.textContent = '…';
  try {
    session = await startCamera(video, deviceId);
    show(deviceId ? deviceInfo : trackInfo, describeTrack(session));
    if (!deviceId) {
      lensControl = await probeLenses(session);
      show(probeInfo, lensControl ? { found: true, kind: lensControl.kind } : { found: false });
    }
    await listDevices(deviceId ?? session.stream.getVideoTracks()[0]?.getSettings().deviceId);
  } catch (error) {
    fail(deviceId ? `Gerät ${deviceId.slice(0, 8)}` : 'Standardkamera', error);
  }
}

async function listDevices(currentId?: string): Promise<void> {
  deviceList.replaceChildren();
  if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') {
    deviceList.textContent = 'enumerateDevices fehlt';
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'videoinput');
    for (const d of inputs) {
      const b = document.createElement('button');
      b.textContent = `${d.label || '(ohne Label)'} · ${d.deviceId.slice(0, 8)}`;
      b.classList.toggle('active', d.deviceId === currentId);
      b.addEventListener('click', () => void open(d.deviceId));
      deviceList.append(b);
    }
    const pre = document.createElement('pre');
    show(pre, inputs.map((d) => ({ label: d.label, deviceId: d.deviceId, groupId: d.groupId })));
    deviceList.append(pre);
  } catch (error) {
    fail('enumerateDevices', error);
  }
}

/** The app's own path: `select('wide')` on the probed control, result or error on the page. */
async function testWide(): Promise<void> {
  if (!lensControl || !session) {
    wideInfo.textContent = 'Erst die Standardkamera starten (und probeLenses muss etwas gefunden haben).';
    return;
  }
  wideInfo.textContent = '…';
  const started = performance.now();
  try {
    session = await lensControl.select('wide');
    show(wideInfo, { ok: true, ms: Math.round(performance.now() - started), track: describeTrack(session) });
  } catch (error) {
    const fallback = error instanceof LensSwitchError ? error.fallback : null;
    session = fallback;
    const cause = error instanceof LensSwitchError ? error.cause : error;
    const causeName = typeof cause === 'object' && cause !== null && 'name' in cause ? String((cause as { name: unknown }).name) : '';
    show(wideInfo, {
      ok: false,
      ms: Math.round(performance.now() - started),
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      cause: `${causeName} ${cause instanceof Error ? cause.message : String(cause)}`,
      fallback: fallback ? 'Standardstream läuft wieder' : 'kein Stream mehr',
    });
  }
}
wideTest.addEventListener('click', () => void testWide());

const start = document.createElement('button');
start.textContent = 'Standardkamera starten';
start.addEventListener('click', () => void open());
const stop = document.createElement('button');
stop.textContent = 'Stoppen';
stop.addEventListener('click', () => {
  if (session) stopCamera(session);
  session = null;
});
controls.append(start, stop);

show(trackInfo, { userAgent: navigator.userAgent });
