import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../js/config.js';
import {
  Analyzer,
  cameraTiltFromOrientation,
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

const lostFace = (t, over = {}) => ({ t, present: true, faceVisible: false, poseVisible: true, hands: [], headHeight: 0.3, ...over });
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

// pinch:親指と人差し指の先の距離(手の大きさ比)。ペンを持つと小さい
function hand(cx, cy, pinch = 0.9) {
  const pts = Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }));
  return { pts, centroid: { x: cx, y: cy }, pinch };
}
const PEN = 0.2;

test('作業:机の上の手が動いていれば作業、止まっていれば思考', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  const writingHand = (t) => hand(0.5 + 0.03 * Math.sin(t / 150), 0.85);
  assert.equal(run(a, 0, 3, (t) => face(t, { hands: [writingHand(t)] })).last.state, 'work');
  const b = new Analyzer(cfg);
  b.setCalibration(CAL);
  assert.equal(run(b, 0, 3, (t) => face(t, { hands: [hand(0.5, 0.85)] })).last.state, 'think');
});

test('作業:手を組んで止まっている(ペンを持つ形に見える)だけでは作業にしない(3 回目の実機検証の不具合)', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  const r = run(a, 0, 3, (t) => face(t, { hands: [hand(0.5, 0.85, PEN)] }));
  assert.equal(r.last.state, 'think');
  assert.equal(r.last.metrics.penGrip, 1); // 手の形は記録だけする
});

test('作業:顔の高さで動いている手は作業にしない', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  assert.equal(run(a, 0, 3, (t) => face(t, { hands: [hand(0.5 + 0.03 * Math.sin(t / 150), 0.35)] })).last.state, 'think');
});

test('居眠り:書いている間は短く目を閉じても「うとうと」にしないが、10 秒閉じていれば居眠り', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  const make = (t) => face(t, { blink: 0.9, ear: 0.08, hands: [hand(0.5 + 0.03 * Math.sin(t / 150), 0.85)] });
  assert.equal(run(a, 0, 5, make).last.state, 'work');
  assert.equal(run(a, 5200, 6, make).last.state, 'sleep');
});

test('癖:手が顔に 1 秒以上あれば「顔を触る」、5 秒以内の連続は 1 回にまとめる', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  const r = run(a, 0, 3, (t) => face(t, { hands: [hand(0.5, 0.35)] }));
  assert.deepEqual(r.events.filter((e) => e.type.startsWith('habit')).map((e) => e.type), ['habit_face']);
  const r2 = run(a, 3200, 2, (t) => face(t, { hands: [hand(0.5, 0.1)] }));
  assert.ok(r2.events.some((e) => e.type === 'habit_head'));
});

test('姿勢:本人の基準(キャリブレーション時の距離)より 25% 以上近い状態が 20 秒続いたら通知', () => {
  const a = new Analyzer(cfg);
  // 基準 30cm → 22.5cm 未満で近すぎ。カメラの高さ 10cm、目はカメラより (-verticalOffset) 上
  a.setCalibration({ ...CAL, cameraHeightCm: 10, measuredEyeDeskCm: 30 });
  const at = (cm) => (t) => face(t, { camDistCm: 40, verticalOffsetCm: -(cm - 10) });
  // 2 回目の実機検証の読むときの距離(約 23cm)では通知しない
  const reading = run(a, 0, 25, at(23));
  assert.equal(reading.last.flags.tooClose, false);
  assert.equal(reading.last.metrics.eyeDeskThresholdCm, 22.5);
  const r1 = run(a, 25200, 19, at(20));
  assert.equal(r1.last.flags.tooClose, true);
  assert.ok(!r1.events.some((e) => e.type === 'posture_close'));
  const r2 = run(a, 44400, 2, at(20));
  assert.equal(r2.events.filter((e) => e.type === 'posture_close').length, 1);
});

test('姿勢:キャリブレーションがなければ距離では判定しない', () => {
  const a = new Analyzer(cfg);
  const r = run(a, 0, 2, (t) => face(t, { camDistCm: 40, verticalOffsetCm: 0 }));
  assert.equal(r.last.flags.tooClose, false);
});

test('【試験中】前に傾いた居眠りの候補:うつむいたまま頭も手も動かない状態が 5 秒続く', () => {
  const a = new Analyzer(cfg);
  a.setCalibration({ ...CAL, headHeight: 1 });
  const still = (t) => face(t, { headHeight: 0.6, noseN: { x: 1, y: 1 } });
  const r = run(a, 0, 7, still);
  assert.equal(r.last.metrics.dozeShadow, 1);
  assert.notEqual(r.last.state, 'sleep'); // 状態の判定には使わない
  // 頭が動いていれば候補にしない
  const b = new Analyzer(cfg);
  b.setCalibration({ ...CAL, headHeight: 1 });
  const moving = (t) => face(t, { headHeight: 0.6, noseN: { x: 1 + 0.05 * Math.sin(t / 200), y: 1 } });
  assert.equal(run(b, 0, 7, moving).last.metrics.dozeShadow, 0);
});

