"""Cut the icons out of the design sheets in design/ into transparent PNGs.

Usage: python3 tools/extract-icons.py            # all sheets -> public/icons/
       python3 tools/extract-icons.py <out_dir>

Each sheet is a 3x2 grid of icons with a text label under each one. Icons are
found automatically (rows/columns of pixels that differ from the background),
then separated from the light gradient background by how far they differ from
it: the shape (with its holes filled) becomes opaque, and the faint glow around
it fades into transparency, so the icons look right on light, green and dark
chat backgrounds. Needs Pillow and NumPy.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent

# sheet -> icon names in reading order (left to right, top to bottom)
SHEETS = {
    'status-icons-sheet.png': ['delivered', 'read', 'pending', 'failed', 'deleted', 'masked'],
    'call-icons-sheet.png': ['call', 'calling', 'call-end', 'call-declined', 'group-call', 'on-hold'],
    'message-icons-sheet.png': ['sending', 'typing', 'recording', 'blocked', 'starred', 'offline'],
}
MARGIN = 12   # include the faint glow around each icon (but never the label)
SIZE = 96     # output square size (crisp at 16-32 CSS px on hi-dpi screens)
SOLID = 30    # difference from the background that counts as icon
SOFT_LOW = 12 # below this it is background (glows ramp in between)
DETECT = 25   # difference used to locate icons and labels


def runs(values):
    """[(start, end)] of consecutive truthy entries."""
    out, start = [], None
    for i, v in enumerate(values):
        if v and start is None:
            start = i
        elif not v and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(values)))
    return out


def locate(img):
    """Bounding boxes (x0, y0, x1, y1) of the icons, in reading order, with safe margins."""
    bg = np.median(img.reshape(-1, 3), axis=0)
    mask = np.abs(img.astype(float) - bg).max(axis=2) > DETECT
    h, w = mask.shape
    bands = runs(mask.sum(axis=1) > 0)  # icon rows and (thin) label rows
    boxes = []
    for i, (y0, y1) in enumerate(bands):
        if y1 - y0 < 60:
            continue  # a text label
        top = max(0, y0 - MARGIN, bands[i - 1][1] + 2 if i else 0)
        bottom = min(h, y1 + MARGIN, bands[i + 1][0] - 2 if i + 1 < len(bands) else h)
        for x0, x1 in runs(mask[y0:y1].sum(axis=0) > 0):
            if x1 - x0 > 40:
                boxes.append((max(0, x0 - MARGIN), top, min(w, x1 + MARGIN), bottom))
    return boxes


def background_plane(crop):
    """Fit a linear gradient (per channel) to the crop's border: the sheet background."""
    h, w, _ = crop.shape
    ys, xs = np.mgrid[0:h, 0:w]
    edge = np.zeros((h, w), bool)
    edge[:3], edge[-3:], edge[:, :3], edge[:, -3:] = True, True, True, True
    A = np.c_[xs[edge], ys[edge], np.ones(edge.sum())]
    bg = np.empty(crop.shape)
    for c in range(3):
        coef, *_ = np.linalg.lstsq(A, crop[..., c][edge].astype(float), rcond=None)
        bg[..., c] = coef[0] * xs + coef[1] * ys + coef[2]
    return bg


def fill_holes(mask):
    """Make every region not reachable from the border part of the mask."""
    h, w = mask.shape
    # .copy(): flood fill is a no-op on an image that wraps a numpy buffer
    padded = Image.fromarray(np.pad(mask, 1).astype(np.uint8) * 255).copy()
    ImageDraw.floodfill(padded, (0, 0), 128)
    outside = np.asarray(padded)[1:h + 1, 1:w + 1] == 128
    return ~outside


def cut_out(crop):
    """Opaque icon with soft edges; the faint glow fades out into transparency."""
    diff = np.abs(crop.astype(float) - background_plane(crop)).max(axis=2)
    soft = np.clip((diff - SOFT_LOW) / (SOLID - SOFT_LOW), 0, 1)
    solid = fill_holes(diff > SOLID)
    # anti-aliased edge: blur the solid core a touch and combine with the soft ramp
    core = np.asarray(Image.fromarray(solid.astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(0.7))) / 255
    alpha = np.maximum(core, soft * 0.6)
    return np.dstack([crop, (alpha * 255).round()]).astype(np.uint8)


def main(out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for sheet, names in SHEETS.items():
        img = np.asarray(Image.open(ROOT / 'design' / sheet).convert('RGB'))
        boxes = locate(img)
        if len(boxes) != len(names):
            sys.exit(f'{sheet}: found {len(boxes)} icons, expected {len(names)}')
        for name, (x0, y0, x1, y1) in zip(names, boxes):
            rgba = Image.fromarray(cut_out(img[y0:y1, x0:x1]), 'RGBA')
            rgba = rgba.crop(rgba.getbbox())
            side = max(rgba.size)
            square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
            square.paste(rgba, ((side - rgba.width) // 2, (side - rgba.height) // 2))
            square.resize((SIZE, SIZE), Image.LANCZOS).save(out_dir / f'{name}.png', optimize=True)
            print('wrote', out_dir / f'{name}.png')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'public' / 'icons')
