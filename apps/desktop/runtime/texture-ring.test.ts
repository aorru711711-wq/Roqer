import assert from "node:assert/strict";
import test from "node:test";

import type { DecodedPng } from "./flipbook-sheet";
import { analyzeRing, describeRing } from "./texture-ring";

const SIZE = 128;

/** A white ring on transparency, its brightness and width given by the angle (radians, -pi to pi). */
function ring(brightness: (angle: number) => number, width: (angle: number) => number, { radius = 0.7, from = -Math.PI, to = Math.PI } = {}): DecodedPng {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const c = (SIZE - 1) / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const angle = Math.atan2(y - c, x - c);
      if (angle < from || angle > to) continue;
      const r = Math.hypot(x - c, y - c) / (SIZE / 2);
      const inside = Math.abs(r - radius) <= width(angle) / 2;
      if (!inside) continue;
      const at = (y * SIZE + x) * 4;
      rgba[at] = rgba[at + 1] = rgba[at + 2] = 255;
      rgba[at + 3] = Math.round(255 * brightness(angle));
    }
  }
  return { width: SIZE, height: SIZE, rgba, hasAlpha: true };
}

test("an even ring at full brightness is noted as clip art", () => {
  const report = analyzeRing(ring(() => 1, () => 0.06));
  assert.ok(report);
  assert.ok(report.brightnessSpread < 0.05, `brightness ${report.brightnessSpread}`);
  assert.ok(report.widthSpread < 0.25, `width ${report.widthSpread}`);
  assert.equal(report.fullShare, 1);
  const lines = describeRing(report);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^This ring is even all round: its brightness spreads \d+% and its width \d+% around the circle, with 100% of it at full brightness\. In the studied effects 84% of 159 rings vary/);
});

test("a ring with a bright, thick arc that thins and fades round the rest passes", () => {
  const weighted = ring((angle) => 0.3 + 0.7 * (0.5 + 0.5 * Math.cos(angle)), (angle) => 0.03 + 0.07 * (0.5 + 0.5 * Math.cos(angle)));
  const report = analyzeRing(weighted);
  assert.ok(report);
  assert.ok(report.brightnessSpread > 0.2 && report.widthSpread > 0.3, JSON.stringify(report));
  assert.deepEqual(describeRing(report), []);
});

test("shapes that are not rings are left alone: a filled disc, an arc, an empty image", () => {
  const disc = ring(() => 1, () => 1.2, { radius: 0.5 });
  assert.equal(analyzeRing(disc), undefined);
  const arc = ring(() => 1, () => 0.06, { from: 0, to: Math.PI / 2 });
  assert.equal(analyzeRing(arc), undefined);
  assert.equal(analyzeRing(ring(() => 0, () => 0.06)), undefined);
});

test("a texture without transparency is read by its brightness", () => {
  const additive = ring(() => 1, () => 0.06);
  for (let at = 0; at < additive.rgba.length; at += 4) {
    const alpha = additive.rgba[at + 3];
    additive.rgba[at] = additive.rgba[at + 1] = additive.rgba[at + 2] = alpha;
    additive.rgba[at + 3] = 255;
  }
  const report = analyzeRing(additive);
  assert.ok(report && report.brightnessSpread < 0.05);
});
