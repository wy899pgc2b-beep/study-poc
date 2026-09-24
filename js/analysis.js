// 学習態度の判定ロジック(設計書 4 章)。
// DOM やカメラに依存しない純粋なロジックなので、Node のテストからも使える。

const LEFT_EYE = { outer: 33, inner: 133, top: [160, 158], bottom: [144, 153] };
const RIGHT_EYE = { outer: 263, inner: 362, top: [385, 387], bottom: [380, 373] };
const FACE = { forehead: 10, chin: 152, leftOuter: 33, rightOuter: 263 };
const IRIS = { left: [469, 470, 471, 472], right: [474, 475, 476, 477] };
const POSE = { nose: 0, leftEye: 2, rightEye: 5, leftShoulder: 11, rightShoulder: 12 };
const HAND_TIPS = [4, 8, 12, 16, 20];
const HAND_KNUCKLES = [0, 5, 9, 13, 17];

export const STATES = ['work', 'think', 'lookaway', 'drowsy', 'sleep', 'absent'];
export const STATE_LABELS = {
  work: '作業(手を動かしている)',
  think: '思考(見つめて考えている)',
  lookaway: 'よそ見',
  drowsy: 'うとうと',
  sleep: '居眠り',
  absent: '不在',
  away: '離席中',
  paused: '一時停止',
};

