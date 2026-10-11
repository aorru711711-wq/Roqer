/**
 * How an effect's colour reads in the frames `capture_moments` took.
 *
 * A magic-missile run asked for deep violet and magenta with sharp white
 * highlights, and its frames came back mostly pale pink and white. Of the
 * effect's pixels 74-85% were pale (bright and nearly grey), 3-6% vivid or
 * deep colour, and 15-24% blown out to pure white. Eight studied artists'
 * videos run 2-21% pale, 35-90% vivid or deep and 0-9% blown out, and a
 * fireball built with Roqer in the same bright place was 8-14% pale. Additive layers only lighten
 * what is behind them, so over a bright sky they wash a colour out to pastel
 * and then white. A model judging its own frames by eye did not see it.
 *
 * Measured the way the reference-clip analysis measures a clip: small frames
 * against their per-pixel median, a pixel belonging to the effect when one of
 * its channels moved more than `CHANGE_THRESHOLD` from it. A frame that
 * changed almost everywhere has a moving camera and is left out. Pure: frames
 * in, numbers and lines out, so it is tested without Electron.
 *
 * When no frame can be measured it says why. A fireball run's live captures
 * came back twice as frames of the caster standing still, the effect nowhere
 * on screen, and the check said nothing at all, so a blank capture looked the
 * same as one it had no opinion on.
 */
import { CHANGE_THRESHOLD, medianBackground, type AnalysisFrame, type PixelOrder } from "./clip-analysis";

/** The least share of the frame the effect must cover for a frame to count. */
const MIN_AREA = 0.003;
/** A frame changed over more than this share has a moving camera, not an effect. */
const WHOLE_FRAME = 0.6;
/** Frames needed for a background: with fewer, the median is one of the frames. */
const MIN_FRAMES = 3;

/** Shares of the effect's pixels, over the frames where it covers the most. */
export type EffectTone = Readonly<{
  /** Frames the shares come from. */
  frames: number;
  /** Bright and nearly grey: white or pastel. */
  pale: number;
  /** Bright and saturated. */
  vivid: number;
  /** Darker and saturated. */
  deep: number;
  /** Every channel near full: pure white. */
  blown: number;
}>;

/**
 * Why frames that decoded could not be measured: nothing changed from frame to
 * frame over enough of the picture to be an effect, or the frames changed
 * almost everywhere, as a moving camera makes them.
 */
export type ToneGap = Readonly<{ gap: "nothing-showed" | "camera-moved"; frames: number }>;

/** Pale share above which an effect reads washed out: the studied videos reach 21%, this run 54-85%. */
export const WASHED_OUT = 0.4;
/** Blown-out share above which white is a blob rather than a highlight: the studied videos reach 9%. */
export const BLOWN_OUT = 0.12;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The effect's colour across a capture's frames; why it cannot be told when no
 * frame shows an effect on a still camera; or undefined when the frames cannot
 * say either: too few for a background, or of different sizes.
 */
