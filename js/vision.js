// MediaPipe Tasks(顔・手・上半身の特徴点)の読み込みと実行(設計書 4.2)。

export const MP_VERSION = '1.0.1';
export const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models';
export const MODEL_URLS = {
  face: `${MODEL_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
  hand: `${MODEL_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
  pose: `${MODEL_BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
};

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

  onProgress('顔のモデルを読み込み中…(1/3)');
  const face = await make('face', mp.FaceLandmarker, MODEL_URLS.face, { numFaces: 1, outputFaceBlendshapes: true });
  onProgress('手のモデルを読み込み中…(2/3)');
  const hand = await make('hand', mp.HandLandmarker, MODEL_URLS.hand, { numHands: 2 });
  onProgress('上半身のモデルを読み込み中…(3/3)');
  const pose = await make('pose', mp.PoseLandmarker, MODEL_URLS.pose, { numPoses: 1 });

  let lastT = 0;
  return {
    delegates,
    // 3 つのモデルを実行し、analysis.js の extractFeatures が受け取る形にして返す
    detect(video, { withPose = true } = {}) {
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
      let faceOut = null;
      if (fr.faceLandmarks?.length) {
        const blendshapes = {};
        for (const c of fr.faceBlendshapes?.[0]?.categories ?? []) blendshapes[c.categoryName] = c.score;
        faceOut = { landmarks: fr.faceLandmarks[0], blendshapes };
      }
      return { t, face: faceOut, hands: hr.landmarks ?? [], pose: poseLandmarks };
    },
    close() {
      face.close();
      hand.close();
      pose.close();
    },
  };
}
