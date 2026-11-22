// Water: the FLIP liquid engine (src/modes/fluid/) with the water preset.
import { createLiquidMode } from './fluid/liquid.js';
import { WATER } from './fluid/tuning.js';

export default function create(ctx) {
  return createLiquidMode(ctx, WATER);
}
