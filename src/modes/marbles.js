// Marbles: the rigid-ball engine with the glass-marble preset (src/modes/balls/).
import { createBallMode } from './balls/mode.js';
import { MARBLES } from './balls/presets.js';

export default function create(ctx) {
  return createBallMode(ctx, MARBLES);
}
