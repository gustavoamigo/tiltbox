// Synthesised sound for the box. No sample files: every sound is made with Web Audio.
//
// Contract (modes call only this):
//   audio.unlock()                      call inside a user gesture (iOS starts audio only from one)
//   audio.enabled                       get/set; persisted by main.js
//   audio.impact(kind, intensity, pitch = 1)
//       one-shot hit. kind: 'glass' | 'rubber' | 'grain' | 'drop' | 'chime'
//       intensity 0..1 (loudness, also brightness), pitch: multiplier around the kind's base (0.5..2)
//       Cheap to call; the engine limits voices and rate, so modes may call it freely per contact.
//   audio.bed(kind) -> { set(level, tone), stop() }
//       a continuous texture. kind: 'water' | 'honey' | 'sand' | 'swirl'
//       level 0..1 (how much is moving), tone 0..1 (how bright/fast). Call set() every frame.
//
// This file is a silent stub until the audio engine lands; the API is final.

export function createAudio() {
  const beds = new Set();
  return {
    enabled: true,
    unlock() {},
    impact(/* kind, intensity, pitch */) {},
    bed(/* kind */) {
      const h = { set() {}, stop() { beds.delete(h); } };
      beds.add(h);
      return h;
    },
    suspend() {},
    resume() {},
  };
}
