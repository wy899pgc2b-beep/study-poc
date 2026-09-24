import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIO, TRANSITION_SEC, evaluatePhase, phaseAt, scenarioTotalSec } from '../js/scenario.js';

const byId = (id) => SCENARIO.find((p) => p.id === id);

function samples(sec, make) {
  const out = [];
  for (let t = 0; t < sec; t += 0.2) out.push({ phaseElapsed: t, dt: 0.2, ...make(t) });
  return out;
}

test('場面の切り替え:最初の 5 秒は指示の読み上げ中', () => {
  assert.equal(phaseAt(0).inTransition, true);
  const p = phaseAt(TRANSITION_SEC + 1);
  assert.equal(p.phase.id, 'read');
  assert.equal(p.inTransition, false);
  assert.ok(Math.abs(p.phaseElapsed - 1) < 1e-9);
  assert.equal(phaseAt(TRANSITION_SEC + SCENARIO[0].sec + 1).inTransition, true);
  assert.equal(phaseAt(scenarioTotalSec()), null);
});

test('読む:思考・作業が 7 割以上なら合格。居眠りの誤判定率を記録する', () => {
  const r = evaluatePhase(byId('read'), samples(25, (t) => ({ state: t < 20 ? 'think' : 'drowsy' })));
  assert.equal(r.pass, true);
  assert.ok(r.notes[0].includes('居眠りの誤判定 23%'));
  const bad = evaluatePhase(byId('read'), samples(25, (t) => ({ state: t < 10 ? 'think' : 'sleep' })));
  assert.equal(bad.pass, false);
});

test('目を閉じる:居眠りの判定まで到達しなければ不合格', () => {
  const drowsyOnly = evaluatePhase(byId('eyes'), samples(25, () => ({ state: 'drowsy' })));
  assert.equal(drowsyOnly.pass, false);
  const ok = evaluatePhase(byId('eyes'), samples(25, (t) => ({ state: t < 12 ? 'drowsy' : 'sleep' })));
  assert.equal(ok.pass, true);
});

test('離席:離席と判定されなければ不合格', () => {
  const noAway = evaluatePhase(byId('leave'), samples(30, () => ({ state: 'absent', away: false })));
  assert.equal(noAway.pass, false);
  const ok = evaluatePhase(byId('leave'), samples(30, (t) => ({ state: 'absent', away: t > 22 })));
  assert.equal(ok.pass, true);
});

test('フラグで判定する場面(顔を近づける)', () => {
  const r = evaluatePhase(byId('close'), samples(15, (t) => ({ state: 'think', flags: { tooClose: t > 5 } })));
  assert.equal(r.pass, true);
});

test('判定できたフレームが少なければ判定なし', () => {
  const r = evaluatePhase(byId('write'), samples(4, () => ({ state: 'work' })));
  assert.equal(r.pass, null);
});
