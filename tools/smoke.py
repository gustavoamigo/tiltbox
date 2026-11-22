#!/usr/bin/env python3
"""Smoke test: load each mode in headless Chromium, drive it through a gravity script
(upright, tilted, upside down, flat, shaken, stirred, rotated page) and check that nothing
goes non-finite or leaves the box. Saves a screenshot per phase.

Usage: python3 tools/smoke.py [mode ...] [--out DIR] [--throttle N]
  --throttle N   slow the CPU N times (DevTools emulation), to estimate a mid-range phone
Exit status 1 if any check fails.
"""
import argparse
import json
import pathlib
import socket
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
G = 9.81

# (name, frames, gravity (x, y, z) or None to keep, extra action)
PHASES = [
    ("settle", 240, (0, G, 0), None),
    ("tilt-right-30", 180, (G * 0.5, G * 0.866, 0), None),
    ("tilt-left-60", 180, (-G * 0.866, G * 0.5, 0), None),
    ("upside-down", 240, (0, -G, 0), None),
    ("upright-again", 240, (0, G, 0), None),
    ("flat-on-table", 120, (0, 0.3, G), None),
    ("shake-side", 90, (0, G, 0), ("shake", [32, 0.8, 1, 0, 7])),
    ("shake-hard", 60, (0, G, 0), ("shake", [45, 0.5, 0.7, 0.7, 9])),
    ("stir", 90, (0, G, 0), ("stir", None)),
    ("after-stir", 120, (0, G, 0), ("unstir", None)),
    ("rotated-90", 120, (0, G, 0), ("rotate", 90)),
    ("rotated-0", 60, (0, G, 0), ("rotate", 0)),
]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("modes", nargs="*")
    ap.add_argument("--out", default="/tmp/tiltbox-smoke")
    ap.add_argument("--throttle", type=float, default=0)
    ap.add_argument("--width", type=int, default=393)
    ap.add_argument("--height", type=int, default=852)
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    port = free_port()
    srv = subprocess.Popen([sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):  # wait for the server to listen
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    failures = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            ctx = b.new_context(viewport={"width": args.width, "height": args.height}, device_scale_factor=1,
                                has_touch=True, is_mobile=True)
            page = ctx.new_page()
            logs = []
            page.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
            page.on("pageerror", lambda e: logs.append(f"pageerror: {e}"))
            page.goto(f"http://127.0.0.1:{port}/?test=1&nosound")
            modes = args.modes or page.evaluate("__T.modes")
            if args.throttle:
                cdp = ctx.new_cdp_session(page)
                cdp.send("Emulation.setCPUThrottlingRate", {"rate": args.throttle})
            for m in modes:
                page.evaluate("(m) => { __T.setMode(m); }", m)  # don't await create(): a hung mode must not hang the run
                try:
                    page.wait_for_function("(m) => (__T.ready && __T.mode === m) || __T.error", arg=m, timeout=20000)
                except Exception:
                    failures.append(f"{m}: did not start within 20 s")
                    print(f"{m}: TIMEOUT")
                    continue
                err = page.evaluate("__T.error")
                if err:
                    failures.append(f"{m}: failed to start: {err}")
                    print(f"{m}: FAILED TO START\n{err}")
                    continue
                page.evaluate("__T.pause(true)")
                print(f"== {m}")
                for name, frames, g, action in PHASES:
                    if g:
                        page.evaluate("(g) => __T.gravity(g[0], g[1], g[2])", list(g))
                    if action:
                        kind, val = action
                        if kind == "shake":
                            page.evaluate("(a) => __T.shake(...a)", val)
                        elif kind == "stir":
                            sw, sh = page.evaluate("[__T.view.simW, __T.view.simH]")
                            page.evaluate("(p) => __T.pointer([p])", {"x": sw * 0.5, "y": sh * 0.75, "vx": 900, "vy": -300})
                        elif kind == "unstir":
                            page.evaluate("__T.pointer(null)")
                        elif kind == "rotate":
                            # A phone turning swaps the viewport and the angle together; the sim box
                            # (the device's own frame) must not change shape.
                            w, h = (args.height, args.width) if val % 180 else (args.width, args.height)
                            page.set_viewport_size({"width": w, "height": h})
                            page.evaluate("(a) => __T.rotate(a)", val)
                            sim = page.evaluate("[__T.view.simW, __T.view.simH]")
                            if sim != [args.width, args.height]:
                                failures.append(f"{m}/rotate {val}: sim box changed to {sim}")
                    t0 = time.time()
                    s = None
                    done = 0
                    while done < frames:  # in chunks so a slow mode cannot hit the evaluate timeout
                        n = min(30, frames - done)
                        s = page.evaluate("(n) => __T.step(n)", n)
                        done += n
                    wall = (time.time() - t0) / frames * 1000
                    err = page.evaluate("__T.error")
                    bad = []
                    if err:
                        bad.append(f"error: {err.splitlines()[0]}")
                    if s is None:
                        bad.append("no stats")
                    else:
                        if s.get("nan"):
                            bad.append("non-finite state")
                        if s.get("outside", 0):
                            bad.append(f"{s['outside']} outside the box")
                    page.screenshot(path=str(out / f"{m}-{name}.png"))
                    keys = {k: v for k, v in (s or {}).items() if k not in ("g",)}
                    summary = " ".join(f"{k}={round(v, 3) if isinstance(v, float) else v}" for k, v in keys.items()
                                       if k not in ("mode", "quality", "fps", "simW", "simH", "source"))
                    flag = "FAIL " + "; ".join(bad) if bad else "ok"
                    print(f"  {name:15s} {flag:4s} {wall:6.2f} ms/frame wall  {summary}")
                    if bad:
                        failures.append(f"{m}/{name}: {'; '.join(bad)}")
                page.set_viewport_size({"width": args.width, "height": args.height})
                page.evaluate("__T.rotate(null)")
                page.evaluate("__T.pointer(null)")
                page.evaluate("__T.gravity(null)")
            b.close()
            if logs:
                print("\nconsole:")
                for line in logs[:40]:
                    print("  " + line)
    finally:
        srv.terminate()
    print(f"\nscreenshots in {out}")
    if failures:
        print("\nFAILURES:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
