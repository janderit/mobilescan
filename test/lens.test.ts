// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isFixedFocus, LensSwitchError, probeLenses, START_ATTEMPTS, type CameraSession, type LensControl, type LensEnvironment } from '../src/camera';

const noWait = (): Promise<void> => Promise.resolve();

/** A session over a fake track; `getCapabilities` and `getSettings` are what the probe reads. */
function fakeSession(track: Partial<MediaStreamTrack>, video = document.createElement('video')): CameraSession {
  const stop = vi.fn();
  const full = { stop, ...track } as unknown as MediaStreamTrack;
  const stream = { getVideoTracks: () => [full], getTracks: () => [full] } as unknown as MediaStream;
  return { stream, video, width: 3000, height: 4000 };
}

function device(deviceId: string, label: string, kind: MediaDeviceKind = 'videoinput'): MediaDeviceInfo {
  return { deviceId, label, kind, groupId: '', toJSON: () => ({}) };
}

describe('probeLenses (v1.2)', () => {
  const noEnv: LensEnvironment = { enumerateDevices: undefined, start: vi.fn(), wait: noWait };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the zoom range below 1 when the track has one and keeps the session', async () => {
    const applyConstraints = vi.fn(() => Promise.resolve());
    const session = fakeSession({
      getCapabilities: () => ({ zoom: { min: 0.5, max: 8 } }) as MediaTrackCapabilities,
      getSettings: () => ({ zoom: 1 }) as MediaTrackSettings,
      applyConstraints,
    });
    const control = (await probeLenses(session, noEnv)) as LensControl;
    expect(control.kind).toBe('zoom');
    expect(await control.select('wide')).toBe(session);
    expect(applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ zoom: 0.5 }] });
    expect(await control.select('default')).toBe(session);
    expect(applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ zoom: 1 }] });
  });

  it('a rejected zoom keeps the running session as the fallback', async () => {
    const session = fakeSession({
      getCapabilities: () => ({ zoom: { min: 0.6, max: 4 } }) as MediaTrackCapabilities,
      getSettings: () => ({}) as MediaTrackSettings,
      applyConstraints: () => Promise.reject(new Error('no')),
    });
    const control = (await probeLenses(session, noEnv)) as LensControl;
    const error = await control.select('wide').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LensSwitchError);
    expect((error as LensSwitchError).fallback).toBe(session);
  });

  it('falls back to a second rear device by its ultra-wide label, stopping the first stream', async () => {
    const video = document.createElement('video');
    const session = fakeSession({ getSettings: () => ({ deviceId: 'main' }) as MediaTrackSettings }, video);
    const wideSession = fakeSession({ getSettings: () => ({ deviceId: 'uw' }) as MediaTrackSettings }, video);
    const start = vi.fn((_video: HTMLVideoElement, deviceId?: string) => Promise.resolve(deviceId ? wideSession : session));
    const env: LensEnvironment = {
      enumerateDevices: () =>
        Promise.resolve([
          device('front', 'Frontkamera'),
          device('main', 'Rückkamera'),
          device('uw', 'Rückkamera (Ultraweitwinkel)'),
          device('mic', 'Mikrofon', 'audioinput'),
        ]),
      start,
      wait: noWait,
    };
    const control = (await probeLenses(session, env)) as LensControl;
    expect(control.kind).toBe('device');
    expect(await control.select('wide')).toBe(wideSession);
    expect(session.stream.getTracks()[0]!.stop).toHaveBeenCalled();
    expect(start).toHaveBeenLastCalledWith(video, 'uw');
    expect(await control.select('default')).toBe(session);
    expect(start).toHaveBeenLastCalledWith(video, undefined);
  });

  it('a wide device that does not open brings the default stream back as the fallback', async () => {
    const video = document.createElement('video');
    const session = fakeSession({ getSettings: () => ({ deviceId: 'main' }) as MediaTrackSettings }, video);
    const restarted = fakeSession({ getSettings: () => ({ deviceId: 'main' }) as MediaTrackSettings }, video);
    const start = vi.fn((_video: HTMLVideoElement, deviceId?: string) =>
      deviceId ? Promise.reject(new DOMException('busy', 'NotReadableError')) : Promise.resolve(restarted),
    );
    const env: LensEnvironment = {
      enumerateDevices: () => Promise.resolve([device('main', 'Back Camera'), device('uw', 'Back Ultra Wide Camera')]),
      start,
      wait: noWait,
    };
    const control = (await probeLenses(session, env)) as LensControl;
    const error = (await control.select('wide').catch((e: unknown) => e)) as LensSwitchError;
    expect(error).toBeInstanceOf(LensSwitchError);
    expect(error.fallback).toBe(restarted);
  });

  /** The Samsung S22 as Chrome reports it: two rear devices, the ultra-wide (camera 2) without autofocus. */
  const S22_MAIN = { focusMode: ['manual', 'single-shot', 'continuous'], zoom: { min: 1, max: 10 } } as unknown as MediaTrackCapabilities;
  const S22_ULTRA = { focusMode: ['manual'], zoom: { min: 1, max: 8 } } as unknown as MediaTrackCapabilities;
  const S22_DEVICES = [
    device('front1', 'camera 1, facing front'),
    device('front3', 'camera 3, facing front'),
    device('cam2', 'camera 2, facing back'),
    device('cam0', 'camera 0, facing back'),
  ];

  it('tells the fixed-focus ultra-wide from a focusing lens', () => {
    expect(isFixedFocus(S22_ULTRA)).toBe(true);
    expect(isFixedFocus(S22_MAIN)).toBe(false);
    expect(isFixedFocus({} as MediaTrackCapabilities)).toBe(false);
  });

  it('on Chrome labels, opens the other rear devices on the first wide select and keeps the fixed-focus one', async () => {
    const video = document.createElement('video');
    const main = fakeSession({ getCapabilities: () => S22_MAIN, getSettings: () => ({ deviceId: 'cam0' }) as MediaTrackSettings }, video);
    const ultra = fakeSession({ getCapabilities: () => S22_ULTRA, getSettings: () => ({ deviceId: 'cam2' }) as MediaTrackSettings }, video);
    const start = vi.fn((_video: HTMLVideoElement, deviceId?: string) => Promise.resolve(deviceId === 'cam2' ? ultra : main));
    const env: LensEnvironment = { enumerateDevices: () => Promise.resolve(S22_DEVICES), start, wait: noWait };
    const control = (await probeLenses(main, env)) as LensControl;
    expect(control.kind).toBe('device');
    // No stream swap at probe time: the trial waits for the first tap.
    expect(start).not.toHaveBeenCalled();
    expect(await control.select('wide')).toBe(ultra);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenLastCalledWith(video, 'cam2');
    expect(await control.select('default')).toBe(main);
    // The second time the wide device is known: opened directly.
    start.mockClear();
    expect(await control.select('wide')).toBe(ultra);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenLastCalledWith(video, 'cam2');
  });

  it('skips a focusing candidate (telephoto) and gives up without a fixed-focus one, default restored', async () => {
    const video = document.createElement('video');
    const main = fakeSession({ getCapabilities: () => S22_MAIN, getSettings: () => ({ deviceId: 'cam0' }) as MediaTrackSettings }, video);
    const tele = fakeSession({ getCapabilities: () => S22_MAIN, getSettings: () => ({ deviceId: 'cam3' }) as MediaTrackSettings }, video);
    const start = vi.fn((_video: HTMLVideoElement, deviceId?: string) => Promise.resolve(deviceId === 'cam3' ? tele : main));
    const env: LensEnvironment = {
      enumerateDevices: () => Promise.resolve([device('cam0', 'camera 0, facing back'), device('cam3', 'camera 3, facing back')]),
      start,
      wait: noWait,
    };
    const control = (await probeLenses(main, env)) as LensControl;
    const error = (await control.select('wide').catch((e: unknown) => e)) as LensSwitchError;
    expect(error).toBeInstanceOf(LensSwitchError);
    expect(error.fallback).toBe(main);
    expect(tele.stream.getTracks()[0]!.stop).toHaveBeenCalled();
    expect(start.mock.calls.map((c) => c[1])).toEqual(['cam3', undefined]);
    // Once exhausted, a later select fails at once and leaves the running stream alone.
    start.mockClear();
    const again = (await control.select('wide').catch((e: unknown) => e)) as LensSwitchError;
    expect(again.fallback).toBe(main);
    expect(start).not.toHaveBeenCalled();
  });

  it('retries a camera start that Chrome refuses right after a stop, and gives up on a denial at once', async () => {
    const video = document.createElement('video');
    const main = fakeSession({ getCapabilities: () => S22_MAIN, getSettings: () => ({ deviceId: 'cam0' }) as MediaTrackSettings }, video);
    const ultra = fakeSession({ getCapabilities: () => S22_ULTRA, getSettings: () => ({ deviceId: 'cam2' }) as MediaTrackSettings }, video);
    let refusals = 2;
    const start = vi.fn((_video: HTMLVideoElement, deviceId?: string) => {
      if (deviceId === 'cam2' && refusals > 0) {
        refusals -= 1;
        return Promise.reject(new DOMException('Could not start video source', 'NotReadableError'));
      }
      return Promise.resolve(deviceId === 'cam2' ? ultra : main);
    });
    const wait = vi.fn(noWait);
    const env: LensEnvironment = { enumerateDevices: () => Promise.resolve(S22_DEVICES), start, wait };
    const control = (await probeLenses(main, env)) as LensControl;
    expect(await control.select('wide')).toBe(ultra);
    expect(start).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);

    const denied = vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError')));
    const deniedControl = (await probeLenses(main, { ...env, start: denied })) as LensControl;
    await deniedControl.select('wide').catch(() => undefined);
    // One attempt for the candidate, one for the restore: no retries on a denial.
    expect(denied).toHaveBeenCalledTimes(2);
    expect(denied.mock.calls.length).toBeLessThan(START_ATTEMPTS);
  });

  it('yields null with a single rear device, no zoom range, or no device list', async () => {
    const plain = fakeSession({ getSettings: () => ({ deviceId: 'main' }) as MediaTrackSettings });
    const env: LensEnvironment = {
      enumerateDevices: () => Promise.resolve([device('front', 'Front Camera'), device('main', 'Back Camera')]),
      start: vi.fn(),
    };
    expect(await probeLenses(plain, env)).toBeNull();
    expect(await probeLenses(plain, noEnv)).toBeNull();
    const zoomFromOne = fakeSession({
      getCapabilities: () => ({ zoom: { min: 1, max: 8 } }) as MediaTrackCapabilities,
      getSettings: () => ({ deviceId: 'main' }) as MediaTrackSettings,
    });
    expect(await probeLenses(zoomFromOne, env)).toBeNull();
    // Sessions from the other tests carry no video track at all.
    const bare = { stream: { getTracks: () => [] } as unknown as MediaStream, video: document.createElement('video'), width: 1, height: 1 };
    expect(await probeLenses(bare, noEnv)).toBeNull();
  });
});
