// ─── ArtPose-Vision · Morfogénesis Digital ──────────────────────────────────
// JRavenelco / Feria de Ciencias 2026
//
// El cuerpo detectado por Hailo-8 (YOLOv8m-pose, 17 KP COCO) deja de
// representarse como un esqueleto rígido. En su lugar, los pares de huesos
// (shoulder→elbow→wrist, hip→knee→ankle, …) actúan como rutas de SIEMBRA
// para un autómata celular tipo Conway, sobre una rejilla 2D.
//
// Las reglas son CONTROLADAS:
//   - base    : B3 / S23   (Conway clásico, organismo estable)
//   - excitada: B36 / S23  (HighLife) cuando una persona extiende un brazo
//                          o pierna por encima del umbral de "extensión".
//
// Cada celda guarda:
//   alive[i]  ∈ {0,1}     — estado del autómata
//   heat[i]   ∈ [0,1]     — energía continua, decae, se alimenta de movimiento
//   tintR/G/B[i]          — color sesgado por la persona que sembró la celda
//
// El render no dibuja líneas ni esferas: emite cada celda viva como un
// pequeño núcleo luminoso con blend additive, dejando rastros de difusión.
// El cuerpo se reconoce por la forma del organismo que mantiene, no por su
// silueta literal.

// ── Conexión OSC ──────────────────────────────────────────────────────────────
const WS_URL      = 'ws://127.0.0.1:8081';
const MAX_PERSONS = 8;
const DEBUG       = window.location.hash.includes('debug');

// ── Esqueleto lógico (no se dibuja, solo siembra) ────────────────────────────
const ALL_PARTS = [
  'nose',
  'shoulder/L', 'shoulder/R',
  'elbow/L',    'elbow/R',
  'wrist/L',    'wrist/R',
  'hip/L',      'hip/R',
  'knee/L',     'knee/R',
  'ankle/L',    'ankle/R',
];

const BONES = [
  ['nose',       'shoulder/L'], ['nose',       'shoulder/R'],
  ['shoulder/L', 'shoulder/R'],
  ['shoulder/L', 'elbow/L'],   ['elbow/L',   'wrist/L'],
  ['shoulder/R', 'elbow/R'],   ['elbow/R',   'wrist/R'],
  ['shoulder/L', 'hip/L'],     ['shoulder/R', 'hip/R'],
  ['hip/L',      'hip/R'],
  ['hip/L',      'knee/L'],    ['knee/L',    'ankle/L'],
  ['hip/R',      'knee/R'],    ['knee/R',    'ankle/R'],
];

// Pares cuya distancia normalizada por shoulder-width define "extensión"
// (brazo o pierna estirada). Si supera el umbral, la persona pasa a HighLife.
const EXTENSION_PAIRS = [
  ['shoulder/L', 'wrist/L'],
  ['shoulder/R', 'wrist/R'],
  ['hip/L',      'ankle/L'],
  ['hip/R',      'ankle/R'],
];
const EXTENSION_THRESH = 1.65;   // múltiplos del shoulder-width

const PERSON_COLORS = [
  [  0, 210, 255], [220,  50, 255], [ 50, 240,  80], [255, 160,   0],
  [255,  50, 120], [ 80, 140, 255], [255, 240,  50], [160,  80, 255],
];

// ── Estado de pose recibido por OSC ──────────────────────────────────────────
const pose         = {};   // /pose/{id}/{part} → [x,y,z]
const poseAt       = {};   // timestamp del último update por clave
const poseVelocity = {};   // 0..1 magnitud suavizada de velocidad
const poseHistory  = {};   // muestra anterior para Δ
const personLastSeen = new Array(MAX_PERSONS).fill(0);
const POSE_TTL_MS = 450;
const PERSON_TIMEOUT = 3000;
let lastPoseTime = 0;
let connected    = false;
let socket;

