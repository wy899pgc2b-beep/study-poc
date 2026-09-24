import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION } from '../js/config.js';

test('試作品の版:config.js と version.json が同じ(公開のたびに両方を上げる)', () => {
  const v = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8'));
  assert.equal(v.version, APP_VERSION);
});
