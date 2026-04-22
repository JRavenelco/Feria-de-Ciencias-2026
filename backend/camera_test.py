import sys
import time

import cv2
import depthai as dai


def main() -> int:
    devices = dai.Device.getAllAvailableDevices()
    if not devices:
        print("No se detectó ninguna cámara OAK-D.")
        return 1

    print(f"Dispositivos detectados: {len(devices)}")
    for index, device in enumerate(devices, start=1):
        print(f"[{index}] {device.getMxId()} {device.protocol}")

    pipeline = dai.Pipeline()

    camera = pipeline.create(dai.node.ColorCamera)
    camera.setPreviewSize(640, 480)
    camera.setInterleaved(False)
    camera.setColorOrder(dai.ColorCameraProperties.ColorOrder.BGR)
    camera.setFps(30)

    xout_rgb = pipeline.create(dai.node.XLinkOut)
    xout_rgb.setStreamName("rgb")
    camera.preview.link(xout_rgb.input)

    with dai.Device(pipeline) as device:
        queue = device.getOutputQueue(name="rgb", maxSize=4, blocking=False)
        print("Streaming RGB iniciado. Presiona q para salir.")
        last_time = time.time()
        frames = 0

        while True:
            packet = queue.get()
            frame = packet.getCvFrame()
            frames += 1

            now = time.time()
            elapsed = now - last_time
            if elapsed >= 1.0:
                fps = frames / elapsed
                frames = 0
                last_time = now
                cv2.setWindowTitle("OAK-D RGB Test", f"OAK-D RGB Test - {fps:.2f} FPS")

            cv2.imshow("OAK-D RGB Test", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

    cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