// ── Rejilla del autómata ─────────────────────────────────────────────────────
let GW = 192;
let GH = 108;
let alive, next, heat, tintR, tintG, tintB;
let cellW, cellH;

// Frecuencia del paso lógico desacoplada del render
const STEP_HZ = 14;
let   lastStep = 0;

// Render
let glowLayer;            // capa para acumular blur
let trailAlpha = 28;      // 0..255 — fading del background

function allocGrid() {
  const N = GW * GH;
  alive = new Uint8Array(N);
  next  = new Uint8Array(N);
  heat  = new Float32Array(N);
  tintR = new Uint8Array(N);
  tintG = new Uint8Array(N);
  tintB = new Uint8Array(N);
}

// ── WebSocket ────────────────────────────────────────────────────────────────
function connectWS() {
  socket = new WebSocket(WS_URL);
  socket.addEventListener('open',  () => { connected = true; if (DEBUG) console.log('[ws] open'); });
  socket.addEventListener('close', () => { connected = false; setTimeout(connectWS, 2000); });
  socket.addEventListener('message', (e) => {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    if (!data.latestPose) return;

    const now = millis();
    const dt  = Math.max((now - lastPoseTime) / 1000, 0.016);
    lastPoseTime = now;

    if (DEBUG) {
      const keys = Object.keys(data.latestPose).filter(k => k.startsWith('/pose/'));
      if (frameCount % 30 === 0) console.log('[osc] keys:', keys.length, keys.slice(0, 8));
    }

    for (const [key, val] of Object.entries(data.latestPose)) {
      if (!key.startsWith('/pose/')) continue;
      if (!Array.isArray(val) || val.length < 3) continue;

      const prev = poseHistory[key];
      if (prev) {
        const dx = val[0] - prev[0], dy = val[1] - prev[1], dz = val[2] - prev[2];
        const speed  = Math.sqrt(dx*dx + dy*dy + dz*dz) / dt;
        const target = Math.min(speed * 8, 1);
        const pv     = poseVelocity[key] || 0;
        poseVelocity[key] = target > pv
          ? pv * 0.3 + target * 0.7
          : pv * 0.85 + target * 0.15;
      }
      poseHistory[key] = val.slice();
      pose[key]        = val;
      poseAt[key]      = now;

      const m = key.match(/^\/pose\/(\d+)\//);
      if (m) {
        const id = parseInt(m[1], 10);
        if (id >= 0 && id < MAX_PERSONS) personLastSeen[id] = now;
      }
    }
  });
}

// ── Acceso a pose con TTL ────────────────────────────────────────────────────
function getPt(id, part) {
  const key = `/pose/${id}/${part}`;
  const t = poseAt[key];
  if (!t || millis() - t > POSE_TTL_MS) return null;
  const v = pose[key];
  return (v && v.length >= 3) ? { x: v[0], y: v[1], z: v[2], heat: poseVelocity[key] || 0 } : null;
}

function personActive(id) {
  return millis() - personLastSeen[id] < PERSON_TIMEOUT;
}

// ── Siembra ──────────────────────────────────────────────────────────────────
function seedCell(gx, gy, r, g, b, hAdd, force) {
  if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) return;
  const i = gy * GW + gx;
  if (force || Math.random() < 0.85) alive[i] = 1;
  heat[i] = Math.min(1, heat[i] + hAdd);
  // mezcla de tinte hacia el color de la persona
  tintR[i] = (tintR[i] * 0.5 + r * 0.5) | 0;
  tintG[i] = (tintG[i] * 0.5 + g * 0.5) | 0;
  tintB[i] = (tintB[i] * 0.5 + b * 0.5) | 0;
}

