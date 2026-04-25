# Feria de Ciencias 2026 — ArtPose Vision

Sistema de arte generativo en tiempo real: pose humana detectada por la OAK-D como pincel digital sobre un autómata celular 3D.

## Arquitectura

```
OAK-D (Myriad X)  →  inferencia pose (human-pose-estimation-0001)
        ↓
RPi 5 / Jetson    →  decodifica landmarks → OSC UDP
        ↓  :12000
Windows Node.js   →  bridge OSC → WebSocket :8081
        ↓
p5.js WebGL       →  autómata celular 3D reactivo a pose
```

## Estructura del repositorio

```
Feria-de-Ciencias-2026/
├── setup_jetson.sh
├── setup_rpi5.sh                        ← setup para Raspberry Pi 5
├── backend/
│   ├── blazepose_publisher.py           ← publisher mock / depthai básico
│   ├── blazepose_oak_rpi5.py            ← inferencia real Myriad X (RPi 5)
│   ├── camera_probe.py
│   ├── camera_test.py
│   ├── requirements.txt
│   ├── requirements-jetson.txt
│   └── requirements-rpi5.txt
└── frontend/
    ├── bridge/
    │   ├── package.json
    │   └── server.js                    ← bridge OSC UDP → WebSocket
    └── p5/
        ├── index.html
        └── sketch.js                    ← autómata celular 3D WebGL
```

---

## Raspberry Pi 5 + OAK-D (setup completo)

```bash
git clone https://github.com/JRavenelco/Feria-de-Ciencias-2026.git repo-feria
cd repo-feria
bash setup_rpi5.sh
```

El script configura udev, `usbfs_memory_mb` y el entorno virtual automáticamente.

### Arrancar inferencia real (Myriad X)

```bash
source .venv/bin/activate
python backend/blazepose_oak_rpi5.py --host <IP_WINDOWS> --port 12000
```

### Arrancar solo mock (sin cámara)

```bash
source .venv/bin/activate
python backend/blazepose_publisher.py --mode mock --host <IP_WINDOWS> --port 12000
```

---

## Windows — Frontend

Orden de arranque:

### 1. Bridge OSC → WebSocket

```powershell
cd frontend\bridge
npm install
node server.js
```

Debe mostrar:
```
OSC listening on 0.0.0.0:12000
WebSocket on ws://127.0.0.1:8081
```

### 2. Servidor p5.js

```powershell
npx --yes serve -l 3000 "C:\ruta\a\Feria-de-Ciencias-2026\frontend\p5"
```

Abre: **`http://localhost:3000`**

### 3. Firewall (solo la primera vez, como Administrador)

```powershell
netsh advfirewall firewall add rule name="OSC-ArtPose" dir=in action=allow protocol=UDP localport=12000
```

---

## Jetson Orin NX (setup original)

```bash
chmod +x setup_jetson.sh
./setup_jetson.sh
source .venv/bin/activate
python backend/blazepose_publisher.py --mode depthai --host <IP_WINDOWS> --port 12000
```

---

## Mensajes OSC publicados

| Dirección          | Valores   |
|--------------------|-----------|
| `/pose/wrist/L`    | `[x,y,z]` |
| `/pose/wrist/R`    | `[x,y,z]` |
| `/pose/elbow/L`    | `[x,y,z]` |
| `/pose/elbow/R`    | `[x,y,z]` |
| `/pose/shoulder/L` | `[x,y,z]` |
| `/pose/shoulder/R` | `[x,y,z]` |
| `/pose/nose`       | `[x,y,z]` |

Coordenadas normalizadas 0–1. `z` = estimación de profundidad.

---

## Controles del sketch 3D

| Control | Acción |
|---------|--------|
| Arrastrar | Rotar escena |
| Scroll | Zoom |
| `R` | Reiniciar autómata |
| `T` | Sembrar células aleatorias |

Las muñecas siembran células en el volumen 3D: izquierda = cyan, derecha = magenta.
