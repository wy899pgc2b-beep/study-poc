// 技術検証アプリの画面の流れ:設定 → 読み込み → 設置ガイド → キャリブレーション → 学習中 → 結果

import { DEFAULTS, SETUP_TILT_DEG } from './config.js';
import {
  Analyzer,
  SessionRecorder,
  STATE_LABELS,
  cameraTiltFromOrientation,
  checkFraming,
  computeCalibration,
  extractFeatures,
  scoreMinute,
} from './analysis.js';
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
  phase: 'idle', // idle | guide | calibrating | running
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
  if (S.opts.voice) S.voice.say(text, o);
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
  say(S.opts.setup === 'flat' ? 'スマホの位置を合わせます。顔が映るように置いてください' : 'スマホの位置を合わせます。顔と肩が映るように置いてください', { interrupt: true });
  startLoop();
}

function guideStep(f) {
  const r = checkFraming(f, { setup: S.opts.setup });
  const has = (code) => r.issues.some((i) => i.code === code);
  const items = [
    ['顔が映っている', !has('no_face')],
    ['顔が画面の中央付近にある', f.faceVisible && !has('off_center')],
    ['スマホとの距離がちょうどよい', f.faceVisible && !has('too_far') && !has('too_close')],
    [S.opts.setup === 'flat' ? '(任意)肩まで映っている' : '肩まで映っている', f.poseVisible],
    ['明るさが十分', !has('dark')],
    ['(任意)手元の手が映っている', f.hands.length > 0],
  ];
  $('guide-list').replaceChildren(
    ...items.map(([label, ok]) => {
      const li = document.createElement('li');
      li.textContent = label;
      li.className = ok ? 'ok' : '';
      return li;
    }),
  );
  if (r.ok) {
    S.guideOkSince ??= f.t;
    if (f.t - S.guideOkSince >= 3000) startCalibration();
  } else {
    S.guideOkSince = null;
    say(r.issues[0].speech, { key: 'guide', minIntervalSec: 7 });
  }
}

$('skip-guide').addEventListener('click', () => startCalibration());

// ---------------------------------------------------------------- キャリブレーション(設計書 4.12)

function startCalibration() {
  S.phase = 'calibrating';
  S.calibFeatures = [];
  S.calibStartAt = performance.now() + 3500; // 音声の案内を聞き終わるのを待つ
  $('phase-label').textContent = 'キャリブレーション';
  $('guide-title').innerHTML = '<b>正しい姿勢で、手を止めて教材を見てください</b>';
  $('guide-list').replaceChildren();
  $('skip-guide').hidden = true;
  S.voice.beep({ freq: 784 });
  say('位置はOKです。正しい姿勢で、手を止めて、教材を見てください', { interrupt: true });
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
  startRunning(cal);
}

// ---------------------------------------------------------------- 学習中

function startRunning(cal) {
  S.cal = cal;
  S.analyzer = new Analyzer(S.cfg, { autoAway: S.opts.autoAway });
  S.analyzer.setCalibration(cal);
  S.startT = performance.now();
  S.startedAt = new Date();
  S.recorder = new SessionRecorder(S.startT, S.cfg, { autoAway: S.opts.autoAway });
  S.lastT = null;
  S.manualAway = false;
  S.deviceMovedAt = null;
  S.samples = {};
  S.scenarioIndex = -1;
  S.inTransition = null;
  S.phase = 'running';
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
      if (!quiet) S.voice.beep({ freq: 660 });
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
    for (const ev of res.events) addEvent(ev);
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
  const videoSize = `${video.videoWidth}×${video.videoHeight}`;
  stopAll();
  const summary = S.recorder.summary();
  const durationSec = (performance.now() - S.startT) / 1000;
  const all = S.perf.all;
  const spanSec = S.perf.lastT && S.perf.firstT ? (S.perf.lastT - S.perf.firstT) / 1000 : 0;
  const data = {
    version: 1,
    createdAt: S.startedAt.toISOString(),
    reason,
    opts: S.opts,
    cfg: S.cfg,
    calibration: S.cal,
    durationSec,
    summary,
    minutes: S.recorder.minutes.map((m, i) => ({ ...m, score: summary.scores[i] })),
    events: S.recorder.events.map((e) => ({ type: e.type, sec: Math.round(((e.t - S.startT) / 1000) * 10) / 10 })),
    scenario: S.opts.mode === 'scenario' ? SCENARIO.map((p) => evaluatePhase(p, S.samples[p.id] || [])) : null,
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

// テスト用(自動テストから状態を確認する)
window.__poc = S;
