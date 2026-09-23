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
| Crop and shear merged | One mode with the shear icon, the default of the view: corner handles shear, edge handles crop, the frame body is not draggable. Found in the first device test of v0.7: a separate crop-corner drag and the one-finger pan added nothing that corners and edges cannot do, and three segments squeezed the bar. |
| Shear bake result | The whole image is warped and the margins kept (like rotation baking), output bounded to the target rectangle plus 25 % per side and the pixel cap. Not cropped to the quadrilateral. |
| Warp engine | JavaScript pixel loop with bilinear sampling, strips of 256 rows. No WebGL: one code path, testable, no texture limits. Budget 3 s for 16 MP behind the busy overlay. |
| Edge search band | 5 % outside to 20 % inside each frame edge. Mostly inward as requested; the small outward band covers paper that extends past the 90 % capture frame. |
| Contrast range | Widened to 0.5 .. 4.0 so auto can reach full black and white; slider mapping piecewise-linear with neutral at the centre tick. |
| Auto feedback | Nothing found: brief warning icon (v0.4 notice), state unchanged. Partial results applied. Auto results are pending edits, back discards them. |
| Auto button placement | In the button bar left of confirm in both edit views; falls back to the stage's top-right corner if seven targets do not fit on 360 px. |

## v0.9 decisions (2026-09-22, pinch zoom)

Taken with Philip when v0.9 was added. Up to v0.6 the browser's page zoom worked by accident;
pinning the app box to the viewport removed it, and the request was to bring it back on
purpose, limited to the image (`v0.9-zoom.md`).

| Topic | Decision |
|---|---|
| Where | Captured view, crop/rotate view and brightness/contrast view. Not the camera view (that would be digital zoom), not the sheets. |
| What zooms | Only the stage content. Bars, header and slider stay in place and keep their size; browser page zoom stays disabled. |
| Zoom is view state | `ZoomState` (scale, translation) composed on top of the fitted view transform, never stored on the page, never baked or shared; reset on back, confirm, 90°, page switch and bakes. |
| Range | 1 up to the lesser of 8 and 2 device pixels per image pixel (the loupe cap). No rubber band below 1. Content must cover the stage on each axis, else centred. |
| One finger while zoomed | Pans in the captured and brightness/contrast views. In the crop/rotate view the handles keep priority: in crop mode a finger clear of every handle's 44 px target pans, a finger on a handle drags it; in rotate mode one finger always rotates, so panning there needs two fingers. (Revised after the second device test: the first version reserved one finger entirely for handles, which made panning in the crop view clumsy.) Page swipe only in the fitted view. |
| Second finger during a drag | Cancels the one-finger drag and its loupes; the pending frame keeps its current position. |
| Double tap | Toggles fitted and 3x at the tap point. No reset button, no zoom indicator. |
| Rendering | CSS transform on a wrapper during the gesture (no drawing per move), crisp redraw of the visible part from the full-resolution image on release; stage canvas keeps its size, so memory does not grow with zoom. Crop/rotate overlay is recomputed per move so handles keep their size. |
| Loupes | Hidden once the zoomed view is as magnified as a loupe would be; otherwise as in v0.6. |
| Gesture source | Pointer Events with two tracked pointers, `touch-action: none` on the stages. No touch or Safari gesture events. |

## v0.10 decisions (2026-09-22, live document detection)

Taken with Philip when v0.10 was added, from a user request: the dashed frame should trace
the document while aiming, and the capture should apply the shear correction on its own
(`v0.10-live-detect.md`).

