#!/usr/bin/env bash
# setup_rpi5.sh — Entorno para Raspberry Pi 5 + cámara OAK
# Requiere: Raspberry Pi OS Bookworm 64-bit
set -euo pipefail

PYTHON_BIN="${PYTHON_BIN:-python3}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[rpi5-setup] $*"; }

# ── 1. Verificar dependencias del sistema ────────────────────────────────────
for cmd in "$PYTHON_BIN" git; do
    command -v "$cmd" &>/dev/null || { log "ERROR: '$cmd' no encontrado."; exit 1; }
done

# ── 2. USB memory limit — crítico para OAK en USB 3.0 de RPi 5 ──────────────
USB_MEM_FILE="/sys/module/usbcore/parameters/usbfs_memory_mb"
if [[ -f "$USB_MEM_FILE" ]]; then
    CURRENT=$(cat "$USB_MEM_FILE")
    if [[ "$CURRENT" -lt 512 ]]; then
        log "Ajustando usbfs_memory_mb: $CURRENT → 1024"
        echo 1024 | sudo tee "$USB_MEM_FILE" > /dev/null
    else
        log "usbfs_memory_mb ya es suficiente: $CURRENT MB"
    fi
else
    log "ADVERTENCIA: $USB_MEM_FILE no encontrado — carga usbcore o actualiza el kernel."
fi

# Persistir el límite en /etc/rc.local si aún no está configurado
RC_LOCAL="/etc/rc.local"
RC_LINE="echo 1024 > /sys/module/usbcore/parameters/usbfs_memory_mb"
if [[ -f "$RC_LOCAL" ]] && ! grep -qF "$RC_LINE" "$RC_LOCAL"; then
    log "Añadiendo límite USB persistente a /etc/rc.local..."
    sudo sed -i "s|^exit 0|$RC_LINE\nexit 0|" "$RC_LOCAL"
fi

# ── 3. Regla udev para OAK (Myriad X, vendor 03e7) ──────────────────────────
UDEV_FILE="/etc/udev/rules.d/80-movidius.rules"
if [[ ! -f "$UDEV_FILE" ]]; then
    log "Instalando regla udev para OAK..."
    sudo tee "$UDEV_FILE" > /dev/null <<'EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="03e7", MODE="0666"
EOF
    sudo udevadm control --reload-rules
    sudo udevadm trigger
    log "Regla udev instalada en $UDEV_FILE"
else
    log "Regla udev para OAK ya existe."
fi

# ── 4. Entorno virtual Python ────────────────────────────────────────────────
VENV_DIR="$SCRIPT_DIR/.venv"
if [[ ! -d "$VENV_DIR" ]]; then
    log "Creando entorno virtual en $VENV_DIR..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

log "Actualizando pip, setuptools y wheel..."
pip install --quiet --upgrade pip setuptools wheel

log "Instalando dependencias para RPi 5..."
pip install --quiet -r "$SCRIPT_DIR/backend/requirements-rpi5.txt"

# ── 5. Verificar DepthAI ─────────────────────────────────────────────────────
log "Verificando DepthAI..."
python - <<'PYEOF'
import depthai
import blobconverter
import numpy
print(f"  depthai      {depthai.__version__}")
print(f"  blobconverter {blobconverter.__version__}")
print(f"  numpy        {numpy.__version__}")
PYEOF

# ── 6. Probe de cámara OAK ───────────────────────────────────────────────────
if python -c "import depthai; devs = depthai.Device.getAllAvailableDevices(); exit(0 if devs else 1)" 2>/dev/null; then
    log "OAK detectada — ejecutando probe de 5 s..."
    python "$SCRIPT_DIR/backend/camera_probe.py" --seconds 5
else
    log "ADVERTENCIA: Ninguna OAK detectada. Conecta la cámara y vuelve a ejecutar."
fi

log ""
log "╔══════════════════════════════════════════════════════╗"
log "║         Instalación RPi 5 completada                 ║"
log "╠══════════════════════════════════════════════════════╣"
log "║  Inferencia real OAK (Myriad X):                     ║"
log "║    source .venv/bin/activate                         ║"
log "║    python backend/blazepose_oak_rpi5.py              ║"
log "║                                                      ║"
log "║  Solo mock (sin cámara):                             ║"
log "║    python backend/blazepose_publisher.py --mode mock ║"
log "║                                                      ║"
log "║  Puente OSC→WS (para p5.js):                         ║"
log "║    node frontend/bridge/server.js                    ║"
log "╚══════════════════════════════════════════════════════╝"
