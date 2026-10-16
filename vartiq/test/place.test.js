'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Place = require('../public/place.js');

test('place: positions are checked, described and linked', () => {
  assert.deepStrictEqual(Place.clean({ lat: '12.5', lon: 77, acc: 19.6 }), { lat: 12.5, lon: 77, acc: 20 });
  for (const bad of [null, {}, { lat: 91, lon: 0 }, { lat: 0, lon: -181 }, { lat: 'x', lon: 1 }]) assert.strictEqual(Place.clean(bad), null);
  assert.strictEqual(Place.clean({ lat: 1, lon: 2, acc: -3 }).acc, undefined, 'a negative accuracy is dropped');
  assert.deepStrictEqual(Place.fromPosition({ coords: { latitude: 1, longitude: 2, accuracy: 30 } }), { lat: 1, lon: 2, acc: 30 });
  assert.strictEqual(Place.describe({ lat: 12.971599, lon: 77.594566, acc: 20 }), '12.97160, 77.59457 (within 20 m)');
  assert.match(Place.describe({ lat: 1, lon: 2, acc: 2500 }), /within 2\.5 km/);
  const url = Place.mapUrl({ lat: 12.9716, lon: 77.5946 });
  assert.match(url, /^https:\/\/www\.openstreetmap\.org\/\?mlat=12\.971600&mlon=77\.594600#map=17\//);
  assert.strictEqual(Place.mapUrl({ lat: 500, lon: 0 }), null, 'never a link for a bad position');
});

test('place: a live share sends when you move or once a minute, and never too fast', () => {
  const a = { lat: 12.9716, lon: 77.5946 };
  const near = { lat: 12.97165, lon: 77.5946 }; // about 5 m
  const far = { lat: 12.9730, lon: 77.5946 }; // about 150 m
  assert.ok(Place.metres(a, far) > 100 && Place.metres(a, near) < 10);
  assert.strictEqual(Place.shouldSend(null, a, 1000, 0), true, 'the first position');
  assert.strictEqual(Place.shouldSend(a, far, 10000, 7000), false, 'moved, but under 5 seconds since the last');
  assert.strictEqual(Place.shouldSend(a, far, 20000, 7000), true, 'moved');
  assert.strictEqual(Place.shouldSend(a, near, 20000, 7000), false, 'barely moved');
  assert.strictEqual(Place.shouldSend(a, near, 70000, 7000), true, 'still here: once a minute');
});

test('place: live status and wording', () => {
  assert.strictEqual(Place.liveActive({ until: 2000 }, 1000), true);
  assert.strictEqual(Place.liveActive({ until: 2000 }, 3000), false, 'time is up even if a stale copy says live');
  assert.strictEqual(Place.liveActive({ until: 2000, endedAt: 1500 }, 1000), false);
  assert.strictEqual(Place.liveActive(undefined), false);
  assert.strictEqual(Place.ago(1000, 3000), 'just now');
  assert.strictEqual(Place.ago(1000, 31000), '30 s ago');
  assert.strictEqual(Place.ago(0, 5 * 60000), '5 min ago');
  assert.strictEqual(Place.ago(0, 3 * 3600000), '3 h ago');
  assert.deepStrictEqual(Place.LIVE_CHOICES.map((c) => c.seconds), [900, 3600, 28800]);
});
