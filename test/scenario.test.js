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

test('読む:思考が 6 割以上、かつ居眠りの誤判定が 5% 以下なら合格', () => {
  const ok = evaluatePhase(byId('read'), samples(25, (t) => ({ state: t < 20 ? 'think' : 'work' })));
  assert.equal(ok.pass, true);
  assert.ok(ok.notes[0].includes('居眠りの誤判定 0%'));
  const sleepy = evaluatePhase(byId('read'), samples(25, (t) => ({ state: t < 20 ? 'think' : 'drowsy' })));
  assert.equal(sleepy.pass, false);
  assert.ok(sleepy.notes[0].includes('居眠りの誤判定 23%'));
  // 1 回目の実機検証のように「作業」ばかりなら不合格(手の動きの誤検出)
  const allWork = evaluatePhase(byId('read'), samples(25, () => ({ state: 'work' })));
  assert.equal(allWork.pass, false);
});

test('場面ごとの数値の分布を記録する', () => {
  const r = evaluatePhase(byId('write'), samples(25, (t) => ({ state: 'work', metrics: { handSpeed: t / 25, blink: null } })));
  assert.ok(r.metrics.handSpeed.n > 100);
  assert.ok(Math.abs(r.metrics.handSpeed.median - 0.564) < 0.01);
  assert.equal(r.metrics.blink, undefined);
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
