import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../js/config.js';
import {
  Analyzer,
  SessionRecorder,
  checkFraming,
  computeCalibration,
  estimateEyeDeskCm,
  extractFeatures,
  focalLengthPx,
  heightAboveCameraCm,
  isEyesClosed,
  learningStyle,
  scoreMinute,
} from '../js/analysis.js';

const cfg = DEFAULTS;
const CAL = { yawDeg: 0, pitchDeg: 0, rollDeg: 0, blink: 0.2, ear: 0.3, slouchRatio: 1, tiltDeg: 0, cameraHeightCm: 10 };

function minute(secs, habits = 0, interruptions = 0) {
  return { secs: { work: 0, think: 0, lookaway: 0, drowsy: 0, sleep: 0, absent: 0, away: 0, paused: 0, ...secs }, habits, interruptions };
}

function face(t, over = {}) {
  return {
    t,
    present: true,
    faceVisible: true,
    poseVisible: true,
    hands: [],
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    blink: 0.1,
    ear: 0.3,
    eyeMid: { x: 0.5, y: 0.35 },
    faceBox: { minX: 0.4, maxX: 0.6, minY: 0.2, maxY: 0.5 },
    chin: { x: 0.5, y: 0.5 },
    faceWidthNorm: 0.2,
    faceHeightNorm: 0.3,
    ...over,
  };
}

const absent = (t) => ({ t, present: false, faceVisible: false, poseVisible: false, hands: [] });

// 5fps で duration 秒ぶん流し、最後の結果と全イベントを返す
function run(analyzer, startMs, durationSec, make) {
  let last;
  const events = [];
  for (let t = startMs; t <= startMs + durationSec * 1000; t += 200) {
    last = analyzer.update(make(t));
    events.push(...last.events);
  }
  return { last, events };
}

test('集中度:設計書 4.5 の計算例は 80%', () => {
  assert.equal(scoreMinute(minute({ work: 30, think: 20, lookaway: 10 }, 1, 1), cfg), 80);
});

test('集中度:評価できた時間が 30 秒未満なら null', () => {
  assert.equal(scoreMinute(minute({ think: 20, away: 40 }), cfg), null);
});

test('集中度:自動離席検知オフでは不在を 0% として数える', () => {
  const m = minute({ think: 30, absent: 30 });
  assert.equal(scoreMinute(m, cfg, { autoAway: true }), 100);
  assert.equal(scoreMinute(m, cfg, { autoAway: false }), 50);
});

test('集中度:減点の上限と 0〜100 の範囲', () => {
  assert.equal(scoreMinute(minute({ think: 60 }, 20, 20), cfg), 75); // 100 - 15 - 10
  assert.equal(scoreMinute(minute({ lookaway: 60 }, 20, 20), cfg), 0);
});

test('幾何:カメラの傾きと目の高さ', () => {
  assert.equal(heightAboveCameraCm({ depthCm: 50, verticalOffsetCm: 5 }, 0), -5);
  assert.ok(Math.abs(heightAboveCameraCm({ depthCm: 40, verticalOffsetCm: 3 }, 90) - 40) < 1e-9);
  const f = focalLengthPx(1280, 720, 69);
  assert.ok(Math.abs(f - 640 / Math.tan((34.5 * Math.PI) / 180)) < 1e-9);
});

function syntheticFaceLandmarks({ irisPx, W, H, eyeOpen = 1 }) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.4, z: 0 }));
  const set = (i, x, y, z = 0) => (lm[i] = { x: x / W, y: y / H, z: z / W });
  // 顔の輪郭の範囲
  set(10, 640, 200);
  set(152, 640, 420);
  set(234, 560, 300);
  set(454, 720, 300);
  // 目(外側・内側・上下)
  const eye = (outer, inner, top, bottom, x0, x1) => {
    set(outer, x0, 300);
    set(inner, x1, 300);
    const cx = (x0 + x1) / 2;
    const h = 9 * eyeOpen;
    set(top[0], cx - 5, 300 - h);
    set(top[1], cx + 5, 300 - h);
    set(bottom[0], cx - 5, 300 + h);
    set(bottom[1], cx + 5, 300 + h);
  };
  eye(33, 133, [160, 158], [144, 153], 590, 620);
  eye(263, 362, [385, 387], [380, 373], 690, 660);
  // 虹彩の輪(右・上・左・下)
  const ring = (idx, cx) => {
    set(idx[0], cx + irisPx / 2, 300);
    set(idx[1], cx, 300 - irisPx / 2);
    set(idx[2], cx - irisPx / 2, 300);
    set(idx[3], cx, 300 + irisPx / 2);
  };
  ring([469, 470, 471, 472], 605);
  ring([474, 475, 476, 477], 675);
  return lm;
}

