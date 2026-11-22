// The simulation lives in the device's natural frame, not the screen's: x right, y down, in CSS
// pixels, origin at the device's top-left corner as you hold it in its natural orientation
// (portrait on a phone). The accelerometer reports in that same frame, so physics never needs to
// know how the page is rotated. When the browser rotates the page to landscape, the renderer
// rotates the picture back, so the contents stay put against the glass instead of jumping.

export function screenAngle() {
  let a = 0;
  if (screen.orientation && typeof screen.orientation.angle === 'number') a = screen.orientation.angle;
  else if (typeof window.orientation === 'number') a = window.orientation; // old iOS
  return (((Math.round(a / 90) * 90) % 360) + 360) % 360;
}

// Affine map sim -> screen CSS px, as X = a x + b y + c, Y = d x + e y + f, for each page angle.
// angle 90: the device is turned 90° counter-clockwise (its top at your left).
function affine(angle, simW, simH) {
  switch (angle) {
    case 90: return [0, 1, 0, -1, 0, simW];
    case 180: return [-1, 0, simW, 0, -1, simH];
    case 270: return [0, -1, simH, 1, 0, 0];
    default: return [1, 0, 0, 0, 1, 0];
  }
}

export class View {
  // cssW/cssH: the screen size of the canvas in CSS px; angle: screenAngle(); dpr: backing scale.
  constructor(cssW, cssH, angle, dpr) {
    const turned = angle === 90 || angle === 270;
    this.cssW = cssW;
    this.cssH = cssH;
    this.angle = angle;
    this.dpr = dpr;
    this.simW = turned ? cssH : cssW;
    this.simH = turned ? cssW : cssH;
    this.pxW = Math.max(1, Math.round(cssW * dpr)); // canvas backing size (screen orientation)
    this.pxH = Math.max(1, Math.round(cssH * dpr));
    const [a, b, c, d, e, f] = affine(angle, this.simW, this.simH);
    this.m = { a, b, c, d, e, f };
    // sim (x, y, 1) -> clip space, column-major mat3 for `uniform mat3`: clip = M * vec3(x, y, 1).
    this.clipMatrix = new Float32Array([
      (2 * a) / cssW, (-2 * d) / cssH, 0,
      (2 * b) / cssW, (-2 * e) / cssH, 0,
      (2 * c) / cssW - 1, 1 - (2 * f) / cssH, 1,
    ]);
  }

  same(o) {
    return o && o.cssW === this.cssW && o.cssH === this.cssH && o.angle === this.angle && o.dpr === this.dpr;
  }

  toScreen(x, y) {
    const { a, b, c, d, e, f } = this.m;
    return { x: a * x + b * y + c, y: d * x + e * y + f };
  }

  // Screen CSS px (e.g. clientX/clientY relative to the stage) -> sim px.
  toSim(X, Y) {
    switch (this.angle) {
      case 90: return { x: this.simW - Y, y: X };
      case 180: return { x: this.simW - X, y: this.simH - Y };
      case 270: return { x: Y, y: this.simH - X };
      default: return { x: X, y: Y };
    }
  }

  // Rotate a screen-space vector (no translation) into the sim frame.
  vecToSim(vx, vy) {
    switch (this.angle) {
      case 90: return { x: -vy, y: vx };
      case 180: return { x: -vx, y: -vy };
      case 270: return { x: vy, y: -vx };
      default: return { x: vx, y: vy };
    }
  }

  // For Canvas2D modes: after this, draw in sim px and it lands right on the rotated screen.
  apply2d(ctx) {
    const { a, b, c, d, e, f } = this.m;
    const s = this.dpr;
    ctx.setTransform(a * s, d * s, b * s, e * s, c * s, f * s);
  }
}
