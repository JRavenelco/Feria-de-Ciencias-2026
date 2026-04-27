#!/home/maker/hailo-rpi5-examples/venv_hailo_rpi_examples/bin/python
"""
hailo_pose_publisher.py — Multi-person pose OSC publisher via Hailo-8.

Usa yolov8m_pose.hef corriendo en el acelerador Hailo-8 para detectar
hasta 6 personas simultáneas con 17 keypoints COCO cada una.

Publica por OSC:
  /pose/{id}/wrist/L    [x, y, z]   ← por persona
  /pose/{id}/wrist/R    [x, y, z]
  /pose/{id}/elbow/L    [x, y, z]
  /pose/{id}/elbow/R    [x, y, z]
  /pose/{id}/shoulder/L [x, y, z]
  /pose/{id}/shoulder/R [x, y, z]
  /pose/{id}/nose       [x, y, z]
  /pose/count           [n]          ← número de personas activas

Uso:
  python hailo_pose_publisher.py --host 192.168.137.1 --port 12000 --input /dev/video0
"""

import argparse
import threading
import time
import os
import sys
from pathlib import Path

# ── Hailo / GStreamer setup ──────────────────────────────────────────────────
project_root = Path(__file__).resolve().parent.parent
env_file     = project_root / ".env"
os.environ["HAILO_ENV_FILE"] = str(env_file)

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib
import hailo
import numpy as np

from hailo_apps.hailo_app_python.core.common.buffer_utils import get_caps_from_pad, get_numpy_from_buffer
from hailo_apps.hailo_app_python.core.gstreamer.gstreamer_app import app_callback_class, GStreamerApp
from hailo_apps.hailo_app_python.apps.pose_estimation.pose_estimation_pipeline import GStreamerPoseEstimationApp
from hailo_apps.hailo_app_python.core.common.core import get_default_parser

from pythonosc.udp_client import SimpleUDPClient

# ── Rutas reales de post-processing en esta instalación ─────────────────────
# get_resource_path() resuelve a /usr/local/hailo/resources/so/ que no existe.
# El .so real está en el path de TAPPAS con nombre y función diferentes.
_CORRECT_SO = '/usr/lib/aarch64-linux-gnu/hailo/tappas/post_processes/libyolov8pose_post.so'
_CORRECT_FN = 'filter'


class _FixedPoseApp(GStreamerPoseEstimationApp):
    """Subclase que corrige las rutas del post-processor para esta instalación."""
    def get_pipeline_string(self):
        self.post_process_so       = _CORRECT_SO
        self.post_process_function = _CORRECT_FN
        return super().get_pipeline_string()

# ── COCO keypoints relevantes ────────────────────────────────────────────────
KP = {
    'nose':       0,
    'shoulder_l': 5,  'shoulder_r': 6,
    'elbow_l':    7,  'elbow_r':    8,
    'wrist_l':    9,  'wrist_r':   10,
    'hip_l':     11,  'hip_r':     12,
    'knee_l':    13,  'knee_r':    14,
    'ankle_l':   15,  'ankle_r':   16,
}

LANDMARK_TO_ADDRESS = {
    'wrist_l':    'wrist/L',    'wrist_r':    'wrist/R',
    'elbow_l':    'elbow/L',    'elbow_r':    'elbow/R',
    'shoulder_l': 'shoulder/L', 'shoulder_r': 'shoulder/R',
    'nose':       'nose',
    'hip_l':      'hip/L',      'hip_r':      'hip/R',
    'knee_l':     'knee/L',     'knee_r':     'knee/R',
    'ankle_l':    'ankle/L',    'ankle_r':    'ankle/R',
}

# ── Publisher OSC con suavizado por persona ──────────────────────────────────
class MultiPersonOscPublisher:
    def __init__(self, host: str, port: int, smoothing: float = 0.55):
        self.client   = SimpleUDPClient(host, port)
        self.alpha    = float(np.clip(smoothing, 0.0, 1.0))
        self._state   = {}          # {(person_id, name): (x,y,z)}
        self._lock    = threading.Lock()
        print(f"OSC → udp://{host}:{port}")

    def publish_frame(self, persons: dict):
        """persons: {person_id: {landmark_name: (x,y,z)}}"""
        with self._lock:
            for pid, landmarks in persons.items():
                for name, address_suffix in LANDMARK_TO_ADDRESS.items():
                    pt = landmarks.get(name)
                    if pt is None:
                        continue
                    pt = self._smooth((pid, name), pt)
                    addr = f'/pose/{pid}/{address_suffix}'
                    self.client.send_message(addr, list(pt))

                # Compatibilidad con sketch de persona 0 (dirección legacy)
                if pid == 0:
                    for name, address_suffix in LANDMARK_TO_ADDRESS.items():
                        pt = landmarks.get(name)
                        if pt is None:
                            continue
                        self.client.send_message(f'/pose/{address_suffix}', list(pt))

            self.client.send_message('/pose/count', len(persons))

    def _smooth(self, key, current):
        prev = self._state.get(key)
        if prev is None or self.alpha == 0.0:
            self._state[key] = current
            return current
        a = self.alpha
        s = (prev[0]*a + current[0]*(1-a),
             prev[1]*a + current[1]*(1-a),
             prev[2]*a + current[2]*(1-a))
        self._state[key] = s
        return s


