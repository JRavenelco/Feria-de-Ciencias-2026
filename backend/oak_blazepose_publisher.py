#!/usr/bin/env python3
"""
oak_blazepose_publisher.py — Publisher OSC sobre BlazePose (OAK-D, Myriad X).

Usa la implementación de geaxgx/depthai_blazepose. La inferencia entera
corre en el chip de la cámara (Edge mode opcional). Aquí solo recibimos
los landmarks ya decodificados y suavizados, los normalizamos a [0,1] y
los publicamos por OSC con el mismo formato que usa Hailo/CSI:

  /pose/{id}/nose         [x, y, z]
  /pose/{id}/shoulder/L   [x, y, z]
  /pose/{id}/shoulder/R   [x, y, z]
  /pose/{id}/elbow/L      [x, y, z]
  /pose/{id}/elbow/R      [x, y, z]
  /pose/{id}/wrist/L      [x, y, z]
  /pose/{id}/wrist/R      [x, y, z]
  /pose/{id}/hip/L        [x, y, z]
  /pose/{id}/hip/R        [x, y, z]
  /pose/{id}/knee/L       [x, y, z]
  /pose/{id}/knee/R       [x, y, z]
  /pose/{id}/ankle/L      [x, y, z]
  /pose/{id}/ankle/R      [x, y, z]
  /pose/count             [n]

Coords:
  x, y ∈ [0, 1] (normalizados respecto al frame de la OAK)
  z    ∈ [0, 1] (heurística por shoulder-width; o real si --xyz)

Uso:
  /home/maker/repo-feria/.venv/bin/python backend/oak_blazepose_publisher.py \\
      --host 192.168.137.1 --port 12000 --person-id 4
"""
import argparse
import sys
import time
from pathlib import Path

import numpy as np

# Repo de geaxgx
BLAZEPOSE_DIR = Path("/home/maker/depthai_blazepose")
sys.path.insert(0, str(BLAZEPOSE_DIR))

from BlazeposeDepthai import BlazeposeDepthai          # noqa: E402
from mediapipe_utils import KEYPOINT_DICT              # noqa: E402

from pythonosc.udp_client import SimpleUDPClient

# ── Mapeo BlazePose → topics OSC ─────────────────────────────────────────────
LANDMARK_MAP = {
    "nose":           ("nose",       0),
    "left_shoulder":  ("shoulder/L", 11),
    "right_shoulder": ("shoulder/R", 12),
    "left_elbow":     ("elbow/L",    13),
    "right_elbow":    ("elbow/R",    14),
    "left_wrist":     ("wrist/L",    15),
    "right_wrist":    ("wrist/R",    16),
    "left_hip":       ("hip/L",      23),
    "right_hip":      ("hip/R",      24),
    "left_knee":      ("knee/L",     25),
    "right_knee":     ("knee/R",     26),
    "left_ankle":     ("ankle/L",    27),
    "right_ankle":    ("ankle/R",    28),
}


def parse_args():
    p = argparse.ArgumentParser(description="OAK BlazePose → OSC publisher")
    p.add_argument("--host",      default="127.0.0.1")
    p.add_argument("--port",      type=int, default=12000)
    p.add_argument("--person-id", type=int, default=4,
                   help="ID OSC asignado a la OAK (default 4; Hailo usa 0-3)")
    p.add_argument("--lm-model",  default="full",
                   choices=["full", "lite", "heavy"])
    p.add_argument("--edge",      action="store_true",
                   help="Edge mode: postprocesado en el dispositivo (más FPS)")
    p.add_argument("--xyz",       action="store_true",
                   help="Profundidad real desde stereo (requiere OAK-D)")
    p.add_argument("--frame-h",   type=int, default=640,
                   help="Altura de frame interna (default 640)")
    p.add_argument("--no-smoothing", action="store_true")
    p.add_argument("--presence",  type=float, default=0.5,
                   help="Umbral de presencia por keypoint (default 0.5)")
    p.add_argument("--report-every", type=int, default=60,
                   help="Imprimir stats cada N frames (default 60)")
    return p.parse_args()


def estimate_z_from_shoulders(lm_xy_norm: dict) -> float:
    """Profundidad heurística: ancho de hombros normalizado → z [0,1]."""
    sl = lm_xy_norm.get("shoulder/L")
    sr = lm_xy_norm.get("shoulder/R")
    if sl is None or sr is None:
        return 0.5
    sw = abs(sl[0] - sr[0])
    if sw < 0.01:
        return 0.5
    # Ancho ~0.18 ⇒ ~1m. Más ancho → más cerca → z menor.
    return float(np.clip(0.18 / sw * 0.4, 0.05, 0.95))