// Bresenham — siembra una línea entre dos joints
function seedLine(x0, y0, x1, y1, r, g, b, hAdd, density) {
  let gx0 = Math.floor(x0 * GW), gy0 = Math.floor(y0 * GH);
  let gx1 = Math.floor(x1 * GW), gy1 = Math.floor(y1 * GH);
  const dx = Math.abs(gx1 - gx0), sx = gx0 < gx1 ? 1 : -1;
  const dy = -Math.abs(gy1 - gy0), sy = gy0 < gy1 ? 1 : -1;
  let err = dx + dy, step = 0;
  while (true) {
    if ((step++ % density) === 0) seedCell(gx0, gy0, r, g, b, hAdd, true);
    if (gx0 === gx1 && gy0 === gy1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; gx0 += sx; }
    if (e2 <= dx) { err += dx; gy0 += sy; }
  }
}

function seedJointCluster(x, y, r, g, b, hAdd) {
  const gx = Math.floor(x * GW), gy = Math.floor(y * GH);
  for (let oy = -1; oy <= 1; oy++)
    for (let ox = -1; ox <= 1; ox++)
      seedCell(gx + ox, gy + oy, r, g, b, hAdd, true);
}

// Detecta si una persona está en estado "excitado" (extensión > umbral)
function isExcited(id) {
  const sl = getPt(id, 'shoulder/L');
  const sr = getPt(id, 'shoulder/R');
  if (!sl || !sr) return false;
  const sw = Math.hypot(sl.x - sr.x, sl.y - sr.y);
  if (sw < 0.02) return false;
  for (const [a, b] of EXTENSION_PAIRS) {
    const pa = getPt(id, a), pb = getPt(id, b);
    if (!pa || !pb) continue;
    const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    if (d / sw > EXTENSION_THRESH) return true;
  }
  return false;
}

function injectFromPose() {
  for (let id = 0; id < MAX_PERSONS; id++) {
    if (!personActive(id)) continue;
    const base = PERSON_COLORS[id % PERSON_COLORS.length];
    const [r, g, b] = base;

    // Huesos como rutas de siembra
    for (const [a, b2] of BONES) {
      const pa = getPt(id, a), pb = getPt(id, b2);
      if (!pa || !pb) continue;
      const h = (pa.heat + pb.heat) * 0.5;
      const density = h > 0.4 ? 1 : 2;     // más rápido → más denso
      seedLine(pa.x, pa.y, pb.x, pb.y, r, g, b, 0.35 + h * 0.6, density);
    }

    // Joints sueltos (incluso si su hueso no está completo)
    for (const part of ALL_PARTS) {
      const pt = getPt(id, part);
      if (!pt) continue;
      seedJointCluster(pt.x, pt.y, r, g, b, 0.45 + pt.heat * 0.55);
    }
  }
}

// ── Paso del autómata ────────────────────────────────────────────────────────
function stepAutomaton() {
  // ¿Algún humano excitado? Toda la rejilla pasa a HighLife (B36/S23).
  // Es global pero controlado: solo dura mientras alguien se estire.
  let highlife = false;
  for (let id = 0; id < MAX_PERSONS; id++) {
    if (personActive(id) && isExcited(id)) { highlife = true; break; }
  }

  for (let y = 0; y < GH; y++) {
    const yU = (y - 1 + GH) % GH;
    const yD = (y + 1) % GH;
    for (let x = 0; x < GW; x++) {
      const xL = (x - 1 + GW) % GW;
      const xR = (x + 1) % GW;
      const i = y * GW + x;

      const n = alive[yU*GW + xL] + alive[yU*GW + x] + alive[yU*GW + xR]
              + alive[ y*GW + xL]                    + alive[ y*GW + xR]
              + alive[yD*GW + xL] + alive[yD*GW + x] + alive[yD*GW + xR];

      const a = alive[i];
      let nv = 0;
      if (a) {
        nv = (n === 2 || n === 3) ? 1 : 0;          // S23
      } else {
        if (highlife) nv = (n === 3 || n === 6) ? 1 : 0;   // B36
        else          nv = (n === 3) ? 1 : 0;              // B3
      }
      next[i] = nv;

      // Decaimiento del heat
      heat[i] *= 0.94;
      if (heat[i] < 0.01) heat[i] = 0;

      // Si la celda muere y hace tiempo que no tiene heat, olvida tinte
      if (!nv && heat[i] === 0) {
        tintR[i] = (tintR[i] * 0.85) | 0;
        tintG[i] = (tintG[i] * 0.85) | 0;
        tintB[i] = (tintB[i] * 0.85) | 0;
      }
    }
  }
  // swap
  const tmp = alive; alive = next; next = tmp;
}

