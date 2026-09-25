// 検証シナリオ:音声の指示どおりに動いてもらい、各場面で AI が正しく判定できたかを調べる(設計書 11 章 フェーズ0)。
// 画面が見えないバックカメラでも使えるよう、指示はすべて音声で出す。

export const TRANSITION_SEC = 5;

const FLAG_LABELS = { habit: '癖を検出', tooClose: '近すぎと判定' };

// しきい値の調整のため、場面ごとに記録する数値(結果の JSON に入る)
export const DIAGNOSTIC_METRICS = [
  'handSpeed',
  'fingerSpeed',
  'pinch',
  'penGrip',
  'handsCount',
  'handFaceDist',
  'touchHandScale',
  'handY',
  'blink',
  'earRatio',
  'eyesClosed',
  'closedScore',
  'closedScoreSmooth',
  'eyeLookDown',
  'eyeLookDownSmooth',
  'eyeLookUp',
  'eyeLookSide',
  'jawOpen',
  'writeShare',
  'handScale',
  'yawDev',
  'pitchUp',
  'eyeDeskCm',
  'headRatio',
  'slouchRel',
  'faceVisible',
  'faceRate',
  'dozeShadow',
  'headMotion',
  'lookingDown',
  'crownRatio',
  'crownDelta',
  'hairFrac',
  'personFrac',
  'segHead',
  'covering',
  'handOnFace',
  'poseVisible',
  'hairShrunk',
  'cameraTiltDeg',
];

const STATE_LETTERS = { work: 'w', think: 't', lookaway: 'l', drowsy: 'd', sleep: 's', absent: 'a', away: 'A', paused: 'p' };

/**
 * 1 秒ごとの様子を文字列にする(しきい値の調整用)。
 * state:w=作業 t=思考 l=よそ見 d=うとうと s=居眠り a=不在 A=離席 p=一時停止
 * face(顔を検出)・closed(閉眼)・grip(ペンの形)・doze(前に傾いた居眠りの候補・試験中)・
 * bow(うつむいている)・head(髪の映り方から頭があると判定)・write(書いている):1=あり 0=なし -=不明
 * by:閉眼と判定した理由 e=目の形 b=目の形と閉じ具合 k=閉じ具合 d=深くうつむいて目の形 p=本人の目を閉じたときの基準 .=開眼 -=不明
 */
