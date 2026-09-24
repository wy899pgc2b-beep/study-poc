// 音声の読み上げと効果音(設計書 3.13)。バックカメラでは画面が見えないため、通知は音が中心。

export class Voice {
  constructor() {
    this.ctx = null;
    this.voice = null;
    this.lastSpoken = {};
    this.alarm = null;
  }

  // iOS では、ユーザーの操作(タップ)の中で一度音を出さないと、以降の音が鳴らない
  unlock() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !this.ctx) this.ctx = new AC();
      this.ctx?.resume?.();
    } catch (e) {
      console.warn('AudioContext を使えません', e);
    }
    if ('speechSynthesis' in window) {
      const pick = () => {
        const voices = speechSynthesis.getVoices();
        this.voice = voices.find((v) => v.lang === 'ja-JP') || voices.find((v) => v.lang?.startsWith('ja')) || null;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
      const u = new SpeechSynthesisUtterance('');
      speechSynthesis.speak(u);
    }
  }

  // key を指定すると、同じ種類の読み上げを minIntervalSec 以内に繰り返さない
  say(text, { key = null, minIntervalSec = 0, interrupt = false } = {}) {
    if (!('speechSynthesis' in window)) return;
    const now = Date.now();
    if (key && this.lastSpoken[key] && now - this.lastSpoken[key] < minIntervalSec * 1000) return;
    if (key) this.lastSpoken[key] = now;
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }

  beep({ freq = 880, sec = 0.15, volume = 0.3 } = {}) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + sec);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + sec + 0.02);
  }

  // 居眠りアラーム:音量を段階的に上げる(設計書 3.8)
  startAlarm() {
    if (this.alarm) return;
    let volume = 0.2;
    const ring = () => {
      this.beep({ freq: 1320, sec: 0.25, volume });
      setTimeout(() => this.beep({ freq: 990, sec: 0.25, volume }), 300);
      volume = Math.min(1, volume + 0.1);
    };
    ring();
    this.alarm = setInterval(ring, 900);
  }

  stopAlarm() {
    if (this.alarm) clearInterval(this.alarm);
    this.alarm = null;
  }

  get alarmActive() {
    return this.alarm != null;
  }
}
