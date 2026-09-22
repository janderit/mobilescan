# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

v0.1 (capture + share) and v0.2 (crop/rotate) are implemented; next is v0.3 (brightness/contrast). The repository contains the product spec (`README.md`),
design intent documents with per-version definitions, icons and mockups (`intent/`), and the
TypeScript + Vite app (`src/`, `test/`, `scripts/`, `public/`).

## Commands

- `npm install`: install dependencies.
- `npm run dev`: starts the Vite dev server with `--host` and a self-signed HTTPS cert
  (`@vitejs/plugin-basic-ssl`), so a phone on the same LAN can open it and grant camera access.
  Accept the self-signed certificate warning on the phone once.
- `npm run build`: renders the app icons from `intent/icons/app-icon.svg` (`npm run icons`),
  type-checks (`tsc --noEmit`), then builds the static site into `dist/`.
- `npm test`: runs the Vitest suite (`test/**/*.test.ts`).
- `npm run lint`: runs ESLint.
- `npm run deploy`: builds, then runs `scripts/deploy.sh`, which copies `dist/` to
  `$DEPLOY_PATH/app/` (the PWA is served at https://mobilescan.app/app/, Vite `base: '/app/'`)
  and `site/index.html` to `$DEPLOY_PATH/index.html` (the product page at the site root).
  Reads `DEPLOY_HOST` and `DEPLOY_PATH` from a git-ignored `.env` (copy `.env.example` to start one).
- The start page shows `v<package.json version> (<git short hash>)`, injected at build time via
  `define` in `vite.config.ts`, so it is visible on the phone whether an update has arrived.
  Bump `version` in `package.json` when releasing.

Layout: `src/` app code, `test/` Vitest specs, `scripts/` build/deploy tooling
(`render-icons.mjs`, `deploy.sh`), `public/` static files served as-is under `/app/`, including
`.htaccess` for the Apache MIME types and cache headers uberspace needs, `site/` the static
product page deployed to the site root.

Read in this order before implementing anything:

1. `README.md`: the authoritative UX spec.
2. `intent/2026-09-22-spec-assessment-and-decisions.md`: decisions that resolve gaps in the spec.
3. `intent/README.md` and the version file you are working on (`intent/v0.1-mvp.md` ... `intent/v0.4-ui-polish.md`).

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

The capture frame is the central concept:

- Camera view shows a dashed DIN A-format frame (1:sqrt2) in portrait, 90% of the *visible* captured width (the video is displayed with `object-fit: cover`, which crops the sides of a 3:4 camera image on tall phones; the frame is fitted into the visible part so the dashes are always on screen). The full image is captured and kept; only the frame area is displayed. The margin, at least 10%, exists so that later rotation/cropping has material to work with.
- **Cropping never modifies pixels.** It only updates the stored frame geometry (`cx, cy, width, height, angle` in image pixels). Crop handles (four edges independently, four corners moving two edges) operate in frame-local coordinates, because the frame may already be rotated. The image stays still on screen; the frame is what moves and rotates. Aspect is free; the frame may not leave the image.
- **Rotation:** dragging around the frame boundary gives fine skew correction, clamped to ±15° around the nearest right angle. A separate "rotate 90° right" button turns in 90° steps and swaps frame width/height. Both accumulate in `angle` and are baked into the image on confirm, with white fill in exposed areas, after which `angle` is 0 again. Sign convention: `angle` is the frame's rotation relative to the image, positive = clockwise on screen (y-down); the 90° button *subtracts* 90° so the baked image turns clockwise. Display in the crop/rotate view (decision 2026-09-22): the image is drawn turned by the base angle (multiples of 90°), so 90° taps are visible and the frame appears upright; during fine rotation the image stays still and only the frame turns. The frame may stick out of the image after rotation (that area becomes white fill); crop drags may not push it out further.
- **Brightness/contrast** uses one slider with a segmented toggle. The preview is a CSS filter (no pixel work while dragging); the values are baked into the whole captured image on confirm.
- **Share** opens a sheet with a three-level compression control (JPEG quality 0.5 / 0.75 / 0.92), then embeds the frame region on a fixed A4 page scaled to fit (orientation follows the crop; borders on one axis are accepted) and hands the PDF to the Web Share API. Success returns to the start page and discards the image; cancel keeps the captured view.

Screens: start → camera → captured image [back] [share] [edit] → edit popover (crop/rotate, brightness/contrast).
Crop/rotate view: [back] [crop|rotate] [rotate 90 right] [confirm]. Brightness/contrast view: [back] [brightness|contrast] [confirm].

## Version roadmap

v0.1 capture + share (MVP) → v0.2 crop/rotate → v0.3 brightness/contrast → v0.4 UI polish.
Each version is independently deployable. Do not pull features from a later version into an earlier one.
