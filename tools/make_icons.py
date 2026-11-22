#!/usr/bin/env python3
"""Render icons/icon.svg to the PNG sizes the home screens want (iOS ignores SVG icons).

Usage: python3 tools/make_icons.py
"""
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
svg = (ROOT / "icons" / "icon.svg").read_text()
SIZES = {"apple-touch-icon.png": 180, "icon-192.png": 192, "icon-512.png": 512}

with sync_playwright() as p:
    b = p.chromium.launch()
    for name, size in SIZES.items():
        pg = b.new_page(viewport={"width": size, "height": size})
        # iOS rounds the corners itself, so the touch icon is drawn square.
        art = svg.replace('rx="112"', 'rx="0"') if name == "apple-touch-icon.png" else svg
        pg.set_content(f'<body style="margin:0;background:transparent">{art.replace("<svg ", f"<svg width={size} height={size} ", 1)}</body>')
        pg.screenshot(path=str(ROOT / "icons" / name), omit_background=True)
        pg.close()
    b.close()
print("icons written")
