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
      hand.sizeNorm = size / W; // 手の大きさ(手首〜中指の付け根。画像の幅を 1 とする)
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
    // 【記録のみ】視線の向き(表情係数)。目を閉じたのか視線を下げただけなのか、顔を動かさないよそ見を見分けられるかを調べる
    const pair = (a, b) => (bs && bs[a] != null && bs[b] != null ? (bs[a] + bs[b]) / 2 : null);
    f.eyeLookDown = pair('eyeLookDownLeft', 'eyeLookDownRight');
    f.eyeLookUp = pair('eyeLookUpLeft', 'eyeLookUpRight');
    // 横向きの視線:両目が同じ向き(左目は外・右目は内、またはその逆)を向いている強さ
    const sideA = pair('eyeLookOutLeft', 'eyeLookInRight');
    const sideB = pair('eyeLookInLeft', 'eyeLookOutRight');
    f.eyeLookSide = sideA == null || sideB == null ? null : Math.max(sideA, sideB);
    // 【記録のみ】口の開き。あくび(眠気の手がかり)を調べる
    f.jawOpen = bs?.jawOpen ?? null;

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
      if ((nose.visibility ?? 1) >= 0.5 && shoulderWidth > 0) {
        f.headHeight = ((f.shoulderMid.y - nose.y) * H) / shoulderWidth;
        // 頭の動きを測るための鼻の位置(肩幅を 1 とする)
        f.noseN = { x: (nose.x * W) / shoulderWidth, y: (nose.y * H) / shoulderWidth };
      }
      f.headLow = f.eyeMid ? false : (pose[POSE.nose].visibility ?? 1) < 0.5 || pose[POSE.nose].y > f.shoulderMid.y - 0.05;
    }
  }

  // 髪・顔の肌などの面積(頭頂部の見え方。設計書 4.9)。5 フレームに 1 回だけ計算するので、ないこともある
  f.seg = frame.segment ?? null;
  f.present = f.faceVisible || f.poseVisible;
  return f;
}

