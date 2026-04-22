#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"
PYTHON_BIN="${PYTHON_BIN:-python3}"

log() {
  echo "[setup_jetson] $*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $1" >&2
    exit 1
  fi
}

log "Verificando comandos base"
require_command "${PYTHON_BIN}"
require_command "git"

log "Creando entorno virtual en ${VENV_DIR}"
"${PYTHON_BIN}" -m venv "${VENV_DIR}"

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

log "Actualizando herramientas base de Python"
python -m pip install --upgrade pip setuptools wheel

log "Instalando dependencias mínimas para Jetson"
pip install -r "${ROOT_DIR}/backend/requirements-jetson.txt"

log "Mostrando versión de DepthAI"
python - <<'PY'
import depthai as dai
print(f"DepthAI version: {dai.__version__}")
PY

log "Ejecutando prueba headless de la OAK-D durante 5 segundos"
python "${ROOT_DIR}/backend/camera_probe.py" --seconds 5 --width 640 --height 480 --fps 30

log "Instalación y prueba base completadas"
log "Para activar el entorno después: source .venv/bin/activate"
log "Para publicar pose por OSC: python backend/blazepose_publisher.py --mode depthai --host 127.0.0.1 --port 12000"