| Topic | Decision |
|---|---|
| Algorithm | The v0.8 edge search, unchanged, run on the live video from the static camera frame. The search band around the frame is the search area; the user still frames the page. Full-image detection stays out. |
| Confidence | Strict: all four edges found, convex, large enough, rotation within the skew range. Plus stability: three agreeing runs (corners within 3 % of the frame width of the tracked outline; 1 % in the first draft never locked on a handheld phone) before the outline shows, two misses before it hides. |
| Feedback | The dashed frame becomes a polygon: grey static rectangle, or green quadrilateral on the detected corners. A short vibration when it turns green. No text, no auto-capture. |
| What the bake uses | The still, detected once more with the strict rule, not the last live result: the still is grabbed later than the last preview frame and the hand moves. A miss on the still gives the v0.9 capture; a miss after a green outline shows the v0.4 warning briefly. |
| Auto-bake | Rotation and shear are baked right after capture behind the busy overlay, margins kept as with confirm in the crop/rotate view. A wrong result costs one retake (back), which is cheaper than a visit to the editor for every scan. |
| Toggle | Magic-wand icon button right of the shutter, `aria-pressed`, on by default. Session state only, not persisted: the spec's no-persistence rule stays untouched, and a stored preference would be a decision of its own. |
| Automatic capture | Not in v0.10. The shutter is an explicit act in the spec; after [+] the camera opens on the same sheet still on the table and would capture it again; the user gets no moment to check framing and light before pixels are resampled. If wanted later: a hold timer with a countdown ring on the shutter, toggle becomes three-state. |
| Loop | `requestVideoFrameCallback` (fallback `requestAnimationFrame`), at most one run per 150 ms, budget 15 ms per run, stops with the stream and with the toggle. Main thread only, no worker or WebGL. |

## v0.11 decisions (2026-09-23, share as JPEG)

Taken with Philip when v0.11 was added, from a user request: a single scanned page should also
be shareable as an image, not only as a PDF (`v0.11-share-jpeg.md`).

| Topic | Decision |
|---|---|
| When | Only while the scan has exactly one page. With two or more pages the share button opens the sheet for the PDF at once, as before: several JPEGs make no single document, and the Web Share API's multi-file support is uneven across targets. |
| How | The share button opens a popover like the edit submenu, with two icons: document (PDF) and image (JPEG). Both continue with the unchanged share sheet, so the compression level applies to the JPEG as well. Two more taps only in the single-page case; the choice is icon-only, in line with the spec. |
| Encoding | The JPEG is the frame region at the chosen level, the same bytes the PDF would embed, named `scan-<stamp>.jpg` with MIME `image/jpeg`. No A4 page around it, no borders. |
| Outcome | As for the PDF: success returns to the start page and discards the page, cancel keeps it, failure shows the notice. The chosen format is session state, not persisted. |
| Popover position | The edit popover sat at a fixed offset from the right edge, which was right for the three-button bar of v0.2 but put it above [+] since v0.5. Both popovers are now anchored above their own button: the view measures the button on render and writes its centre into `--anchor-x`, the CSS centres the popover and its tip on it. |
| Icons | Two new 24x24 stroke icons, `document` and `image`, generated like the others. The share button keeps the share icon. |

## v0.12 decisions (2026-09-23, the still of the green moment)

Taken with Philip when v0.12 was added, from device use: the user reacts to the green outline
and the buzz by pressing the shutter, and the press moves the phone, so the still is taken
after the steady moment the outline announced (`v0.12-frozen-still.md`).

| Topic | Decision |
|---|---|
| What is used | A still grabbed at the moment the outline turns green, if the shutter follows within 600 ms. A video element cannot be rewound, so the candidate must be grabbed proactively; the tracker's three agreeing runs make that moment a steady one. |
| Not automatic capture | The shutter is still the only act that creates a page. The early grab is a candidate that is discarded with the window unless the user presses; the v0.10 decision stands. |
| Conditions | Younger than the window, the outline still green, and every live corner within the tracker's tolerance (3 % of the frame width) of the corners at the grab. A deliberate move after the buzz therefore gets a fresh still of the new framing. |
| Memory | One extra capture canvas at most, released (width 0) when the window expires, the outline is lost, the toggle goes off, the frame is laid out anew or the camera closes. Grabbing on every run was rejected: 64 MB of churn several times a second is not affordable on iOS. |
| Press, not release | The shutter fires on `pointerdown`; the click after it finds the session closed. Keyboard activation still works through the click. |
| Toggle as a switch | The green wand button of v0.10 was read as a button that does something, not as a state. A switch (track green when on, knob with the wand icon) says on/off without text and keeps the icon-only rule. |
| Feedback | None: the captured view shows the page, whichever still it came from. A hint about which still was used would be text or a new icon for a detail the user cannot act on. |


