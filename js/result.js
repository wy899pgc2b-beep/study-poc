// 結果画面の描画(設計書 3.14 学習結果の振り返り)。

import { STATE_LABELS } from './analysis.js';

const EVENT_LABELS = {
  drowsy: 'うとうと',
  sleep: '居眠り',
  lookaway: 'よそ見',
  habit_face: '癖:顔を触る',
  habit_head: '癖:頭・髪を触る',
  chin_rest: '癖:頬杖',
  yawn: 'あくび(記録のみ)',
  posture_close: '姿勢:目が机に近い',
  posture_slouch: '姿勢:前かがみ',
  posture_tilt: '姿勢:体の傾き',
  away_start: '離席(自動)',
  manual_away: '離席(手動)',
  device_move: '端末が動いた',
  app_hidden: 'アプリを離れた',
};

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

export function formatDuration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}時間${m}分`;
  if (m) return `${m}分${r}秒`;
  return `${r}秒`;
}

function stat(label, value, unit = '') {
  return el('div', { class: 'stat' }, el('div', { class: 'label', text: label }), el('div', { class: 'value' }, value, unit ? el('span', { class: 'unit', text: unit }) : null));
}

function section(title, ...children) {
  return el('section', { class: 'card' }, el('h2', { text: title }), ...children);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// 上端だけ角を丸めた棒(4px)。下端は基準線に接する。
function barPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  const b = y + h;
  return `M${x},${b} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${b} Z`;
}

/** 1 分ごとの集中度の棒グラフ。スコアのない分(離席など)は背景の帯で示す。 */
export function focusChart(scores) {
  const W = 360;
  const H = 180;
  const pad = { l: 38, r: 6, t: 10, b: 24 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const n = Math.max(scores.length, 1);
  const slot = pw / n;
  const barW = Math.max(2, Math.min(28, slot - 2));
  const y = (v) => pad.t + ph - (v / 100) * ph;

  const wrap = el('div', { class: 'chart' });
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '1分ごとの集中度のグラフ' });
  const grid = svg('g', { class: 'grid' });
  const axis = svg('g', { class: 'axis' });
  for (const v of [0, 50, 100]) {
    grid.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    const label = svg('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' });
    label.textContent = `${v}%`;
    axis.append(label);
  }
  root.append(grid);

  const bars = svg('g');
  const step = Math.ceil(n / 6);
  scores.forEach((s, i) => {
    const x = pad.l + i * slot + (slot - barW) / 2;
    if (s == null) {
      bars.append(svg('rect', { class: 'gap-band', x, y: pad.t, width: barW, height: ph, rx: 2 }));
    } else if (s > 0) {
      bars.append(svg('path', { class: 'bar', d: barPath(x, y(s), barW, (s / 100) * ph), 'data-i': i }));
    }
    if (i % step === 0) {
      const label = svg('text', { x: pad.l + i * slot + slot / 2, y: H - 8, 'text-anchor': 'middle' });
      label.textContent = `${i + 1}分`;
      axis.append(label);
    }
  });
  root.append(bars, axis);

  const tip = el('div', { class: 'tooltip', hidden: '' });
  const hits = svg('g');
  scores.forEach((s, i) => {
    const hit = svg('rect', { class: 'hit', x: pad.l + i * slot, y: pad.t, width: slot, height: ph });
    const showTip = () => {
      tip.textContent = s == null ? `${i + 1}分目:判定なし(離席など)` : `${i + 1}分目:集中度 ${s}%`;
      tip.style.left = `${((pad.l + i * slot + slot / 2) / W) * 100}%`;
      tip.style.top = `${(y(s ?? 100) / H) * 100}%`;
      tip.hidden = false;
      bars.querySelectorAll('.bar').forEach((b) => b.classList.toggle('active', Number(b.dataset.i) === i));
    };
    hit.addEventListener('pointerenter', showTip);
    hit.addEventListener('click', showTip);
    hit.addEventListener('pointerleave', () => {
      tip.hidden = true;
      bars.querySelectorAll('.bar').forEach((b) => b.classList.remove('active'));
    });
    hits.append(hit);
  });
  root.append(hits);
  wrap.append(root, tip);
  return wrap;
}

function stateBars(totals) {
  const keys = ['work', 'think', 'lookaway', 'drowsy', 'sleep', 'absent', 'away', 'paused'];
  const total = keys.reduce((s, k) => s + (totals[k] || 0), 0);
  const box = el('div', { class: 'hbars' });
  for (const k of keys) {
    const share = total > 0 ? (totals[k] || 0) / total : 0;
    const fill = el('div', { class: 'fill' });
    fill.style.width = `${share * 100}%`;
    box.append(el('span', { text: STATE_LABELS[k] }), el('div', { class: 'track' }, fill), el('span', { class: 'pct', text: `${Math.round(share * 100)}%` }));
  }
  return box;
}

function scenarioTable(results) {
  const passed = results.filter((r) => r.pass === true).length;
  const table = el('table');
  table.append(el('thead', {}, el('tr', {}, el('th', { text: '場面' }), el('th', { class: 'verdict', text: '判定' }), el('th', { text: '主な判定結果' }))));
  const body = el('tbody');
  for (const r of results) {
    const verdict = r.pass == null ? el('span', { text: '—' }) : el('span', { class: r.pass ? 'pass' : 'fail', text: r.pass ? '合格' : '不合格' });
    const top = Object.entries(r.share)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${STATE_LABELS[k] ?? k} ${Math.round(v * 100)}%`)
      .join('、');
    const flagNote = r.flag && r.score != null ? `${r.flagLabel} ${Math.round(r.score * 100)}%` : null;
    const detail = [top, flagNote, ...r.notes].filter(Boolean).join(' / ');
    body.append(el('tr', {}, el('td', {}, el('b', { text: r.label }), el('br'), el('small', { text: r.purpose })), el('td', { class: 'verdict' }, verdict), el('td', { text: detail || '—' })));
  }
  table.append(body);
  return [el('p', { text: `${results.length} 場面中 ${passed} 場面で合格しました。` }), el('div', { class: 'table-scroll' }, table)];
}