const deg = (rad) => (rad * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function toPx(p, W, H) {
  return { x: p.x * W, y: p.y * H, z: (p.z ?? 0) * W };
}

function eyeAspectRatio(lm, eye, W, H) {
  const p = (i) => toPx(lm[i], W, H);
  const width = dist(p(eye.outer), p(eye.inner));
  if (width === 0) return null;
  const h1 = dist(p(eye.top[0]), p(eye.bottom[0]));
  const h2 = dist(p(eye.top[1]), p(eye.bottom[1]));
  return (h1 + h2) / (2 * width);
}

function irisDiameterPx(lm, ring, W, H) {
  const [a, b, c, d] = ring.map((i) => toPx(lm[i], W, H));
  return (dist(a, c) + dist(b, d)) / 2;
}

// カメラの焦点距離(ピクセル)。長辺の画角から求める。
export function focalLengthPx(width, height, fovLongSideDeg) {
  return Math.max(width, height) / 2 / Math.tan(rad(fovLongSideDeg) / 2);
}

/**
 * 端末の傾き(DeviceOrientation の beta・gamma)から、カメラが水平より何度上を向いているかを求める。
 * 画面の法線(フロントカメラの向き)の上向き成分は cos(beta)·cos(gamma)。バックカメラは逆向き。
 */
export function cameraTiltFromOrientation(betaDeg, gammaDeg, camera) {
  if (!Number.isFinite(betaDeg) || !Number.isFinite(gammaDeg)) return null;
  const up = clamp(Math.cos(rad(betaDeg)) * Math.cos(rad(gammaDeg)), -1, 1);
  const elevation = deg(Math.asin(up));
  return camera === 'back' ? -elevation : elevation;
}

// カメラから見た目の高さ(cm)。カメラが上に tiltDeg 傾いているとき、目がカメラよりどれだけ上にあるか。
export function heightAboveCameraCm({ depthCm, verticalOffsetCm }, tiltDeg) {
  const t = rad(tiltDeg);
  return -verticalOffsetCm * Math.cos(t) + depthCm * Math.sin(t);
}

/**
 * 1 フレーム分の検出結果から特徴量を取り出す(設計書 4.3)。
 * frame: { t(ms), width, height, face: {landmarks, blendshapes}|null, hands: [landmarks], pose: landmarks|null, brightness }
 */
export function extractFeatures(frame, cfg) {
  const W = frame.width;
  const H = frame.height;
  const f = {
    t: frame.t,
    width: W,
    height: H,
    brightness: frame.brightness ?? null,
    cameraTiltDeg: frame.cameraTiltDeg ?? null,
    faceVisible: false,
    poseVisible: false,
    hands: (frame.hands || []).map((pts) => {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const hand = { pts, centroid: { x: cx, y: cy } };
      // 手の形:手の大きさ(手首〜中指の付け根)を 1 とした、親指と人差し指の先の距離(ペンを持つと小さくなる)
      const wrist = toPx(pts[0], W, H);
      const size = dist(wrist, toPx(pts[9], W, H));
      if (size > 0) {
        const tip = toPx(pts[8], W, H);
        hand.pinch = dist(toPx(pts[4], W, H), tip) / size;
        hand.finger = { x: (tip.x - wrist.x) / size, y: (tip.y - wrist.y) / size };
      }
      return hand;
    }),
  };

  const lm = frame.face?.landmarks;
  if (lm && lm.length >= 468) {
    f.faceVisible = true;
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (let i = 0; i < 468; i++) {
      const p = lm[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    f.faceBox = { minX, maxX, minY, maxY };
    f.chin = { x: lm[FACE.chin].x, y: lm[FACE.chin].y };

    const earL = eyeAspectRatio(lm, LEFT_EYE, W, H);
    const earR = eyeAspectRatio(lm, RIGHT_EYE, W, H);
    f.ear = earL != null && earR != null ? (earL + earR) / 2 : null;

    const bs = frame.face.blendshapes;
    if (bs && bs.eyeBlinkLeft != null && bs.eyeBlinkRight != null) {
      f.blink = (bs.eyeBlinkLeft + bs.eyeBlinkRight) / 2;
    } else {
      f.blink = null;
    }

    const a = toPx(lm[FACE.leftOuter], W, H);
    const b = toPx(lm[FACE.rightOuter], W, H);
    const top = toPx(lm[FACE.forehead], W, H);
    const chin = toPx(lm[FACE.chin], W, H);
    f.rollDeg = deg(Math.atan2(b.y - a.y, b.x - a.x));
    f.yawDeg = deg(Math.atan2(b.z - a.z, b.x - a.x));
    // 正 = 下を向く(あごが額より奥に行く)
    f.pitchDeg = deg(Math.atan2(chin.z - top.z, chin.y - top.y));
    f.eyeMid = { x: (lm[FACE.leftOuter].x + lm[FACE.rightOuter].x) / 2, y: (lm[FACE.leftOuter].y + lm[FACE.rightOuter].y) / 2 };
    f.faceWidthNorm = maxX - minX;
    f.faceHeightNorm = maxY - minY;

    if (lm.length >= 478) {
      f.irisPx = (irisDiameterPx(lm, IRIS.left, W, H) + irisDiameterPx(lm, IRIS.right, W, H)) / 2;
      const fpx = focalLengthPx(W, H, cfg.cameraFovLongSideDeg);
      if (f.irisPx > 0) {
        f.camDistCm = (fpx * cfg.irisDiameterCm) / f.irisPx;
        const v = f.eyeMid.y * H;
        f.verticalOffsetCm = ((v - H / 2) * f.camDistCm) / fpx; // 下向きが正
      }
    }
  }

  const pose = frame.pose;
  if (pose && pose.length > POSE.rightShoulder) {
    const ls = pose[POSE.leftShoulder];
    const rs = pose[POSE.rightShoulder];
    if ((ls.visibility ?? 1) > 0.5 && (rs.visibility ?? 1) > 0.5) {
      f.poseVisible = true;
      const lsp = toPx(ls, W, H);
      const rsp = toPx(rs, W, H);
      const shoulderWidth = dist(lsp, rsp);
      f.shoulderTiltDeg = deg(Math.atan2(lsp.y - rsp.y, lsp.x - rsp.x));
      f.shoulderMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
      let eyeY = null;
      if (f.eyeMid) eyeY = f.eyeMid.y * H;
      else {
        const le = pose[POSE.leftEye];
        const re = pose[POSE.rightEye];
        if ((le.visibility ?? 1) > 0.5 && (re.visibility ?? 1) > 0.5) eyeY = ((le.y + re.y) / 2) * H;
      }
      if (eyeY != null && shoulderWidth > 0) f.slouchRatio = (f.shoulderMid.y * H - eyeY) / shoulderWidth;
      // 肩から鼻までの高さ(肩幅を 1 とする)。顔の特徴点が取れないとき(顔を机に近づけた・伏せた)にも使える
      const nose = pose[POSE.nose];
      if ((nose.visibility ?? 1) >= 0.5 && shoulderWidth > 0) f.headHeight = ((f.shoulderMid.y - nose.y) * H) / shoulderWidth;
      f.headLow = f.eyeMid ? false : (pose[POSE.nose].visibility ?? 1) < 0.5 || pose[POSE.nose].y > f.shoulderMid.y - 0.05;
    }
  }

  f.present = f.faceVisible || f.poseVisible;
  return f;
}

/** 設置位置ガイドの判定(設計書 3.4)。 */
export function checkFraming(f) {
  const issues = [];
  if (!f.faceVisible) {
    issues.push({ code: 'no_face', message: '顔が映っていません', speech: '顔が映っていません。スマホの位置を調整してください' });
  } else {
    const cx = (f.faceBox.minX + f.faceBox.maxX) / 2;
    const cy = (f.faceBox.minY + f.faceBox.maxY) / 2;
    const size = (f.faceWidthNorm * f.width) / Math.min(f.width, f.height);
    if (cx < 0.2 || cx > 0.8 || cy < 0.1 || cy > 0.75) {
      issues.push({ code: 'off_center', message: '顔が画面の端に寄っています', speech: '顔が画面の端に寄っています。スマホの向きを調整してください' });
    }
    if (size < 0.1) issues.push({ code: 'too_far', message: 'スマホが遠すぎます', speech: 'スマホを少し近づけてください' });
    if (size > 0.45) issues.push({ code: 'too_close', message: 'スマホが近すぎます', speech: 'スマホを少し遠ざけてください' });
  }
  if (!f.poseVisible) {
    issues.push({ code: 'no_shoulders', message: '肩が映っていません', speech: '肩まで映るように、スマホを少し遠ざけてください' });
  }
  if (f.brightness != null && f.brightness < 50) {
    issues.push({ code: 'dark', message: '暗すぎます', speech: '部屋が暗いようです。明かりをつけてください' });
  }
  return { ok: issues.length === 0, issues };
}

/**
 * キャリブレーション(設計書 4.12)。正しい姿勢で教材を見ている数秒間の特徴量から基準値を作る。
 * measuredEyeDeskCm:ユーザーが実際に測った目と机の距離。カメラの高さの推定に使う。
 */
export function computeCalibration(features, { measuredEyeDeskCm, tiltDeg }) {
  const faces = features.filter((f) => f.faceVisible);
  if (faces.length < 3) return null;
  // 端末の傾きが取れていればそれを使い、取れなければ設置スタイルの既定値を使う
  const tiltOf = (f) => f.cameraTiltDeg ?? tiltDeg;
  const heights = faces
    .filter((f) => Number.isFinite(f.camDistCm))
    .map((f) => heightAboveCameraCm({ depthCm: f.camDistCm, verticalOffsetCm: f.verticalOffsetCm }, tiltOf(f)));
  const h = median(heights);
  return {
    yawDeg: median(faces.map((f) => f.yawDeg)),
    pitchDeg: median(faces.map((f) => f.pitchDeg)),
    rollDeg: median(faces.map((f) => f.rollDeg)),
    blink: median(faces.map((f) => f.blink)),
    ear: median(faces.map((f) => f.ear)),
    slouchRatio: median(features.map((f) => f.slouchRatio)),
    tiltDeg: median(faces.map(tiltOf)),
    tiltFromSensor: faces.some((f) => f.cameraTiltDeg != null),
    headHeight: median(features.map((f) => f.headHeight)),
    measuredEyeDeskCm,
    cameraHeightCm: h == null ? null : measuredEyeDeskCm - h,
  };
}

/** 目と机の距離の推定値(cm)。キャリブレーションがない、または虹彩が取れないときは null。 */
export function estimateEyeDeskCm(f, cal) {
  if (!cal || cal.cameraHeightCm == null || !Number.isFinite(f.camDistCm)) return null;
  const tilt = f.cameraTiltDeg ?? cal.tiltDeg;
  return cal.cameraHeightCm + heightAboveCameraCm({ depthCm: f.camDistCm, verticalOffsetCm: f.verticalOffsetCm }, tilt);
}

/** 閉眼の判定(設計書 4.8)。下を向くとまぶたが閉じて見えるので、キャリブレーション値で補正する。 */
export function isEyesClosed(f, cal, cfg) {
  if (!f.faceVisible) return false;
  const calBlink = cal?.blink ?? 0.2;
  const calEar = cal?.ear ?? null;
  const blinkThr = clamp(calBlink + cfg.blinkMarginOverCal, cfg.blinkMin, cfg.blinkMax);
  const earRatio = calEar && f.ear != null ? f.ear / calEar : null;
  const lookingFurtherDown = cal?.pitchDeg != null && f.pitchDeg - cal.pitchDeg > cfg.lookingDownExtraDeg;

  if (earRatio != null && earRatio < cfg.earRatioStrong) return true;
  if (lookingFurtherDown) return false; // 深くうつむいているときは強い証拠(上)だけで判定
  if (f.blink != null && f.blink >= blinkThr) {
    return earRatio == null || earRatio < cfg.earRatioWithBlink;
  }
  return false;
}

const lerp = (p, q, a) => ({ x: p.x + (q.x - p.x) * a, y: p.y + (q.y - p.y) * a });

/**
 * 手の動きの速さ。検出のゆらぎで「止まっている手」が動いて見えないよう、指先と手首の位置を平滑化してから測る。
 * 速さの単位は、顔の幅を 1 とした 1 秒あたりの移動量。
 */
export class HandMotion {
  constructor(cfg) {
    this.cfg = cfg;
    this.prev = [];
    this.prevT = null;
  }

  update(hands, t, scale) {
    const a = this.cfg.handSmoothing;
    const dtSec = this.prevT == null ? 0 : (t - this.prevT) / 1000;
    this.prevT = t;
    const next = [];
    let best = null;
    let bestFinger = null;
    for (const h of hands) {
      const cur = { tip: h.pts[8], wrist: h.pts[0], centroid: h.centroid, finger: h.finger };
      let nearest = null;
      let nd = Infinity;
      for (const p of this.prev) {
        const d = dist(cur.centroid, p.centroid);
        if (d < nd) {
          nd = d;
          nearest = p;
        }
      }
      if (nearest && nd < 0.25) {
        const sm = { tip: lerp(nearest.tip, cur.tip, a), wrist: lerp(nearest.wrist, cur.wrist, a), centroid: cur.centroid, finger: cur.finger };
        if (dtSec > 0 && dtSec <= 1) {
          const v = Math.max(dist(sm.tip, nearest.tip), dist(sm.wrist, nearest.wrist)) / scale / dtSec;
          best = Math.max(best ?? 0, v);
          // 指先の手首に対する動き(手全体の移動を除く。手の大きさ / 秒)。平滑化しない
          if (cur.finger && nearest.finger) bestFinger = Math.max(bestFinger ?? 0, dist(cur.finger, nearest.finger) / dtSec);
        }
        next.push(sm);
      } else {
        next.push(cur);
      }
    }
    this.prev = next;
    return best == null ? null : { speed: best, fingerSpeed: bestFinger };
  }
}

/**
 * フレームごとに状態を判定し、居眠り・癖・姿勢・離席のイベントを出す(設計書 4.4〜4.11)。
 */
export class Analyzer {
  constructor(cfg, { autoAway = true } = {}) {
    this.cfg = cfg;
    this.autoAway = autoAway;
    this.cal = null;
    this.prev = null;
    this.handMotion = new HandMotion(cfg);
    this.handSamples = [];
    this.faceSamples = [];
    this.perclos = [];
    this.closedSince = null;
    this.closedRawSince = null;
    this.lookAwaySince = null;
    this.inLookAway = false;
    this.absentSince = null;
    this.presentSince = null;
    this.away = false;
    this.sleepLevel = null; // null | 'drowsy' | 'sleep'
    this.timers = {};
    this.lastHabitAt = {};
  }

  setCalibration(cal) {
    this.cal = cal;
  }

  // 条件が続いた時間を測る。gapSec 以内の途切れ(検出のちらつき)は続いているとみなす。
  sustainedGap(key, cond, t, gapSec) {
    const g = (this.gapTimers ??= {});
    if (cond) {
      if (!g[key]) g[key] = { start: t, last: t };
      else g[key].last = t;
    } else if (g[key] && (t - g[key].last) / 1000 > gapSec) {
      delete g[key];
    }
    return g[key] ? (t - g[key].start) / 1000 : 0;
  }

  // 条件が続いた時間を測る。続いている秒数を返す(条件が偽なら 0)。
  sustained(key, cond, t) {
    if (!cond) {
      delete this.timers[key];
      return 0;
    }
    if (this.timers[key] == null) this.timers[key] = t;
    return (t - this.timers[key]) / 1000;
  }

  update(f) {
    const cfg = this.cfg;
    const cal = this.cal;
    const t = f.t;
    const dtSec = this.prev ? Math.min(1, (t - this.prev.t) / 1000) : 0;
    const events = [];

    // --- 手の動き(作業の判定)
    const scale = f.faceWidthNorm || this.prev?.faceWidthNorm || 0.15;
    const motion = this.handMotion.update(f.hands, t, scale);
    if (motion) this.handSamples.push({ t, ...motion });
    this.handSamples = this.handSamples.filter((s) => t - s.t <= cfg.handWindowSec * 1000);
    // 一瞬の跳ね(検出の誤り)に引きずられないよう、平均ではなく中央値を使う
    const handSpeed = median(this.handSamples.map((s) => s.speed)) ?? 0;
    const fingerSpeed = median(this.handSamples.map((s) => s.fingerSpeed)) ?? 0;
    const eyeY = f.eyeMid?.y ?? 0.35;
    const handsOnDesk = f.hands.filter((h) => h.centroid.y > eyeY + (f.faceHeightNorm ?? 0.15) * 0.6);
    // 書く動作:机の上の手がペンを持つ形(親指と人差し指の先が近い)をしている。
    // 2 回目の実機検証で、手の速さでは「書く」と「読む」を区別できなかった(中央値 0.027 と 0.033)ため、手の形で判定する
    const pinches = handsOnDesk.map((h) => h.pinch).filter((x) => Number.isFinite(x));
    const pinch = pinches.length ? Math.min(...pinches) : null;
    const penGrip = pinch != null && pinch < cfg.penGripPinchMax;
    const writing = this.sustainedGap('pen', penGrip, t, cfg.penGripGapSec) >= cfg.penGripSec;

    // --- 閉眼・PERCLOS
    const closed = isEyesClosed(f, cal, cfg);
    if (f.faceVisible) {
      this.perclos.push({ t, dt: dtSec, closed });
    }
    // 目覚めたら(目を開けた状態が続いたら)過去の閉眼の記録を消し、アラームがすぐ止まるようにする
    if (this.sustained('eyesOpen', this.sleepLevel != null && f.faceVisible && !closed, t) >= cfg.wakeOpenSec) {
      this.perclos = [];
    }
    this.perclos = this.perclos.filter((s) => t - s.t <= cfg.perclosWindowSec * 1000);
    const totalP = this.perclos.reduce((s, x) => s + x.dt, 0);
    const perclos = totalP >= cfg.perclosMinObservedSec ? this.perclos.reduce((s, x) => s + (x.closed ? x.dt : 0), 0) / totalP : 0;
    if (closed && !writing) {
      if (this.closedSince == null) this.closedSince = t;
    } else {
      this.closedSince = null;
    }
    const closedSec = this.closedSince == null ? 0 : (t - this.closedSince) / 1000;
    // 書く動作の誤検出で居眠りを見逃さないよう、手の動きに関係なく長く閉じていたら居眠りとする
    if (closed) this.closedRawSince ??= t;
    else this.closedRawSince = null;
    const closedRawSec = this.closedRawSince == null ? 0 : (t - this.closedRawSince) / 1000;

    // うつ伏せ:顔は見えないが体は映っていて、頭が低い。顔の検出のちらつきで途切れないよう、短い途切れは許す
    const headRatio = cal?.headHeight && f.headHeight != null ? f.headHeight / cal.headHeight : null;
    const headLow = headRatio != null ? headRatio < cfg.headLowRatio : !!f.headLow;
    const faceDown = !f.faceVisible && f.poseVisible && headLow && !writing;
    const faceDownSec = this.sustainedGap('faceDown', faceDown, t, cfg.faceGapSec);

    // --- 離席(設計書 3.10, 4.11)
    if (!f.present) {
      if (this.absentSince == null) this.absentSince = t;
      this.presentSince = null;
    } else {
      this.absentSince = null;
      if (this.presentSince == null) this.presentSince = t;
    }
    if (this.autoAway && !this.away && this.absentSince != null && (t - this.absentSince) / 1000 >= cfg.awaySec) {
      this.away = true;
      events.push({ type: 'away_start', t: this.absentSince });
    }
    if (this.away && f.faceVisible && this.presentSince != null && (t - this.presentSince) / 1000 >= cfg.returnSec) {
      this.away = false;
      events.push({ type: 'away_end', t });
    }

    // --- よそ見
    const yawDev = cal?.yawDeg != null && f.faceVisible ? Math.abs(f.yawDeg - cal.yawDeg) : 0;
    const pitchUp = cal?.pitchDeg != null && f.faceVisible ? cal.pitchDeg - f.pitchDeg : 0;
    const lookAwayCand = f.present && ((!f.faceVisible && !faceDown) || yawDev > cfg.lookAwayYawDeg || pitchUp > cfg.lookAwayPitchUpDeg);
    // 頭の向きは強い手がかりなので、手が動いていてもよそ見とする
    const lookAwaySec = this.sustained('lookaway', lookAwayCand, t);
    const lookingAway = lookAwaySec >= cfg.lookAwaySec;
    if (lookingAway && !this.inLookAway) events.push({ type: 'lookaway', t });
    this.inLookAway = lookingAway;

    // --- 状態の決定
    let state;
    if (!f.present) state = 'absent';
    else if (closedSec >= cfg.sleepClosedSec || closedRawSec >= cfg.sleepClosedSecAnyHands || faceDownSec >= cfg.faceDownSec) state = 'sleep';
    else if ((closedSec >= cfg.drowsyClosedSec || perclos >= cfg.perclosDrowsy) && !writing) state = 'drowsy';
    else if (lookingAway) state = 'lookaway';
    else if (writing) state = 'work';
    else state = 'think';

    const level = state === 'sleep' ? 'sleep' : state === 'drowsy' ? 'drowsy' : null;
    if (level !== this.sleepLevel) {
      if (level) events.push({ type: level, t });
      else if (this.sleepLevel && f.present) events.push({ type: 'wake', t });
      this.sleepLevel = level;
    }

    // --- 癖(設計書 4.7):指先の位置で判定する
    let habit = null;
    let handFaceDist = null;
    if (f.faceVisible && f.hands.length) {
      const b = f.faceBox;
      const w = b.maxX - b.minX;
      const h = b.maxY - b.minY;
      const inX = (p) => p.x > b.minX - w * 0.15 && p.x < b.maxX + w * 0.15;
      const tips = f.hands.flatMap((hd) => HAND_TIPS.map((i) => hd.pts[i]));
      const knuckles = f.hands.flatMap((hd) => HAND_KNUCKLES.map((i) => hd.pts[i]));
      handFaceDist = Math.min(
        ...tips.map((p) => Math.hypot(Math.max(b.minX - p.x, 0, p.x - b.maxX), Math.max(b.minY - p.y, 0, p.y - b.maxY)) / (w || 1)),
      );
      const onHead = tips.some((p) => inX(p) && p.y < b.minY + h * 0.15 && p.y > b.minY - h * 0.6);
      const onFace = tips.some((p) => inX(p) && p.y >= b.minY + h * 0.15 && p.y < f.chin.y);
      const underChin = [...tips, ...knuckles].some((p) => inX(p) && p.y >= f.chin.y - h * 0.1 && p.y < f.chin.y + h * 0.3);
      const still = handSpeed < cfg.chinRestMaxSpeed;
      const chinSec = this.sustained('chin', underChin && still, t);
      const headSec = this.sustained('head', onHead, t);
      const faceSec = this.sustained('face', onFace && !(underChin && still), t);
      if (chinSec >= cfg.chinRestSec) habit = 'chin_rest';
      else if (headSec >= cfg.habitTouchSec) habit = 'habit_head';
      else if (faceSec >= cfg.habitTouchSec) habit = 'habit_face';
    } else {
      this.sustained('chin', false, t);
      this.sustained('head', false, t);
      this.sustained('face', false, t);
    }
    if (habit) {
      const last = this.lastHabitAt[habit];
      if (last == null || (t - last) / 1000 > cfg.habitMergeSec) events.push({ type: habit, t });
      this.lastHabitAt[habit] = t;
    }

    // --- 姿勢(設計書 4.9)
    const eyeDeskCm = estimateEyeDeskCm(f, cal);
    // 顔を机に近づけすぎると顔の特徴点が取れなくなる(2 回目の実機検証)。そのときは肩に対する頭の低さで判定する
    const headDropped = !f.faceVisible && f.poseVisible && (headRatio != null ? headRatio < cfg.headCloseRatio : !!f.headLow);
    // 本人の基準(キャリブレーション時の距離)より一定の割合以上近づいたら「近すぎ」(設計書 3.9、決定事項 D-7)
    const eyeDeskThresholdCm = cal?.measuredEyeDeskCm ? cal.measuredEyeDeskCm * (1 - cfg.eyeDeskCloseRatio) : null;
    const tooClose = (eyeDeskCm != null && eyeDeskThresholdCm != null && eyeDeskCm < eyeDeskThresholdCm) || headDropped;

    // 【試験中・判定には使わない】前に傾いて居眠りしている候補:顔が見えにくくなり、体は映っていて、ペンを持っていない。
    // 2 回目の実機検証で、前に傾いて目を閉じると目の状態を正しく判定できなかったため、別の手がかりとして記録だけ行う
    this.faceSamples.push({ t, v: f.faceVisible ? 1 : 0 });
    this.faceSamples = this.faceSamples.filter((x) => t - x.t <= cfg.faceRateWindowSec * 1000);
    const faceRate = this.faceSamples.reduce((a, x) => a + x.v, 0) / this.faceSamples.length;
    const dozeShadow = f.poseVisible && !penGrip && faceRate < cfg.dozeShadowFaceRate;
    const slouch = cal?.slouchRatio != null && f.slouchRatio != null && f.slouchRatio < cal.slouchRatio * cfg.slouchRatio;
    const tilt = cal?.rollDeg != null && f.faceVisible && Math.abs(f.rollDeg - cal.rollDeg) > cfg.tiltDeg;
    for (const [key, cond, sec] of [
      ['posture_close', tooClose, cfg.eyeDeskAlertSec],
      ['posture_slouch', slouch, cfg.slouchAlertSec],
      ['posture_tilt', tilt, cfg.tiltAlertSec],
    ]) {
      const s = this.sustained(key, cond, t);
      if (s >= sec && !this.timers[key + ':fired']) {
        this.timers[key + ':fired'] = true;
        events.push({ type: key, t });
      }
      if (!cond) delete this.timers[key + ':fired'];
    }

    this.prev = f;
    return {
      state,
      away: this.away,
      events,
      flags: { writing, eyesClosed: closed, tooClose, slouch, tilt, habit: habit != null },
      metrics: {
        handSpeed,
        fingerSpeed,
        pinch,
        penGrip: penGrip ? 1 : 0,
        handsCount: f.hands.length,
        handFaceDist,
        perclos,
        closedSec,
        eyeDeskCm,
        eyeDeskThresholdCm,
        cameraTiltDeg: f.cameraTiltDeg,
        yawDev,
        pitchUp,
        blink: f.blink,
        earRatio: cal?.ear && f.ear != null ? f.ear / cal.ear : null,
        eyesClosed: closed ? 1 : 0,
        faceVisible: f.faceVisible ? 1 : 0,
        faceRate,
        dozeShadow: dozeShadow ? 1 : 0,
        poseVisible: f.poseVisible ? 1 : 0,
        headRatio,
        slouchRel: cal?.slouchRatio && f.slouchRatio != null ? f.slouchRatio / cal.slouchRatio : null,
      },
    };
  }
}

/** 1 分の集中度(設計書 4.5)。評価できた時間が足りない分は null。 */
export function scoreMinute(m, cfg, { autoAway = true } = {}) {
  const s = m.secs;
  const evaluable = s.work + s.think + s.lookaway + s.drowsy + s.sleep + (autoAway ? 0 : s.absent);
  if (evaluable < cfg.minEvaluableSec) return null;
  const base = (100 * (s.work + s.think)) / evaluable + (cfg.drowsyWeight * s.drowsy) / evaluable;
  const penalty =
    Math.min(cfg.habitPenaltyMax, cfg.habitPenalty * m.habits) +
    Math.min(cfg.interruptionPenaltyMax, cfg.interruptionPenalty * Math.max(0, m.interruptions - 1));
  return clamp(Math.round(base - penalty), 0, 100);
}

function emptyMinute(index) {
  return { index, secs: { work: 0, think: 0, lookaway: 0, drowsy: 0, sleep: 0, absent: 0, away: 0, paused: 0 }, habits: 0, interruptions: 0 };
}

const HABIT_EVENTS = new Set(['habit_face', 'habit_head', 'chin_rest']);

/** 学習スタイル(設計書 4.6)。 */
export function learningStyle(workSec, thinkSec, minuteScores) {
  const total = workSec + thinkSec;
  let hands = null;
  let handRatio = null;
  if (total > 0) {
    handRatio = workSec / total;
    hands = handRatio >= 0.6 ? 'アウトプット型' : handRatio <= 0.4 ? '熟考型' : 'バランス型';
  }
  let pattern = null;
  const scores = minuteScores.filter((s) => s != null);
  if (scores.length >= 30) {
    const n = Math.floor(scores.length / 3);
    const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const first = avg(scores.slice(0, n));
    const last = avg(scores.slice(-n));
    const all = avg(scores);
    const sd = Math.sqrt(avg(scores.map((x) => (x - all) ** 2)));
    if (last - first >= 10) pattern = 'スロースターター型';
    else if (first - last >= 15) pattern = '短期集中型';
    else if (all >= 70 && first - last < 10) pattern = '持久型';
    else if (sd >= 20) pattern = '波あり型';
  }
  return { hands, handRatio, pattern };
}

/** セッションの記録と 1 分ごとの集計(設計書 3.14, 6.2 MINUTE_SCORE)。 */
export class SessionRecorder {
  constructor(startT, cfg, { autoAway = true } = {}) {
    this.startT = startT;
    this.cfg = cfg;
    this.autoAway = autoAway;
    this.minutes = [];
    this.events = [];
  }

  minuteAt(t) {
    const index = Math.max(0, Math.floor((t - this.startT) / 60000));
    while (this.minutes.length <= index) this.minutes.push(emptyMinute(this.minutes.length));
    return this.minutes[index];
  }

  // kind: 状態名、または 'away' / 'paused'
  add(t, dtSec, kind) {
    if (dtSec <= 0) return;
    this.minuteAt(t).secs[kind] += dtSec;
  }

  addEvent(ev) {
    this.events.push(ev);
    const m = this.minuteAt(ev.t);
    if (HABIT_EVENTS.has(ev.type)) m.habits += 1;
    if (ev.type === 'lookaway') m.interruptions += 1;
  }

  scores() {
    return this.minutes.map((m) => scoreMinute(m, this.cfg, { autoAway: this.autoAway }));
  }

  summary() {
    const totals = emptyMinute(-1).secs;
    for (const m of this.minutes) for (const k of Object.keys(totals)) totals[k] += m.secs[k];
    const scores = this.scores();
    const valid = scores.filter((s) => s != null);
    const evaluable = (m) => m.secs.work + m.secs.think + m.secs.lookaway + m.secs.drowsy + m.secs.sleep + (this.autoAway ? 0 : m.secs.absent);
    const effectiveFocusMin = this.minutes.reduce((sum, m, i) => (scores[i] == null ? sum : sum + (scores[i] / 100) * (evaluable(m) / 60)), 0);
    const counts = {};
    for (const e of this.events) counts[e.type] = (counts[e.type] || 0) + 1;
    return {
      totals,
      studySec: this.minutes.reduce((s, m) => s + evaluable(m), 0),
      awaySec: totals.away + (this.autoAway ? totals.absent : 0),
      pausedSec: totals.paused,
      avgFocus: valid.length ? Math.round(valid.reduce((s, x) => s + x, 0) / valid.length) : null,
      effectiveFocusMin,
      scores,
      counts,
      style: learningStyle(totals.work, totals.think, scores),
    };
  }
}
