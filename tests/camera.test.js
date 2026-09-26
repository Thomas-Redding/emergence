import test from "node:test";
import assert from "node:assert/strict";
import { panCamera, PAN_SPEED } from "../render/render.js";

const cam = (zoom = 24) => ({ x: 50, y: 50, zoom });

test("panning moves the camera in the held direction, at constant screen speed", () => {
  const c = cam(20);
  assert.equal(panCamera(c, 1, 0, 0.5), true);
  assert.equal(c.x, 50 + (PAN_SPEED * 0.5) / 20);
  assert.equal(c.y, 50);
  const zoomedOut = cam(5), zoomedIn = cam(50);
  panCamera(zoomedOut, 1, 0, 1);
  panCamera(zoomedIn, 1, 0, 1);
  // same on-screen distance (PAN_SPEED px) whatever the zoom
  assert.ok(Math.abs((zoomedOut.x - 50) * 5 - PAN_SPEED) < 1e-9);
  assert.ok(Math.abs((zoomedIn.x - 50) * 50 - PAN_SPEED) < 1e-9);
});

test("diagonals are not faster; no direction means no movement; shift is 3x", () => {
  const d = cam(), s = cam();
  panCamera(d, 1, 1, 1);
  const len = Math.sqrt((d.x - 50) ** 2 + (d.y - 50) ** 2);
  assert.ok(Math.abs(len - PAN_SPEED / 24) < 1e-9);
  const still = cam();
  assert.equal(panCamera(still, 0, 0, 1), false);
  assert.deepEqual([still.x, still.y], [50, 50]);
  panCamera(s, 1, 0, 1, true);
  assert.ok(Math.abs((s.x - 50) - 3 * PAN_SPEED / 24) < 1e-9);
});

test("motion scales with elapsed time, and the camera stays inside the world", () => {
  const a = cam(), b = cam();
  panCamera(a, 0, 1, 0.1);
  for (let i = 0; i < 10; i++) panCamera(b, 0, 1, 0.01);
  assert.ok(Math.abs(a.y - b.y) < 1e-9, "same total distance whatever the frame rate");
  const c = cam();
  panCamera(c, 1, 1, 100, true, { width: 96, height: 96 });
  assert.deepEqual([c.x, c.y], [96, 96]);
  panCamera(c, -1, -1, 1000, true, { width: 96, height: 96 });
  assert.deepEqual([c.x, c.y], [0, 0]);
});
