"""Cut the message-status icons out of the design sheet into transparent PNGs.

Usage: python3 tools/extract-status-icons.py design/status-icons-sheet.png [out_dir]

The sheet has a light gradient background. Each icon is separated by how far
it differs from that background: the shape (with its holes filled) becomes
opaque, and the faint glow around it fades into transparency, so the icons
look right on light, green and dark chat backgrounds.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# name: (x0, y0, x1, y1) bounding box of the artwork on the 1024x559 sheet
ICONS = {
    'delivered': (118, 58, 298, 235),
    'read': (421, 58, 608, 235),
    'pending': (763, 58, 884, 235),  # "non delivered"
    'failed': (117, 310, 299, 485),
    'deleted': (456, 310, 587, 485),
    'masked': (739, 310, 922, 485),
}
MARGIN = 12   # include the faint glow around each icon
SIZE = 96     # output square size (crisp at 16-32 CSS px on hi-dpi screens)
SOLID = 30    # difference from the background that counts as icon
SOFT_LOW = 12 # below this it is background (glows ramp in between)


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


def main(sheet, out_dir):
    img = np.asarray(Image.open(sheet).convert('RGB'))
    h, w, _ = img.shape
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, (x0, y0, x1, y1) in ICONS.items():
        x0, y0 = max(0, x0 - MARGIN), max(0, y0 - MARGIN)
        x1, y1 = min(w, x1 + MARGIN), min(h, y1 + MARGIN)
        crop = img[y0:y1, x0:x1]
        rgba = Image.fromarray(cut_out(crop), 'RGBA')
        rgba = rgba.crop(rgba.getbbox())
        side = max(rgba.size)
        square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
        square.paste(rgba, ((side - rgba.width) // 2, (side - rgba.height) // 2))
        square.resize((SIZE, SIZE), Image.LANCZOS).save(out_dir / f'{name}.png', optimize=True)
        print('wrote', out_dir / f'{name}.png')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else Path(__file__).parent.parent / 'public' / 'icons')