// ── p5 setup / draw ──────────────────────────────────────────────────────────
function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  frameRate(60);
  recomputeCellSize();
  allocGrid();
  connectWS();
}

function recomputeCellSize() {
  cellW = width  / GW;
  cellH = height / GH;
}

function draw() {
  // Estela: rect translúcido en lugar de background() opaco
  noStroke();
  fill(4, 6, 16, trailAlpha);
  rect(0, 0, width, height);

  // Inyectar siembra cada frame (suave) y avanzar autómata a STEP_HZ
  injectFromPose();
  const now = millis();
  if (now - lastStep > 1000 / STEP_HZ) {
    stepAutomaton();
    lastStep = now;
  }

  // Render: blend additive para acumular brillo
  blendMode(ADD);
  noStroke();
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const i = y * GW + x;
      const a = alive[i];
      const h = heat[i];
      if (!a && h < 0.05) continue;
      const intensity = a ? (0.55 + h * 0.45) : (h * 0.45);
      const r = tintR[i] * intensity;
      const g = tintG[i] * intensity;
      const b = tintB[i] * intensity;
      fill(r, g, b, a ? 235 : 120);
      const px = x * cellW, py = y * cellH;
      const sz = a ? Math.max(cellW, cellH) * (h > 0.6 ? 1.6 : 1.1)
                   : Math.max(cellW, cellH) * 0.9;
      rect(px, py, sz, sz);
    }
  }
  blendMode(BLEND);

  // HUD
  let activePeople = 0, anyExcited = false;
  for (let id = 0; id < MAX_PERSONS; id++) {
    if (personActive(id)) {
      activePeople++;
      if (isExcited(id)) anyExcited = true;
    }
  }
  const hud = document.getElementById('hud');
  if (hud) {
    hud.innerHTML =
      `<span style="color:${connected ? '#46dc82' : '#dc5050'}">${connected ? '● OSC' : '○ Sin OSC'}</span>` +
      `&nbsp;&nbsp;personas:&nbsp;${activePeople}` +
      `&nbsp;&nbsp;regla:&nbsp;<b style="color:${anyExcited ? '#ffd35a' : '#a0beff'}">${anyExcited ? 'B36/S23 (excitada)' : 'B3/S23 (Conway)'}</b>` +
      `&nbsp;&nbsp;|&nbsp;&nbsp;F fullscreen&nbsp;&nbsp;R reset&nbsp;&nbsp;[ ] densidad rejilla` +
      (DEBUG ? `&nbsp;&nbsp;<span style="color:#ff8a3a">debug</span>` : '');
  }
}

// ── Interacción ──────────────────────────────────────────────────────────────
function keyPressed() {
  if (key === 'r' || key === 'R') {
    alive.fill(0); next.fill(0); heat.fill(0);
    tintR.fill(0); tintG.fill(0); tintB.fill(0);
  }
  if (key === 'f' || key === 'F') {
    const el = document.querySelector('canvas');
    if (el.requestFullscreen)            el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }
  if (key === '[') { GW = Math.max(96, GW - 16); GH = Math.max(54, GH - 9); allocGrid(); recomputeCellSize(); }
  if (key === ']') { GW = Math.min(384, GW + 16); GH = Math.min(216, GH + 9); allocGrid(); recomputeCellSize(); }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  recomputeCellSize();
}
