import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionDiagnostics } from '../js/diagnostics.js';

// 5fps で sec 秒ぶん記録する
function feed(d, fromSec, sec, make) {
  for (let s = fromSec; s < fromSec + sec; s += 0.2) d.add({ t: s * 1000, dt: 0.2, ...make(s) });
}

test('自由に学習の記録:警告の直前 12 秒の様子(数値の分布と 1 秒ごとの文字列)を残す', () => {
  const d = new SessionDiagnostics();
  const m = (closed, writing) => ({ earRatio: closed ? 0.4 : 0.9, blink: closed ? 0.6 : 0.3, eyesClosed: closed ? 1 : 0, closedBy: closed ? 'blink' : null, writing: writing ? 1 : 0, faceVisible: 1 });
  feed(d, 0, 20, () => ({ state: 'work', metrics: m(false, true) }));
  feed(d, 20, 10, () => ({ state: 'drowsy', metrics: m(true, false) }));
  d.alert({ type: 'drowsy', t: 29_800 }, 0);
  d.alert({ type: 'wake', t: 29_800 }, 0); // 警告でないものは残さない
  const r = d.result();
  assert.equal(r.alerts.length, 1);
  const a = r.alerts[0];
  assert.equal(a.type, 'drowsy');
  assert.equal(a.sec, 29.8);
  assert.equal(a.timeline.state.length, 12);
  assert.equal(a.timeline.state, 'wwdddddddddd'); // 直前 12 秒:作業 2 秒 → うとうと 10 秒
  assert.equal(a.timeline.by, '..kkkkkkkkkk');
  assert.equal(a.timeline.write, '110000000000');
  assert.equal(a.metrics.earRatio, '0.4/0.4/0.9'); // 10%/中央値/90%
  // 状態ごとの分布
  assert.ok(Math.abs(r.byState.work.sec - 20) < 0.3);
  assert.equal(r.byState.work.metrics.eyesClosed.median, 0);
  assert.equal(r.byState.drowsy.metrics.eyesClosed.median, 1);
});

test('自由に学習の記録:長く使っても、状態ごとに残す数と警告の数には上限がある', () => {
  const d = new SessionDiagnostics({ perState: 50, maxOtherAlerts: 3 });
  feed(d, 0, 100, () => ({ state: 'think', metrics: { earRatio: 1 } }));
  for (let i = 0; i < 5; i++) d.alert({ type: 'habit_face', t: 100_000 }, 0);
  const r = d.result();
  assert.equal(r.byState.think.metrics.earRatio.n, 50);
  assert.ok(Math.abs(r.byState.think.sec - 100) < 0.3);
  assert.equal(r.alerts.length, 3);
  assert.equal(r.alertCount, 5);
});

test('自由に学習の記録:うとうと・居眠りは癖などとは別枠で残し、学習の後半の分も残る(34 分の自由学習では最初の 30 件だけだった)', () => {
  // 乱数を決めておき、上限を超えた後も入れ替えが起きるようにする
  let i = 0;
  const seq = [0.1, 0.5, 0.2, 0.9, 0.05, 0.3, 0.15, 0.6];
  const d = new SessionDiagnostics({ maxSleepyAlerts: 4, maxOtherAlerts: 2, random: () => seq[i++ % seq.length] });
  feed(d, 0, 5, () => ({ state: 'think', metrics: { earRatio: 1 } }));
  // 癖が先にたくさん出ても、うとうと・居眠りの枠は減らない
  for (let k = 0; k < 10; k++) d.alert({ type: 'habit_face', t: 1000 + k }, 0);
  for (let k = 0; k < 20; k++) d.alert({ type: k % 5 ? 'drowsy' : 'sleep', t: 2000 + k * 60_000 }, 0);
  const r = d.result();
  const sleepy = r.alerts.filter((a) => a.type === 'drowsy' || a.type === 'sleep');
  assert.equal(sleepy.length, 4);
  assert.equal(r.alerts.filter((a) => a.type === 'habit_face').length, 2);
  assert.deepEqual(r.alertCounts, { sleepy: 20, other: 10 });
  assert.ok(sleepy.some((a) => a.sec > 5 * 60)); // 5 番目以降(後半)の警告も残る
  // 時刻の順に並ぶ
  assert.deepEqual(r.alerts.map((a) => a.sec), [...r.alerts.map((a) => a.sec)].sort((a, b) => a - b));
});

test('自由に学習の記録:前かがみの通知の直前の姿勢の数値を残す', () => {
  const d = new SessionDiagnostics();
  feed(d, 0, 13, () => ({ state: 'think', metrics: { slouchRel: 0.7, headRatio: 0.8, eyeDeskCm: 31 } }));
  d.alert({ type: 'posture_slouch', t: 12_800 }, 0);
  const a = d.result().alerts[0];
  assert.equal(a.type, 'posture_slouch');
  assert.equal(a.metrics.slouchRel, '0.7/0.7/0.7');
  assert.equal(a.metrics.eyeDeskCm, '31/31/31');
});
