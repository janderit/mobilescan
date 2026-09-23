/**
 * Session settings: flags that are fixed for now and may become user settings
 * later. Plain in-memory state, never persisted (the app keeps no storage);
 * every app start begins with the defaults. No DOM.
 */

export interface Settings {
  /**
   * Complete the fourth edge of a document from the DIN A aspect ratio when
   * three edges were found (pages in a spiral block, whose bound edge the
   * edge search does not find). v1.1.
   */
  completeDinEdge: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = { completeDinEdge: true };

/** The session's settings; mutate in place to change them for the rest of the session. */
export const settings: Settings = { ...DEFAULT_SETTINGS };