def main() -> int:
    args = parse_args()

    # Importar Edge si se pidió (sobreescribe BlazeposeDepthai)
    if args.edge:
        from BlazeposeDepthaiEdge import BlazeposeDepthai as Tracker
    else:
        Tracker = BlazeposeDepthai

    print("─── OAK BlazePose · publisher OSC ───")
    print(f"  destino       : udp://{args.host}:{args.port}")
    print(f"  person-id     : {args.person_id}")
    print(f"  modelo        : {args.lm_model}  (edge={args.edge}, xyz={args.xyz})")
    print(f"  presencia min : {args.presence}")
    print()

    tracker = Tracker(
        input_src="rgb_laconic",
        lm_model=args.lm_model,
        smoothing=not args.no_smoothing,
        xyz=args.xyz,
        crop=False,
        internal_frame_height=args.frame_h,
        stats=False,
        trace=False,
    )

    img_w, img_h = tracker.img_w, tracker.img_h
    print(f"  frame OAK     : {img_w}x{img_h}\n")

    client = SimpleUDPClient(args.host, args.port)

    n_frames = 0
    n_published = 0
    t_last = time.perf_counter()

    try:
        while True:
            frame, body = tracker.next_frame()
            if frame is None:
                print("[fin] tracker terminó")
                break
            n_frames += 1

            if body is not None and hasattr(body, "landmarks") and body.landmarks is not None:
                # body.landmarks shape (N, 3) en pixeles del frame original
                lms_px = body.landmarks
                presence = getattr(body, "presence", None)

                # Primera pasada: x,y normalizados
                xy_norm: dict = {}
                for _, (suffix, idx) in LANDMARK_MAP.items():
                    if idx >= len(lms_px):
                        continue
                    if presence is not None and presence[idx] < args.presence:
                        continue
                    px, py = lms_px[idx, 0], lms_px[idx, 1]
                    x_n = float(np.clip(px / img_w, 0.0, 1.0))
                    y_n = float(np.clip(py / img_h, 0.0, 1.0))
                    xy_norm[suffix] = (x_n, y_n)

                # Z: si tenemos --xyz usamos profundidad real escalada;
                # sino estimamos por shoulder-width.
                if args.xyz and getattr(body, "xyz", None) is not None:
                    # body.xyz en mm (cámara). Mapear ~ [0.4m, 4m] → [0.05, 0.95]
                    z_mm = body.xyz[2]
                    z_est = float(np.clip((z_mm - 400) / (4000 - 400), 0.05, 0.95))
                else:
                    z_est = estimate_z_from_shoulders(xy_norm)

                # Publicar
                pid = args.person_id
                for _, (suffix, idx) in LANDMARK_MAP.items():
                    pt = xy_norm.get(suffix)
                    if pt is None:
                        continue
                    client.send_message(f"/pose/{pid}/{suffix}",
                                        [pt[0], pt[1], z_est])

                client.send_message("/pose/count", 1)
                n_published += 1
            else:
                client.send_message("/pose/count", 0)

            # Stats periódicos
            if (n_frames % args.report_every) == 0:
                now = time.perf_counter()
                fps = args.report_every / max(now - t_last, 1e-3)
                t_last = now
                pct = (100.0 * n_published / n_frames) if n_frames else 0.0
                lm_score = getattr(body, "lm_score", None) if body else None
                lm_s = f"{lm_score:.2f}" if lm_score is not None else " --"
                n_kp = len([1 for _, (sfx, idx) in LANDMARK_MAP.items()
                            if body is not None
                            and hasattr(body, "presence")
                            and body.presence is not None
                            and idx < len(body.presence)
                            and body.presence[idx] >= args.presence])
                print(f"frame {n_frames:5d} | {fps:5.1f} fps | "
                      f"detect {pct:5.1f}% | lm={lm_s} | "
                      f"kp_publicados={n_kp}/{len(LANDMARK_MAP)}")

    except KeyboardInterrupt:
        print("\n[interrumpido]")
    finally:
        tracker.exit()
        print(f"\nFrames totales: {n_frames}, con persona: {n_published}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
