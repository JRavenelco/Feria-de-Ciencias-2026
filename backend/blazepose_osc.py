#!/usr/bin/env python3
"""
blazepose_osc.py — BlazePose (depthai_blazepose) → OSC publisher.

Corre inferencia completa de BlazePose en el chip Myriad X de la OAK-D
y publica los keypoints por OSC con el mismo esquema que hailo_pose_publisher:

  /pose/{id}/nose        [x, y, z]
  /pose/{id}/shoulder/L  [x, y, z]
  /pose/{id}/shoulder/R  [x, y, z]
  /pose/{id}/elbow/L     [x, y, z]
  /pose/{id}/elbow/R     [x, y, z]
  /pose/{id}/wrist/L     [x, y, z]
  /pose/{id}/wrist/R     [x, y, z]
  /pose/{id}/hip/L       [x, y, z]
  /pose/{id}/hip/R       [x, y, z]
  /pose/{id}/knee/L      [x, y, z]
  /pose/{id}/knee/R      [x, y, z]
  /pose/{id}/ankle/L     [x, y, z]
  /pose/{id}/ankle/R     [x, y, z]
  /pose/count            [n]

Uso:
  python blazepose_osc.py --host 192.168.137.1 --port 12000 --id 4
"""

import sys
import os
import argparse
import time

# Añadir depthai_blazepose al path
BLAZEPOSE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'depthai_blazepose')
BLAZEPOSE_DIR = os.path.abspath(BLAZEPOSE_DIR)
if not os.path.isdir(BLAZEPOSE_DIR):
    BLAZEPOSE_DIR = os.path.expanduser('~/depthai_blazepose')
if not os.path.isdir(BLAZEPOSE_DIR):
    sys.exit(f'No encontré depthai_blazepose en {BLAZEPOSE_DIR}')
sys.path.insert(0, BLAZEPOSE_DIR)

from BlazeposeDepthaiEdge import BlazeposeDepthaiEdge
import mediapipe_utils as mpu
from pythonosc.udp_client import SimpleUDPClient
import numpy as np

# Mapeo BlazePose → dirección OSC del sketch
KP_MAP = {
    'nose':          ('nose',       mpu.KEYPOINT_DICT['nose']),
    'shoulder/L':    ('shoulder/L', mpu.KEYPOINT_DICT['left_shoulder']),
    'shoulder/R':    ('shoulder/R', mpu.KEYPOINT_DICT['right_shoulder']),
    'elbow/L':       ('elbow/L',    mpu.KEYPOINT_DICT['left_elbow']),
    'elbow/R':       ('elbow/R',    mpu.KEYPOINT_DICT['right_elbow']),
    'wrist/L':       ('wrist/L',    mpu.KEYPOINT_DICT['left_wrist']),
    'wrist/R':       ('wrist/R',    mpu.KEYPOINT_DICT['right_wrist']),
    'hip/L':         ('hip/L',      mpu.KEYPOINT_DICT['left_hip']),
    'hip/R':         ('hip/R',      mpu.KEYPOINT_DICT['right_hip']),
    'knee/L':        ('knee/L',     mpu.KEYPOINT_DICT['left_knee']),
    'knee/R':        ('knee/R',     mpu.KEYPOINT_DICT['right_knee']),
    'ankle/L':       ('ankle/L',    mpu.KEYPOINT_DICT['left_ankle']),
    'ankle/R':       ('ankle/R',    mpu.KEYPOINT_DICT['right_ankle']),
}


def shoulder_width(lm):
    sl = lm.get('shoulder/L')
    sr = lm.get('shoulder/R')
    if sl is None or sr is None:
        return 0.15
    return abs(sl[0] - sr[0])


def parse_args():
    p = argparse.ArgumentParser(description='BlazePose OAK-D → OSC publisher')
    p.add_argument('--host',      default='192.168.137.1',
                   help='IP destino OSC (default: 192.168.137.1)')
    p.add_argument('--port',      type=int, default=12000,
                   help='Puerto UDP OSC (default: 12000)')
    p.add_argument('--id',        type=int, default=4,
                   help='Person-ID asignado a la OAK (default: 4, Hailo usa 0-3)')
    p.add_argument('--smoothing', type=float, default=0.6,
                   help='Suavizado exponencial 0-1 (default: 0.6)')
    p.add_argument('--fps',       type=int, default=25,
                   help='FPS internos de la cámara (default: 25)')
    p.add_argument('--height',    type=int, default=640,
                   help='Alto del frame interno (default: 640)')
    return p.parse_args()


def main():
    args = parse_args()
    client = SimpleUDPClient(args.host, args.port)
    alpha  = float(np.clip(args.smoothing, 0.0, 1.0))
    state  = {}  # parte → (x,y,z) suavizado

    def smooth(key, cur):
        prev = state.get(key)
        if prev is None or alpha == 0:
            state[key] = cur
            return cur
        s = (prev[0]*alpha + cur[0]*(1-alpha),
             prev[1]*alpha + cur[1]*(1-alpha),
             prev[2]*alpha + cur[2]*(1-alpha))
        state[key] = s
        return s

    print(f'Iniciando BlazePose en OAK-D | person-id={args.id}')
    print(f'Publicando OSC → udp://{args.host}:{args.port}')
    print('Ctrl+C para detener.\n')

    tracker = BlazeposeDepthaiEdge(
        input_src='rgb',
        smoothing=True,
        internal_fps=args.fps,
        internal_frame_height=args.height,
        stats=False,
        trace=False,
    )

    img_w = tracker.img_w
    img_h = tracker.img_h
    print(f'Resolución del frame: {img_w}×{img_h}')

    frame_count = 0
    try:
        while True:
            frame, body = tracker.next_frame()
            if frame is None:
                break

            frame_count += 1

            if body is None:
                client.send_message('/pose/count', 0)
                if frame_count % 60 == 0:
                    print(f'frame {frame_count:>5d} | sin persona', flush=True)
                continue

            # Extraer y normalizar keypoints
            lm = {}
            for addr_suffix, (_, idx) in KP_MAP.items():
                if idx >= len(body.landmarks):
                    continue
                pt = body.landmarks[idx]   # [x_px, y_px, z_px]
                x_norm = float(np.clip(pt[0] / img_w, 0.0, 1.0))
                y_norm = float(np.clip(pt[1] / img_h, 0.0, 1.0))
                lm[addr_suffix] = (x_norm, y_norm, 0.0)

            # Estimar profundidad Z desde ancho de hombros
            sw    = shoulder_width(lm)
            z_est = float(np.clip(0.18 / max(sw, 0.01) * 0.4, 0.05, 0.90))
            lm    = {k: (v[0], v[1], z_est) for k, v in lm.items()}

            pid = args.id
            for addr_suffix, pt in lm.items():
                pt = smooth(addr_suffix, pt)
                client.send_message(f'/pose/{pid}/{addr_suffix}', list(pt))

            client.send_message('/pose/count', 1)

            if frame_count % 60 == 0:
                sample = {k: f'({v[0]:.2f},{v[1]:.2f})' for k, v in list(lm.items())[:4]}
                print(f'frame {frame_count:>5d} | kp={len(lm)}/13  {sample}', flush=True)

    except KeyboardInterrupt:
        print('\nDetenido.')
    finally:
        tracker.exit()

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
