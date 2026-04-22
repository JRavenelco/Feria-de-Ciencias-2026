import argparse
import math
import time
from typing import Dict, Iterable, Optional, Tuple

try:
    import depthai as dai
except ImportError:
    dai = None

from pythonosc.udp_client import SimpleUDPClient

Point3D = Tuple[float, float, float]
PoseFrame = Dict[str, object]


LANDMARK_TO_ADDRESS = {
    "wrist_l": "/pose/wrist/L",
    "wrist_r": "/pose/wrist/R",
    "elbow_l": "/pose/elbow/L",
    "elbow_r": "/pose/elbow/R",
    "shoulder_l": "/pose/shoulder/L",
    "shoulder_r": "/pose/shoulder/R",
    "nose": "/pose/nose",
}


class OscPosePublisher:
    def __init__(self, host: str, port: int, smoothing: float) -> None:
        self.client = SimpleUDPClient(host, port)
        self.smoothing = max(0.0, min(1.0, smoothing))
        self.state: Dict[Tuple[int, str], Point3D] = {}

    def publish(self, pose_frame: PoseFrame) -> None:
        person_id = int(pose_frame.get("id", 0))
        landmarks = pose_frame.get("landmarks", {})
        if not isinstance(landmarks, dict):
            return

        for landmark_name, address in LANDMARK_TO_ADDRESS.items():
            value = landmarks.get(landmark_name)
            if not self._is_point3d(value):
                continue

            point = self._smooth(person_id, landmark_name, value)
            self.client.send_message(address, list(point))
            self.client.send_message(f"{address}/id", person_id)

        self.client.send_message("/pose/person/id", person_id)

    def _smooth(self, person_id: int, landmark_name: str, current: Point3D) -> Point3D:
        key = (person_id, landmark_name)
        previous = self.state.get(key)
        if previous is None or self.smoothing == 0.0:
            self.state[key] = current
            return current

        alpha = self.smoothing
        smoothed = (
            previous[0] * alpha + current[0] * (1.0 - alpha),
            previous[1] * alpha + current[1] * (1.0 - alpha),
            previous[2] * alpha + current[2] * (1.0 - alpha),
        )
        self.state[key] = smoothed
        return smoothed

    @staticmethod
    def _is_point3d(value: object) -> bool:
        if not isinstance(value, (list, tuple)) or len(value) != 3:
            return False
        return all(isinstance(item, (int, float)) for item in value)


def mock_pose_frames() -> Iterable[PoseFrame]:
    t = 0.0
    while True:
        wrist_l = (
            0.32 + 0.12 * math.sin(t * 1.6),
            0.55 + 0.18 * math.cos(t * 1.2),
            0.40 + 0.25 * math.sin(t * 0.9),
        )
        wrist_r = (
            0.68 + 0.12 * math.sin(t * 1.4 + 1.2),
            0.52 + 0.16 * math.cos(t * 1.3 + 0.7),
            0.45 + 0.22 * math.cos(t * 1.0),
        )
        elbow_l = (
            0.38 + 0.08 * math.sin(t * 1.2),
            0.44 + 0.10 * math.cos(t * 1.1),
            0.35 + 0.12 * math.sin(t * 0.7),
        )
        elbow_r = (
            0.62 + 0.08 * math.sin(t * 1.1 + 1.3),
            0.43 + 0.10 * math.cos(t * 1.0 + 0.3),
            0.34 + 0.12 * math.cos(t * 0.8),
        )
        shoulder_l = (0.43, 0.32, 0.25)
        shoulder_r = (0.57, 0.32, 0.25)
        nose = (0.50 + 0.03 * math.sin(t * 0.8), 0.22, 0.12)

        yield {
            "id": 0,
            "landmarks": {
                "wrist_l": wrist_l,
                "wrist_r": wrist_r,
                "elbow_l": elbow_l,
                "elbow_r": elbow_r,
                "shoulder_l": shoulder_l,
                "shoulder_r": shoulder_r,
                "nose": nose,
            },
        }
        t += 0.05


