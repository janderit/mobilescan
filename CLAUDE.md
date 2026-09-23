# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Versions v0.1 through v0.12 are implemented: capture + share, crop/rotate, brightness/contrast,
UI polish, multi-page PDFs, loupe previews while dragging, shear / perspective correction,
auto-detect for frame and tone, pinch zoom in the captured and edit views, live document
detection in the camera view with auto-bake on capture, sharing a single page as a JPEG, and the
frozen still of the green moment for a shutter pressed right after it. The repository contains the product spec
(`README.md`), design intent documents with per-version definitions, icons and mockups
(`intent/`), and the TypeScript + Vite app (`src/`, `test/`, `scripts/`, `public/`).

## Commands

- `npm install`: install dependencies.
- `npm run dev`: starts the Vite dev server with `--host` and a self-signed HTTPS cert
  (`@vitejs/plugin-basic-ssl`), so a phone on the same LAN can open it and grant camera access.
  Accept the self-signed certificate warning on the phone once.
- `npm run build`: renders the app icons from `intent/icons/app-icon.svg` (`npm run icons`),
  renders the product page (`npm run site`), type-checks (`tsc --noEmit`), then builds the static
  site into `dist/`.
- `npm run site`: renders `site/index.template.html` to the git-ignored `site/index.html`
  (`scripts/render-site.mjs`), filling the `{{IMPRINT_*}}` placeholders of the Impressum from the
  `IMPRINT_*` variables in `.env`. Contact data must never be committed; edit the template, not
  the output. Without a `.env` the placeholders from `.env.example` are used.
