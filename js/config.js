// 判定のしきい値など。技術検証ではここの値を調整する(設計書 4 章の初期案に対応)。
export const DEFAULTS = {
  analysisFps: 5,

  // 離席(設計書 3.10)
  awaySec: 20,
  returnSec: 3,

  // よそ見(設計書 4.4):キャリブレーション時の頭の向きからのずれ
  lookAwayYawDeg: 25,
  lookAwayPitchUpDeg: 20,
  lookAwaySec: 3,

  // 目の閉じ具合(設計書 4.8)
  blinkMarginOverCal: 0.3, // キャリブレーション時の閉じ具合 + この値 を「閉じている」とみなす
  blinkMin: 0.45,
  blinkMax: 0.8,
  earRatioWithBlink: 0.8, // 表情係数が高く、かつ EAR 比がこの値未満なら閉眼
  earRatioStrong: 0.45, // EAR 比がこの値未満なら表情係数に関係なく閉眼
  lookingDownExtraDeg: 15, // キャリブレーションよりさらに下を向いているときは強い証拠だけで判定
  drowsyClosedSec: 3,
  sleepClosedSec: 10,
  perclosWindowSec: 60,
  perclosDrowsy: 0.3,
  perclosMinObservedSec: 20, // これより短い観測では PERCLOS を使わない
  wakeOpenSec: 2, // 目を開けた状態がこの秒数続いたら目覚めたとみなす
  sleepClosedSecAnyHands: 20, // 手が動いていても、これだけ長く目を閉じていれば居眠り
  faceDownSec: 30,

  // 手の動き(作業の判定):顔の幅を 1 とした速さ(1 秒あたり)
  // 1 回目の実機検証(2026-09-24)で、0.05 では止まっている手も「書いている」と判定されたため引き上げた
  handWindowSec: 1.5,
  handSmoothing: 0.5, // 手の位置の平滑化(1 に近いほど平滑化が弱い)
  writeSpeedMin: 0.15,
  handNoiseFactor: 2.5, // キャリブレーションで測ったゆらぎの何倍を書く動作の下限にするか
  writeSpeedMax: 1.5,

  // 癖(設計書 4.7)
  habitTouchSec: 1,
  chinRestSec: 5,
  chinRestMaxSpeed: 0.3, // 頬杖とみなす手の速さの上限
  habitMergeSec: 5,

  // 姿勢(設計書 4.9)
  irisDiameterCm: 1.17,
  cameraFovLongSideDeg: 69,
  eyeDeskThresholdCm: 30,
  eyeDeskAlertSec: 20,
  slouchRatio: 0.8,
  slouchAlertSec: 60,
  tiltDeg: 15,
  tiltAlertSec: 60,

  // 集中度(設計書 4.5)
  minEvaluableSec: 30,
  drowsyWeight: 40,
  habitPenalty: 3,
  habitPenaltyMax: 15,
  interruptionPenalty: 2,
  interruptionPenaltyMax: 10,
};

// 設置スタイルごとのカメラの上向きの傾き(度)。平置きは真上を向く。
export const SETUP_TILT_DEG = { stand: 0, flat: 90 };
