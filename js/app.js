// 技術検証アプリの画面の流れ:設定 → 読み込み → 設置ガイド → キャリブレーション → 学習中 → 結果

import { APP_VERSION, DEFAULTS, SETUP_TILT_DEG, TILT_RANGE_DEG } from './config.js';
import {
  Analyzer,
  SessionRecorder,
  STATE_LABELS,
  cameraTiltFromOrientation,
  checkFraming,
  deviceIsLandscape,
  computeCalibration,
  computeClosedReference,
  extractFeatures,
  eyeSignalQuality,
  scoreMinute,
} from './analysis.js';
import { SessionDiagnostics } from './diagnostics.js';
import { SCENARIO, evaluatePhase, phaseAt } from './scenario.js';
import { createVision } from './vision.js';
import { Voice } from './voice.js';
import { renderResult } from './result.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');

const EVENT_TEXT = {
  away_start: '離席を検知',
  away_end: '着席を検知(再開)',
  drowsy: 'うとうと',
  sleep: '居眠り(アラーム)',
  wake: '目覚め',
  lookaway: 'よそ見',
  habit_face: '癖:顔を触る',
  habit_head: '癖:頭・髪を触る',
  chin_rest: '癖:頬杖',
  yawn: 'あくび(記録のみ)',
  posture_close: '姿勢:目が机に近い',
  posture_slouch: '姿勢:前かがみ',
  posture_tilt: '姿勢:体の傾き',
  device_move: '端末が動いた(一時停止)',
  manual_away: '離席(手動)',
  manual_resume: '再開(手動)',
  app_hidden: 'アプリを離れた',
};

const S = {
  voice: new Voice(),
  vision: null,
  visionGpu: null,
  stream: null,
  phase: 'idle', // idle | guide | calibrating | calibratingClosed | waitOpen | running
  raf: null,
};

function show(name) {
  for (const s of ['setup', 'loading', 'camera', 'result']) $(`screen-${s}`).hidden = s !== name;
  window.scrollTo(0, 0);
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

// ---------------------------------------------------------------- 設定 → 起動

// 前回の設定を覚えておく(この端末のブラウザの中だけ。電池残量は毎回変わるので保存しない)
const SETTINGS_KEY = 'study-poc-settings';

function saveSettings(form) {
  try {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || el.name === 'batteryStart') continue;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'radio') {
        if (el.checked) out[el.name] = el.value;
      } else out[el.name] = el.value;
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
  } catch {
    // 保存できない環境(プライベートブラウズなど)では何もしない
  }
}

function restoreSettings(form) {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!saved) return;
    for (const el of form.elements) {
      if (!el.name || !(el.name in saved)) continue;
      if (el.type === 'checkbox') el.checked = !!saved[el.name];
      else if (el.type === 'radio') el.checked = el.value === saved[el.name];
      else el.value = saved[el.name];
    }
  } catch {
    // 読めなければ既定値のまま
  }
}

restoreSettings($('setup-form'));

function readOptions(form) {
  const fd = new FormData(form);
  const num = (k, d) => (fd.get(k) === '' || fd.get(k) == null ? d : Number(fd.get(k)));
  const opts = {
    mode: fd.get('mode'),
    camera: fd.get('camera'),
    setup: fd.get('setup'),
    subject: String(fd.get('subject') || '学習'),
    eyeDesk: num('eyeDesk', 35),
    autoAway: fd.get('autoAway') === 'on',
    gpu: fd.get('gpu') === 'on',
    voice: fd.get('voice') === 'on',
    batteryStart: num('batteryStart', null),
  };
  const cfg = {
    ...DEFAULTS,
    analysisFps: num('fps', DEFAULTS.analysisFps),
    awaySec: num('awaySec', DEFAULTS.awaySec),
    eyeDeskCloseRatio: num('closeRatio', DEFAULTS.eyeDeskCloseRatio * 100) / 100,
    cameraFovLongSideDeg: num('fov', DEFAULTS.cameraFovLongSideDeg),
  };
  return { opts, cfg };
}

