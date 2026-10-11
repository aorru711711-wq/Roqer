/**
 * Whether a drawn ring is even all round, the way clip art is.
 *
 * A magic-missile run drew its rings and rune band as clean bands of one
 * width at full brightness all the way round, and the effect read as cheap
 * beside artists' work. Of 159 ring textures in the studied effects, 84%
 * vary around the circle: a bright, thick arc that thins and fades round the
 * rest, brush strokes with breaks, or radial streaks. Their brightness
 * spreads a median 32% around the ring and their width 51%, and a median of
 * 8% of a ring is at full brightness. The run's ring spread 1% and was at
 * full brightness all round.
 *
 * The ring is found from the pixels: drawn pixels mostly in one band about
 * the centre, and present around at least half of it. Around it, each of 72
 * angles gets the band's brightest pixel and its width in pixels. Pure:
 * decoded pixels in, numbers and lines out.
 */
import type { DecodedPng } from "./flipbook-sheet";

const ANGLES = 72;
/** A pixel at least this bright (alpha times value) is drawn. */
const DRAWN = 0.15;
/** Brightness spread and width spread under which a ring is even: 16% of the studied rings are. */
const EVEN_BRIGHTNESS = 0.15;
const EVEN_WIDTH = 0.25;

export type RingReport = Readonly<{
  /** Spread of the brightest pixel around the ring, as a coefficient of variation. */
  brightnessSpread: number;
  /** Spread of the band's width around the ring. */
  widthSpread: number;
  /** Share of the angles at full brightness. */
  fullShare: number;
}>;

/** How bright a pixel shows: its alpha times its value, or its value when the texture has no transparency. */
function intensities(png: DecodedPng): Float32Array {
  const { width, height, rgba } = png;
  const count = width * height;
  let opaque = true;
  if (png.hasAlpha) {
    for (let index = 0; index < count; index++) {
      if (rgba[index * 4 + 3] < 230) {
        opaque = false;
        break;
      }
    }
  }
  const out = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const value = Math.max(rgba[index * 4], rgba[index * 4 + 1], rgba[index * 4 + 2]) / 255;
    out[index] = opaque ? value : value * (rgba[index * 4 + 3] / 255);
  }
  return out;
}

function spread(values: readonly number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/** The ring's evenness, or undefined when the texture is not a ring (a filled shape, an arc, a star, a sigil's lines). */
export function analyzeRing(png: DecodedPng): RingReport | undefined {
  const { width, height } = png;
  if (width < 16 || height < 16) return undefined;
  const intensity = intensities(png);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const half = Math.min(width, height) / 2;
  const radii: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (intensity[y * width + x] >= DRAWN) radii.push(Math.hypot(x - cx, y - cy) / half);
    }
  }
  if (radii.length < width * height * 0.003) return undefined;
  const sorted = [...radii].sort((a, b) => a - b);
  const middle = sorted[sorted.length >> 1];
  // A ring: drawn pixels in one band, not near the centre.
  if (middle < 0.25 || radii.filter((radius) => Math.abs(radius - middle) < 0.18 * middle).length < 0.75 * radii.length) return undefined;
  const peak = new Array<number>(ANGLES).fill(0);
  const thickness = new Array<number>(ANGLES).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = intensity[y * width + x];
      if (value < DRAWN) continue;
      const radius = Math.hypot(x - cx, y - cy) / half;
      if (Math.abs(radius - middle) >= 0.25 * middle) continue;
      const bin = Math.min(ANGLES - 1, Math.floor(((Math.atan2(y - cy, x - cx) + Math.PI) / (2 * Math.PI)) * ANGLES));
      peak[bin] = Math.max(peak[bin], value);
      thickness[bin]++;
    }
  }
  const present = peak.map((value, bin) => ({ value, width: thickness[bin] })).filter((entry) => entry.value > DRAWN);
  // An arc or a crescent is drawn on purpose to one side; only a ring that goes round is judged.
  if (present.length < ANGLES / 2) return undefined;
  return {
    brightnessSpread: spread(present.map((entry) => entry.value)),
    widthSpread: spread(present.map((entry) => entry.width)),
    fullShare: present.filter((entry) => entry.value > 0.85).length / present.length,
  };
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

/** A note for a ring that is even all round; nothing for one that varies. */
export function describeRing(report: RingReport): string[] {
  if (report.brightnessSpread >= EVEN_BRIGHTNESS || report.widthSpread >= EVEN_WIDTH) return [];
  return [
    `This ring is even all round: its brightness spreads ${percent(report.brightnessSpread)} and its width ${percent(report.widthSpread)} around the circle, with ${percent(report.fullShare)} of it at full brightness. In the studied effects 84% of 159 rings vary: a bright, thick arc that thins and fades round the rest, brush strokes with breaks, or radial streaks. Their brightness spreads a median 32% and their width 51%, and only about 8% of a ring is at full brightness. An even ring at full brightness reads as clip art; vary its value and width smoothly with the angle (not in lumps), unless it is a symbol's line.`,
  ];
}
