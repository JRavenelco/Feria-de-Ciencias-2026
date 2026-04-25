"""
blazepose_oak_rpi5.py — Inferencia de pose real en el Myriad X de la OAK.

Toda la NN corre en el chip de la cámara; la RPi 5 solo recibe las
coordenadas decodificadas y las reenvía por OSC a Processing / p5.js.

Modelo: human-pose-estimation-0001 (OpenVINO / blobconverter)
  Entrada  : BGR [1, 3, 256, 456]
  Salidas  : Mconv7_stage2_L2 → heatmaps  [1, 19, 32, 57]
             Mconv7_stage2_L1 → PAFs       [1, 38, 32, 57]

Keypoints COCO (índices que usamos):
  0 nose | 2 shoulder_r | 3 elbow_r | 4 wrist_r
         | 5 shoulder_l | 6 elbow_l | 7 wrist_l
"""

import argparse
import time
from typing import Dict, Iterable, Optional, Tuple

import numpy as np

try:
    import depthai as dai
except ImportError as exc:
    raise SystemExit(
        "DepthAI no instalado.\n"
        "  pip install depthai  (o ejecuta setup_rpi5.sh)"
    ) from exc

try:
    import blobconverter
except ImportError as exc:
    raise SystemExit(
        "blobconverter no instalado.\n"
        "  pip install blobconverter"
    ) from exc

from pythonosc.udp_client import SimpleUDPClient

# ── Constantes del modelo ────────────────────────────────────────────────────
NN_W, NN_H       = 456, 256      # resolución de entrada de la NN
HEATMAP_W        = 57            # columnas del mapa de calor
HEATMAP_H        = 32            # filas del mapa de calor
CONFIDENCE_THR   = 0.15          # umbral mínimo de confianza por keypoint

# Índices COCO de los keypoints que publicamos
KEYPOINT_IDX: Dict[str, int] = {
    "nose":       0,
    "shoulder_r": 2,
    "elbow_r":    3,
    "wrist_r":    4,
    "shoulder_l": 5,
    "elbow_l":    6,
    "wrist_l":    7,
}

LANDMARK_SUFFIX: Dict[str, str] = {
    "wrist_l":    "wrist/L",
    "wrist_r":    "wrist/R",
    "elbow_l":    "elbow/L",
    "elbow_r":    "elbow/R",
    "shoulder_l": "shoulder/L",
    "shoulder_r": "shoulder/R",
    "nose":       "nose",
}

Point3D = Tuple[float, float, float]
PoseFrame = Dict[str, object]


# ── Decodificación de heatmaps ───────────────────────────────────────────────

def _shoulder_width(kps: Dict[str, Optional[Point3D]]) -> float:
    """Distancia horizontal entre hombros (proxy de profundidad)."""
    sl = kps.get("shoulder_l")
    sr = kps.get("shoulder_r")
    if sl is None or sr is None:
        return 0.15
    return abs(sl[0] - sr[0])


def decode_heatmaps(
    heatmaps: np.ndarray,
) -> Dict[str, Optional[Point3D]]:
    """
    heatmaps : float32, shape [19, 32, 57]
    Devuelve dict nombre→(x_norm, y_norm, z_est) o None si no visible.
    z_est es una estimación de profundidad basada en confianza (0‥1).
    """
    raw: Dict[str, Optional[Point3D]] = {}
    for name, idx in KEYPOINT_IDX.items():
        hm = heatmaps[idx]                              # [32, 57]
        flat = int(np.argmax(hm))
        row, col = divmod(flat, HEATMAP_W)
        conf = float(hm[row, col])
        if conf < CONFIDENCE_THR:
            raw[name] = None
            continue
        x = col / (HEATMAP_W - 1)
        y = row / (HEATMAP_H - 1)
        raw[name] = (x, y, conf)                        # z temporal = conf

    # Refinar z usando ancho de hombros (más anchos = más cerca → z menor)
    sw = _shoulder_width(raw)
    ref_width = 0.18                                    # ancho de referencia ~1 m
    z_from_body = float(np.clip(ref_width / max(sw, 0.01) * 0.4, 0.05, 0.95))

    result: Dict[str, Optional[Point3D]] = {}
    for name, pt in raw.items():
        if pt is None:
            result[name] = None
        else:
            result[name] = (pt[0], pt[1], z_from_body)

    return result


# ── Pipeline DepthAI ─────────────────────────────────────────────────────────

def build_pipeline(blob_path: str, fps: int) -> "dai.Pipeline":
    pipeline = dai.Pipeline()

    cam = pipeline.create(dai.node.ColorCamera)
    cam.setPreviewSize(NN_W, NN_H)
    cam.setInterleaved(False)
    cam.setColorOrder(dai.ColorCameraProperties.ColorOrder.BGR)
    cam.setFps(fps)

    # ImageManip garantiza el formato correcto aunque el preview cambie
    manip = pipeline.create(dai.node.ImageManip)
    manip.initialConfig.setResize(NN_W, NN_H)
    manip.initialConfig.setFrameType(dai.ImgFrame.Type.BGR888p)
    manip.setMaxOutputFrameSize(NN_W * NN_H * 3)
    cam.preview.link(manip.inputImage)

    nn = pipeline.create(dai.node.NeuralNetwork)
    nn.setBlobPath(blob_path)
    nn.setNumInferenceThreads(2)        # usa ambos clusters del Myriad X
    nn.input.setBlocking(False)
    nn.input.setQueueSize(1)            # descarta frames si la NN va lenta
    manip.out.link(nn.input)

    xout = pipeline.create(dai.node.XLinkOut)
    xout.setStreamName("nn")
    nn.out.link(xout.input)

    return pipeline


