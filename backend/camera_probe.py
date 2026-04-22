import argparse
import time

import depthai as dai


def create_pipeline(width: int, height: int, fps: float) -> dai.Pipeline:
    pipeline = dai.Pipeline()

    camera = pipeline.create(dai.node.ColorCamera)
    camera.setPreviewSize(width, height)
    camera.setInterleaved(False)
    camera.setColorOrder(dai.ColorCameraProperties.ColorOrder.BGR)
    camera.setFps(fps)

    xout_rgb = pipeline.create(dai.node.XLinkOut)
    xout_rgb.setStreamName("rgb")
    camera.preview.link(xout_rgb.input)

    return pipeline


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--fps", type=float, default=30.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    devices = dai.Device.getAllAvailableDevices()
    if not devices:
        print("No se detectó ninguna cámara OAK-D.")
        return 1

    print(f"Dispositivos detectados: {len(devices)}")
    for index, device in enumerate(devices, start=1):
        print(f"[{index}] mxid={device.getMxId()} protocol={device.protocol}")

    pipeline = create_pipeline(args.width, args.height, args.fps)

    with dai.Device(pipeline) as device:
        info = device.getDeviceInfo()
        print(f"Conectado a OAK-D mxid={info.getMxId()}")
        queue = device.getOutputQueue(name="rgb", maxSize=4, blocking=False)

        start_time = time.perf_counter()
        report_time = start_time
        frames = 0

        while True:
            packet = queue.get()
            frame = packet.getCvFrame()
            frames += 1

            now = time.perf_counter()
            if now - report_time >= 1.0:
                elapsed = now - start_time
                fps = frames / elapsed if elapsed > 0 else 0.0
                print(
                    f"elapsed={elapsed:.2f}s frames={frames} avg_fps={fps:.2f} shape={frame.shape}"
                )
                report_time = now

            if now - start_time >= args.seconds:
                break

    total_elapsed = time.perf_counter() - start_time
    avg_fps = frames / total_elapsed if total_elapsed > 0 else 0.0
    print(f"Prueba completada: frames={frames} tiempo={total_elapsed:.2f}s avg_fps={avg_fps:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
