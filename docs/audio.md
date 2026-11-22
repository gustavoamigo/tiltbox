# Audio engine (`src/audio.js`)

Every sound is synthesised with Web Audio; there are no sample files. Modes use only the API in `docs/design.md`: `impact(kind, intensity, pitch)`, `bed(kind) → { set(level, tone), stop() }`, plus `unlock`, `enabled`, `suspend`, `resume` from the shell. Unknown kinds are ignored. Before `unlock()`, while `enabled` is false, while the page is hidden and while the context is not running, every call is a no-op.

## How it works

**Graph.** Voices and beds → master gain (the mute) → `DynamicsCompressor` → `WaveShaper` soft clipper → speakers. `createSynth(ctx)` builds all of it on any `BaseAudioContext`, so the tests render through the same code on an `OfflineAudioContext`. `createAudio()` is the engine modes talk to: it owns the `AudioContext`, rate limiting and the iOS life cycle.

**Impacts are pre-rendered.** After unlock, each impact kind is synthesised in plain JS into a small bank of stereo `AudioBuffer`s: a few brightness levels (soft hit to hard hit) × a few random takes, each normalised to the same short-term loudness and panned slightly left or right. That is 40 takes in all, rendered one per `setTimeout` task so the Start tap never stalls a frame. A hit is then one `AudioBufferSourceNode` and one `GainNode`; `playbackRate` carries the caller's pitch and ±3–6 % random jitter, and the gain carries the intensity. A kind stays silent until its bank is complete, which takes well under a second.

| Kind | Synthesis | At pitch 1 |
|---|---|---|
| `glass` | 5 inharmonic modes (ratios 0.72–2.66 of a random 2.1–2.5 kHz root, τ 4.5–12 ms), a 1 kHz knock, a bright 0.3 ms contact click; soft hits lose the top modes | centroid 2.2–2.5 kHz, −40 dB after 65–80 ms |
| `rubber` | sine at ~210 Hz with pitch falling from +45…115 % (τ 11 ms) through a tanh, its second mode at ×2.3 gliding with it, a 720 Hz 'pok', a dull click | centroid 180–220 Hz, −40 dB after 155 ms |
| `grain` | 0.7 ms noise burst through a 3–7 kHz resonance | centroid 5–6.4 kHz, 15 ms |
| `drop` | sine from ~820 Hz rising ×1.9–2.7 in 35 ms (the 'ip' of 'plip') | centroid 1.1–1.3 kHz, 55 ms |
| `chime` | bar modes 1, 2.76, 5.40, 8.93 plus a near-unison twin (shimmer), always G6 (1568 Hz) × pitch, so pitch is the note | 0.65 s ring |

**Beds** are a looping 2 s noise buffer (one per context, made once) through biquads whose frequencies and gains follow `level` and `tone` with `setTargetAtTime`, steered at most 30 times a second however often `set()` is called. An Ornstein–Uhlenbeck random walk moves each centre frequency slowly, so a steady bed never sounds like a loop. Level 0 is silence (gains glide to 0).

| Bed | Graph | Extras |
|---|---|---|
| `water` | noise → band-pass at (300 + 800·tone) Hz → low-pass; a high-passed fizz when fast | bubbles: pitched-down drops, up to ~18/s at full level and tone |
| `honey` | noise → high-pass → resonant low-pass at (400 + 450·tone) Hz, slow (τ 0.2 s) | an occasional slow low bloop |
| `sand` | a pre-made crackle loop (2500 tiny grains/s) high-passed at 1.5–4 kHz, played faster with tone, level fluttering; a little air above 6 kHz | |
| `swirl` | two band-passes an octave apart at (300 + 1000·tone) Hz under a low-pass | |

**Voices and rate.** `impact()` only records a candidate in preallocated typed arrays; a microtask after the frame's task plays the loudest few, loudest first. Per kind there is a token bucket (`rate` hits/s, `burst`) and a per-frame cap; the whole engine has 24 voices. A new hit takes a free voice, or steals the quietest playing one (its current loudness estimated from its gain and decay constant) if the new hit is louder, fading it over ~5 ms; otherwise it is dropped. Hits from one frame start spread over 12 ms, so a burst is a rattle rather than one loud flam. A recent-hit density (80 ms window) scales each hit by 1/√(1 + density/4), so 400 clacks a second are only a few dB louder than one.