test('特徴量:虹彩の大きさから距離、目の形から EAR を求める', () => {
  const W = 1280;
  const H = 720;
  const lm = syntheticFaceLandmarks({ irisPx: 20, W, H });
  const f = extractFeatures({ t: 0, width: W, height: H, face: { landmarks: lm, blendshapes: { eyeBlinkLeft: 0.1, eyeBlinkRight: 0.3 } }, hands: [], pose: null }, cfg);
  assert.equal(f.faceVisible, true);
  assert.equal(f.poseVisible, false);
  assert.ok(Math.abs(f.rollDeg) < 1e-9);
  assert.ok(Math.abs(f.blink - 0.2) < 1e-9);
  assert.ok(Math.abs(f.ear - 18 / 30) < 1e-9);
  const expected = (focalLengthPx(W, H, 69) * 1.17) / 20;
  assert.ok(Math.abs(f.camDistCm - expected) < 1e-6);
  assert.ok(f.verticalOffsetCm < 0); // 目は画面の中央より上にある
});

test('キャリブレーション:実測の距離からカメラの高さを逆算し、同じ姿勢なら同じ距離を返す', () => {
  const W = 1280;
  const H = 720;
  const lm = syntheticFaceLandmarks({ irisPx: 20, W, H });
  const feats = [0, 200, 400, 600].map((t) => extractFeatures({ t, width: W, height: H, face: { landmarks: lm, blendshapes: null }, hands: [], pose: null }, cfg));
  const cal = computeCalibration(feats, { measuredEyeDeskCm: 35, tiltDeg: 0 });
  assert.ok(cal);
  assert.ok(Math.abs(estimateEyeDeskCm(feats[0], cal) - 35) < 1e-6);
  // 顔を近づける(虹彩が大きく見え、目が下に来る)と距離が縮む
  const closer = extractFeatures({ t: 800, width: W, height: H, face: { landmarks: syntheticFaceLandmarks({ irisPx: 30, W, H }).map((p) => ({ ...p, y: p.y + 0.25 })), blendshapes: null }, hands: [], pose: null }, cfg);
  assert.ok(estimateEyeDeskCm(closer, cal) < 30);
});

test('キャリブレーション:顔が映っていなければ null', () => {
  assert.equal(computeCalibration([absent(0), absent(200)], { measuredEyeDeskCm: 35, tiltDeg: 0 }), null);
});

test('閉眼:下を向いて読んでいる程度では閉眼と判定しない', () => {
  const cal = { ...CAL, pitchDeg: 10 };
  // いつもより深くうつむき、まぶたが下がって見える
  assert.equal(isEyesClosed(face(0, { pitchDeg: 30, blink: 0.7, ear: 0.2 }), cal, cfg), false);
  // 同じ角度でも、完全に閉じていれば閉眼
  assert.equal(isEyesClosed(face(0, { pitchDeg: 30, blink: 0.95, ear: 0.1 }), cal, cfg), true);
  // 普通の角度で閉じている
  assert.equal(isEyesClosed(face(0, { blink: 0.8, ear: 0.2 }), cal, cfg), true);
  assert.equal(isEyesClosed(face(0, { blink: 0.3, ear: 0.28 }), cal, cfg), false);
});

test('居眠り:目を閉じて 3 秒でうとうと、10 秒で居眠り', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  const closed = (t) => face(t, { blink: 0.9, ear: 0.08 });
  const r1 = run(a, 0, 4, closed);
  assert.equal(r1.last.state, 'drowsy');
  const r2 = run(a, 4200, 7, closed);
  assert.equal(r2.last.state, 'sleep');
  assert.deepEqual([...r1.events, ...r2.events].map((e) => e.type), ['drowsy', 'sleep']);
  const r3 = run(a, 11400, 3, (t) => face(t));
  assert.ok(r3.events.some((e) => e.type === 'wake'));
  assert.equal(r3.last.state, 'think');
});

test('離席:20 秒映らなければ離席。開始時刻は映らなくなった時点にさかのぼる', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  run(a, 0, 2, (t) => face(t));
  const r = run(a, 2200, 21, absent);
  assert.equal(r.last.away, true);
  const start = r.events.find((e) => e.type === 'away_start');
  assert.equal(start.t, 2200);
  // 戻って 3 秒で再開
  const back = run(a, 23400, 3.2, (t) => face(t));
  assert.equal(back.last.away, false);
  assert.ok(back.events.some((e) => e.type === 'away_end'));
});

test('離席:自動検知オフなら離席にならない', () => {
  const a = new Analyzer(cfg, { autoAway: false });
  const r = run(a, 0, 30, absent);
  assert.equal(r.last.away, false);
  assert.equal(r.last.state, 'absent');
});

test('よそ見:横を向いて 3 秒続いたらよそ見', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  const r1 = run(a, 0, 2, (t) => face(t, { yawDeg: 40 }));
  assert.equal(r1.last.state, 'think');
  const r2 = run(a, 2200, 2, (t) => face(t, { yawDeg: 40 }));
  assert.equal(r2.last.state, 'lookaway');
  assert.equal([...r1.events, ...r2.events].filter((e) => e.type === 'lookaway').length, 1);
});

