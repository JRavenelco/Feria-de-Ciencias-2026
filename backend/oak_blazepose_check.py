#!/usr/bin/env python3
"""
oak_blazepose_check.py — Validación headless de BlazePose en la OAK.

Usa la implementación de geaxgx/depthai_blazepose (33 KP, tracking real,
suavizado One-Euro). NO abre ventana — corre en `rgb_laconic` para no
depender de DISPLAY. Imprime, cada N frames:

  - FPS
  - pd_score (detección de persona)
  - lm_score (landmark global)
  - cuántos keypoints superan threshold de presencia
  - posición xyz del mid-hip (si --xyz)

Ejecutar:
  cd /home/maker/repo-feria
  /home/maker/repo-feria/.venv/bin/python backend/oak_blazepose_check.py
"""
import sys
import time
from pathlib import Path

# Agregar el repo de geaxgx al path
BLAZEPOSE_DIR = Path("/home/maker/depthai_blazepose")
sys.path.insert(0, str(BLAZEPOSE_DIR))

from BlazeposeDepthai import BlazeposeDepthai  # noqa: E402
from mediapipe_utils import KEYPOINT_DICT       # noqa: E402

REPORT_EVERY = 30   # frames

def main():
    print("─── OAK BlazePose · validación headless ───")
    print(f"  modelo landmark : full")
    print(f"  input           : rgb_laconic (sin host frames)")
    print(f"  smoothing       : on\n")

    tracker = BlazeposeDepthai(
        input_src="rgb_laconic",
        lm_model="full",
        smoothing=True,
        xyz=False,            # poner True si quieres profundidad real
        crop=False,
        internal_frame_height=640,
        stats=False,
        trace=False,
    )

    n_frames = 0
    t0 = time.perf_counter()
    last_report = t0

    try:
        while True:
            frame, body = tracker.next_frame()
            if frame is None:
                print("[fin] tracker no devolvió frame")
                break
            n_frames += 1

            if (n_frames % REPORT_EVERY) == 0:
                now = time.perf_counter()
                fps = REPORT_EVERY / max(now - last_report, 1e-3)
                last_report = now

                if body is None:
                    print(f"frame {n_frames:5d} | {fps:5.1f} fps | sin persona detectada")
                    continue

                # Contar landmarks confiables
                n_kp_visible = 0
                if hasattr(body, "norm_landmarks") and body.norm_landmarks is not None:
                    nl = body.norm_landmarks
                    # presencia ≈ landmarks[:,3] (confianza por punto)
                    if nl.shape[1] >= 4:
                        vis = nl[:, 3]
                        n_kp_visible = int((vis > 0.5).sum())
                    else:
                        n_kp_visible = nl.shape[0]

                pd = getattr(body, "pd_score", None)
                lm = getattr(body, "lm_score", None)
                pd_s = f"{pd:.2f}" if pd is not None else " --"
                lm_s = f"{lm:.2f}" if lm is not None else " --"
                print(f"frame {n_frames:5d} | {fps:5.1f} fps | "
                      f"pd={pd_s} lm={lm_s} | "
                      f"kp_visibles={n_kp_visible}/33")
    except KeyboardInterrupt:
        print("\n[interrumpido]")
    finally:
        elapsed = time.perf_counter() - t0
        print(f"\nTotal frames: {n_frames}  ({n_frames/max(elapsed,1):.1f} fps medios)")
        tracker.exit()

if __name__ == "__main__":
    sys.exit(main())