export function phaseTimeline(samples, sec) {
  const n = Math.ceil(sec);
  const buckets = Array.from({ length: n }, () => []);
  for (const s of samples) {
    const i = Math.min(n - 1, Math.floor(s.phaseElapsed));
    if (i >= 0) buckets[i].push(s);
  }
  const majority = (items) => {
    const c = {};
    for (const x of items) c[x] = (c[x] || 0) + 1;
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const flag = (b, key) => {
    const v = b.map((s) => s.metrics?.[key]).filter((x) => x === 0 || x === 1);
    if (!v.length) return '-';
    return v.reduce((a, x) => a + x, 0) / v.length >= 0.5 ? '1' : '0';
  };
  return {
    state: buckets.map((b) => (b.length ? STATE_LETTERS[b.some((s) => s.away) ? 'away' : majority(b.map((s) => s.state))] ?? '?' : '-')).join(''),
    face: buckets.map((b) => flag(b, 'faceVisible')).join(''),
    closed: buckets.map((b) => flag(b, 'eyesClosed')).join(''),
    grip: buckets.map((b) => flag(b, 'penGrip')).join(''),
    doze: buckets.map((b) => flag(b, 'dozeShadow')).join(''),
    bow: buckets.map((b) => flag(b, 'lookingDown')).join(''),
    head: buckets.map((b) => flag(b, 'segHead')).join(''),
    write: buckets.map((b) => flag(b, 'writing')).join(''),
    by: buckets
      .map((b) => {
        const v = b.filter((s) => s.metrics).map((s) => s.metrics.closedBy ?? '.');
        return v.length ? CLOSED_BY_LETTERS[majority(v)] ?? '?' : '-';
      })
      .join(''),
  };
}

const CLOSED_BY_LETTERS = { ear: 'e', earBlink: 'b', blink: 'k', down: 'd', personal: 'p', '.': '.' };

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 数値の分布(10%・中央値・90%)。 */
export function metricStats(samples, keys = DIAGNOSTIC_METRICS) {
  const out = {};
  for (const key of keys) {
    const v = samples
      .map((s) => s.metrics?.[key])
      .filter((x) => Number.isFinite(x))
      .sort((a, b) => a - b);
    if (!v.length) continue;
    const r = (x) => Math.round(x * 1000) / 1000;
    const mean = v.reduce((a, x) => a + x, 0) / v.length;
    out[key] = { p10: r(quantile(v, 0.1)), median: r(quantile(v, 0.5)), p90: r(quantile(v, 0.9)), mean: r(mean), n: v.length };
  }
  return out;
}

export const SCENARIO = [
  {
    id: 'read',
    label: '教材を読む',
    speech: '教材を見下ろして、読んでください',
    sec: 25,
    graceSec: 3,
    // 読んでいるときは手を止めているはずなので「思考」が多いこと。居眠りの誤判定はほぼ 0 であること
    expect: { states: ['think'], minShare: 0.6, maxFalseSleep: 0.05 },
    purpose: '下を向いて読んでいるときに、居眠りや作業と誤判定しないか',
  },
  {
    id: 'write',
    label: '書く',
    speech: 'ペンを持って、ノートに文字を書いてください',
    sec: 25,
    graceSec: 3,
    expect: { states: ['work'], minShare: 0.5 },
    purpose: 'ペンを持って書いている時間を作業と判定できるか',
    // 平置きでは手元が映らない(5 回目)
    notIn: { flat: '平置きでは手元が映らないため対象外' },
  },
  {
    id: 'eyes',
    label: '目を閉じる',
    speech: '顔を上げたまま、目を閉じてください。音が鳴るまで開けないでください',
    sec: 25,
    graceSec: 4,
    expect: { states: ['drowsy', 'sleep'], minShare: 0.6, mustReach: 'sleep' },
    purpose: '目を閉じた居眠りを検知できるか(10 秒で居眠りと判定)',
  },
  {
    id: 'doze',
    label: '前に傾いて目を閉じる',
    speech: '少し前に傾いて、目を閉じてください。いつもの居眠りの姿勢で、音が鳴るまで続けてください',
    sec: 25,
    graceSec: 4,
    expect: { states: ['drowsy', 'sleep'], minShare: 0.6, mustReach: 'sleep' },
    purpose: 'ふだんの居眠りの姿勢(少し前に傾いて目を閉じる)を検知できるか',
  },
  {
    id: 'facedown',
    label: '机に伏せる',
    speech: '机に顔を伏せて、居眠りのまねをしてください。音が鳴るまで続けてください',
    sec: 35,
    graceSec: 5,
    expect: { mustReach: 'sleep' },
    purpose: '机に伏せた居眠りを検知できるか(20 秒で居眠りと判定)',
  },
  {
    id: 'lookaway',
    label: 'よそ見',
    speech: '顔を横に向けて、よそ見をしてください',
    sec: 15,
    graceSec: 4,
    expect: { states: ['lookaway'], minShare: 0.6 },
    purpose: 'よそ見を検知できるか',
  },
  {
    id: 'touch',
    label: '顔や頭を触る',
    speech: '顔や頭を、ときどき触ってください',
    sec: 20,
    graceSec: 2,
    // 「ときどき」触るので、時間の割合ではなく検出した回数で判定する
    expect: { events: ['habit_face', 'habit_head', 'chin_rest'], minEvents: 2 },
    purpose: '癖(顔や頭を触る)を検出できるか',
  },
  {
    id: 'close',
    label: '顔を机に近づける',
    speech: '顔を机に近づけて、のぞき込むような姿勢をしてください',
    sec: 15,
    graceSec: 3,
    expect: { flag: 'tooClose', minShare: 0.5 },
    purpose: '目と机の距離が近すぎることを検知できるか',
  },
  {
    id: 'leave',
    label: '離席',
    speech: '席を立って、カメラに映らない所まで離れてください。音が鳴ったら戻ってください',
    // 席を立って画角から出るまでに数秒かかる(2 回目の実機検証で約 6 秒)ため、離席の判定(20 秒)に余裕を持たせる
    sec: 40,
    graceSec: 4,
    expect: { states: ['absent'], minShare: 0.6, mustAway: true },
    purpose: '離席を検知できるか(20 秒で離席と判定)',
  },
];

export function scenarioTotalSec(scenario = SCENARIO) {
  return scenario.reduce((s, p) => s + TRANSITION_SEC + p.sec, 0);
}

/** 経過秒数から、今どの場面かを返す。移行中(指示の読み上げ中)は評価しない。 */
export function phaseAt(elapsedSec, scenario = SCENARIO) {
  let t = 0;
  for (let i = 0; i < scenario.length; i++) {
    const p = scenario[i];
    if (elapsedSec < t + TRANSITION_SEC) return { index: i, phase: p, inTransition: true, phaseElapsed: 0 };
    t += TRANSITION_SEC;
    if (elapsedSec < t + p.sec) return { index: i, phase: p, inTransition: false, phaseElapsed: elapsedSec - t };
    t += p.sec;
  }
  return null;
}

/**
 * 1 つの場面の判定結果を評価する。
 * samples: [{ phaseElapsed, dt, state, away, flags }]
 */
export function evaluatePhase(phase, samples, { setup = 'stand' } = {}) {
  const used = samples.filter((s) => s.phaseElapsed >= phase.graceSec);
  const total = used.reduce((s, x) => s + x.dt, 0);
  const share = {};
  for (const s of used) share[s.state] = (share[s.state] || 0) + s.dt;
  for (const k of Object.keys(share)) share[k] = total > 0 ? share[k] / total : 0;

  const result = {
    id: phase.id,
    label: phase.label,
    purpose: phase.purpose,
    seconds: total,
    share,
    notes: [],
    metrics: metricStats(used),
    timeline: phaseTimeline(samples, phase.sec),
  };
  if (phase.notIn?.[setup]) {
    result.pass = null;
    result.notes.push(phase.notIn[setup]);
    return result;
  }
  if (total < 3) {
    result.pass = null;
    result.notes.push('判定できたフレームが少なすぎます');
    return result;
  }

  // 指定された条件をすべて満たせば合格
  const e = phase.expect;
  const checks = [];
  if (e.states) {
    const hit = e.states.reduce((s, k) => s + (share[k] || 0), 0);
    result.score = hit;
    checks.push(hit >= e.minShare);
  }
  if (e.mustReach) {
    const reached = used.some((s) => s.state === e.mustReach);
    result.notes.push(reached ? '居眠りの判定まで到達' : '居眠りの判定まで到達せず');
    checks.push(reached);
  }
  if (e.mustAway) {
    const away = used.some((s) => s.away);
    result.notes.push(away ? '離席と判定' : '離席と判定されず');
    checks.push(away);
  }
  if (e.flag) {
    const flagged = used.reduce((s, x) => s + (x.flags?.[e.flag] ? x.dt : 0), 0) / total;
    result.flag = e.flag;
    result.flagLabel = FLAG_LABELS[e.flag] ?? e.flag;
    result.score = flagged;
    checks.push(flagged >= e.minShare);
  }
  if (e.minEvents != null) {
    const count = samples.reduce((n, x) => n + (x.events ?? []).filter((t) => e.events.includes(t)).length, 0);
    result.eventCount = count;
    result.notes.push(`癖を ${count} 回検出`);
    checks.push(count >= e.minEvents);
  }
  if (e.maxFalseSleep != null) {
    const falseSleep = (share.drowsy || 0) + (share.sleep || 0);
    result.notes.push(`居眠りの誤判定 ${Math.round(falseSleep * 100)}%`);
    checks.push(falseSleep <= e.maxFalseSleep);
  }
  result.pass = checks.every(Boolean);
  return result;
}