function hand(cx, cy) {
  const pts = Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }));
  return { pts, centroid: { x: cx, y: cy } };
}

test('作業:机の上で手が動いていれば作業、止まっていれば思考', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  const moving = (t) => face(t, { hands: [hand(0.5 + 0.02 * Math.sin(t / 150), 0.85)] });
  assert.equal(run(a, 0, 3, moving).last.state, 'work');
  const b = new Analyzer(cfg);
  b.setCalibration(CAL);
  assert.equal(run(b, 0, 3, (t) => face(t, { hands: [hand(0.5, 0.85)] })).last.state, 'think');
});

test('作業:書いている間は目が閉じ気味でも居眠りにしない', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  const r = run(a, 0, 12, (t) => face(t, { blink: 0.9, ear: 0.08, hands: [hand(0.5 + 0.02 * Math.sin(t / 150), 0.85)] }));
  assert.equal(r.last.state, 'work');
  assert.ok(!r.events.some((e) => e.type === 'sleep'));
});

test('癖:手が顔に 1 秒以上あれば「顔を触る」、5 秒以内の連続は 1 回にまとめる', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  const r = run(a, 0, 3, (t) => face(t, { hands: [hand(0.5, 0.35)] }));
  assert.deepEqual(r.events.filter((e) => e.type.startsWith('habit')).map((e) => e.type), ['habit_face']);
  const r2 = run(a, 3200, 2, (t) => face(t, { hands: [hand(0.5, 0.1)] }));
  assert.ok(r2.events.some((e) => e.type === 'habit_head'));
});

test('姿勢:目と机の距離がしきい値未満で 20 秒続いたら通知', () => {
  const a = new Analyzer(cfg);
  a.setCalibration({ ...CAL, cameraHeightCm: 10 });
  // 高さ = 10 + (-verticalOffset) = 10 + 15 = 25cm < 30cm
  const near = (t) => face(t, { camDistCm: 40, verticalOffsetCm: -15 });
  const r1 = run(a, 0, 19, near);
  assert.equal(r1.last.flags.tooClose, true);
  assert.ok(!r1.events.some((e) => e.type === 'posture_close'));
  const r2 = run(a, 19200, 2, near);
  assert.equal(r2.events.filter((e) => e.type === 'posture_close').length, 1);
});

test('記録:1 分ごとの集計、実効集中時間、学習スタイル', () => {
  const rec = new SessionRecorder(0, cfg);
  rec.add(10_000, 30, 'work');
  rec.add(20_000, 20, 'think');
  rec.add(30_000, 10, 'lookaway');
  rec.addEvent({ type: 'habit_face', t: 40_000 });
  rec.addEvent({ type: 'lookaway', t: 41_000 });
  rec.add(70_000, 40, 'away');
  rec.add(80_000, 20, 'think');
  const s = rec.summary();
  assert.deepEqual(s.scores, [80, null]);
  assert.equal(s.avgFocus, 80);
  assert.ok(Math.abs(s.effectiveFocusMin - 0.8) < 1e-9);
  assert.equal(s.studySec, 80);
  assert.equal(s.awaySec, 40);
  assert.equal(s.style.hands, 'バランス型');
});

test('学習スタイル:手作業の比率と集中の持続パターン', () => {
  assert.equal(learningStyle(70, 30, []).hands, 'アウトプット型');
  assert.equal(learningStyle(30, 70, []).hands, '熟考型');
  const rising = Array.from({ length: 30 }, (_, i) => (i < 10 ? 50 : i < 20 ? 65 : 80));
  assert.equal(learningStyle(1, 1, rising).pattern, 'スロースターター型');
  const steady = Array.from({ length: 30 }, () => 85);
  assert.equal(learningStyle(1, 1, steady).pattern, '持久型');
  assert.equal(learningStyle(1, 1, steady.slice(0, 10)).pattern, null);
});

test('設置ガイド:顔・肩・明るさの条件', () => {
  assert.deepEqual(checkFraming({ faceVisible: false, poseVisible: false, brightness: 20 }).issues.map((i) => i.code), ['no_face', 'no_shoulders', 'dark']);
  const ok = checkFraming({ faceVisible: true, poseVisible: true, brightness: 120, width: 720, height: 1280, faceBox: { minX: 0.4, maxX: 0.6, minY: 0.2, maxY: 0.4 }, faceWidthNorm: 0.2 });
  assert.equal(ok.ok, true);
  const far = checkFraming({ faceVisible: true, poseVisible: true, width: 720, height: 1280, faceBox: { minX: 0.48, maxX: 0.52, minY: 0.2, maxY: 0.25 }, faceWidthNorm: 0.04 });
  assert.deepEqual(far.issues.map((i) => i.code), ['too_far']);
});
