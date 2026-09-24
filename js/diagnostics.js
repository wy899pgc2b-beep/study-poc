// 「自由に学習」の記録(しきい値の調整用)。状態ごとの数値の分布と、警告(うとうと・居眠り・癖など)の直前の様子を残す。
// 映像は含まない。
import { metricStats, phaseTimeline } from './scenario.js';

// 警告の直前の様子として残す数値
export const ALERT_METRICS = ['earRatio', 'blink', 'closedScore', 'closedScoreSmooth', 'eyeLookDown', 'eyeLookSide', 'jawOpen', 'pitchUp', 'handSpeed', 'handScale', 'handFaceDist', 'faceVisible', 'handOnFace', 'writeShare'];

// 状態ごとの分布として残す数値
export const STATE_METRICS = [
  'earRatio',
  'blink',
  'eyeLookDown',
  'eyeLookSide',
  'jawOpen',
  'eyesClosed',
  'closedScore',
  'pitchUp',
  'yawDev',
  'handSpeed',
  'handScale',
  'writeShare',
  'handsCount',
  'handFaceDist',
  'handOnFace',
  'faceVisible',
  'headRatio',
  'lookingDown',
  'hairShrunk',
  'eyeDeskCm',
  'perclos',
];

const ALERT_TYPES = new Set(['drowsy', 'sleep', 'habit_face', 'habit_head', 'chin_rest', 'lookaway', 'posture_close', 'yawn']);
const STATES = ['work', 'think', 'lookaway', 'drowsy', 'sleep'];

export class SessionDiagnostics {
  constructor({ contextSec = 12, maxAlerts = 30, perState = 1500, random = Math.random } = {}) {
    this.contextSec = contextSec;
    this.maxAlerts = maxAlerts;
    this.perState = perState;
    this.random = random;
    this.recent = [];
    this.byState = {};
    this.alerts = [];
    this.alertCount = 0;
  }

  // sample: { t(ms), dt(秒), state, metrics }
  add(sample) {
    if (!sample.metrics) return;
    this.recent.push(sample);
    this.recent = this.recent.filter((s) => sample.t - s.t <= this.contextSec * 1000);
    if (!STATES.includes(sample.state)) return;
    // 長く使っても大きくなりすぎないよう、状態ごとに一定数を無作為に残す(リザーバーサンプリング)
    const b = (this.byState[sample.state] ??= { sec: 0, seen: 0, samples: [] });
    b.sec += sample.dt;
    b.seen += 1;
    if (b.samples.length < this.perState) b.samples.push(sample);
    else {
      const j = Math.floor(this.random() * b.seen);
      if (j < this.perState) b.samples[j] = sample;
    }
  }

  // ev: { type, t(ms) }。add の後に呼ぶ
  alert(ev, startT) {
    if (!ALERT_TYPES.has(ev.type)) return;
    this.alertCount += 1;
    if (this.alerts.length >= this.maxAlerts) return;
    const from = ev.t - this.contextSec * 1000;
    const ctx = this.recent.filter((s) => s.t >= from).map((s) => ({ ...s, phaseElapsed: (s.t - from) / 1000 }));
    const tl = phaseTimeline(ctx, this.contextSec);
    // 貼り付けやすいよう、分布は「10%/中央値/90%」の文字列にする
    const stats = metricStats(ctx, ALERT_METRICS);
    const metrics = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, `${v.p10}/${v.median}/${v.p90}`]));
    this.alerts.push({
      type: ev.type,
      sec: Math.round((ev.t - startT) / 100) / 10,
      metrics,
      timeline: { state: tl.state, closed: tl.closed, by: tl.by, write: tl.write, face: tl.face },
    });
  }

  result() {
    const byState = {};
    for (const [state, b] of Object.entries(this.byState)) {
      byState[state] = { sec: Math.round(b.sec * 10) / 10, metrics: metricStats(b.samples, STATE_METRICS) };
    }
    return { contextSec: this.contextSec, alertCount: this.alertCount, alerts: this.alerts, byState };
  }
}