// iOS では動きセンサーの許可を、タップの処理の中で求める必要がある。
// 動き(持ち上げの検知)と向き(カメラの傾き。目と机の距離の推定に使う)の両方を求める。
function requestSensorPermission(EventClass) {
  try {
    if (typeof EventClass === 'undefined') return Promise.resolve(false);
    if (typeof EventClass.requestPermission === 'function') {
      return EventClass.requestPermission()
        .then((r) => r === 'granted')
        .catch(() => false);
    }
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

function onOrientation(e) {
  S.orientation = { beta: e.beta, gamma: e.gamma };
}

function currentCameraTilt() {
  if (!S.orientation) return null;
  return cameraTiltFromOrientation(S.orientation.beta, S.orientation.gamma, S.opts.camera);
}

async function startCamera(camera) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザではカメラを使えません。iPhone の Safari で https のページとして開いてください。');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: camera === 'back' ? 'environment' : 'user' }, width: { ideal: 1280 }, height: { ideal: 960 } },
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

function stopCamera() {
  S.stream?.getTracks().forEach((tr) => tr.stop());
  S.stream = null;
  video.srcObject = null;
}

async function keepAwake() {
  try {
    if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {
    console.warn('画面の自動消灯を止められません', e);
  }
}

function showError(err) {
  console.error(err);
  show('setup');
  const box = document.createElement('p');
  box.className = 'error';
  const name = err?.name === 'NotAllowedError' ? 'カメラの使用が許可されませんでした。設定アプリの Safari → カメラ で許可してください。' : String(err?.message || err);
  box.textContent = `起動できませんでした:${name}`;
  $('setup-form').prepend(box);
}

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('setup-form').querySelectorAll('.error').forEach((x) => x.remove());
  const { opts, cfg } = readOptions(e.target);
  saveSettings(e.target);
  S.opts = opts;
  S.cfg = cfg;
  S.voice.unlock(); // 音声オフでも居眠りアラームは鳴らすため、常に有効にする
  const motion = requestSensorPermission(window.DeviceMotionEvent);
  const orientation = requestSensorPermission(window.DeviceOrientationEvent);
  show('loading');
  try {
    $('loading-text').textContent = 'カメラを起動中…';
    S.stream = await startCamera(opts.camera);
    if (!S.vision || S.visionGpu !== opts.gpu) {
      S.vision?.close();
      S.vision = await createVision({ useGpu: opts.gpu, onProgress: (t) => ($('loading-text').textContent = t) });
      S.visionGpu = opts.gpu;
    }
    S.motionGranted = await motion;
    if (S.motionGranted) window.addEventListener('devicemotion', onMotion);
    S.orientation = null;
    if (await orientation) window.addEventListener('deviceorientation', onOrientation);
    await keepAwake();
    startGuide();
  } catch (err) {
    stopCamera();
    showError(err);
  }
});

// ---------------------------------------------------------------- 共通のループ

function say(text, o) {
  return S.opts.voice ? S.voice.say(text, o) : null;
}

function startLoop() {
  cancelAnimationFrame(S.raf);
  S.lastProc = 0;
  S.frameNo = 0;
  S.lastDetT = null;
  S.perf = { samples: [], all: [], errors: 0, frames: 0, firstT: null, lastT: null };
  const loop = () => {
    S.raf = requestAnimationFrame(loop);
    const now = performance.now();
    if (now - S.lastProc < 1000 / S.cfg.analysisFps - 4) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    S.lastProc = now;
    processFrame();
  };
  S.raf = requestAnimationFrame(loop);
}

function measureBrightness() {
  const c = (S.bCanvas ??= document.createElement('canvas'));
  c.width = 16;
  c.height = 12;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 16, 12);
  const d = ctx.getImageData(0, 0, 16, 12).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return sum / (d.length / 4);
}

function processFrame() {
  const t0 = performance.now();
  S.frameNo += 1;
  const withPose = S.frameNo % 2 === 1 || !S.lastPose;
  let det;
  try {
    // 頭と髪の分類は重いので 5 フレームに 1 回(約 1 秒に 1 回)
    det = S.vision.detect(video, { withPose, withSegment: S.frameNo % 5 === 1 });
  } catch (err) {
    S.perf.errors += 1;
    console.error(err);
    return;
  }
  const interval = S.lastDetT ? det.t - S.lastDetT : 0;
  S.lastDetT = det.t;
  if (withPose) {
    S.lastPose = det.pose;
    S.lastPoseT = det.t;
  }
  // 上半身は 2 回に 1 回だけ解析するので、直前の結果を使い回す(遅い端末でも途切れないよう、間隔に合わせて猶予を延ばす)
  const pose = withPose ? det.pose : det.t - S.lastPoseT < Math.max(1000, 2.5 * interval) ? S.lastPose : null;
  if (S.frameNo % 10 === 1) S.brightness = measureBrightness();
  const frame = { t: det.t, width: video.videoWidth, height: video.videoHeight, face: det.face, hands: det.hands, pose, brightness: S.brightness, cameraTiltDeg: currentCameraTilt(), segment: det.segment };
  const f = extractFeatures(frame, S.cfg);

  const ms = performance.now() - t0;
  S.perf.samples.push(ms);
  if (S.perf.samples.length > 30) S.perf.samples.shift();
  if (S.phase === 'running') {
    S.perf.all.push(ms);
    S.perf.frames += 1;
    S.perf.firstT ??= det.t;
    S.perf.lastT = det.t;
  }

  if (!S.dark) drawOverlay(det, pose);
  if (S.phase === 'guide') guideStep(f);
  else if (S.phase === 'calibrating') calibrationStep(f);
  else if (S.phase === 'calibratingClosed') closedCalibrationStep(f);
  else if (S.phase === 'waitOpen' && f.t >= S.waitOpenUntil && (S.waitOpenSpoken || f.t >= S.waitOpenMaxUntil)) startRunning(S.pendingCal);
  else if (S.phase === 'running') runStep(f);
  updatePerf();
}

