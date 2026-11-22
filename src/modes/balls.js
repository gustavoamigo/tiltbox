// Balls: the rigid-ball engine with the bouncy-rubber preset (src/modes/balls/).
import { createBallMode } from './balls/mode.js';
import { BALLS } from './balls/presets.js';

export default function create(ctx) {
  return createBallMode(ctx, BALLS);
}