# ── Callback de Hailo ─────────────────────────────────────────────────────────
class PoseCallbackData(app_callback_class):
    def __init__(self, publisher: MultiPersonOscPublisher):
        super().__init__()
        self.publisher = publisher


def _shoulder_width(lm: dict) -> float:
    sl = lm.get('shoulder_l')
    sr = lm.get('shoulder_r')
    if sl is None or sr is None:
        return 0.15
    return abs(sl[0] - sr[0])


def app_callback(pad, info, user_data: PoseCallbackData):
    buffer = info.get_buffer()
    if buffer is None:
        return Gst.PadProbeReturn.OK

    user_data.increment()
    format, width, height = get_caps_from_pad(pad)
    if width is None or height is None:
        return Gst.PadProbeReturn.OK

    roi        = hailo.get_roi_from_buffer(buffer)
    detections = roi.get_objects_typed(hailo.HAILO_DETECTION)

    persons = {}

    for detection in detections:
        if detection.get_label() != 'person':
            continue
        if detection.get_confidence() < 0.40:
            continue

        # Track ID (asignado por el tracker SORT en el pipeline)
        track_objs = detection.get_objects_typed(hailo.HAILO_UNIQUE_ID)
        pid = track_objs[0].get_id() % 4 if track_objs else 0   # IDs 0-3 (Hailo+CSI)

        bbox = detection.get_bbox()

        landmarks_objs = detection.get_objects_typed(hailo.HAILO_LANDMARKS)
        if not landmarks_objs:
            continue

        points = landmarks_objs[0].get_points()

        # Extraer keypoints relevantes → normalizar a [0,1] en imagen completa
        lm = {}
        for kp_name, kp_idx in KP.items():
            if kp_idx >= len(points):
                continue
            pt = points[kp_idx]
            # Los puntos de Hailo están relativos al bounding box
            x_norm = pt.x() * bbox.width()  + bbox.xmin()
            y_norm = pt.y() * bbox.height() + bbox.ymin()
            vis    = pt.confidence() if hasattr(pt, 'confidence') else 1.0
            if vis < 0.15:
                continue
            lm[kp_name] = (float(x_norm), float(y_norm), 0.0)

        if not lm:
            continue

        # Estimar profundidad Z desde ancho de hombros
        sw   = _shoulder_width(lm)
        z_est = float(np.clip(0.18 / max(sw, 0.01) * 0.4, 0.05, 0.90))
        lm = {k: (v[0], v[1], z_est) for k, v in lm.items()}

        persons[pid] = lm

    if persons:
        user_data.publisher.publish_frame(persons)

    return Gst.PadProbeReturn.OK


# ── CLI ───────────────────────────────────────────────────────────────────────
def parse_args():
    parser = get_default_parser()
    parser.add_argument('--host',      default='127.0.0.1',
                        help='IP destino OSC (default: 127.0.0.1)')
    parser.add_argument('--port',      type=int, default=12000,
                        help='Puerto UDP OSC (default: 12000)')
    parser.add_argument('--smoothing', type=float, default=0.55,
                        help='Suavizado exponencial 0-1 (default: 0.55)')
    return parser


def main():
    parser    = parse_args()
    args, _   = parser.parse_known_args()

    publisher = MultiPersonOscPublisher(args.host, args.port, args.smoothing)
    user_data = PoseCallbackData(publisher)

    print(f"Iniciando Hailo YOLOv8m-pose | cámara: {args.input}")
    print(f"Publicando OSC → udp://{args.host}:{args.port}")
    print("Ctrl+C para detener.\n")

    app = _FixedPoseApp(app_callback, user_data, parser)
    app.run()


if __name__ == '__main__':
    main()
