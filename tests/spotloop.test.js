"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  clamp,
  formatTime,
  validBounds,
  makeLastWindow,
  safeParseState,
} = require("../spotloop.js");

test("formats millisecond positions", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(72000), "1:12");
  assert.equal(formatTime(3661000), "61:01");
});

test("clamps marker positions", () => {
  assert.equal(clamp(-10, 0, 100), 0);
  assert.equal(clamp(55, 0, 100), 55);
  assert.equal(clamp(150, 0, 100), 100);
});

test("accepts only ordered loop bounds at least one second apart", () => {
  assert.equal(validBounds(1000, 5000, 10000), true);
  assert.equal(validBounds(1000, 1500, 10000), false);
  assert.equal(validBounds(5000, 1000, 10000), false);
  assert.equal(validBounds(1000, 11000, 10000), false);
});

test("builds a trailing playback window", () => {
  assert.deepEqual(makeLastWindow(30000, 15000), { start: 15000, end: 30000 });
  assert.deepEqual(makeLastWindow(8000, 15000), { start: 0, end: 8000 });
});

test("recovers safely from invalid saved state", () => {
  assert.deepEqual(safeParseState("not-json"), { version: 1, sectionsByTrack: {} });
  assert.deepEqual(safeParseState('{"sectionsByTrack":{"track":[]}}'), {
    version: 1,
    sectionsByTrack: { track: [] },
  });
});