function drawOverlay(det, pose) {
  const W = video.videoWidth;
  const H = video.videoHeight;
  if (overlay.width !== W) overlay.width = W;
  if (overlay.height !== H) overlay.height = H;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const lw = Math.max(2, W / 320);
  ctx.lineWidth = lw;
  if (det.face) {
    const lm = det.face.landmarks;
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (let i = 0; i < 468; i++) {
      minX = Math.min(minX, lm[i].x);
      maxX = Math.max(maxX, lm[i].x);
      minY = Math.min(minY, lm[i].y);
      maxY = Math.max(maxY, lm[i].y);
    }
    ctx.strokeStyle = '#6da7ec';
    ctx.strokeRect(minX * W, minY * H, (maxX - minX) * W, (maxY - minY) * H);
    ctx.fillStyle = '#ffffff';
    for (const i of [468, 473]) if (lm[i]) ctx.fillRect(lm[i].x * W - lw, lm[i].y * H - lw, lw * 2, lw * 2);
  }
  ctx.fillStyle = '#eda100';
  for (const hand of det.hands) for (const p of hand) ctx.fillRect(p.x * W - lw, p.y * H - lw, lw * 2, lw * 2);
  if (pose && pose[11] && pose[12]) {
    ctx.strokeStyle = '#1baf7a';
    ctx.beginPath();
    ctx.moveTo(pose[11].x * W, pose[11].y * H);
    ctx.lineTo(pose[12].x * W, pose[12].y * H);
    ctx.stroke();
  }
}

function updatePerf() {
  const a = S.perf.samples;
  if (!a.length) return;
  const avg = a.reduce((s, x) => s + x, 0) / a.length;
  $('m-perf').textContent = `${Math.round(avg)}ms`;
}

// ---------------------------------------------------------------- 設置ガイド(設計書 3.4)

function startGuide() {
  S.phase = 'guide';
  S.guideOkSince = null;
  S.guideHandAt = null;
  S.guideNoHandSince = null;
  $('screen-camera').querySelector('.video-wrap').classList.toggle('mirror', S.opts.camera === 'front');
  $('guide-panel').hidden = false;
  $('scenario-panel').hidden = true;
  $('guide-title').innerHTML = '<b>スマホの位置を合わせてください</b>';
  $('skip-guide').hidden = false;
  $('phase-label').textContent = '設置ガイド';
  $('state-chip').textContent = '—';
  $('elapsed').textContent = '0:00';
  $('event-log').replaceChildren();
  $('btn-away').textContent = '離席';
  show('camera');
  const guideSpeech = {
    stand: 'スマホの位置を合わせます。顔と肩が映るように置いてください',
    tilt: 'スマホの位置を合わせます。スマホを45度くらいに寝かせて、顔と手元が映るように置いてください',
    // 胸から 45〜50cm では、体の近くの手元と頭の上の両方を収める余裕がほとんどない(14 回目)。60cm なら上下に約 7° ずつ余裕ができる
    landscape: 'スマホの位置を合わせます。スマホを横向きにして、胸から60センチくらい離し、少し後ろに傾けて立てかけてください。ペンを持った手を、ノートに書くときの位置に置いてください',
    flat: 'スマホの位置を合わせます。顔が映るように置いてください',
  };
  say(guideSpeech[S.opts.setup] ?? guideSpeech.stand, { interrupt: true });
  startLoop();
}

