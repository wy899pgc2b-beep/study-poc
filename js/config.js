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
  // 3 回目の実機検証:顔を上げて目を閉じたとき、閉じ具合 0.63(基準 0.43)・EAR 比 0.42 だったため緩めた(0.3 → 0.15、0.45 → 0.6)
  blinkMarginOverCal: 0.15, // キャリブレーション時の閉じ具合 + この値 を「閉じている」とみなす
  blinkMin: 0.45,
  blinkMax: 0.8,
  earRatioWithBlink: 0.8, // 表情係数が高く、かつ EAR 比がこの値未満なら閉眼
  earRatioStrong: 0.6, // EAR 比がこの値未満なら表情係数に関係なく閉眼
  lookingDownExtraDeg: 15, // キャリブレーションよりさらに下を向いているときは強い証拠だけで判定
  drowsyClosedSec: 3,
  sleepClosedSec: 10,
  perclosWindowSec: 60,
  perclosDrowsy: 0.3,
  perclosMinObservedSec: 20, // これより短い観測では PERCLOS を使わない
  wakeOpenSec: 2, // 目を開けた状態がこの秒数続いたら目覚めたとみなす
  faceDownSec: 20, // 設計書の初期案は 30 秒。検証シナリオで確かめられるよう 20 秒で試す
  faceGapSec: 2, // 顔の検出のちらつき(この秒数以内の途切れ)は続いているとみなす
  headLowRatio: 0.5, // 肩からの頭の高さがキャリブレーション時のこの割合未満なら「頭が低い」(伏せている)
  faceRateWindowSec: 10, // 顔の検出率を測る時間

  // うつむき具合と在席(設計書 4.9)
  headDownRatio: 0.85, // 肩からの頭の高さがキャリブレーション時のこの割合未満なら「うつむいている」
  crownBowDelta: 0.2, // 頭頂部の見える割合がキャリブレーション時よりこれ以上増えたら「うつむいている」
  segMinHairFrac: 0.005, // 画面のうち髪がこれ以上映っていれば、顔や上半身が見えなくても頭があるとみなす
  segHairRatio: 0.5, // …ただしキャリブレーション時の髪の面積のこの割合以上
  segPersonRatio: 0.4, // …かつ人の面積がキャリブレーション時のこの割合以上

  // 【試験中】前に傾いた居眠りの候補:うつむいたまま、頭も手もほとんど動かない状態が続く
  headMotionWindowSec: 2,
  dozeHeadStill: 0.05, // 頭の動き(肩幅 / 秒)がこれ未満
  dozeHandStill: 0.05, // 手の動き(顔の幅 / 秒)がこれ未満
  dozeShadowSec: 5,

  // 手の動き:速さの単位は、顔の幅を 1 とした 1 秒あたりの移動量
  handWindowSec: 1.5,
  handSmoothing: 0.5, // 手の位置の平滑化(1 に近いほど平滑化が弱い)

  // 書く動作(作業)の判定:机の上の手の速さ(docs/verification.md の 3 回目)
  writeSpeedMin: 0.12,
  penGripPinchMax: 0.35, // 【記録のみ】手の形(ペンを持つ形)の目安

  // 癖(設計書 4.7)
  habitTouchSec: 1,
  chinRestSec: 5,
  chinRestMaxSpeed: 0.3, // 頬杖とみなす手の速さの上限
  habitMergeSec: 5,

  // 姿勢(設計書 4.9)
  irisDiameterCm: 1.17,
  cameraFovLongSideDeg: 69,
  // 目と机の距離は本人の基準で判定する:キャリブレーション時の距離よりこの割合以上近づいたら「近すぎ」(決定事項 D-7)
  eyeDeskCloseRatio: 0.25,
  eyeDeskAlertSec: 20,
  // 一般的な目安。本人の基準がこれより近いときに、参考として 1 回だけ案内する
  eyeDeskGuidelineCm: 30,
  headCloseRatio: 0.75, // 顔が取れないとき、肩からの頭の高さがこの割合未満なら「近すぎ」
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
