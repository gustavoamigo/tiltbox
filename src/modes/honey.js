// Honey: the FLIP liquid engine (src/modes/fluid/) with the honey preset: viscous, slow, amber.
import { createLiquidMode } from './fluid/liquid.js';
import { HONEY } from './fluid/tuning.js';

export default function create(ctx) {
  return createLiquidMode(ctx, HONEY);
}