def oak_pose_frames(blob_path: str, fps: int, person_id: int = 4) -> Iterable[PoseFrame]:
    """Generador: un dict de landmarks por cada frame inferido en la OAK."""
    args_person_id = person_id
    pipeline = build_pipeline(blob_path, fps)

    with dai.Device(pipeline) as device:
        mx_id = device.getDeviceInfo().getMxId()
        print(f"OAK conectada | MxId: {mx_id}")

        queue = device.getOutputQueue("nn", maxSize=4, blocking=False)
        prev_kps: Dict[str, Optional[Point3D]] = {}

        while True:
            packet = queue.get()

            try:
                raw = np.array(packet.getLayerFp16("Mconv7_stage2_L2"),
                               dtype=np.float32)
                heatmaps = raw.reshape(19, HEATMAP_H, HEATMAP_W)
            except Exception as exc:
                print(f"[WARN] Error al leer capa NN: {exc}")
                continue

            kps = decode_heatmaps(heatmaps)

            # Rellena keypoints faltantes con el frame anterior
            landmarks: Dict[str, Point3D] = {}
            for name in LANDMARK_SUFFIX:
                pt = kps.get(name) or prev_kps.get(name)
                if pt is not None:
                    landmarks[name] = pt

            prev_kps = {k: v for k, v in kps.items() if v is not None}

            if landmarks:
                yield {"id": args_person_id, "landmarks": landmarks}


# ── Publicador OSC ───────────────────────────────────────────────────────────

class OscPublisher:
    def __init__(self, host: str, port: int, smoothing: float) -> None:
        self.client = SimpleUDPClient(host, port)
        self.alpha = float(np.clip(smoothing, 0.0, 1.0))
        self._state: Dict[str, Point3D] = {}

    def publish(self, frame: PoseFrame) -> None:
        person_id = int(frame.get("id", 4))
        landmarks: Dict[str, Point3D] = frame.get("landmarks", {})

        for name, suffix in LANDMARK_SUFFIX.items():
            pt = landmarks.get(name)
            if pt is None:
                continue
            pt = self._smooth(name, pt)
            self.client.send_message(f'/pose/{person_id}/{suffix}', list(pt))

        self.client.send_message('/pose/count', 1)

    def _smooth(self, name: str, current: Point3D) -> Point3D:
        prev = self._state.get(name)
        if prev is None or self.alpha == 0.0:
            self._state[name] = current
            return current
        a = self.alpha
        smoothed: Point3D = (
            prev[0] * a + current[0] * (1.0 - a),
            prev[1] * a + current[1] * (1.0 - a),
            prev[2] * a + current[2] * (1.0 - a),
        )
        self._state[name] = smoothed
        return smoothed


# ── CLI ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Pose OSC publisher — RPi 5 + OAK (inferencia real en Myriad X)"
    )
    p.add_argument("--host",      default="127.0.0.1",
                   help="IP destino OSC (default: 127.0.0.1)")
    p.add_argument("--port",      type=int, default=12000,
                   help="Puerto UDP OSC (default: 12000)")
    p.add_argument("--fps",       type=int, default=30,
                   help="FPS objetivo (default: 30)")
    p.add_argument("--smoothing", type=float, default=0.6,
                   help="Suavizado exponencial 0.0–1.0 (default: 0.6)")
    p.add_argument("--shaves",    type=int, default=6,
                   help="SHAVE cores del Myriad X para la NN (default: 6, rango 4-13)")
    p.add_argument("--openvino-version", default="2022.1",
                   help="Versión de OpenVINO para blobconverter (default: 2022.1)")
    p.add_argument("--person-id", type=int, default=4,
                   help="ID de persona asignado a la OAK (default: 4, rango 4-7)")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    print("Descargando / verificando blob de pose estimation...")
    print(f"  Modelo  : human-pose-estimation-0001")
    print(f"  Shaves  : {args.shaves}")
    print(f"  OpenVINO: {args.openvino_version}")

    blob_path = blobconverter.from_zoo(
        name="human-pose-estimation-0001",
        shaves=args.shaves,
        version=args.openvino_version,
    )
    print(f"  Blob    : {blob_path}\n")

    publisher = OscPublisher(args.host, args.port, args.smoothing)
    frame_interval = 1.0 / max(args.fps, 1)

    print(f"Publicando OSC → udp://{args.host}:{args.port}  @  {args.fps} FPS")
    print("Ctrl+C para detener.\n")

    print(f"  Person-ID OAK: {args.person_id} (Hailo usa 0-3, OAK usa 4-7)\n")

    try:
        for frame in oak_pose_frames(blob_path, args.fps, person_id=args.person_id):
            t0 = time.perf_counter()
            publisher.publish(frame)
            remaining = frame_interval - (time.perf_counter() - t0)
            if remaining > 0:
                time.sleep(remaining)
    except KeyboardInterrupt:
        print("\nPublicación detenida.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