function guideStep(f) {
  const r = checkFraming(f, { setup: S.opts.setup });
  const has = (code) => r.issues.some((i) => i.code === code);
  const items = [
    ['顔が映っている', !has('no_face')],
    ['顔が画面の中央付近にある', f.faceVisible && !has('off_center')],
    ['スマホとの距離がちょうどよい', f.faceVisible && !has('too_far') && !has('too_close')],
    [S.opts.setup === 'stand' ? '肩まで映っている' : '(任意)肩まで映っている', f.poseVisible],
    ['明るさが十分', !has('dark')],
  ];
  // 横向き:書く動作は手が映らないと判定できない(12・13 回目:書き始めて数秒で手が画面の下に外れた)。
  // ペンを持った手が書く位置で映ることを確かめてから進める。手の検出のちらつきは 1.5 秒まで許す
  const handRequired = S.opts.setup === 'landscape';
  if (f.hands.length) S.guideHandAt = f.t;
  const handOk = S.guideHandAt != null && f.t - S.guideHandAt <= 1500;
  items.push([handRequired ? 'ペンを持った手が、書く位置で映っている' : '(任意)手元の手が映っている', handOk]);
  if (handRequired && !handOk) {
    S.guideNoHandSince ??= f.t;
    // 手を置いても映らないときは、置き方を直してもらう(スマホを起こすと画面の下端が下がり、遠ざけると手元が画面に入る)
    const long = f.t - S.guideNoHandSince > 12000;
    const canRaise = f.cameraTiltDeg == null || f.cameraTiltDeg > 13;
    const speech = !long
      ? 'ペンを持った手を、ノートに書くときの位置に置いてください'
      : canRaise
        ? '手元が映っていません。スマホをもう少し起こすか、少し遠ざけてください'
        : '手元が映っていません。スマホを少し遠ざけてください';
    say(speech, { key: 'hand', minIntervalSec: 8 });
  } else {
    S.guideNoHandSince = null;
  }
  // 斜め置き・横向き:端末の傾きをその場で表示し、目安から外れていれば音声で知らせる。
  // 横向きは傾きが大きいと手元が画面の下に外れる(検証 9・12・13 回目。config.js の TILT_RANGE_DEG)ので、目安に入るまで位置合わせを進めない
  const tilt = f.cameraTiltDeg;
  const range = TILT_RANGE_DEG[S.opts.setup];
  const tiltRequired = S.opts.setup === 'landscape';
  let tiltBlocks = false;
  if (range) {
    const inRange = tilt != null && tilt >= range.min && tilt <= range.max;
    tiltBlocks = tiltRequired && tilt != null && !inRange;
    const opt = tiltRequired ? '' : '(任意)';
    const label = tilt == null ? `${opt}スマホの傾き:センサーを読めません` : `${opt}スマホの傾き ${Math.round(tilt)}°(目安 ${range.min}〜${range.max}°)`;
    items.push([label, inRange]);
    if (tilt != null && !inRange) {
      say(tilt < range.min ? 'スマホをもう少し寝かせてください' : 'スマホをもう少し起こしてください', { key: 'tilt', minIntervalSec: tiltRequired ? 8 : 30 });
    }
  }
  // 横向きに置いたのに映像が縦のまま(画面の向きのロックがかかっている)と、顔や手を正しく検出できない
  const devLandscape = S.orientation ? deviceIsLandscape(S.orientation.beta, S.orientation.gamma) : null;
  const videoLandscape = video.videoWidth > video.videoHeight;
  if (S.opts.setup === 'landscape' && devLandscape === false) {
    items.push(['スマホが横向きになっていません', false]);
    say('スマホを横向きにしてください', { key: 'landscape', minIntervalSec: 15 });
  }
  if (devLandscape != null) {
    const match = devLandscape === videoLandscape;
    items.push([match ? `映像の向き:${videoLandscape ? '横' : '縦'}` : '映像の向きが合っていません(画面の向きのロックを解除してください)', match]);
    if (!match) say('画面の向きのロックを解除してください', { key: 'orient', minIntervalSec: 10 });
  }
  $('guide-list').replaceChildren(
    ...items.map(([label, ok]) => {
      const li = document.createElement('li');
      li.textContent = label;
      li.className = ok ? 'ok' : '';
      return li;
    }),
  );
  if (r.ok && !tiltBlocks && (handOk || !handRequired)) {
    S.guideOkSince ??= f.t;
    if (f.t - S.guideOkSince >= 3000) startCalibration();
  } else {
    S.guideOkSince = null;
    if (!r.ok) say(r.issues[0].speech, { key: 'guide', minIntervalSec: 7 });
  }
}

$('skip-guide').addEventListener('click', () => startCalibration());

