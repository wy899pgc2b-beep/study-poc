// MediaPipe Tasks(顔・手・上半身の特徴点)の読み込みと実行(設計書 4.2)。

export const MP_VERSION = '1.0.1';
export const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models';
export const MODEL_URLS = {
  face: `${MODEL_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
  hand: `${MODEL_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
  pose: `${MODEL_BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  // 髪・顔の肌・体・服などを画素ごとに分ける(頭頂部の見え方と、顔が見えないときの在席の判定に使う)
  segment: `${MODEL_BASE}/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite`,
};

// selfie_multiclass の分類(0:背景 1:髪 2:体の肌 3:顔の肌 4:服 5:その他)
const SEG = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, others: 5 };

/** 分類結果(画素ごとの番号)から、髪・顔の肌・人の面積の割合を求める。間引いて数える。 */
export function segmentStats(mask, width, height, step = 4) {
  const counts = [0, 0, 0, 0, 0, 0];
  let total = 0;
  let hairYSum = 0;
  for (let y = 0; y < height; y += step) {
    const row = y * width;
    for (let x = 0; x < width; x += step) {
      const c = mask[row + x];
      if (c < counts.length) counts[c] += 1;
      if (c === SEG.hair) hairYSum += y;
      total += 1;
    }
  }
  if (!total) return null;
  const hair = counts[SEG.hair] / total;
  const face = counts[SEG.faceSkin] / total;
  return {
    hairFrac: hair,
    faceSkinFrac: face,
    personFrac: 1 - counts[SEG.background] / total,
    // 頭頂部の見える割合:頭(髪+顔の肌)のうち髪の占める割合。うつむくほど大きくなる
    crownRatio: hair + face > 0.002 ? hair / (hair + face) : null,
    hairCenterY: counts[SEG.hair] ? hairYSum / counts[SEG.hair] / height : null,
  };
}

export async function createVision({ useGpu = true, onProgress = () => {} } = {}) {
  onProgress('AI ライブラリを読み込み中…');
  const mp = await import(`${MP_BASE}/vision_bundle.mjs`);
  const fileset = await mp.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);

  const delegates = {};
  async function make(name, Cls, modelAssetPath, extra) {
    const options = (delegate) => ({ baseOptions: { modelAssetPath, delegate }, runningMode: 'VIDEO', ...extra });
    if (useGpu) {
      try {
        const task = await Cls.createFromOptions(fileset, options('GPU'));
        delegates[name] = 'GPU';
        return task;
      } catch (e) {
        console.warn(`${name}: GPU で起動できないため CPU を使います`, e);
      }
    }
    const task = await Cls.createFromOptions(fileset, options('CPU'));
    delegates[name] = 'CPU';
    return task;
  }

  onProgress('顔のモデルを読み込み中…(1/4)');
  const face = await make('face', mp.FaceLandmarker, MODEL_URLS.face, { numFaces: 1, outputFaceBlendshapes: true });
  onProgress('手のモデルを読み込み中…(2/4)');
  const hand = await make('hand', mp.HandLandmarker, MODEL_URLS.hand, { numHands: 2 });
  onProgress('上半身のモデルを読み込み中…(3/4)');
  const pose = await make('pose', mp.PoseLandmarker, MODEL_URLS.pose, { numPoses: 1 });
  onProgress('頭と髪のモデルを読み込み中…(4/4)');
  let segmenter = null;
  try {
    segmenter = await make('segment', mp.ImageSegmenter, MODEL_URLS.segment, { outputCategoryMask: true, outputConfidenceMasks: false });
  } catch (e) {
    // 読み込めなくても、ほかの判定は続ける
    console.warn('頭と髪のモデルを読み込めませんでした', e);
    delegates.segment = 'なし';
  }

  let lastT = 0;
  return {
    delegates,
    // 4 つのモデルを実行し、analysis.js の extractFeatures が受け取る形にして返す
    detect(video, { withPose = true, withSegment = false } = {}) {
      // MediaPipe はタイムスタンプが単調増加である必要がある
      const t = Math.max(performance.now(), lastT + 1);
      lastT = t;
      const fr = face.detectForVideo(video, t);
      const hr = hand.detectForVideo(video, t);
      let poseLandmarks;
      if (withPose) {
        const pr = pose.detectForVideo(video, t);
        poseLandmarks = pr.landmarks?.[0] ?? null;
      }
      let segment;
      if (withSegment && segmenter) {
        const sr = segmenter.segmentForVideo(video, t);
        const m = sr.categoryMask;
        if (m) segment = segmentStats(m.getAsUint8Array(), m.width, m.height);
        sr.close?.();
      }
      let faceOut = null;
      if (fr.faceLandmarks?.length) {
        const blendshapes = {};
        for (const c of fr.faceBlendshapes?.[0]?.categories ?? []) blendshapes[c.categoryName] = c.score;
        faceOut = { landmarks: fr.faceLandmarks[0], blendshapes };
      }
      return { t, face: faceOut, hands: hr.landmarks ?? [], pose: poseLandmarks, segment };
    },
    close() {
      face.close();
      hand.close();
      pose.close();
      segmenter?.close();
    },
  };
}