- `npm test`: runs the Vitest suite (`test/**/*.test.ts`).
- `npm run lint`: runs ESLint.
- `npm run deploy`: builds, then runs `scripts/deploy.sh`, which copies `dist/` to
  `$DEPLOY_PATH/app/` (the PWA is served at https://mobilescan.app/app/, Vite `base: '/app/'`)
  and `site/index.html` to `$DEPLOY_PATH/index.html` (the product page at the site root).
  Reads `DEPLOY_HOST` and `DEPLOY_PATH` from a git-ignored `.env` (copy `.env.example` to start one).
- The start page shows `v<package.json version> (<git short hash>.<build moment hash>)`, injected
  at build time via `define` in `vite.config.ts`, so it is visible on the phone whether an update
  has arrived. The build moment hash is the first four hex characters of the SHA-256 of the build's
  ISO datetime, so a redeploy of an unchanged version and commit still counts as an update.
  Bump `version` in `package.json` when releasing.
- Updates: the build also writes `dist/version.json` (`{ version, build }`, plugin `versionFile`
  in `vite.config.ts`). It is excluded from the service worker precache and served `no-cache`
  (`public/.htaccess`). `src/update.ts` fetches it with `cache: 'no-store'` whenever the start
  page is shown or becomes visible (at most once a minute, never while `navigator.onLine` is
  false; any failure counts as "no update"). A differing build shows the icon-only update button
  under the start button; tapping it runs `registration.update()`, posts `SKIP_WAITING` to the
  new worker once installed, and reloads on `controllerchange` (plain reload after 15 s as a
  fallback). The service worker uses `registerType: 'prompt'`, so a new worker waits instead of
  taking over a running scan; closing the app also lets it activate.

Layout: `src/` app code, `test/` Vitest specs, `scripts/` build/deploy tooling
(`render-icons.mjs`, `render-site.mjs`, `deploy.sh`), `public/` static files served as-is under
`/app/`, including `.htaccess` for the Apache MIME types and cache headers uberspace needs, `site/`
the bilingual (DE/EN) product page with Impressum and Datenschutzhinweis, deployed to the site root
(template in the repo, rendered file git-ignored). Inside `src/`: `geometry.ts` is a barrel over
`angles.ts`, `affine.ts`, `homography.ts`, `frame.ts` and `layout.ts`; the app shell `app.ts` holds
the state machine and the transitions (`main.ts` only mounts it, so jsdom tests can drive it) over
three helpers: `screen-switcher.ts` (the cross-fade), `overlays.ts` (busy spinner, error notice and
`run`, the one place work goes behind the spinner) and `page-flow.ts` (park, wake and bake pages
over `scan.ts`); the screens are in `start-view.ts`, `error-view.ts` (camera errors), `camera-view.ts` (video, overlay,
live detector, detect toggle), `captured-view.ts` (page header, stage, button bar, popover, share
sheet), `editor.ts` (plus `loupe-cluster.ts`) and `tone-view.ts`; `frame-overlay.ts` is the SVG
shade-with-hole (and outline) the camera and crop/rotate views draw over their stages; `update-prompt.ts` drives the
start page's update button over `update.ts`; `scan.ts` owns the page list over `pages.ts`.
`detect.ts` is the canvas glue (`DetectScratch`, `detectFrameIn`) and a barrel over
`detect-edges.ts`, `detect-frame.ts`, `detect-tracker.ts` and `detect-tone.ts`, and `live-detect.ts`
runs it on the video and on the still after the shutter (`detectStill`); `color.ts` holds the
luminance coefficients the tone chain and the detection share, and `canvas.ts` the display caps
(`MAX_DPR`, `MAX_DEVICE_PIXELS_PER_IMAGE_PIXEL`) the zoom and the loupes obey. Every module starts
with a header comment that states its job and its purity (DOM or not); read it before editing.

Read in this order before implementing anything:

1. `README.md`: the authoritative UX spec.
2. `intent/2026-09-22-spec-assessment-and-decisions.md`: decisions that resolve gaps in the spec.
3. `intent/README.md` and the version file you are working on (`intent/v0.1-mvp.md` ... `intent/v0.12-frozen-still.md`).

Icons live in `intent/icons/` (24x24 stroke SVGs, use them verbatim in the app). Mockups in
`intent/mockups/` are generated: edit `intent/mockups/generate.py` and run
`python3 intent/mockups/generate.py`; never hand-edit the SVG output.

## What MobileScan is

A progressive web app (PWA) for scanning paper documents on Android and iPhone and saving them as PDFs.

Hard constraints from the spec that shape every design decision:

- **Local only.** All image processing happens in the browser. No data leaves the device except via the OS share-to target the user picks. No server component exists and none should be added.
- **Static hosting.** Deployed as static files to uberspace (https://mobilescan.app), served by Apache, copied via an scp script that reads `DEPLOY_HOST` and `DEPLOY_PATH` from a git-ignored `.env`. Anything that requires a backend or server-side rendering is out of scope.
- **No retention.** After a successful share, the image is discarded. Do not add persistence (localStorage, IndexedDB, caches of scans). The service worker precaches the app shell only.
- **Icons, not labels.** UI buttons carry icons only. The visible texts are the German start button "Dokument scannen" and, since the file icons alone proved unintuitive, the short captions "Klein / Mittel / Groß" under the compression icons in the share sheet. Accessibility labels are German `aria-label`s.
- **Target browsers.** Modern mobile Safari and Chrome only. No desktop or file-input fallback for the camera.

## Core UX model (spec plus decisions)

The capture frame is the central concept. These are the invariants an implementer must not break;
the intent files hold the reasoning, the named constants in the code hold the numbers.

- **The frame is geometry, not pixels.** The camera shows a dashed DIN A-format frame (1:sqrt2,
  portrait) fitted into the *visible* part of the cover-cropped video; the full camera image is
  captured and kept, and the frame (`cx, cy, width, height` in image pixels) says which part is the
  document. Cropping only updates the frame; the margin around it is the material that rotation and
  shear work with. Handles operate in frame-local coordinates, the image stays still on screen and
  the frame moves. The frame may stick out of the image (white fill on bake), but a drag may not
  push it out further, and every edge keeps at least `MIN_FRAME_FRACTION` of the image width.
- **`Frame` vs `UprightFrame`** (`src/model.ts`). `Frame` may carry a rotation `angle` and corner
  offsets `corners` (frame-local `[nw, ne, se, sw]`, present only when an offset reaches
  `CORNER_EPSILON`; build them through `withCorners` in `src/frame.ts` so `hasCornerOffsets` and
  `corners !== undefined` agree). `UprightFrame` (`angle: 0`, no `corners`) is the type of every
  stored frame (`Page.frame`, `Capture.frame`), of `initialFrame` and of every bake result, so the
  compiler rejects a pending frame reaching a stage, the share code or a page. Only the crop/rotate
  view's pending frame, detection results and the editing helpers use `Frame`; `uprightFrame`
  converts once angle 0 and no offsets are established and throws otherwise.
- **Angle sign convention.** `angle` is the frame's rotation relative to the image, positive =
  clockwise on screen (y-down). Fine rotation is clamped to `MAX_SKEW` around the nearest right
  angle; the "rotate 90° right" button *subtracts* 90°, swaps width and height and permutes the
  corner offsets so the quadrilateral turns rigidly with the image. The crop/rotate view draws the
  image turned by the base angle (multiples of 90°) so the frame appears upright; during fine
  rotation only the frame turns (`intent/2026-09-22-spec-assessment-and-decisions.md`).
- **Crop and shear share one mode.** [crop+shear|rotate], crop+shear the default with all eight
  handles: an edge handle crops the rectangle and keeps the offsets, a corner handle moves that
  corner's offset alone, clamped so the quadrilateral stays convex and no corner leaves the image
  beyond where it already is. The frame body cannot be dragged. The frame is drawn as the
  quadrilateral with the shade following it; loupes (`src/loupe.ts`, `src/editor.ts`) magnify the
  affected corners during a drag and never take pointer events.
- **Bake semantics** (`src/bake.ts`). Confirm in the crop/rotate view resamples the whole image
  once: rotation alone through `bakeLayout`, rotation plus offsets through the homography of
  `warpLayout` and `src/warp.ts`, with white fill in exposed areas under the pixel cap
  `MAX_CAPTURE_PIXELS`. Afterwards the frame is the upright target rectangle without offsets;
  `frameNeedsBake` says whether pixel work is needed at all. Baking runs behind the busy overlay,
  deferred until it has painted; a failed bake leaves image and frame untouched and shows the notice.
- **Tone chain.** One slider with a segmented toggle (brightness, contrast, colour temperature;
  neutral always at the slider centre) plus a grayscale toggle. The preview is the CSS filter chain
  `brightness(b) contrast(c) url(#temperature) grayscale(1)` on the display canvas (no pixel work
  while dragging, the temperature step is an inline SVG `feColorMatrix`); confirm bakes the same
  chain into the whole image through the 2D context `filter` property when it consists of shorthand
  functions only, otherwise through the per-pixel loop in `src/tone.ts`, which mirrors the Filter
  Effects spec so both paths agree. Neutral values leave the image untouched; values reset to
  neutral on each visit and edits accumulate in the image.
- **Auto-detect.** The wand buttons of both edit views and the live loop share the pipeline in
  `src/detect.ts`: `sampleImage` (`src/canvas.ts`) renders a working copy through an affine
  transform, transparent where the image does not reach so those pixels never count, and pure
  `ImageData` maths runs on it; see the constants in `src/detect-edges.ts`, `src/detect-frame.ts`
  and `src/detect-tone.ts`. The wand keeps partial results and shows a pending frame or tone;
  nothing found calls `onNotice` and keeps the current state. Synchronous, no busy overlay; the tone
  wand measures the source image, not the preview.
- **Live detect and the capture rule.** The camera view runs the strict rule (`detectFrameStrict`)
  on the video with `DetectionTracker` hysteresis (`src/live-detect.ts`) and turns the outline green
  on a hit. The toggle right of the shutter is session state, on by default, never persisted. On
  capture with the toggle on, the still is detected once more from the scaled static frame; a hit
  becomes the page frame and is baked behind the busy overlay (the page is created with the static
  frame, so a failed bake leaves it), a miss keeps the static frame and shows the notice if the
  outline was green. The live result is never used for the bake. There is no automatic capture.
  When the outline turns green the camera view grabs a still at once and keeps it for
  `FROZEN_STILL_MS`; the shutter (`takeStill`) uses it when it is younger than that, the outline
  is still green and the live corners agree with the frozen ones within `AGREE_FRACTION`, else a
  fresh grab. The frozen still is released (width 0) with the window, on loss, toggle off,
  relayout and close. The shutter fires on `pointerdown`; the following click finds no session.
- **Share.** Three compression levels (`src/quality.ts`); every page's frame region is encoded as
  JPEG in order and placed on a fixed A4 page scaled to fit (orientation follows the crop, borders
  on one axis accepted; `src/pdf.ts`), and one PDF goes to the Web Share API. With exactly one
  page the share button first opens a popover (PDF | image) above itself; image shares the frame
  region's JPEG itself (`buildJpegFile`, same encoder and levels, `scan-<stamp>.jpg`) after the
  same sheet. With several pages share opens the sheet for the PDF directly. The format is
  session state (`format` in the app state), never persisted. Success returns to
  the start page and discards every page; cancel keeps the captured view; failure shows the notice.
  Both popovers of the captured view are anchored above their button (`--anchor-x`, measured on
  render), not at a fixed offset from the right edge.
- **Multi-page memory rule.** A scan is a list of pages (`src/scan.ts`, `src/pages.ts`) of which
  only the current one holds a full-resolution canvas; the others are parked as full-image JPEG
  blobs and woken behind the busy overlay. A page is re-encoded only when a bake changed it
  (`dirty`); cropping only updates its frame. [+] parks the current page and opens the camera, the
  capture is appended and becomes current; camera back after [+] returns to the page shown before.
  Back with several pages removes the current page; with one page it is the retake. "n/m" in the
  page header is the second text exception. Soft limit `MAX_PAGES`. Page switches push no history
  entry.
- **Zoom is view state only.** Pinch, one-finger pan and double tap on the captured, crop/rotate and
  tone stages (`src/zoom.ts`, `src/zoom-gesture.ts`, `src/zoom-stage.ts`, `src/frame-stage.ts`)
  compose a similarity on top of the fitted transform; it is never stored, baked or shared, scale 1
  is always the fitted view, and it resets on every entry to a view, on 90° and on every new capture
  in the stage. `ZoomStage` owns the canvas, the gesture and the redraw for all three views (the
  captured and tone views through `FrameStage`, which fits the frame region; the crop/rotate view
  fits the whole image at its base angle) and hands pointer events to the gesture first; handles
  keep priority over the pan, rotate mode keeps one finger for rotation, a second finger cancels a
  drag without moving the pending frame, and page swipes work only in the fitted view. The stage canvas has the stage size in device
  pixels (`MAX_DPR`) and draws only the visible source rectangle, so memory does not grow with the
  zoom.
- **History and back.** Every screen change pushes a history entry and `popstate` acts as the
  current screen's back button (`src/navigation.ts`), so hardware back never leaves the app
  mid-scan. Camera failures show the icon-only error screen whose status label names the cause.
  Backgrounding the page stops the camera stream and returning restarts it.
- **Motion.** Screens cross-fade in `FADE_MS` (written to `--fade` on the root), the popovers scale
  in from their button, a white flash plus vibration confirms the shutter, the live outline's
  colour transitions; all off under `prefers-reduced-motion`. Notices show the warning icon for
  `NOTICE_MS` over the current view.
- **No persistence.** Pages, frames, tones, zoom and the live-detect toggle live in memory for the
  session; nothing is written to storage, and the service worker precaches only the app shell.

Screens: start → camera (or camera error) → captured image [back] [share] [edit] [+] → share popover (PDF, image; single page only) → share sheet; edit popover (crop/rotate, brightness/contrast).
Camera view: [back] top-left, [shutter] with the live-detect toggle to its right, dashed outline (grey static frame or green detected document).
Crop/rotate view: [back] [crop+shear|rotate] [rotate 90 right] [auto] [confirm], with loupes in the stage centre during drags. Brightness/contrast view: [back] [brightness|contrast|temperature] [grayscale toggle] [auto] [confirm].

## Version roadmap

v0.1 capture + share (MVP) → v0.2 crop/rotate → v0.3 brightness/contrast → v0.4 UI polish →
v0.5 multi-page PDFs → v0.6 loupe previews → v0.7 shear → v0.8 auto-detect → v0.9 pinch zoom →
v0.10 live detect → v0.11 share as JPEG → v0.12 frozen still. Each version is independently deployable. Do not pull features from a later version into an earlier one.