// ---------------------------------------------------------------- キャリブレーション(設計書 4.12)

function startCalibration() {
  S.phase = 'calibrating';
  S.calibFeatures = [];
  S.calibStartAt = performance.now() + 3500; // 音声の案内を聞き終わるのを待つ
  $('phase-label').textContent = 'キャリブレーション';
  $('guide-title').innerHTML = '<b>正しい姿勢で、手を止めて、机の上の教材を見てください(画面は見ない)</b>';
  $('guide-list').replaceChildren();
  $('skip-guide').hidden = true;
  S.voice.beep({ freq: 784 });
  // 6 回目:フロントカメラの画面を見たままキャリブレーションし、読むときより 23° 上を向いた基準になった
  say('位置はOKです。画面ではなく、机の上の教材を見てください。正しい姿勢で、手を止めてください', { interrupt: true });
}

function calibrationStep(f) {
  if (f.t < S.calibStartAt) return;
  S.calibFeatures.push(f);
  const left = Math.ceil(3 - (f.t - S.calibStartAt) / 1000);
  $('guide-list').replaceChildren(Object.assign(document.createElement('li'), { textContent: `記録中… あと ${Math.max(0, left)} 秒` }));
  if (f.t - S.calibStartAt < 3000) return;
  const cal = computeCalibration(S.calibFeatures, { measuredEyeDeskCm: S.opts.eyeDesk, tiltDeg: SETUP_TILT_DEG[S.opts.setup] });
  if (!cal) {
    say('顔が映っていなかったため、もう一度位置を合わせます', { interrupt: true });
    startGuide();
    return;
  }
  cal.orientation = video.videoWidth > video.videoHeight ? 'landscape' : 'portrait';
  startClosedCalibration(cal);
}

// 本人の「目を閉じたとき」の基準を取る。カメラ・置き方・メガネで閉じたときの値が変わるため(8 回目)。
// この値にかなり近い状態が続いたときだけ閉眼とする(config.js の personalCloseScore)
function startClosedCalibration(cal) {
  S.phase = 'calibratingClosed';
  S.pendingCal = cal;
  S.calibFeatures = [];
  S.calibStartAt = performance.now() + 5000; // 音声の案内を聞き終わり、目を閉じるのを待つ
  $('guide-title').innerHTML = '<b>そのまま目を閉じてください。音が鳴ったら目を開けてください</b>';
  say('次に、そのままの姿勢で、目を閉じてください。音が鳴ったら、目を開けてください', { interrupt: true });
}

function closedCalibrationStep(f) {
  if (f.t < S.calibStartAt) return;
  S.calibFeatures.push(f);
  const left = Math.ceil(3 - (f.t - S.calibStartAt) / 1000);
  $('guide-list').replaceChildren(Object.assign(document.createElement('li'), { textContent: `目を閉じたときを記録中… あと ${Math.max(0, left)} 秒` }));
  if (f.t - S.calibStartAt < 3000) return;
  const cal = S.pendingCal;
  cal.closedRef = computeClosedReference(S.calibFeatures, cal, S.cfg);
  cal.eyeSignal = eyeSignalQuality(cal, S.cfg);
  S.voice.beep({ freq: 1046, sec: 0.3, volume: 0.6 });
  // 目を開けるまで待ってから始める(自由学習:すぐに始めたため、まだ閉じていた目を「うとうと」と判定した)
  // 目を閉じたときを記録できなければ、本人の基準が使えないことを伝える。判定はこれまでの基準で続ける
  // 案内を読み終えるまで始めない(記録できなかったときの長い案内が、「学習を始めます」で途中で切れていた)。
  // 読み終わりの通知が来ないこともあるので、最長 12 秒で始める
  const u = say(
    cal.closedRef
      ? '目を開けてください。始めます'
      : '目を開けてください。目を閉じたときの記録ができなかったため、前に傾いた居眠りを判定できないことがあります',
    { interrupt: true },
  );
  S.waitOpenSpoken = !u;
  if (u) u.onend = u.onerror = () => (S.waitOpenSpoken = true);
  S.phase = 'waitOpen';
  S.waitOpenUntil = performance.now() + 3000;
  S.waitOpenMaxUntil = performance.now() + 12000;
  $('guide-title').innerHTML = '<b>目を開けてください</b>';
}

// ---------------------------------------------------------------- 学習中

