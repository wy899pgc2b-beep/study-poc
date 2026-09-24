// 検証シナリオ:音声の指示どおりに動いてもらい、各場面で AI が正しく判定できたかを調べる(設計書 11 章 フェーズ0)。
// 画面が見えないバックカメラでも使えるよう、指示はすべて音声で出す。

export const TRANSITION_SEC = 5;

const FLAG_LABELS = { habit: '癖を検出', tooClose: '近すぎと判定' };

export const SCENARIO = [
  {
    id: 'read',
    label: '教材を読む',
    speech: '教材を見下ろして、読んでください',
    sec: 25,
    graceSec: 3,
    expect: { states: ['think', 'work'], minShare: 0.7 },
    purpose: '下を向いて読んでいるときに、居眠りと誤判定しないか',
  },
  {
    id: 'write',
    label: '書く',
    speech: 'ノートに文字を書いてください',
    sec: 25,
    graceSec: 3,
    expect: { states: ['work'], minShare: 0.5 },
    purpose: '手を動かしている時間を作業と判定できるか',
  },
  {
    id: 'eyes',
    label: '目を閉じる',
    speech: '目を閉じて、居眠りのまねをしてください。音が鳴るまで続けてください',
    sec: 25,
    graceSec: 4,
    expect: { states: ['drowsy', 'sleep'], minShare: 0.6, mustReach: 'sleep' },
    purpose: '居眠りを検知できるか(10 秒で居眠りと判定)',
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
    expect: { flag: 'habit', minShare: 0.15 },
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
    sec: 30,
    graceSec: 4,
    expect: { states: ['absent'], minShare: 0.7, mustAway: true },
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
export function evaluatePhase(phase, samples) {
  const used = samples.filter((s) => s.phaseElapsed >= phase.graceSec);
  const total = used.reduce((s, x) => s + x.dt, 0);
  const share = {};
  for (const s of used) share[s.state] = (share[s.state] || 0) + s.dt;
  for (const k of Object.keys(share)) share[k] = total > 0 ? share[k] / total : 0;

  const result = { id: phase.id, label: phase.label, purpose: phase.purpose, seconds: total, share, notes: [] };
  if (total < 3) {
    result.pass = null;
    result.notes.push('判定できたフレームが少なすぎます');
    return result;
  }

  const e = phase.expect;
  if (e.states) {
    const hit = e.states.reduce((s, k) => s + (share[k] || 0), 0);
    result.score = hit;
    result.pass = hit >= e.minShare;
    if (e.mustReach) {
      const reached = used.some((s) => s.state === e.mustReach);
      result.notes.push(reached ? '居眠りの判定まで到達' : '居眠りの判定まで到達せず');
      if (!reached) result.pass = false;
    }
    if (e.mustAway) {
      const away = used.some((s) => s.away);
      result.notes.push(away ? '離席と判定' : '離席と判定されず');
      if (!away) result.pass = false;
    }
  } else if (e.flag) {
    const flagged = used.reduce((s, x) => s + (x.flags?.[e.flag] ? x.dt : 0), 0) / total;
    result.flag = e.flag;
    result.flagLabel = FLAG_LABELS[e.flag] ?? e.flag;
    result.score = flagged;
    result.pass = flagged >= e.minShare;
  }

  if (phase.id === 'read') {
    const falseSleep = (share.drowsy || 0) + (share.sleep || 0);
    result.notes.push(`居眠りの誤判定 ${Math.round(falseSleep * 100)}%`);
  }
  return result;
}