def create_rgb_pipeline() -> dai.Pipeline:
    if dai is None:
        raise RuntimeError("DepthAI no está instalado en este entorno.")

    pipeline = dai.Pipeline()

    camera = pipeline.create(dai.node.ColorCamera)
    camera.setPreviewSize(640, 480)
    camera.setInterleaved(False)
    camera.setColorOrder(dai.ColorCameraProperties.ColorOrder.BGR)
    camera.setFps(30)

    xout_rgb = pipeline.create(dai.node.XLinkOut)
    xout_rgb.setStreamName("rgb")
    camera.preview.link(xout_rgb.input)

    return pipeline


def depthai_pose_frames() -> Iterable[PoseFrame]:
    if dai is None:
        raise RuntimeError("DepthAI no está instalado en este entorno.")

    devices = dai.Device.getAllAvailableDevices()
    if not devices:
        raise RuntimeError("No se detectó ninguna cámara OAK-D para el modo depthai.")

    pipeline = create_rgb_pipeline()
    with dai.Device(pipeline) as device:
        device_info = device.getDeviceInfo()
        print(f"OAK-D conectada: {device_info.getMxId()}")
        queue = device.getOutputQueue(name="rgb", maxSize=4, blocking=False)

        while True:
            packet = queue.get()
            frame = packet.getCvFrame()
            height, width = frame.shape[:2]
            timestamp = time.time()
            phase = timestamp * 1.75

            wrist_l = (
                0.30 + 0.08 * math.sin(phase),
                0.55 + 0.10 * math.cos(phase * 1.2),
                0.35 + 0.08 * math.sin(phase * 0.9),
            )
            wrist_r = (
                0.70 + 0.08 * math.sin(phase + 1.3),
                0.55 + 0.10 * math.cos(phase * 1.1 + 0.4),
                0.35 + 0.08 * math.cos(phase * 0.8),
            )
            shoulder_l = (0.42, 0.34, 0.22)
            shoulder_r = (0.58, 0.34, 0.22)
            elbow_l = ((wrist_l[0] + shoulder_l[0]) / 2.0, (wrist_l[1] + shoulder_l[1]) / 2.0, 0.28)
            elbow_r = ((wrist_r[0] + shoulder_r[0]) / 2.0, (wrist_r[1] + shoulder_r[1]) / 2.0, 0.28)
            nose = (0.50, 0.24, 0.12)

            yield {
                "id": 0,
                "source": "depthai_rgb_base",
                "frame_size": [width, height],
                "landmarks": {
                    "wrist_l": wrist_l,
                    "wrist_r": wrist_r,
                    "elbow_l": elbow_l,
                    "elbow_r": elbow_r,
                    "shoulder_l": shoulder_l,
                    "shoulder_r": shoulder_r,
                    "nose": nose,
                },
            }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=12000)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--smoothing", type=float, default=0.75)
    parser.add_argument("--mode", choices=["mock", "depthai"], default="mock")
    parser.add_argument("--allow-fallback", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    publisher = OscPosePublisher(args.host, args.port, args.smoothing)
    frame_interval = 1.0 / max(args.fps, 1.0)

    print(f"Publicando pose OSC en udp://{args.host}:{args.port}")
    print(f"Modo: {args.mode}")

    source: Optional[Iterable[PoseFrame]] = None

    if args.mode == "depthai":
        try:
            source = depthai_pose_frames()
        except Exception as error:
            print(f"No fue posible iniciar DepthAI: {error}")
            if not args.allow_fallback:
                return 1
            print("Activando fallback a modo mock.")

    if source is None:
        source = mock_pose_frames()

    try:
        for frame in source:
            start = time.perf_counter()
            publisher.publish(frame)
            elapsed = time.perf_counter() - start
            delay = frame_interval - elapsed
            if delay > 0:
                time.sleep(delay)
    except KeyboardInterrupt:
        print("Publicación detenida.")
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