function startRunning(cal) {
  S.cal = cal;
  S.analyzer = new Analyzer(S.cfg, { autoAway: S.opts.autoAway, setup: S.opts.setup });
  S.analyzer.setCalibration(cal);
  S.startT = performance.now();
  S.startedAt = new Date();
  S.recorder = new SessionRecorder(S.startT, S.cfg, { autoAway: S.opts.autoAway });
  S.lastT = null;
  S.manualAway = false;
  S.deviceMovedAt = null;
  S.lastDrowsyBeepAt = null;
  // 自由に学習:状態ごとの数値の分布と、警告の直前の様子を記録する(検証シナリオは場面ごとに記録している)
  S.diag = S.opts.mode === 'free' ? new SessionDiagnostics() : null;
  S.samples = {};
  S.scenarioIndex = -1;
  S.inTransition = null;
  S.phase = 'running';
  S.videoSize = `${video.videoWidth}×${video.videoHeight}`;
  S.perf.all = [];
  S.perf.frames = 0;
  S.perf.firstT = null;
  $('guide-panel').hidden = true;
  const scenario = S.opts.mode === 'scenario';
  $('scenario-panel').hidden = !scenario;
  $('phase-label').textContent = scenario ? '検証シナリオ' : S.opts.subject;
  S.voice.beep({ freq: 1046, sec: 0.25, volume: 0.4 });
  if (!scenario) {
    say('学習を始めます。がんばりましょう', { interrupt: true });
    // 一般的な目安は参考として 1 回だけ案内する(決定事項 D-7)
    if (S.opts.eyeDesk < S.cfg.eyeDeskGuidelineCm) {
      say(`参考です。一般的には、目と教材の距離は${S.cfg.eyeDeskGuidelineCm}センチ以上が目安とされています`);
    }
  }
}

function addEvent(ev) {
  S.recorder.addEvent(ev);
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = fmtClock((ev.t - S.startT) / 1000);
  li.append(time, EVENT_TEXT[ev.type] ?? ev.type);
  const log = $('event-log');
  log.prepend(li);
  while (log.children.length > 30) log.lastChild.remove();
  notify(ev);
}

// 通知(設計書 3.13)。検証シナリオ中は指示の音声と重ならないよう、読み上げの通知は出さない。
function notify(ev) {
  const quiet = S.opts.mode === 'scenario';
  switch (ev.type) {
    case 'sleep':
      S.voice.startAlarm();
      break;
    case 'wake':
      S.voice.stopAlarm();
      break;
    case 'drowsy':
      // 判定がちらついて何度も鳴らないよう、一定の間隔をあける。検証シナリオ中も鳴らす(鳴るかどうかを確かめられるように)
      if (S.lastDrowsyBeepAt == null || ev.t - S.lastDrowsyBeepAt >= S.cfg.drowsyBeepMinSec * 1000) {
        S.lastDrowsyBeepAt = ev.t;
        S.voice.chime();
      }
      break;
    case 'away_start':
      S.voice.stopAlarm();
      if (!quiet) say('離席として記録します', { key: 'away', minIntervalSec: 30 });
      break;
    case 'away_end':
      if (!quiet) say('おかえりなさい。再開します', { key: 'back', minIntervalSec: 30 });
      break;
    case 'posture_close':
      if (!quiet) say('目が机に近すぎます。少し離しましょう', { key: 'close', minIntervalSec: 300 });
      break;
    case 'posture_slouch':
      if (!quiet) say('背中が丸まっています。姿勢を戻しましょう', { key: 'slouch', minIntervalSec: 300 });
      break;
    case 'posture_tilt':
      if (!quiet) S.voice.beep({ freq: 523 });
      break;
    default:
      break;
  }
}

function runStep(f) {
  const t = f.t;
  const dt = S.lastT == null ? 0 : Math.min(1, (t - S.lastT) / 1000);
  S.lastT = t;
  const elapsed = (t - S.startT) / 1000;

  let kind;
  let res = null;
  const deviceMoving = S.deviceMovedAt != null && t - S.deviceMovedAt < 3000;
  if (S.manualAway) kind = 'away';
  else if (deviceMoving) kind = 'paused';
  else {
    res = S.analyzer.update(f);
    kind = res.away ? 'away' : res.state;
    S.diag?.add({ t, dt, state: kind, metrics: res.metrics });
    for (const ev of res.events) {
      S.diag?.alert(ev, S.startT);
      addEvent(ev);
    }
  }
  S.recorder.add(t, dt, kind);

  if (S.opts.mode === 'scenario') {
    if (!scenarioStep(elapsed, dt, res, kind)) return;
  }
  updateLive(f, res, kind, elapsed);
}