test('よそ見:顔が見えなくても、うつむいているだけならよそ見にしない(3 回目の実機検証の不具合)', () => {
  const a = new Analyzer(cfg);
  a.setCalibration({ ...CAL, headHeight: 1 });
  const r = run(a, 0, 6, (t) => lostFace(t, { headHeight: 0.62 }));
  assert.equal(r.last.state, 'think');
  assert.ok(!r.events.some((e) => e.type === 'lookaway'));
  // 顔が見えず、頭の高さがふだんどおり(後ろを向いた)ならよそ見
  const b = new Analyzer(cfg);
  b.setCalibration({ ...CAL, headHeight: 1 });
  assert.equal(run(b, 0, 6, (t) => lostFace(t, { headHeight: 1.0 })).last.state, 'lookaway');
});

test('うつむき:頭頂部の見える割合がキャリブレーション時より増えたら「うつむいている」', () => {
  const a = new Analyzer(cfg);
  a.setCalibration({ ...CAL, crownRatio: 0.2, hairFrac: 0.02, personFrac: 0.5 });
  const seg = (crownRatio) => ({ crownRatio, hairFrac: 0.03, faceSkinFrac: 0.02, personFrac: 0.5 });
  assert.equal(run(a, 0, 1, (t) => face(t, { seg: seg(0.25) })).last.metrics.lookingDown, 0);
  assert.equal(run(a, 1200, 1, (t) => face(t, { seg: seg(0.6) })).last.metrics.lookingDown, 1);
});

test('居眠り:机に伏せて顔も上半身も検出できなくても、髪が大きく映っていれば離席ではなく居眠り(3 回目の実機検証の不具合)', () => {
  const a = new Analyzer(cfg);
  a.setCalibration({ ...CAL, headHeight: 1, crownRatio: 0.2, hairFrac: 0.02, personFrac: 0.5 });
  const facedown = (t) => ({ ...absent(t), seg: { crownRatio: 0.95, hairFrac: 0.08, faceSkinFrac: 0.004, personFrac: 0.6 } });
  const r = run(a, 0, 21, facedown);
  assert.equal(r.last.away, false);
  assert.equal(r.last.state, 'sleep');
  assert.ok(r.events.some((e) => e.type === 'sleep'));
  // 誰もいない(髪も人も映っていない)なら離席
  const b = new Analyzer(cfg);
  b.setCalibration({ ...CAL, crownRatio: 0.2, hairFrac: 0.02, personFrac: 0.5 });
  const empty = (t) => ({ ...absent(t), seg: { crownRatio: null, hairFrac: 0, faceSkinFrac: 0, personFrac: 0.01 } });
  assert.equal(run(b, 0, 21, empty).last.away, true);
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

// 再現性のある疑似乱数(検出のゆらぎを再現する)
function rng(seed = 1) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648 - 0.5;
  };
}

function jitterHand(cx, cy, amp, rand) {
  const pts = Array.from({ length: 21 }, () => ({ x: cx + rand() * amp, y: cy + rand() * amp, z: 0 }));
  return { pts, centroid: { x: cx, y: cy } };
}

test('作業:止まっている手が検出のゆらぎで動いて見えても、書いているとは判定しない(実機検証 1 回目の不具合)', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  const rand = rng(7);
  // 顔の幅 0.2 に対して ±0.004 程度のゆらぎ(旧しきい値 0.05 では「書いている」になっていた)
  const r = run(a, 0, 5, (t) => face(t, { hands: [jitterHand(0.5, 0.85, 0.008, rand)] }));
  assert.equal(r.last.state, 'think');
});

test('キャリブレーション:端末の傾きと、肩からの頭の高さを記録する', () => {
  const feats = [];
  for (let t = 0; t <= 3000; t += 200) feats.push(face(t, { cameraTiltDeg: 12, camDistCm: 50, verticalOffsetCm: -5, headHeight: 1.1 }));
  const cal = computeCalibration(feats, { measuredEyeDeskCm: 35, tiltDeg: 0 });
  assert.equal(cal.tiltDeg, 12);
  assert.equal(cal.tiltFromSensor, true);
  assert.equal(cal.headHeight, 1.1);
  assert.ok(Math.abs(estimateEyeDeskCm(feats[0], cal) - 35) < 1e-9);
});

