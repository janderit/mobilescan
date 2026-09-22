/**
 * Update check and in-app update for the installed PWA.
 *
 * The build writes `version.json` (`{ version, build }`) next to the app. It is
 * not precached by the service worker and served with `Cache-Control: no-cache`,
 * so fetching it with `cache: 'no-store'` always reflects the deployed build.
 * When the file names a different build than the running one, the start page
 * shows an update button; applying the update asks the browser to fetch the
 * new service worker, tells it to skip waiting once installed and reloads when
 * it has taken control. Offline, unreachable or malformed responses count as
 * "no update" so the user is never bothered without network.
 */

export interface BuildInfo {
  version: string;
  build: string;
}

/** What the app shell needs from the update machinery (mocked in tests). */
export interface UpdateChecker {
  /** Resolves true when the server has a build other than the running one. */
  check(): Promise<boolean>;
  /** Activates the new build and reloads the page; never resolves normally in production. */
  apply(): Promise<void>;
}

export interface UpdateServiceOptions {
  current: BuildInfo;
  /** URL of `version.json`, relative to the page. */
  url: string;
  fetch?: typeof fetch;
  isOnline?: () => boolean;
  serviceWorker?: ServiceWorkerContainer | null;
  reload?: () => void;
  /** Time to wait for the new worker before falling back to a plain reload. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Parses the version file; null unless it carries both fields as strings. */
export function parseBuildInfo(data: unknown): BuildInfo | null {
  if (typeof data !== 'object' || data === null) return null;
  const { version, build } = data as Record<string, unknown>;
  if (typeof version !== 'string' || typeof build !== 'string') return null;
  return { version, build };
}

export function isNewerBuild(current: BuildInfo, remote: BuildInfo): boolean {
  return remote.version !== current.version || remote.build !== current.build;
}

export class UpdateService implements UpdateChecker {
  private readonly current: BuildInfo;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch | null;
  private readonly isOnline: () => boolean;
  private readonly serviceWorker: ServiceWorkerContainer | null;
  private readonly reload: () => void;
  private readonly timeoutMs: number;

  constructor(options: UpdateServiceOptions) {
    this.current = options.current;
    this.url = options.url;
    this.fetchImpl =
      options.fetch ?? (typeof fetch === 'function' ? (input, init) => fetch(input, init) : null);
    this.isOnline = options.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
    this.serviceWorker =
      options.serviceWorker !== undefined
        ? options.serviceWorker
        : typeof navigator !== 'undefined'
          ? (navigator.serviceWorker ?? null)
          : null;
    this.reload = options.reload ?? (() => window.location.reload());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async check(): Promise<boolean> {
    if (!this.fetchImpl || !this.isOnline()) return false;
    try {
      const response = await this.fetchImpl(this.url, { cache: 'no-store' });
      if (!response.ok) return false;
      const remote = parseBuildInfo(await response.json());
      return remote !== null && isNewerBuild(this.current, remote);
    } catch {
      return false;
    }
  }

  async apply(): Promise<void> {
    const registration = await this.serviceWorker?.getRegistration().catch(() => undefined);
    if (!this.serviceWorker || !registration) {
      this.reload();
      return;
    }
    const sw = this.serviceWorker;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sw.removeEventListener('controllerchange', finish);
        resolve();
      };
      // The new worker has taken over: the reload below is served by its cache.
      sw.addEventListener('controllerchange', finish);
      // Nothing arrived in time (or sw.js did not change): reload anyway.
      const timer = setTimeout(finish, this.timeoutMs);

      const activate = (worker: ServiceWorker) => worker.postMessage({ type: 'SKIP_WAITING' });
      const watch = (worker: ServiceWorker) => {
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed') activate(worker);
        });
      };

      if (registration.waiting) {
        activate(registration.waiting);
      } else if (registration.installing) {
        watch(registration.installing);
      }
      registration.addEventListener('updatefound', () => {
        if (registration.installing) watch(registration.installing);
      });
      registration.update().catch(() => {
        // Could not fetch sw.js: the timeout falls back to a plain reload.
      });
    });
    this.reload();
  }
}
