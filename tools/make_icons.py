#!/usr/bin/env python3
"""Render the icons from icons/icon.svg (app icon) and icons/favicon.svg (bolder, for tabs).

Usage: python3 tools/make_icons.py

Writes:
  icons/icon-192.png, icon-512.png      manifest icons, rounded corners
  icons/icon-maskable-512.png           square, full bleed: Android crops it to its own shape
  icons/apple-touch-icon.png            180 px, square and opaque: iOS rounds it itself
  icons/favicon-16.png, favicon-32.png  tab icons, and favicon.ico (16, 32, 48) at the root
"""
import io
import pathlib

from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
art = (ICONS / "icon.svg").read_text()
fav = (ICONS / "favicon.svg").read_text()


def square(svg):
    # No rounded corners: for icons the platform masks itself.
    return svg.replace('rx="112"', 'rx="0"').replace('rx="104"', 'rx="0"').replace('rx="14"', 'rx="0"')


def render(page, svg, size, transparent=True):
    sized = svg.replace("<svg ", f'<svg width="{size}" height="{size}" ', 1)
    page.set_viewport_size({"width": size, "height": size})
    page.set_content(f'<body style="margin:0;background:{"transparent" if transparent else "#060a14"}">{sized}</body>')
    return page.screenshot(omit_background=transparent)


with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    (ICONS / "icon-192.png").write_bytes(render(pg, art, 192))
    (ICONS / "icon-512.png").write_bytes(render(pg, art, 512))
    (ICONS / "icon-maskable-512.png").write_bytes(render(pg, square(art), 512, transparent=False))
    (ICONS / "apple-touch-icon.png").write_bytes(render(pg, square(art), 180, transparent=False))
    favs = {n: render(pg, fav, n) for n in (16, 32, 48)}
    b.close()

(ICONS / "favicon-16.png").write_bytes(favs[16])
(ICONS / "favicon-32.png").write_bytes(favs[32])
imgs = [Image.open(io.BytesIO(favs[n])).convert("RGBA") for n in (48, 32, 16)]
imgs[0].save(ROOT / "favicon.ico", format="ICO", sizes=[(48, 48), (32, 32), (16, 16)], append_images=imgs[1:])
print("icons written")