test('特徴量:手の形(親指と人差し指の先の距離)を手の大きさ比で求める', () => {
  const W = 1000;
  const H = 1000;
  const pts = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.8, z: 0 }));
  pts[0] = { x: 0.5, y: 0.9, z: 0 }; // 手首
  pts[9] = { x: 0.5, y: 0.8, z: 0 }; // 中指の付け根(手の大きさ 100px)
  pts[4] = { x: 0.52, y: 0.75, z: 0 }; // 親指の先
  pts[8] = { x: 0.5, y: 0.75, z: 0 }; // 人差し指の先(親指から 20px)
  const f = extractFeatures({ t: 0, width: W, height: H, face: null, hands: [pts], pose: null }, cfg);
  assert.ok(Math.abs(f.hands[0].pinch - 0.2) < 1e-9);
  assert.ok(Math.abs(f.hands[0].finger.y + 1.5) < 1e-9);
});

test('よそ見:手が動いていても、横を向いていればよそ見', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  const r = run(a, 0, 4, (t) => face(t, { yawDeg: 40, hands: [hand(0.5, 0.85, PEN)] }));
  assert.equal(r.last.state, 'lookaway');
});

test('癖:頬杖(指先が頬、手のひらがあごの下)は 5 秒で頬杖。その前に「顔を触る」とは数えない', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  const chinHand = () => {
    const pts = Array.from({ length: 21 }, () => ({ x: 0.52, y: 0.52, z: 0 })); // 手のひらはあごの下
    for (const i of [4, 8, 12, 16, 20]) pts[i] = { x: 0.55, y: 0.42, z: 0 }; // 指先は頬
    return { pts, centroid: { x: 0.53, y: 0.5 } };
  };
  const r = run(a, 0, 6, (t) => face(t, { hands: [chinHand()] }));
  const types = r.events.map((e) => e.type).filter((x) => x.startsWith('habit') || x === 'chin_rest');
  assert.deepEqual(types, ['chin_rest']);
});

test('端末の傾き:DeviceOrientation からカメラの上向きの角度を求める', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(cameraTiltFromOrientation(90, 0, 'front'), 0)); // 縦に立てる
  assert.ok(near(cameraTiltFromOrientation(75, 0, 'front'), 15)); // 後ろに 15° 傾ける(画面がこちら向き)
  assert.ok(near(cameraTiltFromOrientation(105, 0, 'back'), 15)); // 画面が向こう向きで後ろに傾ける
  assert.ok(near(cameraTiltFromOrientation(0, 0, 'front'), 90)); // 平置き・画面が上
  assert.ok(near(cameraTiltFromOrientation(180, 0, 'back'), 90)); // 平置き・画面が下
  assert.ok(near(cameraTiltFromOrientation(0, 90, 'front'), 0)); // 横向きに立てる
  assert.equal(cameraTiltFromOrientation(null, 0, 'front'), null);
});


test('居眠り:机に伏せて 20 秒で居眠り。顔の検出が時々ちらついても途切れない', () => {
  const a = new Analyzer(cfg);
  a.setCalibration({ ...CAL, headHeight: 1 });
  // 3 秒ごとに 0.4 秒だけ顔が(誤って)検出される
  const make = (t) => (t % 3000 < 400 ? face(t) : lostFace(t));
  const r1 = run(a, 0, 18, make);
  assert.notEqual(r1.last.state, 'sleep');
  const r2 = run(a, 18200, 4, make);
  assert.ok([...r1.events, ...r2.events].some((e) => e.type === 'sleep'));
});

test('姿勢:顔を近づけすぎて顔が取れないときは、肩からの頭の低さで「近すぎ」と判定する', () => {
  const a = new Analyzer(cfg);
  a.setCalibration({ ...CAL, headHeight: 1 });
  const r1 = run(a, 0, 2, (t) => lostFace(t, { headHeight: 0.6 }));
  assert.equal(r1.last.flags.tooClose, true);
  const r2 = run(a, 2200, 19, (t) => lostFace(t, { headHeight: 0.6 }));
  assert.ok(r2.events.some((e) => e.type === 'posture_close'));
  // 頭の高さがふだんどおりなら(後ろを向いただけ)近すぎではない
  const b = new Analyzer(cfg);
  b.setCalibration({ ...CAL, headHeight: 1 });
  assert.equal(run(b, 0, 2, (t) => lostFace(t, { headHeight: 0.95 })).last.flags.tooClose, false);
});

test('閉眼:4 回目の実機検証の値(顔を上げて目を閉じる)は閉眼、読むときの値は開眼', () => {
  const cal = { ...CAL, blink: 0.551, ear: 0.1, pitchDeg: 24 };
  // 目を閉じる:閉じ具合 0.64、EAR 比 0.58
  assert.equal(isEyesClosed(face(0, { pitchDeg: 22, blink: 0.64, ear: 0.058 }), cal, cfg), true);
  // 閉じ具合がやや低くても EAR 比 0.75 なら閉眼
  assert.equal(isEyesClosed(face(0, { pitchDeg: 22, blink: 0.55, ear: 0.075 }), cal, cfg), true);
  // 読む:閉じ具合 0.52(90%)、EAR 比 1.19(10%)
  assert.equal(isEyesClosed(face(0, { pitchDeg: 28, blink: 0.52, ear: 0.119 }), cal, cfg), false);
});

