import assert from "node:assert/strict";
import test from "node:test";

import { LimitsCache, type LimitsReport } from "./limits-cache";

const older: LimitsReport = {
  windows: [{ usedPercent: 10, windowMinutes: 300, resetsAt: null }],
  limitReached: false,
};
const newer: LimitsReport = {
  windows: [{ usedPercent: 80, windowMinutes: 300, resetsAt: null }],
  limitReached: true,
};

test("a replace during an in-flight fetch is still the value after that fetch resolves", async () => {
  let now = 1_000;
  let release: (value: LimitsReport) => void = () => undefined;
  let fetches = 0;
  const cache = new LimitsCache({
    intervalMs: 60_000,
    now: () => now,
    fetch: () => {
      fetches += 1;
      return new Promise<LimitsReport>((resolve) => {
        release = (value) => resolve(value);
      });
    },
  });

  const reading = cache.read();
  await new Promise((resolve) => setImmediate(resolve));
  now = 2_000;
  cache.replace(newer);
  release(older);
  const limits = await reading;
  assert.equal(limits.kind, "reported");
  if (limits.kind !== "reported") return;
  assert.equal(limits.windows[0]?.usedPercent, 80);
  assert.equal(limits.limitReached, true);
  assert.equal(limits.observedAt, 2_000);
  assert.equal(fetches, 1);
});

test("a thrown fetch keeps the previous report", async () => {
  let now = 1_000;
  let fail = false;
  let fetches = 0;
  const cache = new LimitsCache({
    intervalMs: 60_000,
    now: () => now,
    fetch: async () => {
      fetches += 1;
      if (fail) throw new Error("down");
      return older;
    },
  });

  const first = await cache.read();
  assert.equal(first.kind, "reported");
  if (first.kind !== "reported") return;
  assert.equal(first.observedAt, 1_000);

  fail = true;
  now = 61_000;
  const kept = await cache.read();
  assert.equal(fetches, 2);
  assert.deepEqual(kept, first);
});

test("a second read inside the interval does not call fetch", async () => {
  let now = 1_000;
  let fetches = 0;
  const cache = new LimitsCache({
    intervalMs: 60_000,
    now: () => now,
    fetch: async () => {
      fetches += 1;
      return older;
    },
  });

  const first = await cache.read();
  now = 30_000;
  const second = await cache.read();
  assert.equal(fetches, 1);
  assert.deepEqual(second, first);
});