function scenarioStep(elapsed, dt, res, kind) {
  const pa = phaseAt(elapsed);
  if (!pa) {
    S.voice.beep({ freq: 1046, sec: 0.3, volume: 0.5 });
    say('検証が終わりました。お疲れさまでした', { interrupt: true });
    finish('scenario_done');
    return false;
  }
  if (pa.index !== S.scenarioIndex || pa.inTransition !== S.inTransition) {
    if (pa.inTransition) {
      S.voice.stopAlarm();
      if (S.scenarioIndex >= 0) S.voice.beep({ freq: 1046, sec: 0.3, volume: 0.5 });
      say(`${pa.index + 1}つめ。${pa.phase.speech}`, { interrupt: true });
    } else {
      S.voice.beep({ freq: 784, sec: 0.12 });
    }
    S.scenarioIndex = pa.index;
    S.inTransition = pa.inTransition;
  }
  if (!pa.inTransition) {
    (S.samples[pa.phase.id] ??= []).push({ phaseElapsed: pa.phaseElapsed, dt, state: res ? res.state : kind, away: kind === 'away', flags: res?.flags ?? {}, metrics: res?.metrics ?? null, events: res?.events.map((ev) => ev.type) ?? [] });
  }
  $('scenario-step').textContent = `${pa.index + 1} / ${SCENARIO.length}`;
  $('scenario-text').textContent = pa.inTransition ? `次:${pa.phase.label}(指示を聞いてください)` : `${pa.phase.label} — あと ${Math.ceil(pa.phase.sec - pa.phaseElapsed)} 秒`;
  $('scenario-progress').style.width = pa.inTransition ? '0%' : `${(pa.phaseElapsed / pa.phase.sec) * 100}%`;
  return true;
}

function updateLive(f, res, kind, elapsed) {
  $('elapsed').textContent = fmtClock(elapsed);
  $('state-chip').textContent = STATE_LABELS[kind] ?? kind;
  const m = S.recorder.minutes[S.recorder.minutes.length - 1];
  const live = m ? scoreMinute(m, { ...S.cfg, minEvaluableSec: 5 }, { autoAway: S.opts.autoAway }) : null;
  $('m-focus').textContent = live == null ? '—' : `${live}%`;
  if (!res) return;
  const mt = res.metrics;
  $('m-eyedesk').textContent = mt.eyeDeskCm == null ? '—' : `${Math.round(mt.eyeDeskCm)}cm${res.flags.tooClose ? ' ⚠' : ''}`;
  $('m-blink').textContent = mt.blink == null ? '—' : `${Math.round(mt.blink * 100)}%${res.flags.eyesClosed ? '(閉)' : ''}`;
  // 頭の向き(顔が見えるとき)と、頭頂部の見える割合(髪 ÷ 髪+顔の肌)
  const crown = mt.crownRatio == null ? '' : ` 頭頂${Math.round(mt.crownRatio * 100)}%`;
  $('m-head').textContent = (f.faceVisible ? `横${Math.round(mt.yawDev)}° 上${Math.round(mt.pitchUp)}°` : '顔なし') + crown;
  // 手の数と手の形(親指と人差し指の先の距離。小さいほどペンを持つ形)
  $('m-hand').textContent = `${f.hands.length}本 形${mt.pinch == null ? '—' : mt.pinch.toFixed(2)}${res.flags.writing ? ' 書' : ''}`;
}

// ---------------------------------------------------------------- 操作

$('btn-dark').addEventListener('click', () => {
  S.dark = true;
  $('dark-overlay').hidden = false;
});
$('dark-overlay').addEventListener('click', () => {
  S.dark = false;
  $('dark-overlay').hidden = true;
});

$('btn-away').addEventListener('click', () => {
  if (S.phase !== 'running') return;
  S.manualAway = !S.manualAway;
  $('btn-away').textContent = S.manualAway ? '再開' : '離席';
  addEvent({ type: S.manualAway ? 'manual_away' : 'manual_resume', t: performance.now() });
});

$('btn-finish').addEventListener('click', () => {
  if (S.phase === 'running') finish('manual');
  else {
    stopAll();
    show('setup');
  }
});

// 端末の持ち上げ・大きな動き(設計書 3.11)
function onMotion(e) {
  if (S.phase !== 'running') return;
  const a = e.acceleration;
  if (!a) return;
  const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
  if (mag < 2.5) return;
  const now = performance.now();
  if (S.deviceMovedAt == null || now - S.deviceMovedAt > 3000) addEvent({ type: 'device_move', t: now });
  S.deviceMovedAt = now;
}