**Levels.** `intensity` is linear amplitude: 0.5 is 6 dB below 1. Hits below 0.015 are skipped. The compressor (threshold −10 dB, knee 6, ratio 12, attack 2 ms, release 150 ms) leaves single hits alone and catches dense sums; Web Audio adds its own make-up gain (+4.3 dB measured) below the threshold. The soft clipper is unity up to 0.7 and then a tanh knee ending at 0.917, so the output can never reach full scale.

**iOS and page life.** `unlock()` (from the Start tap) creates the context in the gesture, plays a one-sample silent buffer and calls `resume()`. Whenever the context should run but is not (iOS `interrupted` after a call or Siri, or a `resume()` refused outside a gesture), the next `pointerdown`, `pointerup`, `touchend`, `keydown` or `click` anywhere retries, until it runs. `suspend()`/`resume()` (page hidden or shown) and `enabled = false` suspend the context, which saves battery; muting also sets the master gain to 0 at once. `navigator.audioSession.type = 'ambient'` (iOS 17+): Tiltbox mixes with the user's music, and the ring/silent switch mutes it, as it does for most games.

## Tuning constants

| Constant | Value | Why |
|---|---|---|
| `gain` per kind | glass 0.45, rubber 0.45, grain 0.30, drop 0.42, chime 0.18 | a full hit at about −20 dBFS short-term RMS (grain −27, a tick; chime lower because it rings 0.65 s) |
| `rate`, `burst`, `perFrame` | glass 120/s, 16, 8; rubber 40/s, 8, 4; grain 140/s, 12, 8; drop 30/s, 6, 4; chime 16/s, 5, 3 | dense enough for a shaken jar of marbles; bouncy-ball thumps are long (150 ms) and turn to mud if denser |
| `MAX_VOICES` | 24 | each is two nodes; more is inaudible under the compressor |
| `SPREAD_S` | 12 ms | spreads one frame's hits; shorter flams, longer sounds late |
| rubber second mode | ×2.3, amplitude 0.3–0.55 | a phone speaker plays almost nothing at 200 Hz; this mode (~480 Hz) carries the bounce there |
| honey high-pass | 0.5 × its low-pass | removes rumble a phone cannot play; keeps it darker than water |
| `MAX_PARTIAL_HZ` | 11 kHz | partials above are dropped at synthesis so pitch 2 stays below Nyquist at 44.1 kHz |

Phone-speaker check: each sound weighted by a 4th-order high-pass at 450 Hz (roughly a phone's speaker). Glass, grain, drop, chime and sand lose 0 dB; rubber loses 1–7 dB (more at low pitch); honey at tone 0 loses 5 dB; water and swirl 0–3 dB.

## Measured

Headless Chromium 1248 on the development desktop, 48 kHz.

- Every kind at intensity 0.2/0.6/1 and pitch 0.7/1/1.5 (45 renders) and every bed at 8 level/tone settings: peak below 1, centroid in the intended band (scaled by pitch), beds exactly silent at level 0.
- Stress through the master chain: 400 glass hits in 1 s, peak 0.69; 200 in 50 ms, peak 0.81; all four beds flat out + 120 full hits + 300 glass hits in 100 ms, peak 0.79 (0.05 % of samples in the clipper's knee); 120 full hits on one sample, peak 0.917 (the clipper's ceiling).
- `impact()` hammered 5000 times in one frame: 0.12–0.16 µs per call, 26–27 played (the per-frame caps), live voices peak 24, the flush 0.9 ms. 42 calls a frame for 120 frames: 0.2–0.34 µs per call, flush 0.15–0.2 ms a frame (0.3–0.55 ms at 4× CPU throttle), worst frame 0.4 ms (1–3 ms at 4×). Bed `set()` 0.01 ms a frame. Bank rendering: at most 0.9 ms per task (3.8 ms at 4×), 40 tasks.
- No exceptions before unlock (every kind, unknown kinds, NaN/negative/huge arguments, beds created and stopped), with `enabled = false` (0 played of 5000, 0.02–0.04 µs per call, context suspended), while hidden (0 played), and after an interruption from outside (suspended, then running again after the next gesture). A second `unlock()` keeps the one context.
- Real app page with sound on (water, honey): output peak 0.3–0.4, no errors.

Not verifiable here: how it sounds (judged only by numbers and spectrograms), iOS Safari behaviour (unlock, `interrupted`, audio session), and audio-thread load on a phone.
