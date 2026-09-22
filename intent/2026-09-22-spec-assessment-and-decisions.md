# Spec assessment and decisions (2026-09-22)

Assessment of `README.md` as the basis for an implementation plan, plus the
decisions taken with Philip in the planning session.

## What the spec already settles

- Product scope: single-page scan, crop/rotate, brightness/contrast, PDF via Web Share.
- Hard constraints: local-only processing, static hosting on uberspace/Apache, no retention, icons-only UI.
- Screen flow: start -> camera -> captured image -> edit submenu -> edit views with [back] [toggle] [confirm].
- Capture-frame model: full image kept, DIN A frame at ~90% shown, frame geometry is the crop, rotation baked on confirm with white fill.

## Gaps found and decisions taken

| Gap | Decision |
|---|---|
| Tech stack unspecified | TypeScript + Vite, no UI framework. Vitest for geometry/image math. |
| "Best-fit, no borders" contradicts a fixed page for non-DIN crops | Fixed A4 page, image scaled to fit (borders on one axis if the crop is not 1:sqrt2). Page orientation follows crop orientation. |
| Where the compression level is chosen | Share opens a small sheet: segmented 3-level icon control + confirm. Nothing persisted. |
| Camera unavailable (denied, desktop, old iOS) | No fallback. Target modern mobile Safari and Chrome only. |
| Rotation range | Drag around the frame boundary gives small skew correction only, about +/-15 degrees. A separate "rotate 90 degrees right" icon button in the crop/rotate view turns the image in 90-degree steps (clockwise; four taps return to the start). Both accumulate into the frame rotation and are baked together on confirm. |
| Behaviour after share sheet closes | Success: discard image, return to start page. Cancel/abort: stay on captured image. |
| Brightness/contrast control | One slider below the image; segmented toggle selects which value it drives. Live preview via CSS filter, baked on confirm. |
| Deploy target | scp script reads host and path from a git-ignored `.env` (DEPLOY_HOST, DEPLOY_PATH). |
| Purpose of `intent/` | Design intent documents such as this one. |

## Assumptions still open (will be applied unless overridden)

- Single page per PDF. No multi-page capture in v1.
- DIN frame is 1:sqrt2, centred, sized so its larger fit dimension is 90% of the captured image.
- Crop edges move freely (aspect not locked); frame may not leave the captured image bounds.
- Baking rotation rotates the full captured image about the frame centre and resets frame rotation to 0. A 90-degree step swaps the frame's width and height so the visible area stays the same paper region.
- The crop/rotate view's button row is [back] [crop|rotate] [rotate 90 right] [confirm]; the 90-degree button is available in both crop and rotate mode.
- Back on the captured-image view discards the image; back in an edit view discards that view's pending edits.
- Edit submenu is a two-icon popover over the captured-image view.
- Language is German (`lang="de"`); PDF filename `scan.pdf` with a timestamp.
- Portrait-only manifest orientation; rear camera only.
- Service worker caches the app shell only, never image data. Install prompt is browser-driven (Android); iOS users add to home screen manually; no in-app hint in v1.
- Captured resolution: highest the video track offers, capped to stay under iOS canvas limits (about 16 MP).
- Icons: inline SVG, no icon font or CDN.
- PDF built with a small client library (pdf-lib or jsPDF); JPEG quality per level roughly 0.5 / 0.75 / 0.92.