export function measureEffectTone(frames: readonly AnalysisFrame[], order: PixelOrder = "bgra"): EffectTone | ToneGap | undefined {
  if (frames.length < MIN_FRAMES) return undefined;
  const { width, height } = frames[0];
  if (width < 8 || height < 8 || frames.some((frame) => frame.width !== width || frame.height !== height || frame.pixels.length < width * height * 4)) return undefined;
  const background = medianBackground(frames, order);
  const [ri, gi, bi] = order === "bgra" ? [2, 1, 0] : [0, 1, 2];
  const count = width * height;
  const measured: { area: number; pale: number; vivid: number; deep: number; blown: number }[] = [];
  let moved = 0;
  for (const frame of frames) {
    let effect = 0, pale = 0, vivid = 0, deep = 0, blown = 0;
    for (let pixel = 0; pixel < count; pixel++) {
      const r = frame.pixels[pixel * 4 + ri], g = frame.pixels[pixel * 4 + gi], b = frame.pixels[pixel * 4 + bi];
      const change = Math.max(Math.abs(r - background[pixel * 3]), Math.abs(g - background[pixel * 3 + 1]), Math.abs(b - background[pixel * 3 + 2]));
      if (change <= CHANGE_THRESHOLD) continue;
      effect++;
      const high = Math.max(r, g, b) / 255;
      const low = Math.min(r, g, b) / 255;
      const saturation = high > 0 ? (high - low) / high : 0;
      if (high > 0.6 && saturation < 0.35) pale++;
      if (high > 0.5 && saturation >= 0.5) vivid++;
      if (high <= 0.5 && saturation >= 0.4) deep++;
      if (low > 0.9) blown++;
    }
    const area = effect / count;
    if (area > WHOLE_FRAME) moved++;
    if (area < MIN_AREA || area > WHOLE_FRAME) continue;
    measured.push({ area, pale: pale / effect, vivid: vivid / effect, deep: deep / effect, blown: blown / effect });
  }
  if (measured.length === 0) return { gap: moved > 0 ? "camera-moved" : "nothing-showed", frames: frames.length };
  // The frames where the effect is largest carry its look; a fading tail would only dilute it.
  const busiest = [...measured].sort((a, b) => b.area - a.area).slice(0, Math.max(Math.min(3, measured.length), Math.ceil(measured.length / 3)));
  return {
    frames: busiest.length,
    pale: median(busiest.map((frame) => frame.pale)),
    vivid: median(busiest.map((frame) => frame.vivid)),
    deep: median(busiest.map((frame) => frame.deep)),
    blown: median(busiest.map((frame) => frame.blown)),
  };
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** Whether a reading is a measurement rather than a gap. */
export function isToneGap(reading: EffectTone | ToneGap): reading is ToneGap {
  return "gap" in reading;
}

/** Why the colour check measured nothing, as a line for the capture's result. */
export function describeToneGap(gap: ToneGap): string {
  if (gap.gap === "camera-moved") {
    return `Colour check: not measured. The camera moved across these ${gap.frames} frames (they differ almost everywhere), so the effect cannot be told from the scene. Hold the camera still across the moments to have it measured.`;
  }
  return `Colour check: not measured. Across these ${gap.frames} frames nothing changes over even ${(MIN_AREA * 100).toFixed(1)}% of the picture: the effect is not on screen here, too small to see from this camera, or the same in every frame (the check measures what changes). If it should be moving on screen, find out why before judging these frames: whether the code started it, and whether the camera faces it.`;
}

/** The colour check as lines for the capture's result: the shares, then what to change when it is washed or blown out. */
export function describeEffectTone(tone: EffectTone): string[] {
  const lines = [
    `Colour check (the ${tone.frames === 1 ? "frame" : `${tone.frames} frames`} where the effect is largest, against the frames' own background): of the effect's pixels, ${percent(tone.pale)} are pale (white or pastel), ${percent(tone.vivid)} vivid colour, ${percent(tone.deep)} deep colour and ${percent(tone.blown)} blown out to pure white. Studied artists' effects run 2-21% pale, 35-90% vivid or deep and 0-9% blown out.`,
  ];
  if (tone.pale > WASHED_OUT) {
    lines.push("Unless it is meant to be pale (wind, mist, a white holy light), it is washed out, and that reads as cheap. Additive layers (`LightEmission` 1) only lighten what is behind them, so over a bright sky a colour turns pastel and then white. Carry the colour on solid layers (`LightEmission` 0, or below 0 for a dark rim) at Brightness 1-5, keep additive for thin highlights and small glows, and keep soft glows dim: Brightness about 1, Transparency 0.6 or more.");
  }
  if (tone.blown > BLOWN_OUT) {
    lines.push("Too much is pure white: a white highlight is a thin shape (a ring, sparks, a star's arms) at Brightness 1-2, not a soft ball or stacked glows. Overlapping additive layers add up to white; bring them down until the coloured shapes show.");
  }
  return lines;
}
