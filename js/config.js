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
  faceDownSec: 20, // 設計書の初期案は 30 秒。検証シナリオで確かめられるよう 20 秒で試す
  faceGapSec: 2, // 顔の検出のちらつき(この秒数以内の途切れ)は続いているとみなす
  headLowRatio: 0.5, // 肩からの頭の高さがキャリブレーション時のこの割合未満なら「頭が低い」(伏せている)
  faceRateWindowSec: 10, // 顔の検出率を測る時間
  dozeShadowFaceRate: 0.7, // 【試験中】顔の検出率がこれ未満なら「前に傾いた居眠り」の候補として記録する

  // 手の動き:速さの単位は、顔の幅を 1 とした 1 秒あたりの移動量
  handWindowSec: 1.5,
  handSmoothing: 0.5, // 手の位置の平滑化(1 に近いほど平滑化が弱い)

  // 書く動作(作業)の判定:手の形で判定する(docs/verification.md の 2 回目)
  penGripPinchMax: 0.35, // 親指と人差し指の先の距離(手の大きさ比)がこれ未満ならペンを持つ形
  penGripSec: 1,
  penGripGapSec: 1,

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