test('居眠り:閉眼の判定が 1 秒ちらついても、10 秒の計測を続ける(4 回目の実機検証の不具合)', () => {
  const a = new Analyzer(cfg);
  a.setCalibration(CAL);
  // 3 秒ごとに 0.6 秒だけ「開いた」と判定される
  const flicker = (t) => (t % 3000 < 600 ? face(t) : face(t, { blink: 0.9, ear: 0.08 }));
  const r = run(a, 0, 12, flicker);
  assert.ok(r.events.some((e) => e.type === 'sleep'));
  // 2 秒以上開いていれば計測はやり直し
  const b = new Analyzer(cfg);
  b.setCalibration(CAL);
  const open2s = (t) => (t % 6000 < 2400 ? face(t) : face(t, { blink: 0.9, ear: 0.08 }));
  assert.ok(!run(b, 0, 12, open2s).events.some((e) => e.type === 'sleep'));
});

test('設置ガイド:平置きでは肩が映っていなくてもよい', () => {
  const f = { faceVisible: true, poseVisible: false, brightness: 120, width: 720, height: 1280, faceBox: { minX: 0.4, maxX: 0.6, minY: 0.3, maxY: 0.5 }, faceWidthNorm: 0.2 };
  assert.equal(checkFraming(f).ok, false);
  assert.equal(checkFraming(f, { setup: 'flat' }).ok, true);
});

test('うとうと:居眠りの後に顔が見えなくなっても、古い閉眼の記録で「うとうと」を続けない(5 回目の実機検証の不具合)', () => {
  const a = new Analyzer(cfg);
  a.setCalibration({ ...CAL, headHeight: 1 });
  // 25 秒目を閉じて居眠り → その後、顔を上げたまま横を向く(顔は見えず、頭の高さはふだんどおり)
  run(a, 0, 25, (t) => face(t, { blink: 0.9, ear: 0.08 }));
  const r = run(a, 25200, 8, (t) => lostFace(t, { headHeight: 1.1 }));
  assert.equal(r.last.state, 'lookaway');
  assert.equal(r.last.metrics.perclos, 0);
});

test('よそ見:平置きでは頭頂部の割合でうつむきを判断しない(5 回目:横を向くと割合が増えた)', () => {
  const cal = { ...CAL, headHeight: 1, crownRatio: 0.35, hairFrac: 0.06, personFrac: 0.23 };
  const turned = (t) => lostFace(t, { headHeight: 1.13, seg: { crownRatio: 0.73, hairFrac: 0.036, faceSkinFrac: 0.01, personFrac: 0.15 } });
  const flat = new Analyzer(cfg, { setup: 'flat' });
  flat.setCalibration(cal);
  assert.equal(run(flat, 0, 5, turned).last.state, 'lookaway');
  const stand = new Analyzer(cfg, { setup: 'stand' });
  stand.setCalibration(cal);
  assert.notEqual(run(stand, 0, 5, turned).last.state, 'lookaway');
});

test('居眠り:平置きのスマホの上に伏せて顔がカメラを覆うと、20 秒で居眠り(5 回目の実機検証の不具合)', () => {
  const a = new Analyzer(cfg, { setup: 'flat' });
  a.setCalibration({ ...CAL, headHeight: 1, crownRatio: 0.35, hairFrac: 0.06, personFrac: 0.23 });
  const covered = { crownRatio: 0, hairFrac: 0, faceSkinFrac: 0.2, personFrac: 0.93 };
  // 顔は 4 割ほどしか検出できず、見えたときは目がカメラのすぐ近く(推定 4cm)
  const make = (t) =>
    t % 2500 < 1000
      ? face(t, { seg: covered, camDistCm: 4, verticalOffsetCm: 0, headHeight: 0.6 })
      : lostFace(t, { headHeight: 0.6, seg: covered });
  const r = run(a, 0, 22, make);
  assert.ok(r.events.some((e) => e.type === 'sleep'));
  assert.equal(r.last.away, false);
  // 顔を近づけて読んでいるだけ(人の面積 0.75、距離 16cm)なら伏せていない
  const b = new Analyzer(cfg, { setup: 'flat' });
  b.setCalibration({ ...CAL, headHeight: 1, crownRatio: 0.35, hairFrac: 0.06, personFrac: 0.23 });
  const close = (t) => face(t, { seg: { crownRatio: 0.38, hairFrac: 0.2, faceSkinFrac: 0.3, personFrac: 0.75 }, camDistCm: 16, verticalOffsetCm: 0 });
  assert.equal(run(b, 0, 22, close).last.metrics.covering, 0);
});
