import assert from "node:assert/strict";
import test from "node:test";

import type { AnalysisFrame } from "./clip-analysis";
import { describeEffectTone, describeToneGap, isToneGap, measureEffectTone, type EffectTone } from "./effect-tone";

type Rgb = readonly [number, number, number];

const WIDTH = 48;
const HEIGHT = 32;
/** A bright daytime floor, about the value of a new place's baseplate and sky. */
const DAYLIGHT: Rgb = [160, 166, 176];

/**
 * Frames of one scene in which a disc of `color` shows at a different place in
 * each frame, as an effect moves; the first and last frames are empty. Each
 * pixel is covered at most once, so the frames' median is the background.
 */
function scene(color: Rgb, { order = "rgba", background = DAYLIGHT, frames = 6, radius = 6 }: { order?: "rgba" | "bgra"; background?: Rgb; frames?: number; radius?: number } = {}): AnalysisFrame[] {
  return Array.from({ length: frames }, (_, index) => {
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    const cx = 8 + index * 7;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const inside = index > 0 && index < frames - 1 && Math.hypot(x - cx, y - HEIGHT / 2) <= radius;
        const [r, g, b] = inside ? color : background;
        const at = (y * WIDTH + x) * 4;
        pixels.set(order === "bgra" ? [b, g, r, 255] : [r, g, b, 255], at);
      }
    }
    return { time: index * 0.1, width: WIDTH, height: HEIGHT, pixels };
  });
}

/** A measurement, failing the test when it comes back as a gap. */
function measure(frames: AnalysisFrame[], order: "rgba" | "bgra" = "bgra"): EffectTone | undefined {
  const reading = measureEffectTone(frames, order);
  assert.ok(reading === undefined || !isToneGap(reading), `a gap: ${JSON.stringify(reading)}`);
  return reading as EffectTone | undefined;
}

test("a pale effect over a bright scene is measured as washed out, and told what to change", () => {
  const tone = measure(scene([250, 205, 245]), "rgba");
  assert.ok(tone);
  assert.ok(tone.pale > 0.9, `pale ${tone.pale}`);
  assert.equal(tone.vivid, 0);
  const lines = describeEffectTone(tone);
  assert.match(lines[0], /of the effect's pixels, \d+% are pale \(white or pastel\), 0% vivid colour, 0% deep colour and 0% blown out to pure white\. Studied artists' effects run 2-21% pale, 35-90% vivid or deep and 0-9% blown out\./);
  assert.ok(lines.some((line) => /Unless it is meant to be pale \(wind, mist, a white holy light\), it is washed out, and that reads as cheap\. Additive layers \(`LightEmission` 1\) only lighten what is behind them/.test(line)));
  assert.ok(!lines.some((line) => /Too much is pure white/.test(line)));
});

test("a deep, saturated effect passes without advice", () => {
  const deep = measure(scene([70, 10, 120]), "rgba");
  assert.ok(deep);
  assert.ok(deep.deep > 0.9, `deep ${deep.deep}`);
  assert.equal(describeEffectTone(deep).length, 1);
  const vivid = measure(scene([230, 40, 200]), "rgba");
  assert.ok(vivid && vivid.vivid > 0.9);
  assert.equal(describeEffectTone(vivid).length, 1);
});

test("white blown out across the effect is named as too much white", () => {
  const tone = measure(scene([255, 255, 255]), "rgba");
  assert.ok(tone && tone.blown > 0.9);
  const lines = describeEffectTone(tone);
  assert.ok(lines.some((line) => /Too much is pure white: a white highlight is a thin shape/.test(line)));
});

test("Electron's BGRA bitmaps are read in their own byte order", () => {
  const rgba = measure(scene([230, 40, 200]), "rgba");
  const bgra = measure(scene([230, 40, 200], { order: "bgra" }), "bgra");
  assert.deepEqual(bgra, rgba);
  // Read in the wrong order, magenta would still be vivid; a blue-dominant colour shows the difference.
  assert.ok((measure(scene([40, 90, 230], { order: "bgra" }))?.vivid ?? 0) > 0.9, "BGRA is the default");
});

test("it says nothing it cannot tell: too few frames or mismatched sizes", () => {
  assert.equal(measureEffectTone(scene([250, 205, 245], { frames: 2 }), "rgba"), undefined);
  const mismatched = scene([250, 205, 245]);
  mismatched[2] = { ...mismatched[2], width: WIDTH - 1 };
  assert.equal(measureEffectTone(mismatched, "rgba"), undefined);
});

test("frames with no effect in them, or from a moving camera, are named as such rather than passed over", () => {
  // Every frame different everywhere: the camera moved, so nothing is an effect.
  const moving = Array.from({ length: 5 }, (_, index) => scene([0, 0, 0], { background: [index * 50, 255 - index * 50, 100] })[0]);
  const moved = measureEffectTone(moving, "rgba");
  assert.deepEqual(moved, { gap: "camera-moved", frames: 5 });
  assert.ok(moved && isToneGap(moved));
  assert.match(describeToneGap(moved), /^Colour check: not measured\. The camera moved across these 5 frames/);
  // An effect the colour of the scene, as when nothing played: nothing changes.
  const still = measureEffectTone(scene(DAYLIGHT), "rgba");
  assert.deepEqual(still, { gap: "nothing-showed", frames: 6 });
  assert.ok(still && isToneGap(still));
  assert.match(describeToneGap(still), /Across these 6 frames nothing changes over even 0\.3% of the picture: the effect is not on screen here, too small to see from this camera, or the same in every frame/);
  // A speck under 0.3% of the picture is too small to measure.
  assert.deepEqual(measureEffectTone(scene([230, 40, 200], { radius: 0.5 }), "rgba"), { gap: "nothing-showed", frames: 6 });
  assert.ok(!isToneGap(measureEffectTone(scene([230, 40, 200]), "rgba")!));
});