/** 設置位置ガイドの判定(設計書 3.4)。 */
export function checkFraming(f, { setup = 'stand' } = {}) {
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
  // 正面に立てるとき以外(斜め置き・平置き)は肩が映らないことが多いので、肩は求めない
  if (!f.poseVisible && setup === 'stand') {
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
    crownRatio: median(features.map((f) => f.seg?.crownRatio)),
    hairFrac: median(features.map((f) => f.seg?.hairFrac)),
    personFrac: median(features.map((f) => f.seg?.personFrac)),
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

/**
 * 閉眼の判定(設計書 4.8)。下を向くとまぶたが閉じて見えるので、キャリブレーション値で補正する。
 * 閉じていると判定した理由を返す(閉じていなければ null)。
 * 'down' 深くうつむいていて EAR がとても小さい / 'ear' EAR がはっきり小さい /
 * 'earBlink' EAR がやや小さく閉じ具合もやや高い / 'blink' 閉じ具合が高い
 */
export function eyeClosureReason(f, cal, cfg) {
  if (!f.faceVisible) return null;
  const calBlink = cal?.blink ?? 0.2;
  const calEar = cal?.ear ?? null;
  const blinkThr = clamp(calBlink + cfg.blinkMarginOverCal, cfg.blinkMin, cfg.blinkMax);
  const earRatio = calEar && f.ear != null ? f.ear / calEar : null;
  const lookingFurtherDown = cal?.pitchDeg != null && f.pitchDeg - cal.pitchDeg > cfg.lookingDownExtraDeg;

  // 深くうつむいているときは、まぶたが下がって見えるので、目の形がはっきり閉じているときだけ閉眼とする
  if (lookingFurtherDown) return earRatio != null && earRatio < cfg.earRatioStrongWhenDown ? 'down' : null;
  // 目の形(EAR)がはっきり小さい
  if (earRatio != null && earRatio < cfg.earRatioAlone) return 'ear';
  if (f.blink == null) return earRatio != null && earRatio < cfg.earRatioStrong ? 'ear' : null;
  // 目の形がやや小さく、閉じ具合もやや高い(4 回目:閉じ具合が基準の境目でちらついた)。
  // 目の形だけでは判定しない(7 回目:低い位置のカメラでは、読むだけで EAR 比が 0.6〜0.75 に下がった)
  const blinkWithEar = Math.max(blinkThr - cfg.blinkSlackWithEar, cfg.blinkMinWithEar);
  if (earRatio != null && earRatio < cfg.earRatioStrong && f.blink >= blinkWithEar) return 'earBlink';
  // 閉じ具合が高く、目の形も基準より小さい
  if (f.blink >= blinkThr && (earRatio == null || earRatio < cfg.earRatioWithBlink)) return 'blink';
  return null;
}

export function isEyesClosed(f, cal, cfg) {
  return eyeClosureReason(f, cal, cfg) != null;
}

/** 指先が顔の範囲(少し広げたもの)に入っているか。 */
export function handCoversFace(f) {
  if (!f.faceVisible || !f.faceBox || !f.hands?.length) return false;
  const b = f.faceBox;
  const mx = (b.maxX - b.minX) * 0.1;
  const my = (b.maxY - b.minY) * 0.1;
  return f.hands.some((h) =>
    HAND_TIPS.some((i) => {
      const p = h.pts[i];
      return p && p.x > b.minX - mx && p.x < b.maxX + mx && p.y > b.minY - my && p.y < b.maxY + my;
    }),
  );
}

/** 端末が横向きか(DeviceOrientation の beta・gamma から)。平らに置いていて分からないときは null。 */
export function deviceIsLandscape(betaDeg, gammaDeg) {
  if (!Number.isFinite(betaDeg) || !Number.isFinite(gammaDeg)) return null;
  const up = (d) => (d * Math.PI) / 180;
  const yUp = Math.abs(Math.sin(up(betaDeg))); // 端末の縦方向がどれだけ上を向いているか
  const xUp = Math.abs(Math.cos(up(betaDeg)) * Math.sin(up(gammaDeg))); // 横方向
  if (Math.max(xUp, yUp) < 0.3) return null;
  return xUp > yUp;
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
  constructor(cfg, { autoAway = true, setup = 'stand' } = {}) {
    this.cfg = cfg;
    this.autoAway = autoAway;
    this.setup = setup;
    this.cal = null;
    this.prev = null;
    this.handMotion = new HandMotion(cfg);
    this.handSamples = [];
    this.writeSamples = [];
    this.faceSamples = [];
    this.headSamples = [];
    this.prevNose = null;
    this.lastSeg = null;
    this.perclos = [];
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
  // 途切れている間は時間を伸ばさない(0.6 秒触って 0.4 秒離れたのを「1 秒触った」としない)
  sustainedGap(key, cond, t, gapSec) {
    const g = (this.gapTimers ??= {});
    if (cond) {
      if (!g[key]) g[key] = { start: t, last: t };
      else g[key].last = t;
    } else if (g[key] && (t - g[key].last) / 1000 > gapSec) {
      delete g[key];
    }
    return g[key] ? (g[key].last - g[key].start) / 1000 : 0;
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
    // 書く動作:机の上の手が一定以上の速さで動いている(3 回目の実機検証:書く 0.145、読む 0.029、目を閉じて手を組む 0.08)。
    // 手の形(ペンを持つ形)は、書くとき 0.57・手を組んでいるとき 0.27 と逆になったため、判定には使わず記録だけする
    const pinches = handsOnDesk.map((h) => h.pinch).filter((x) => Number.isFinite(x));
    const pinch = pinches.length ? Math.min(...pinches) : null;
    const penGrip = pinch != null && pinch < cfg.penGripPinchMax;
    const writing = handsOnDesk.length > 0 && handSpeed >= cfg.writeSpeedMin;
    // 【記録のみ】机の上の手の大きさ(顔の幅を 1 とする)。手がカメラに近いほど大きく、手の速さも大きく出る
    const handSizes = handsOnDesk.map((h) => h.sizeNorm).filter((x) => x > 0);
    const handScale = handSizes.length && f.faceWidthNorm ? Math.max(...handSizes) / f.faceWidthNorm : null;
    // 【記録のみ】直近 10 秒のうち書いていた時間の割合
    this.writeSamples.push({ t, dt: dtSec, w: writing });
    this.writeSamples = this.writeSamples.filter((x) => t - x.t <= cfg.sleepClosedSec * 1000);
    const writeTotal = this.writeSamples.reduce((a, x) => a + x.dt, 0);
    const writeShare = writeTotal > 0 ? this.writeSamples.reduce((a, x) => a + (x.w ? x.dt : 0), 0) / writeTotal : 0;

    // 顔の検出率(直近 10 秒)
    this.faceSamples.push({ t, v: f.faceVisible ? 1 : 0 });
    this.faceSamples = this.faceSamples.filter((x) => t - x.t <= cfg.faceRateWindowSec * 1000);
    const faceRate = this.faceSamples.reduce((a, x) => a + x.v, 0) / this.faceSamples.length;

    // --- 閉眼・PERCLOS
    // 手が顔にかかっているときは、目が隠れて「閉じている」と誤判定しやすい(6 回目:顔を触る場面で居眠りと判定された)。
    // そのあいだは閉眼として数えない
    const handOnFace = handCoversFace(f);
    const closedBy = handOnFace ? null : eyeClosureReason(f, cal, cfg);
    const closed = closedBy != null;
    if (f.faceVisible) {
      this.perclos.push({ t, dt: dtSec, closed });
    }
    // 目覚めたら(目を開けた状態が続いたら)過去の閉眼の記録を消し、アラームがすぐ止まるようにする
    if (this.sustainedGap('eyesOpen', this.sleepLevel != null && f.faceVisible && !closed, t, cfg.faceGapSec) >= cfg.wakeOpenSec) {
      this.perclos = [];
    }
    this.perclos = this.perclos.filter((s) => t - s.t <= cfg.perclosWindowSec * 1000);
    const totalP = this.perclos.reduce((s, x) => s + x.dt, 0);
    // 顔がいま見えていないときは PERCLOS を使わない(5 回目:居眠りの後、顔が見えない間も古い閉眼の記録で「うとうと」が 1 分近く続いた)
    const perclos =
      totalP >= cfg.perclosMinObservedSec && faceRate >= cfg.perclosMinFaceRate
        ? this.perclos.reduce((s, x) => s + (x.closed ? x.dt : 0), 0) / totalP
        : 0;
    // 閉眼の判定は境目の値でちらつく(4 回目:閉じたまま 1 秒だけ「開いた」と出て、10 秒の計測がやり直しになった)。
    // 短い途切れは閉じたままとみなす
    const closedSec = this.sustainedGap('closed', closed && !writing, t, cfg.closedGapSec);
    // 居眠りは手の動きに関係なく、目を閉じた時間で判定する(3 回目:手を組んだのを書く動作と誤判定し、居眠りを見逃した。
    // 自由に学習(8 回目の前):ペンを持って手をほとんど動かしていなくても「書いている」と判定された。書く動作の判定はまだ当てにならない)
    const closedRawSec = this.sustainedGap('closedRaw', closed, t, cfg.closedGapSec);

    // 【記録のみ】あくび
    const yawnSec = this.sustainedGap('yawn', f.jawOpen != null && f.jawOpen >= cfg.yawnJawOpen, t, 0.5);
    if (yawnSec >= cfg.yawnSec && !this.yawnFired) {
      this.yawnFired = true;
      events.push({ type: 'yawn', t });
    }
    if (yawnSec === 0) this.yawnFired = false;

    // --- 頭のうつむき具合(設計書 4.9)
    const seg = f.seg ?? this.lastSeg;
    if (f.seg) this.lastSeg = f.seg;
    // 髪の面積がキャリブレーション時より大きく減っていれば、頭は下がっていない(横や後ろを向いた)。
    // そのときは上半身の特徴点による「頭が低い」を使わない(7 回目:横向きに置いて横を向くと、肩からの頭の高さが −1.0 と出て
    // 「うつむいている」「伏せている」と判定され、よそ見を見逃した。うつむく・伏せるときは髪の面積が増える)
    const hairShrunk =
      seg?.hairFrac != null && cal?.hairFrac >= cfg.segMinHairFrac && seg.hairFrac < cal.hairFrac * cfg.hairShrinkRatio;
    const rawHeadRatio = cal?.headHeight && f.headHeight != null ? f.headHeight / cal.headHeight : null;
    const headRatio = hairShrunk ? null : rawHeadRatio;
    const poseHeadLow = !hairShrunk && !!f.headLow; // 頭の高さの比が取れないときの目安
    const headLow = headRatio != null ? headRatio < cfg.headLowRatio : poseHeadLow;
    // 頭頂部の見える割合(髪 ÷ (髪 + 顔の肌))のキャリブレーション時からの増え方。うつむくほど大きい
    const crownDelta = seg?.crownRatio != null && cal?.crownRatio != null ? seg.crownRatio - cal.crownRatio : null;
    // 頭頂部の割合でうつむきを判断するのは、正面に立てたときだけ(5 回目:平置きでは、うつむいても割合は変わらず、横を向くと増えた。
    // 7 回目:横向きに立てかけると、前に傾いて目を閉じても +0.01 しか増えなかった。ほかの置き方では記録だけする)
    const lookingDown =
      (headRatio != null && headRatio < cfg.headDownRatio) ||
      (this.setup === 'stand' && !hairShrunk && crownDelta != null && crownDelta > cfg.crownBowDelta);
    // 顔も上半身も見つからなくても、頭(髪)が大きく映っていれば席にいる(3 回目:机に伏せると上半身も検出できず「離席」になった)
    const segHead =
      seg != null && cal?.hairFrac && cal?.personFrac
        ? seg.hairFrac >= Math.max(cfg.segMinHairFrac, cal.hairFrac * cfg.segHairRatio) && seg.personFrac >= cal.personFrac * cfg.segPersonRatio
        : false;
    // 頭がカメラを覆っている:人が画面のほとんどを占め、顔が見えないか目がカメラのすぐ近くにある
    // (5 回目:平置きのスマホの上に伏せると、顔がカメラを覆い、伏せていると判定できなかった)
    const nearEyeDesk = estimateEyeDeskCm(f, cal);
    const covering =
      seg != null && seg.personFrac >= cfg.coverPersonFrac && (!f.faceVisible || (nearEyeDesk != null && nearEyeDesk < cfg.coverEyeDeskCm));
    const present = f.present || segHead || covering;
    // うつ伏せ:顔は見えず、頭が低い(上半身が映っていれば肩からの高さ、映っていなければ髪だけが見えている)。
    // 顔の検出のちらつきで途切れないよう、短い途切れは許す
    const faceDown = !writing && ((!f.faceVisible && ((f.poseVisible && headLow) || (!f.poseVisible && segHead))) || covering);
    const faceDownSec = this.sustainedGap('faceDown', faceDown, t, cfg.faceGapSec);

    // --- 離席(設計書 3.10, 4.11)
    if (!present) {
      if (this.absentSince == null) this.absentSince = t;
      this.presentSince = null;
    } else {
      this.absentSince = null;
      if (this.presentSince == null) this.presentSince = t;
    }
    if (this.autoAway && !this.away && this.absentSince != null && (t - this.absentSince) / 1000 >= cfg.awaySec) {
      this.away = true;
      this.perclos = [];
      events.push({ type: 'away_start', t: this.absentSince });
    }
    if (this.away && f.faceVisible && this.presentSince != null && (t - this.presentSince) / 1000 >= cfg.returnSec) {
      this.away = false;
      events.push({ type: 'away_end', t });
    }

    // --- よそ見
    const yawDev = cal?.yawDeg != null && f.faceVisible ? Math.abs(f.yawDeg - cal.yawDeg) : 0;
    const pitchUp = cal?.pitchDeg != null && f.faceVisible ? cal.pitchDeg - f.pitchDeg : 0;
    // 顔が見えなくても、うつむいているだけ(頭が低い・頭頂部が多く見える)ならよそ見ではない(3 回目:読むときに顔が取れず、よそ見と誤判定した)
    const lookAwayCand =
      present && ((!f.faceVisible && !faceDown && !lookingDown) || yawDev > cfg.lookAwayYawDeg || pitchUp > cfg.lookAwayPitchUpDeg);
    // 頭の向きは強い手がかりなので、手が動いていてもよそ見とする
    const lookAwaySec = this.sustained('lookaway', lookAwayCand, t);
    const lookingAway = lookAwaySec >= cfg.lookAwaySec;
    if (lookingAway && !this.inLookAway) events.push({ type: 'lookaway', t });
    this.inLookAway = lookingAway;

    // --- 状態の決定
    let state;
    if (!present) state = 'absent';
    else if (closedRawSec >= cfg.sleepClosedSec || faceDownSec >= cfg.faceDownSec) state = 'sleep';
    else if ((closedSec >= cfg.drowsyClosedSec || perclos >= cfg.perclosDrowsy) && !writing) state = 'drowsy';
    else if (lookingAway) state = 'lookaway';
    else if (writing) state = 'work';
    else state = 'think';

    const level = state === 'sleep' ? 'sleep' : state === 'drowsy' ? 'drowsy' : null;
    if (level !== this.sleepLevel) {
      if (level) events.push({ type: level, t });
      else if (this.sleepLevel && present) {
        events.push({ type: 'wake', t });
        this.perclos = [];
      }
      this.sleepLevel = level;
    }

    // --- 癖(設計書 4.7):指先の位置で判定する。手の検出のちらつきで途切れないよう、短い途切れは許す
    let habit = null;
    let handFaceDist = null;
    let onHead = false;
    let onFace = false;
    let chinRest = false;
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
      onHead = tips.some((p) => inX(p) && p.y < b.minY + h * 0.15 && p.y > b.minY - h * 0.6);
      onFace = tips.some((p) => inX(p) && p.y >= b.minY + h * 0.15 && p.y < f.chin.y);
      const underChin = [...tips, ...knuckles].some((p) => inX(p) && p.y >= f.chin.y - h * 0.1 && p.y < f.chin.y + h * 0.3);
      chinRest = underChin && handSpeed < cfg.chinRestMaxSpeed;
    }
    const chinSec = this.sustainedGap('habitChin', chinRest, t, cfg.habitGapSec);
    const headSec = this.sustainedGap('habitHead', onHead, t, cfg.habitGapSec);
    const faceSec = this.sustainedGap('habitFace', onFace && !chinRest, t, cfg.habitGapSec);
    if (chinSec >= cfg.chinRestSec) habit = 'chin_rest';
    else if (headSec >= cfg.habitTouchSec) habit = 'habit_head';
    else if (faceSec >= cfg.habitTouchSec) habit = 'habit_face';
    if (habit) {
      const last = this.lastHabitAt[habit];
      if (last == null || (t - last) / 1000 > cfg.habitMergeSec) events.push({ type: habit, t });
      this.lastHabitAt[habit] = t;
    }

    // --- 姿勢(設計書 4.9)
    const eyeDeskCm = estimateEyeDeskCm(f, cal);
    // 顔を机に近づけすぎると顔の特徴点が取れなくなる(2 回目の実機検証)。そのときは肩に対する頭の低さで判定する
    const headDropped = !f.faceVisible && f.poseVisible && (headRatio != null ? headRatio < cfg.headCloseRatio : poseHeadLow);
    // 本人の基準(キャリブレーション時の距離)より一定の割合以上近づいたら「近すぎ」(設計書 3.9、決定事項 D-7)
    const eyeDeskThresholdCm = cal?.measuredEyeDeskCm ? cal.measuredEyeDeskCm * (1 - cfg.eyeDeskCloseRatio) : null;
    const tooClose = (eyeDeskCm != null && eyeDeskThresholdCm != null && eyeDeskCm < eyeDeskThresholdCm) || headDropped;

    // 頭の動き(肩幅 / 秒、直近の中央値)
    if (f.noseN && this.prevNose && dtSec > 0) this.headSamples.push({ t, v: dist(f.noseN, this.prevNose) / dtSec });
    this.prevNose = f.noseN ?? null;
    this.headSamples = this.headSamples.filter((x) => t - x.t <= cfg.headMotionWindowSec * 1000);
    const headMotion = median(this.headSamples.map((x) => x.v));

    // 【試験中・判定には使わない】前に傾いて居眠りしている候補:うつむいていて、頭も手もほとんど動かない状態が続く。
    // 前に傾いて目を閉じると目の状態を判定できない(2・3 回目)ため、目以外の手がかりとして記録だけ行う
    const stillNow = lookingDown && headMotion != null && headMotion < cfg.dozeHeadStill && handSpeed < cfg.dozeHandStill;
    const dozeShadow = this.sustainedGap('dozeShadow', stillNow, t, 1) >= cfg.dozeShadowSec;
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
        closedBy,
        eyeLookDown: f.eyeLookDown ?? null,
        eyeLookUp: f.eyeLookUp ?? null,
        eyeLookSide: f.eyeLookSide ?? null,
        jawOpen: f.jawOpen ?? null,
        writing: writing ? 1 : 0,
        writeShare,
        handScale,
        handOnFace: handOnFace ? 1 : 0,
        faceVisible: f.faceVisible ? 1 : 0,
        faceRate,
        dozeShadow: dozeShadow ? 1 : 0,
        headMotion,
        lookingDown: lookingDown ? 1 : 0,
        crownRatio: seg?.crownRatio ?? null,
        crownDelta,
        hairFrac: seg?.hairFrac ?? null,
        personFrac: seg?.personFrac ?? null,
        segHead: segHead ? 1 : 0,
        covering: covering ? 1 : 0,
        poseVisible: f.poseVisible ? 1 : 0,
        headRatio: rawHeadRatio,
        hairShrunk: hairShrunk ? 1 : 0,
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
