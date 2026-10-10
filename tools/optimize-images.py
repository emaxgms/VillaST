#!/usr/bin/env python3
"""Generate the non-photo image assets the site ships.

Run from the repo root:

    python3 tools/optimize-images.py

Outputs:
  images/og-image.jpg   1200x630 social preview (crop of images/01.jpg)
  apple-touch-icon.png  180x180 home-screen icon (also the fallback for tile-less bots)

Deliberately NOT done here: WebP/AVIF twins of the photos. Measured on the current
sources (576-1200px, already heavily compressed Booking.com JPEGs) a WebP re-encode
saves ~9% at q80 and ~26% at q62 - not worth the quality risk or the extra <picture>
markup. The real win is reshooting the photos at 2x; see docs/seo-marketing-review.md.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / "images"

# OWNER: swap for a better shot any time - must stay 1.91:1, 1200x630.
OG_SOURCE = "01.jpg"
OG_SIZE = (1200, 630)
ICON_SIZE = (180, 180)
SEA = (26, 60, 94)  # --color-sea
SAND = (232, 213, 183)  # --color-sand


def make_og_image() -> Path:
    out = IMAGES / "og-image.jpg"
    with Image.open(IMAGES / OG_SOURCE) as im:
        im = im.convert("RGB")
        tgt_ratio = OG_SIZE[0] / OG_SIZE[1]
        if im.width / im.height > tgt_ratio:  # too wide -> trim the sides
            w = int(im.height * tgt_ratio)
            box = ((im.width - w) // 2, 0, (im.width + w) // 2, im.height)
        else:  # too tall -> trim the bottom, keeping the top third
            h = int(im.width / tgt_ratio)
            top = int((im.height - h) * 0.25)
            box = (0, top, im.width, top + h)
        im.crop(box).resize(OG_SIZE, Image.Resampling.LANCZOS).save(
            out, "JPEG", quality=86, optimize=True
        )
    return out


def make_icon() -> Path:
    out = ROOT / "apple-touch-icon.png"
    img = Image.new("RGB", ICON_SIZE, SEA)
    draw = ImageDraw.Draw(img)
    font = None
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ):
        if Path(candidate).exists():
            font = ImageFont.truetype(candidate, 86)
            break
    if font is None:  # no TrueType on this box: leave the plain tile rather than a bitmap glyph
        print("WARNING: no TrueType font found, writing a monogram-free icon")
    else:
        left, top, right, bottom = draw.textbbox((0, 0), "RT", font=font)
        draw.text(
            ((ICON_SIZE[0] - (right - left)) / 2 - left, (ICON_SIZE[1] - (bottom - top)) / 2 - top),
            "RT",
            font=font,
            fill=SAND,
        )
    img.save(out, "PNG", optimize=True)
    return out


def main() -> int:
    og, icon = make_og_image(), make_icon()
    with Image.open(og) as im:
        assert im.size == OG_SIZE, f"og-image is {im.size}"
    with Image.open(icon) as im:
        assert im.size == ICON_SIZE, f"icon is {im.size}"
    print(f"wrote {og.relative_to(ROOT)} ({og.stat().st_size / 1024:.0f} KB)")
    print(f"wrote {icon.relative_to(ROOT)} ({icon.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
