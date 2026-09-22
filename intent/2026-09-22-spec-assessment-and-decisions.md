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
- DIN frame is 1:sqrt2, centred, sized so its larger fit dimension is 90% of the *visible* part of the captured image (revised after v0.1 device testing: with `object-fit: cover` on a tall phone, 90% of the full image width ran off screen).
- Crop edges move freely (aspect not locked); frame may not leave the captured image bounds.
- Baking rotation rotates the full captured image about the frame centre and resets frame rotation to 0. A 90-degree step swaps the frame's width and height so the visible area stays the same paper region.
- The crop/rotate view's button row is [back] [crop|rotate] [rotate 90 right] [confirm]; the 90-degree button is available in both crop and rotate mode.
- Back on the captured-image view discards the image; back in an edit view discards that view's pending edits.
- Edit submenu is a two-icon popover over the captured-image view.
- Language is German (`lang="de"`); PDF filename `scan.pdf` with a timestamp.
- Portrait-only manifest orientation; rear camera only.
- Service worker caches the app shell only, never image data. Install prompt is browser-driven (Android); iOS users add to home screen manually; no in-app hint in v1.
- Captured resolution: highest the video track offers, capped to stay under iOS canvas limits (about 16 MP).
- Icons: inline SVG, no icon font or CDN. Exception added after v0.1 device testing: the three compression icons in the share sheet carry short captions (Klein / Mittel / Groß) because the file icons alone were not intuitive.
- PDF built with a small client library (pdf-lib or jsPDF); JPEG quality per level roughly 0.5 / 0.75 / 0.92.

## v0.4 decisions (2026-09-22, at the start of v0.4)

Taken after comparing `v0.4-ui-polish.md` against the v0.3 code.

| Topic | Decision |
|---|---|
| Hardware back / swipe back | Every screen change pushes a history entry; `popstate` acts as the current screen's back button. Without this, back in the installed app exits to the launcher and drops the scan. |
| Non-camera errors (share, bake) | Shown as a brief icon-only warning over the current view, image and view untouched. Camera errors keep their own screen per the mockup. |
| Busy overlay for baking | Baking is deferred two animation frames after the overlay renders, so the spinner is actually painted before the synchronous pixel work. |
| Retake | Goes straight from captured view to camera, no detour via the start page (would flicker with cross-fades). |
| Shutter feedback | White flash plus `navigator.vibrate` where available; both off under reduced motion. |
| Lighthouse PWA criterion | Lighthouse no longer has a PWA category (removed in v12). Installability is checked in the Chrome DevTools Application panel; Lighthouse supplies accessibility and performance scores only. |
| iOS splash | Out. The manifest background colour covers Android; iOS would need one startup image per device size. |
| iOS "add to home screen" hint | Stays out (confirms the v1 decision above). The app is fully usable in a Safari tab and the hint would be the only text-heavy screen. |
| `beforeunload` prompt | None. Unreliable in standalone mode; the history integration covers accidental back. Only defensive clearing of image references. |
| Tests | jsdom tests for the state machine: camera error path, share fallback, history handling. |

## v0.5 to v0.8 decisions (2026-09-22, planning the second roadmap)

Taken with Philip when the four follow-up milestones were defined
(`v0.5-multi-page.md` .. `v0.8-auto-detect.md`).

| Topic | Decision |
|---|---|
| Multi-page memory | Only the current page is a full-resolution canvas. Other pages are parked as a full-image JPEG blob (quality 0.95) plus frame, re-encoded only after a bake changed the image. iOS canvas memory cannot hold several 16 MP canvases. Soft limit 20 pages. |
| Back on a multi-page captured view | Removes the current page and shows its neighbour; with one page it is the v0.4 retake. No separate delete button. |
| New page position | Appended after the last page; no reordering (spec). |
| Page position text | "n/m" in the header is the second text exception after Klein / Mittel / Groß. |
| Loupe counts | Corner drag 1, edge drag 2, body drag and rotation 4, shear corner 1. Cluster centred on the stage; when the drag starts inside it, the cluster is shifted away from the finger (vertically, else horizontally) and only suppressed if nothing fits. Initially plain suppression, changed after the first device test showed it hid the four-loupe grid for most body drags. |
| Shear semantics | Four independent corners define a homography (perspective correction), baked together with rotation on confirm. Corner offsets live in frame-local coordinates on the pending frame only. |
| Shear bake result | The whole image is warped and the margins kept (like rotation baking), output bounded to the target rectangle plus 25 % per side and the pixel cap. Not cropped to the quadrilateral. |
| Warp engine | JavaScript pixel loop with bilinear sampling, strips of 256 rows. No WebGL: one code path, testable, no texture limits. Budget 3 s for 16 MP behind the busy overlay. |
| Edge search band | 5 % outside to 20 % inside each frame edge. Mostly inward as requested; the small outward band covers paper that extends past the 90 % capture frame. |
| Contrast range | Widened to 0.5 .. 4.0 so auto can reach full black and white; slider mapping piecewise-linear with neutral at the centre tick. |
| Auto feedback | Nothing found: brief warning icon (v0.4 notice), state unchanged. Partial results applied. Auto results are pending edits, back discards them. |
| Auto button placement | In the button bar left of confirm in both edit views; falls back to the stage's top-right corner if seven targets do not fit on 360 px. |
