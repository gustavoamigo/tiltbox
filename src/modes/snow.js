// Snow: a snow globe. The engine lives in src/modes/snow/; see docs/modes/snow.md.
import { createSnowMode } from './snow/mode.js';

export default function create(ctx) {
  return createSnowMode(ctx);
}