document.addEventListener('visibilitychange', async () => {
  if (S.phase !== 'running') return;
  if (document.hidden) {
    S.hiddenAt = performance.now();
    addEvent({ type: 'app_hidden', t: S.hiddenAt });
  } else if (S.hiddenAt != null) {
    // アプリを離れていた時間を一時停止として 1 秒ずつ記録する
    const now = performance.now();
    for (let t = S.hiddenAt + 1000; t <= now; t += 1000) S.recorder.add(t, 1, 'paused');
    S.hiddenAt = null;
    S.lastT = now;
    await keepAwake();
    video.play().catch(() => {});
  }
});

function stopAll() {
  cancelAnimationFrame(S.raf);
  S.phase = 'idle';
  S.voice.stopAlarm();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  S.wakeLock?.release?.().catch(() => {});
  S.wakeLock = null;
  window.removeEventListener('devicemotion', onMotion);
  window.removeEventListener('deviceorientation', onOrientation);
  S.dark = false;
  $('dark-overlay').hidden = true;
  stopCamera();
}

// ---------------------------------------------------------------- 結果

function percentile(a, p) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function finish(reason) {
  // 学習を始めたときの映像の大きさ(終わるときはスマホを持ち上げて縦向きにしていることがある。自由学習で 960×1280 と記録された)
  const videoSize = S.videoSize ?? `${video.videoWidth}×${video.videoHeight}`;
  stopAll();
  const summary = S.recorder.summary();
  const durationSec = (performance.now() - S.startT) / 1000;
  const all = S.perf.all;
  const spanSec = S.perf.lastT && S.perf.firstT ? (S.perf.lastT - S.perf.firstT) / 1000 : 0;
  const data = {
    version: 1,
    appVersion: APP_VERSION,
    createdAt: S.startedAt.toISOString(),
    reason,
    opts: S.opts,
    cfg: S.cfg,
    calibration: S.cal,
    durationSec,
    summary,
    minutes: S.recorder.minutes.map((m, i) => ({ ...m, score: summary.scores[i] })),
    events: S.recorder.events.map((e) => ({ type: e.type, sec: Math.round(((e.t - S.startT) / 1000) * 10) / 10 })),
    scenario: S.opts.mode === 'scenario' ? SCENARIO.map((p) => evaluatePhase(p, S.samples[p.id] || [], { setup: S.opts.setup })) : null,
    diagnostics: S.diag ? S.diag.result() : null,
    perf: {
      avgMs: all.length ? all.reduce((s, x) => s + x, 0) / all.length : 0,
      p95Ms: percentile(all, 0.95),
      effectiveFps: spanSec > 0 ? (S.perf.frames - 1) / spanSec : 0,
      delegates: S.vision?.delegates ?? {},
      errors: S.perf.errors,
      videoSize,
      userAgent: navigator.userAgent,
    },
  };
  S.result = data;
  const modeLabel = S.opts.mode === 'scenario' ? '検証シナリオ' : '自由に学習';
  $('result-sub').textContent = `${S.opts.subject}・${modeLabel}・${S.startedAt.toLocaleString('ja-JP')}・${fmtClock(durationSec)}`;
  renderResult($('result-body'), data, {
    onBatteryChange: (end, perHour) => {
      data.battery = { start: S.opts.batteryStart, end, perHour };
    },
  });
  show('result');
}

function resultJson() {
  return JSON.stringify(S.result, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v), 2);
}

$('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(resultJson());
    $('btn-copy').textContent = 'コピーしました';
  } catch {
    $('btn-copy').textContent = 'コピーできませんでした';
  }
  setTimeout(() => ($('btn-copy').textContent = 'データをコピー'), 2000);
});

$('btn-download').addEventListener('click', () => {
  const blob = new Blob([resultJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `study-poc-${S.result.createdAt.replace(/[:.]/g, '-')}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('btn-again').addEventListener('click', () => show('setup'));

// 試作品の版を表示し、キャッシュに残った古い版が読み込まれていれば知らせる(9 回目:公開直後の検証が 1 つ前の版で動いた)
$('app-version').textContent = `試作品の版:${APP_VERSION}`;
fetch('version.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .then((v) => {
    if (v?.version && v.version !== APP_VERSION) {
      $('stale-version').hidden = false;
      $('stale-version-text').textContent = `新しい版(${v.version})が公開されていますが、古い版(${APP_VERSION})が読み込まれています。`;
    }
  })
  .catch(() => {});
$('btn-reload').addEventListener('click', () => location.reload());

// テスト用(自動テストから状態を確認する)
window.__poc = S;