## v1.1 decisions (2026-09-23, DIN completion for bound pages)

Taken with Philip when v1.1 was added, from the question whether a page in a spiral block can
be detected from three edges with the fourth assumed from the DIN A format
(`v1.1-din-completion.md`).

| Topic | Decision |
|---|---|
| Three edges plus the ratio | Feasible as one pure step between the edge fit and the corners: `detectEdges` already reports every side's line and whether it was found, and everything downstream works on corners. |
| Any side | The missing side is whichever did not fit; left, right, top and bottom bindings need no separate handling. |
| Band as the guard | The inferred edge is accepted only inside the missing side's search band. Without it, letter paper, receipts and book pages would turn green with a confidently wrong edge. With it, the rule reads "the edge is where you aimed, and its position agrees with DIN". |
| Orientation by the frame | Times or divided by sqrt 2: the candidate nearer to the frame line wins. The camera frame is portrait A-format and the user fits the page into it; in the editor a cropped frame carries the user's intent the same way. |
| Perspective as affine | The extent between the adjacent edges is averaged between the opposite edge and the frame line. Three edges plus a ratio do not determine the fourth under perspective without the camera's intrinsics; the error is a millimetre or two near the binding, where the holes are anyway. |
| Flag, no UI | `settings.completeDinEdge`, on, in a session settings module so it can become a user setting later. The pure maths takes `DetectOptions`; only `detectFrameIn` reads the settings, so tests drive the flag explicitly and the rules stay pure. |
| Wand applies it too | The wand already applied partial results with the frame line for a missing edge; the completed edge is the same partial result, better placed. |

## v1.2 decisions (2026-09-23, wide-angle lens)

Taken with Philip when v1.2 was added, from the question whether the user can switch between
the 1x and the 0.5x/0.6x rear camera while aiming (`v1.2-wide-lens.md`).

| Topic | Decision |
|---|---|
| Two mechanisms | A zoom range below 1 on the running track (`getCapabilities().zoom`, `applyConstraints`), or a separate video input device. Both behind one `LensControl`; zoom is tried first because it needs no restart. The first idea that Chrome on Android offers the zoom path was wrong: the S22 reports `zoom.min: 1` on every camera (Chrome's zoom is a sensor crop), so Android goes through devices too. |
| Hidden where absent | Many Android phones expose neither to the web. The switch is not rendered then; a disabled control would ask a question the app cannot answer. |
| Two states, not a zoom slider | The frame concept has the user frame the page. A continuous zoom competes with that and with the pinch zoom of the edit views; default and wide are the two cases the native camera app also offers as buttons. |
| Switch, not button | Same reasoning as the detect toggle of v0.12: on/off state without text. Left of the shutter so the two switches mirror each other. |
| Session state | Kept across camera opens within the session, like the detect toggle, because large pages come in batches. Not persisted. |
| Default first | Every camera open starts the default lens and then applies the remembered choice, so the fallback on a failing wide lens is the working stream, not the error screen. A failing device switch from the running view is a camera error like any other. |
| Device choice | `enumerateDevices` says nothing about a lens but its localised label, and list order is undocumented on both platforms (the first idea, position next to the current device, was dropped). iOS names the lens: the word "ultra" is common to the ultra-wide labels of the Latin-script locales and settles it. Chrome on Android says only "facing back": those are candidates, opened in turn on the first tap, and the fixed-focus one (no autofocus in `focusMode`) is the ultra-wide, as the S22 diagnostics showed (camera 2: `["manual"]`, no torch; camera 0: continuous autofocus, torch). Trial on the tap, not at camera open, so the camera keeps opening as fast as before; no qualifying candidate gives up and remembers it for the session. |
| Diagnostics page | `/app/diagnose.html` prints what the browser reveals about the cameras (track settings and capabilities, device list, each device openable) so a phone can be examined without USB debugging. Outside the app shell; its text is not one of the app's text exceptions. |
| Quality | The wide lens is softer, distorts the corners and has no autofocus on iPhones. Accepted: the perspective correction covers the geometry and the user sees the result and can retake; no hint about which lens took a page. |
