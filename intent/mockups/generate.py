#!/usr/bin/env python3
"""Generates intent/icons/*.svg and intent/mockups/*.svg.

Run from the repository root:  python3 intent/mockups/generate.py
Icons are 24x24 stroke icons (stroke 2, round caps/joins, currentColor).
Mockups are 390x844 phone screens that inline the same icon paths.
"""
import os, textwrap

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ICONS = os.path.join(ROOT, "intent", "icons")
MOCKS = os.path.join(ROOT, "intent", "mockups")

# name -> (description, inner svg markup in a 24x24 box)
ICON = {
    "arrow-left": ("Back", '<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>'),
    "shutter": ("Take picture", '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6.5" fill="currentColor"/>'),
    "share": ("Share / save PDF", '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/>'),
    "edit": ("Edit submenu (sliders)", '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>'),
    "crop": ("Crop mode", '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>'),
    "rotate": ("Rotate (fine skew) mode", '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>'),
    "rotate-90-right": ("Rotate 90 degrees clockwise", '<rect x="3" y="9" width="9" height="12" rx="1"/><path d="M8 4h6a4 4 0 0 1 4 4v3"/><path d="M15 8l3 3 3-3"/>'),
    "brightness": ("Brightness", '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
    "contrast": ("Contrast", '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
    "temperature": ("Colour temperature", '<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/><path d="M12 9v6"/>'),
    "grayscale": ("Grayscale (drop colour)", '<path d="M12 2.7l5.7 6.4a7.5 7.5 0 1 1-11.4 0z"/><path d="M4 4l16 16"/>'),
    "check": ("Confirm", '<path d="M20 6L9 17l-5-5"/>'),
    "close": ("Cancel / dismiss", '<path d="M18 6L6 18M6 6l12 12"/>'),
    "file-small": ("Compression: small file, lower quality", '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 17h8"/>'),
    "file-medium": ("Compression: medium", '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8"/>'),
    "file-large": ("Compression: large file, best quality", '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 9h4M8 13h8M8 17h8"/>'),
    "warning": ("Error state", '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>'),
    "refresh": ("Retry", '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
    "spinner": ("Busy indicator (rotates)", '<path d="M12 2a10 10 0 0 1 10 10" stroke-width="3"/>'),
}

APP_ICON = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <title>MobileScan app icon</title>
  <rect width="512" height="512" rx="112" fill="#1e40af"/>
  <rect x="136" y="96" width="240" height="320" rx="16" fill="#ffffff"/>
  <path d="M176 176h160M176 224h160M176 272h112" stroke="#93c5fd" stroke-width="16" stroke-linecap="round"/>
  <rect x="96" y="56" width="320" height="400" rx="24" fill="none" stroke="#ffffff" stroke-width="12" stroke-dasharray="28 20"/>
  <rect x="80" y="304" width="352" height="12" rx="6" fill="#facc15"/>
</svg>
"""

def icon_svg(name):
    desc, inner = ICON[name]
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" '
            f'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            f'<title>{desc}</title>{inner}</svg>\n')

def icon_at(name, x, y, size=28, color="#111827"):
    s = size / 24
    return (f'<g transform="translate({x - size/2:.1f},{y - size/2:.1f}) scale({s:.3f})" fill="none" stroke="{color}" '
            f'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{ICON[name][1]}</g>')

def btn(name, x, y, r=32, fill="#ffffff", stroke="#d1d5db", color="#111827", size=28):
    return (f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>'
            + icon_at(name, x, y, size, color))

def segmented(x, y, items, active, w=140, h=48, captions=None):
    """items: icon names. Returns a segmented control centred at x,y.
    captions: optional list of short texts drawn under the icons."""
    n = len(items); seg = w / n; out = [f'<rect x="{x-w/2}" y="{y-h/2}" width="{w}" height="{h}" rx="12" fill="#f3f4f6" stroke="#d1d5db" stroke-width="1.5"/>']
    for i, it in enumerate(items):
        cx = x - w/2 + seg*(i+0.5)
        color = "#ffffff" if i == active else "#374151"
        if i == active:
            out.append(f'<rect x="{cx-seg/2+4}" y="{y-h/2+4}" width="{seg-8}" height="{h-8}" rx="9" fill="#1e40af"/>')
        if captions:
            out.append(icon_at(it, cx, y - 8, 24, color))
            out.append(f'<text x="{cx}" y="{y+18}" text-anchor="middle" font-size="12" fill="{color}">{captions[i]}</text>')
        else:
            out.append(icon_at(it, cx, y, 24, color))
    return "".join(out)

def paper(x, y, w, h, rot=0, bg="#fdfdf7", line="#9ca3af", opacity=1.0):
    """A photographed sheet of paper with text lines."""
    lines = []
    ly = y + 30
    while ly < y + h - 20:
        lw = w * (0.75 if (int(ly) // 17) % 4 else 0.45)
        lines.append(f'<rect x="{x+18}" y="{ly}" width="{lw:.0f}" height="4" rx="2" fill="{line}"/>')
        ly += 17
    return (f'<g transform="rotate({rot} {x+w/2} {y+h/2})" opacity="{opacity}"><rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{bg}"/>'
            + "".join(lines) + '</g>')

def frame(x, y, w, h, rot=0, color="#facc15", handles=False, dash="10 8"):
    out = [f'<g transform="rotate({rot} {x+w/2} {y+h/2})">'
           f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="none" stroke="{color}" stroke-width="3" stroke-dasharray="{dash}"/>']
    if handles:
        for hx, hy in [(x,y),(x+w,y),(x,y+h),(x+w,y+h),(x+w/2,y),(x+w/2,y+h),(x,y+h/2),(x+w,y+h/2)]:
            out.append(f'<circle cx="{hx}" cy="{hy}" r="9" fill="{color}" stroke="#111827" stroke-width="1.5"/>')
    out.append('</g>')
    return "".join(out)

W, H = 390, 844
def phone(title, body, bg="#ffffff", note=""):
    return textwrap.dedent(f'''\
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H+70}" width="{W}" height="{H+70}" font-family="-apple-system, Helvetica, Arial, sans-serif">
      <title>{title}</title>
      <rect x="0" y="0" width="{W}" height="{H}" rx="40" fill="{bg}" stroke="#111827" stroke-width="3"/>
      <rect x="130" y="14" width="130" height="30" rx="15" fill="#111827"/>
      <clipPath id="screen"><rect x="2" y="2" width="{W-4}" height="{H-4}" rx="38"/></clipPath>
      <g clip-path="url(#screen)">
      {body}
      </g>
      <rect x="140" y="{H-16}" width="110" height="5" rx="2.5" fill="{'#ffffff' if bg != '#ffffff' else '#111827'}"/>
      <text x="{W/2}" y="{H+40}" text-anchor="middle" font-size="15" fill="#374151">{note}</text>
    </svg>
    ''')

# ---- screen bodies ---------------------------------------------------------
# Areas: content 0..660, button bar ~ y=740
BAR = 740

def start():
    return (f'<text x="{W/2}" y="300" text-anchor="middle" font-size="34" font-weight="700" fill="#111827">MobileScan</text>'
            f'<rect x="55" y="380" width="280" height="64" rx="32" fill="#1e40af"/>'
            f'<text x="{W/2}" y="422" text-anchor="middle" font-size="20" font-weight="600" fill="#ffffff">Dokument scannen</text>')

def camera():
    # live video fills screen (cover); DIN frame 1:sqrt2, 90% of the visible width, centred
    fw = 0.9 * W; fh = fw * 1.4142
    fx = (W - fw)/2; fy = (H - fh)/2
    return (f'<rect x="0" y="0" width="{W}" height="{H}" fill="#374151"/>'
            + paper(70, 170, 250, 350, rot=-4, opacity=0.9)
            + f'<rect x="0" y="0" width="{W}" height="{H}" fill="#000" opacity="0.15"/>'
            + frame(fx, fy, fw, fh)
            + btn("shutter", W/2, 760, r=40, fill="#ffffff", stroke="#9ca3af", size=48)
            + btn("arrow-left", 48, 90, r=24, fill="#111827", stroke="#111827", color="#ffffff", size=24))

def captured(extra=""):
    # only the frame area is shown, scaled to fit 350 wide
    fw = 350; fh = fw * 1.4142 * 0.94  # slightly cropped by screen height
    fx = 20; fy = 70
    return (f'<rect x="{fx}" y="{fy}" width="{fw}" height="{fh}" fill="#6b7280"/>'
            + f'<clipPath id="cap"><rect x="{fx}" y="{fy}" width="{fw}" height="{fh}"/></clipPath>'
            + f'<g clip-path="url(#cap)">' + paper(40, 100, 310, 440, rot=-4) + '</g>'
            + btn("arrow-left", 70, BAR) + btn("share", W/2, BAR, fill="#1e40af", stroke="#1e40af", color="#ffffff") + btn("edit", 320, BAR)
            + extra)

def share_sheet():
    sheet = (f'<rect x="0" y="0" width="{W}" height="{H}" fill="#000" opacity="0.4"/>'
             f'<rect x="0" y="560" width="{W}" height="300" rx="28" fill="#ffffff"/>'
             f'<rect x="165" y="574" width="60" height="5" rx="2.5" fill="#d1d5db"/>'
             + segmented(W/2, 640, ["file-small", "file-medium", "file-large"], 1, w=240, h=64, captions=["Klein", "Mittel", "Groß"])
             + btn("close", 70, 740) + btn("check", 320, 740, fill="#1e40af", stroke="#1e40af", color="#ffffff"))
    return captured() + sheet

def edit_menu():
    menu = (f'<rect x="0" y="0" width="{W}" height="{H}" fill="#000" opacity="0.25"/>'
            f'<rect x="230" y="620" width="140" height="72" rx="20" fill="#ffffff" stroke="#d1d5db"/>'
            f'<path d="M320 708l-10-16h20z" fill="#ffffff" stroke="#d1d5db"/><rect x="311" y="690" width="18" height="4" fill="#ffffff"/>'
            + btn("crop", 268, 656, r=26) + btn("brightness", 332, 656, r=26)
            + btn("edit", 320, BAR, fill="#1e40af", stroke="#1e40af", color="#ffffff"))
    return captured() + menu

def full_image(rot_paper=-4, frame_rot=0, frame_handles=False, frame_box=None, filt=""):
    # entire captured image shown (100 %), frame at stored geometry
    iw = 350; ih = iw * 4/3 * 1.0  # camera 3:4 portrait
    ix = 20; iy = 60
    fw = 0.9 * iw; fh = fw * 1.4142
    if fh > ih * 0.9:
        fh = ih * 0.9; fw = fh / 1.4142
    fx = ix + (iw - fw)/2; fy = iy + (ih - fh)/2
    if frame_box: fx, fy, fw, fh = frame_box
    return (f'<rect x="{ix}" y="{iy}" width="{iw}" height="{ih}" fill="#6b7280"/>'
            + f'<clipPath id="img"><rect x="{ix}" y="{iy}" width="{iw}" height="{ih}"/></clipPath>'
            + f'<g clip-path="url(#img)" {filt}>' + paper(ix+35, iy+45, iw-70, ih-90, rot=rot_paper) + '</g>'
            + frame(fx, fy, fw, fh, rot=frame_rot, handles=frame_handles))

def crop():
    return (full_image(frame_handles=True, frame_box=(52, 92, 290, 420))
            + btn("arrow-left", 55, BAR) + segmented(150, BAR, ["crop", "rotate"], 0, w=120)
            + btn("rotate-90-right", 250, BAR) + btn("check", 335, BAR, fill="#1e40af", stroke="#1e40af", color="#ffffff"))

def rotate():
    # frame rotated -4 deg to align with the skewed paper; drag arc hint
    body = full_image(frame_rot=-4)
    body += ('<path d="M300 140 A 170 170 0 0 1 335 240" fill="none" stroke="#facc15" stroke-width="3" stroke-dasharray="4 6"/>'
             '<circle cx="335" cy="240" r="14" fill="#ffffff" stroke="#111827" stroke-width="2" opacity="0.9"/>')
    body += (btn("arrow-left", 55, BAR) + segmented(150, BAR, ["crop", "rotate"], 1, w=120)
             + btn("rotate-90-right", 250, BAR) + btn("check", 335, BAR, fill="#1e40af", stroke="#1e40af", color="#ffffff"))
    return body

def rotated_90():
    # after one tap: the whole image is turned, so it is now landscape; frame turned with it.
    iw = 350; ih = iw * 3/4; ix = 20; iy = 200
    fw = 0.9 * iw; fh = fw / 1.4142
    fx = ix + (iw - fw)/2; fy = iy + (ih - fh)/2
    return (f'<rect x="{ix}" y="{iy}" width="{iw}" height="{ih}" fill="#6b7280"/>'
            + f'<clipPath id="img2"><rect x="{ix}" y="{iy}" width="{iw}" height="{ih}"/></clipPath>'
            + f'<g clip-path="url(#img2)"><g transform="rotate(90 {ix+iw/2} {iy+ih/2})">'
            + paper(ix+iw/2-ih/2+30, iy+ih/2-iw/2+40, ih-60, iw-80, rot=-4) + '</g></g>'
            + frame(fx, fy, fw, fh, handles=True)
            + btn("arrow-left", 55, BAR) + segmented(150, BAR, ["crop", "rotate"], 0, w=120)
            + btn("rotate-90-right", 250, BAR) + btn("check", 335, BAR, fill="#1e40af", stroke="#1e40af", color="#ffffff"))

def slider(x, y, w, value, icon):
    kx = x + w * value
    return (f'<rect x="{x}" y="{y-3}" width="{w}" height="6" rx="3" fill="#e5e7eb"/>'
            f'<rect x="{x}" y="{y-3}" width="{kx-x:.0f}" height="6" rx="3" fill="#1e40af"/>'
            f'<circle cx="{kx:.0f}" cy="{y}" r="14" fill="#ffffff" stroke="#1e40af" stroke-width="2"/>'
            f'<line x1="{x+w/2}" y1="{y-10}" x2="{x+w/2}" y2="{y+10}" stroke="#9ca3af" stroke-width="1"/>')

def bc(mode, gray=False):
    """mode: 0 brightness, 1 contrast, 2 temperature. gray: grayscale toggle on."""
    filt = ['filter="brightness(1.15)"', 'filter="contrast(1.3)"', 'filter="url(#warm)"'][mode]
    if gray:
        filt = 'filter="grayscale(1)"'
    # captured view shows only the frame area
    fw = 350; fh = 470; fx = 20; fy = 60
    body = ('<filter id="warm" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" '
            'values="1.12 0 0 0 0  0 1 0 0 0  0 0 0.88 0 0  0 0 0 1 0"/></filter>'
            + f'<rect x="{fx}" y="{fy}" width="{fw}" height="{fh}" fill="#6b7280"/>'
            + f'<clipPath id="bc"><rect x="{fx}" y="{fy}" width="{fw}" height="{fh}"/></clipPath>'
            + f'<g clip-path="url(#bc)" {filt}>' + paper(40, 90, 310, 440, rot=-4, bg="#f4ecd8") + '</g>')
    # slider: tick at neutral (middle for brightness and temperature, a third for contrast)
    body += slider(50, 620, 290, [0.62, 0.7, 0.8][mode], "brightness")
    gray_btn = (btn("grayscale", 275, BAR, r=26, fill="#1e40af", stroke="#1e40af", color="#ffffff", size=24)
                if gray else btn("grayscale", 275, BAR, r=26, size=24))
    body += (btn("arrow-left", 40, BAR, r=26, size=24)
             + segmented(150, BAR, ["brightness", "contrast", "temperature"], mode, w=150, h=44)
             + gray_btn
             + btn("check", 345, BAR, r=26, fill="#1e40af", stroke="#1e40af", color="#ffffff", size=24))
    return body

def busy():
    return captured() + (f'<rect x="0" y="0" width="{W}" height="{H}" fill="#ffffff" opacity="0.6"/>'
                         + icon_at("spinner", W/2, 330, 56, "#1e40af"))

def camera_error():
    return (f'<rect x="0" y="0" width="{W}" height="{H}" fill="#111827"/>'
            + icon_at("warning", W/2, 330, 72, "#facc15")
            + btn("refresh", W/2, 460, r=36, fill="#1e40af", stroke="#1e40af", color="#ffffff", size=32)
            + btn("arrow-left", 48, 90, r=24, fill="#374151", stroke="#374151", color="#ffffff", size=24))

SCREENS = [
    ("v0.1-01-start", "v0.1 Start page", start(), "#ffffff", "Start: the only text in the app."),
    ("v0.1-02-camera", "v0.1 Camera with DIN frame", camera(), "#374151", "Camera: dashed DIN A frame at 90 % width, shutter below."),
    ("v0.1-03-captured", "v0.1 Captured image", captured(), "#ffffff", "Captured: frame area only. [back] [share] [edit]"),
    ("v0.1-04-share-sheet", "v0.1 Share sheet with compression level", share_sheet(), "#ffffff", "Share sheet: pick compression, confirm opens OS share."),
    ("v0.1-05-busy", "v0.1 Busy while generating PDF", busy(), "#ffffff", "Busy overlay while compressing and building the PDF."),
    ("v0.2-01-edit-menu", "v0.2 Edit submenu", edit_menu(), "#ffffff", "Edit popover: crop/rotate, brightness/contrast."),
    ("v0.2-02-crop", "v0.2 Crop mode", crop(), "#ffffff", "Crop: full image, frame with 8 handles."),
    ("v0.2-03-rotate", "v0.2 Rotate mode", rotate(), "#ffffff", "Rotate: drag around the frame, ±15° skew."),
    ("v0.2-04-rotated-90", "v0.2 After one 90° tap", rotated_90(), "#ffffff", "After one 90° tap: image and frame turned."),
    ("v0.3-01-brightness", "v0.3 Brightness", bc(0), "#ffffff", "Brightness: one slider, live CSS-filter preview."),
    ("v0.3-02-contrast", "v0.3 Contrast", bc(1), "#ffffff", "Contrast: same slider, toggle selects the value."),
    ("v0.3-03-temperature", "v0.3 Colour temperature", bc(2), "#ffffff", "Temperature: cool .. warm, neutral in the middle."),
    ("v0.3-04-grayscale", "v0.3 Grayscale toggle", bc(0, gray=True), "#ffffff", "Grayscale toggle on: colour dropped, values still apply."),
    ("v0.4-01-camera-error", "v0.4 Camera unavailable", camera_error(), "#111827", "Camera unavailable: icon-only error, retry, back."),
]

def main():
    for name in ICON:
        with open(os.path.join(ICONS, name + ".svg"), "w") as f: f.write(icon_svg(name))
    with open(os.path.join(ICONS, "app-icon.svg"), "w") as f: f.write(APP_ICON)
    for fname, title, body, bg, note in SCREENS:
        with open(os.path.join(MOCKS, fname + ".svg"), "w") as f: f.write(phone(title, body, bg, note))
    print(f"{len(ICON)+1} icons, {len(SCREENS)} mockups")

if __name__ == "__main__":
    main()