export function renderResult(container, data, { onBatteryChange } = {}) {
  container.replaceChildren();
  const s = data.summary;

  if (data.scenario) container.append(section('検証シナリオの判定', ...scenarioTable(data.scenario)));

  const style = [s.style.hands, s.style.pattern].filter(Boolean).join(' × ') || '判定なし';
  container.append(
    el(
      'div',
      { class: 'stats' },
      stat('学習時間', formatDuration(s.studySec)),
      stat('離席', formatDuration(s.awaySec)),
      stat('一時停止', formatDuration(s.pausedSec)),
      stat('平均集中度', s.avgFocus == null ? '—' : String(s.avgFocus), s.avgFocus == null ? '' : '%'),
      stat('集中時間', s.effectiveFocusMin.toFixed(1), '分'),
      stat('学習スタイル', style),
    ),
  );

  container.append(
    section(
      '1分ごとの集中度',
      focusChart(s.scores),
      el('p', { class: 'note', text: '灰色の帯は、離席などで評価できる時間が 30 秒未満だった分です。棒をタップすると値を表示します。' }),
    ),
  );

  container.append(section('状態の内訳', stateBars(s.totals)));

  const cal = data.calibration;
  if (cal?.measuredEyeDeskCm) {
    const threshold = cal.measuredEyeDeskCm * (1 - data.cfg.eyeDeskCloseRatio);
    const rows = [
      el('tr', {}, el('td', { text: 'あなたの基準(キャリブレーション時)' }), el('td', { text: `${cal.measuredEyeDeskCm}cm` })),
      el('tr', {}, el('td', { text: '「近すぎ」と判定する距離' }), el('td', { text: `${threshold.toFixed(1)}cm 未満` })),
      el('tr', {}, el('td', { text: '「近すぎ」の通知' }), el('td', { text: `${s.counts.posture_close || 0} 回` })),
    ];
    const guideline = data.cfg.eyeDeskGuidelineCm;
    container.append(
      section(
        '目と机の距離',
        el('table', {}, el('tbody', {}, ...rows)),
        cal.measuredEyeDeskCm < guideline
          ? el('p', { class: 'note', text: `参考:一般的には、目と教材の距離は ${guideline}cm 以上が目安とされています。` })
          : null,
      ),
    );
  }

  const counts = Object.entries(EVENT_LABELS)
    .filter(([k]) => s.counts[k])
    .map(([k, label]) => el('tr', {}, el('td', { text: label }), el('td', { text: `${s.counts[k]} 回` })));
  container.append(section('検出したできごと', counts.length ? el('table', {}, el('tbody', {}, ...counts)) : el('p', { class: 'note', text: 'ありませんでした' })));

  const p = data.perf;
  const batteryInput = el('input', { type: 'number', min: '1', max: '100', inputmode: 'numeric', placeholder: '例:72' });
  const batteryOut = el('p', { class: 'note' });
  const updateBattery = () => {
    const end = Number(batteryInput.value);
    const start = data.opts.batteryStart;
    const hours = data.durationSec / 3600;
    if (!start || !end || hours <= 0) {
      batteryOut.textContent = '開始時と終了時の電池残量を入力すると、1 時間あたりの消費を計算します。';
      return;
    }
    const perHour = (start - end) / hours;
    batteryOut.textContent =
      data.durationSec < 20 * 60
        ? '20 分未満の記録では電池の消費を正しく計算できません。「自由に学習」で 30 分以上試してください。'
        : `1 時間あたり約 ${perHour.toFixed(1)}% の消費(目標:20% 以下)`;
    onBatteryChange?.(end, perHour);
  };
  batteryInput.addEventListener('input', updateBattery);
  updateBattery();
  container.append(
    section(
      '処理速度と電池',
      el(
        'table',
        {},
        el(
          'tbody',
          {},
          el('tr', {}, el('td', { text: '1 回の解析にかかった時間' }), el('td', { text: `平均 ${p.avgMs.toFixed(0)} ms(遅い方から 5%:${p.p95Ms.toFixed(0)} ms)` })),
          el('tr', {}, el('td', { text: '実際の解析頻度' }), el('td', { text: `${p.effectiveFps.toFixed(1)} 回/秒(設定 ${data.cfg.analysisFps} 回/秒)` })),
          el('tr', {}, el('td', { text: '使ったプロセッサ' }), el('td', { text: Object.entries(p.delegates).map(([k, v]) => `${k}: ${v}`).join('、') })),
          el('tr', {}, el('td', { text: '映像の大きさ' }), el('td', { text: p.videoSize })),
          el('tr', {}, el('td', { text: '解析の失敗' }), el('td', { text: `${p.errors} 回` })),
        ),
      ),
      el('label', { class: 'field' }, '終了時の電池残量(%)', batteryInput),
      batteryOut,
    ),
  );

  const minuteRows = s.scores.map((score, i) =>
    el('tr', {}, el('td', { text: `${i + 1}分目` }), el('td', { text: score == null ? '判定なし' : `${score}%` })),
  );
  container.append(
    el(
      'details',
      { class: 'card' },
      el('summary', { text: '詳しいデータ(1 分ごとの表・キャリブレーション値)' }),
      el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: '時間' }), el('th', { text: '集中度' }))), el('tbody', {}, ...minuteRows)),
      el('pre', { class: 'note', text: JSON.stringify(data.calibration, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v), 2) }),
    ),
  );
}
