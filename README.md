# Feria de Ciencias 2026

## ArtPose-Vision (OAK-D + Jetson Orin NX)

Sistema de arte generativo en tiempo real que usa detección de pose humana como un pincel digital sobre hardware Edge AI.

## Arquitectura

- **Capa de percepción**: OAK-D Lite ejecutando inferencia de pose en el dispositivo.
- **Capa de procesamiento**: Jetson Orin NX administrando DepthAI, normalización de coordenadas y transmisión de eventos.
- **Capa creativa**: p5.js renderizando visuales reactivos a partir de mensajes OSC.

## Estructura del repositorio

```text
Feria-de-Ciencias-2026/
├── setup_jetson.sh
├── backend/
│   ├── blazepose_publisher.py
│   ├── camera_probe.py
│   ├── camera_test.py
│   ├── requirements-jetson.txt
│   └── requirements.txt
└── frontend/
    ├── bridge/
    │   ├── package.json
    │   └── server.js
    └── p5/
        ├── index.html
        └── sketch.js
```

## Estado actual

Este repo queda preparado para:

- verificar la conexión OAK-D desde Jetson
- validar el canal OSC en `127.0.0.1:12000`
- probar visuales reactivas en p5.js con un emisor de pose simulado

La parte de inferencia específica de BlazePose en la VPU se deja desacoplada del transmisor OSC para que puedas conectar el modelo/exportador OpenVINO que decidas usar sin rehacer la arquitectura del sistema.

## Backend

### Jetson Orin NX

Flujo recomendado en Jetson:

```bash
chmod +x setup_jetson.sh
./setup_jetson.sh
```

Este script:

- crea `.venv`
- instala dependencias mínimas de `backend/requirements-jetson.txt`
- valida `DepthAI`
- ejecuta una prueba headless de la OAK-D con `backend/camera_probe.py`

Si quieres correr la prueba manualmente:

```bash
source .venv/bin/activate
python backend/camera_probe.py --seconds 10 --width 640 --height 480 --fps 30
```

### 1) Crear entorno

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r backend/requirements.txt
```

### 2) Verificar cámara OAK-D

```bash
python backend/camera_test.py
```

Esto abre una ventana con el stream RGB si la OAK-D Lite está conectada correctamente.

Para un entorno sin interfaz gráfica o por SSH:

```bash
python backend/camera_probe.py --seconds 10
```

Esto imprime `frames`, `avg_fps` y resolución detectada sin abrir ventanas.

### 3) Probar transmisor OSC

```bash
python backend/blazepose_publisher.py --mode mock --host 127.0.0.1 --port 12000
```

Para validar acceso real a la OAK-D desde Jetson:

```bash
python backend/blazepose_publisher.py --mode depthai --host 127.0.0.1 --port 12000
```

Mensajes emitidos:

- `/pose/wrist/L [x, y, z]`
- `/pose/wrist/R [x, y, z]`
- `/pose/elbow/L [x, y, z]`
- `/pose/elbow/R [x, y, z]`
- `/pose/shoulder/L [x, y, z]`
- `/pose/shoulder/R [x, y, z]`
- `/pose/nose [x, y, z]`

## Frontend

### 1) Instalar puente OSC -> WebSocket

```bash
npm install
node server.js
```

Ejecuta esto dentro de `frontend/bridge`.

El puente escucha OSC UDP en `12000` y publica eventos al navegador por WebSocket en `ws://127.0.0.1:8081`.

### 2) Abrir la pieza p5.js

Sirve `frontend/p5` con cualquier servidor estático y abre `index.html`.

Ejemplo:

```bash
python -m http.server 8080
```

Luego visita `http://127.0.0.1:8080/frontend/p5/` si lo ejecutas desde la raíz del repo, o sirve directamente esa carpeta.

## Flujo recomendado de validación

1. Conectar OAK-D Lite a la Jetson.
2. Ejecutar `python backend/camera_test.py`.
3. Ejecutar `node frontend/bridge/server.js`.
4. Ejecutar `python backend/blazepose_publisher.py --mode mock`.
5. Abrir `frontend/p5/index.html`.
6. Verificar que las estelas reaccionan al movimiento enviado por OSC.

## Siguiente integración real de pose

El siguiente paso es conectar el modelo de pose de DepthAI al publicador OSC. La interfaz esperada es un diccionario por persona con esta forma:

```json
{
  "id": 0,
  "landmarks": {
    "wrist_l": [x, y, z],
    "wrist_r": [x, y, z],
    "elbow_l": [x, y, z],
    "elbow_r": [x, y, z],
    "shoulder_l": [x, y, z],
    "shoulder_r": [x, y, z],
    "nose": [x, y, z]
  }
}
```

Puedes reemplazar el generador `mock_pose_frames()` por la salida del pipeline real sin tocar el frontend.

## GitHub

GitHub no permite espacios en el nombre técnico del repositorio. Para publicarlo, te recomiendo usar:

```text
Feria-de-Ciencias-2026
```

Y conservar `Feria de Ciencias 2026` como título del proyecto en el `README`.

## Próximos pasos sugeridos

- integrar BlazePose/OpenVINO directamente en la OAK-D Lite
- asignar color por `person_id`
- suavizar landmarks con filtro temporal adicional
- mapear `z` a grosor, opacidad y dispersión de partículas
- añadir soporte para múltiples personas
