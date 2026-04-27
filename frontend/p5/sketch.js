// ─── ArtPose-Vision · Morfogénesis Digital (Gray-Scott + SDF) ───────────────
// JRavenelco / Feria de Ciencias 2026
//
// Implementa el modelo de Reacción-Difusión de Gray-Scott como simulación
// de morfogénesis sobre la GPU usando shaders GLSL y ping-pong buffering.
// El esqueleto detectado por la OAK (BlazePose) modula localmente los
// parámetros f (feed) y k (kill) mediante una Función de Distancia con
// Signo (SDF) calculada en el fragment shader: cada pixel mide su distancia
// al segmento óseo más cercano y, según esa distancia, decide si el sistema
// debe "florecer" o "morir".
//
// Pipeline:
//    OAK (BlazePose 33 KP, edge inference)
//      └─ python pythonosc → udp://host:12000
//           └─ node ws bridge → ws://127.0.0.1:8081
//                └─ este sketch ← uniforms del shader Gray-Scott
//
// Buffers:
//    bufA, bufB : p5.Graphics WEBGL (RG = U,V concentraciones)
//    canvas     : p5 WEBGL principal, dibuja el resultado con paleta.
//
// Referencias técnicas:
//    - Turing 1952. The Chemical Basis of Morphogenesis.
//    - Gray-Scott model. f, k típicos: (0.055, 0.062) coral / (0.029, 0.057) negativo.
//    - Karl Sims, Reaction-Diffusion Tutorial.
//    - jasonwebb/reaction-diffusion-playground (referencia de implementación GPU).

// ── Conexión con el bridge ─────────────────────────────────────────────────────────
const BRIDGE_HOST = (location.hostname && location.hostname !== '') ? location.hostname : '127.0.0.1';
const WS_URL      = `ws://${BRIDGE_HOST}:8081`;
const HTTP_URL    = `http://${BRIDGE_HOST}:8082`;
const MAX_PERSONS = 8;
const DEBUG       = window.location.hash.includes('debug');

// ── Topología BlazePose / COCO simplificada (13 KP) ──────────────────────────
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

// MAX_* deben coincidir con las constantes en los shaders.
const MAX_BONES  = 64;         // límite WebGL1 portable; suficiente para 4 personas
const MAX_JOINTS = 64;

// ── Estado de pose recibido por OSC ──────────────────────────────────────────
const pose         = {};   // /pose/{id}/{part} → [x,y,z]
const poseAt       = {};   // timestamp del último update por clave
const personLastSeen = new Array(MAX_PERSONS).fill(0);
const POSE_TTL_MS = 600;
const PERSON_TIMEOUT = 3000;
let connected    = false;
let socket;

// Buffers para uniforms (re-usados cada frame para evitar GC)
const boneArr  = new Float32Array(MAX_BONES  * 4);
const jointArr = new Float32Array(MAX_JOINTS * 4);
let   numBones = 0;
let   numJoints = 0;

// ── Simulación ───────────────────────────────────────────────────────────────
// Resolución de la simulación (independiente del canvas).
// 480x270 = ~130 K celdas. Suficiente detalle para domo/proyector.
const SIM_W = 480;
const SIM_H = 270;
const ITERS_PER_FRAME = 8;     // pasos de Gray-Scott por frame de render

// Parámetros base de Gray-Scott. La SDF los modula localmente.
let baseFeed = 0.055;          // “coral”
let baseKill = 0.062;
let dU = 1.00;                 // difusión del sustrato
let dV = 0.50;                 // difusión del activador
let dt = 1.00;

// Fuerza de la modulación por proximidad al cuerpo
let skinStrength = 1.0;

// Paleta del display — todas con fondo negro puro para máximo contraste.
let paletteIdx = 0;
const PALETTES = [
  // [color de fondo,                color medio,             highlight]
  [[ 0,  0,  0], [ 60, 200, 220], [255, 240, 200]],   // cyan eléctrico
  [[ 0,  0,  0], [200,  60, 220], [255, 220, 100]],   // magenta hot
  [[ 0,  0,  0], [ 80, 240,  90], [240, 255, 200]],   // verde fluorescente
  [[ 0,  0,  0], [240, 130,  20], [255, 240, 200]],   // dorado
  [[ 0,  0,  0], [180, 180, 180], [255, 255, 255]],   // monocromo
];

// ── Shaders ──────────────────────────────────────────────────────────────────
// Vertex shader compartido — usa las matrices que p5 setea automáticamente.
// Esto es lo que permite usar plane()/rect() del API de p5 sin hacer la
// conversión a clip-space a mano.
const VERT_SRC = `
precision highp float;
attribute vec3 aPosition;
attribute vec2 aTexCoord;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
varying vec2 vTexCoord;
void main() {
  vTexCoord = aTexCoord;
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
}
`;

// Fragment shader del paso Gray-Scott con modulación SDF.
const RD_FRAG_SRC = `
precision highp float;

#define MAX_BONES  64
#define MAX_JOINTS 64

varying vec2 vTexCoord;
uniform sampler2D uState;
uniform vec2  uResolution;
uniform float uDt, uDu, uDv;
uniform float uFeed, uKill;
uniform float uSkinStrength;
uniform int   uBoneCount;
uniform vec4  uBones[MAX_BONES];   // (x1,y1,x2,y2) en [0,1]
uniform int   uJointCount;
uniform vec4  uJoints[MAX_JOINTS]; // (x,y,heat,radius) en [0,1]

float distToSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float denom = max(dot(ba, ba), 1e-6);
  float h = clamp(dot(pa, ba) / denom, 0.0, 1.0);
  return length(pa - ba * h);
}

float skeletonSDF(vec2 p) {
  float d = 1.0;
  for (int i = 0; i < MAX_BONES; i++) {
    if (i >= uBoneCount) break;
    vec4 s = uBones[i];
    d = min(d, distToSegment(p, s.xy, s.zw));
  }
  return d;
}

void main() {
  vec2 uv = vTexCoord;
  vec2 px = 1.0 / uResolution;

  vec2 c  = texture2D(uState, uv).rg;
  float u = c.r;
  float v = c.g;

  // Laplaciano 9-puntos (kernel estándar de Gray-Scott)
  vec2 lap = vec2(0.0);
  lap += texture2D(uState, uv + vec2(-px.x, -px.y)).rg * 0.05;
  lap += texture2D(uState, uv + vec2( 0.0,  -px.y)).rg * 0.20;
  lap += texture2D(uState, uv + vec2( px.x, -px.y)).rg * 0.05;
  lap += texture2D(uState, uv + vec2(-px.x,  0.0 )).rg * 0.20;
  lap += c * (-1.0);
  lap += texture2D(uState, uv + vec2( px.x,  0.0 )).rg * 0.20;
  lap += texture2D(uState, uv + vec2(-px.x,  px.y)).rg * 0.05;
  lap += texture2D(uState, uv + vec2( 0.0,   px.y)).rg * 0.20;
  lap += texture2D(uState, uv + vec2( px.x,  px.y)).rg * 0.05;

  // Distancia al esqueleto y “piel” gaussiana
  float dSkel = skeletonSDF(uv);
  float skin  = exp(-dSkel * dSkel * 600.0) * uSkinStrength;

  // Modulación local de feed/kill: cerca del cuerpo el sistema "florece".
  float feed = uFeed + skin * 0.020;
  float kill = uKill - skin * 0.005;

  float reaction = u * v * v;
  float du = uDu * lap.r - reaction + feed * (1.0 - u);
  float dv = uDv * lap.g + reaction - (kill + feed) * v;

  float newU = clamp(u + du * uDt, 0.0, 1.0);
  float newV = clamp(v + dv * uDt, 0.0, 1.0);

  // Inyección de activador (V) en los joints — cada joint es una semilla.
  for (int i = 0; i < MAX_JOINTS; i++) {
    if (i >= uJointCount) break;
    vec4 j = uJoints[i];          // (x, y, heat, radius)
    float d = distance(uv, j.xy);
    if (d < j.w) {
      float strength = (1.0 - d / j.w) * (0.4 + j.z * 0.6);
      newV = max(newV, strength);
      newU = min(newU, 1.0 - strength * 0.6);
    }
  }

  gl_FragColor = vec4(newU, newV, 0.0, 1.0);
}
`;

// Fragment shader de presentación: mapea V a paleta.
const DISP_FRAG_SRC = `
precision highp float;
varying vec2 vTexCoord;
uniform sampler2D uState;
uniform vec3 uColorBg;
uniform vec3 uColorMid;
uniform vec3 uColorHi;

void main() {
  float v = texture2D(uState, vTexCoord).g;
  // Curva de respuesta — exalta los bordes de los patrones
  float t = smoothstep(0.05, 0.45, v);
  vec3 col = mix(uColorBg, uColorMid, t);
  col = mix(col, uColorHi, smoothstep(0.30, 0.55, v));
  // viñeta sutil
  vec2 d = vTexCoord - 0.5;
  float vig = smoothstep(0.85, 0.35, length(d));
  col *= 0.55 + 0.45 * vig;
  gl_FragColor = vec4(col, 1.0);
}
`;

// ── Variables p5 ─────────────────────────────────────────────────────────────
let bufA, bufB;
// Cada p5.Graphics(WEBGL) tiene su propio contexto, por eso necesitamos un
// shader RD por buffer (no se pueden compartir entre contextos en p5).
let rdShaderA, rdShaderB, dispShader;
let pingPongFlip = 0;          // 0 → leer A, escribir B; 1 → leer B, escribir A

// ── Setup / WebSocket ────────────────────────────────────────────────────────
function connectWS() {
  socket = new WebSocket(WS_URL);
  socket.addEventListener('open',  () => { connected = true; if (DEBUG) console.log('[ws] open'); });
  socket.addEventListener('close', () => { connected = false; setTimeout(connectWS, 2000); });
  socket.addEventListener('message', (e) => {
    let data; try { data = JSON.parse(e.data); } catch { return; }
    if (!data.latestPose) return;

    const now = millis();

    if (DEBUG && (frameCount % 60 === 0)) {
      const keys = Object.keys(data.latestPose).filter(k => k.startsWith('/pose/'));
      console.log('[osc] keys:', keys.length, keys.slice(0, 6));
    }

    for (const [key, val] of Object.entries(data.latestPose)) {
      if (!key.startsWith('/pose/')) continue;
      if (!Array.isArray(val) || val.length < 3) continue;
      pose[key]   = val;
      poseAt[key] = now;

      const m = key.match(/^\/pose\/(\d+)\//);
      if (m) {
        const id = parseInt(m[1], 10);
        if (id >= 0 && id < MAX_PERSONS) personLastSeen[id] = now;
      }
    }
  });
}

function getPt(id, part) {
  const key = `/pose/${id}/${part}`;
  const t = poseAt[key];
  if (!t || millis() - t > POSE_TTL_MS) return null;
  const v = pose[key];
  return (v && v.length >= 3) ? { x: v[0], y: v[1], z: v[2] } : null;
}

function personActive(id) {
  return millis() - personLastSeen[id] < PERSON_TIMEOUT;
}

// ── Construir buffers de uniforms a partir de la pose actual ─────────────────
function rebuildPoseUniforms() {
  numBones  = 0;
  numJoints = 0;

  for (let id = 0; id < MAX_PERSONS; id++) {
    if (!personActive(id)) continue;

    // Joints
    for (const part of ALL_PARTS) {
      if (numJoints >= MAX_JOINTS) break;
      const pt = getPt(id, part);
      if (!pt) continue;
      const i = numJoints * 4;
      jointArr[i + 0] = pt.x;
      jointArr[i + 1] = pt.y;
      jointArr[i + 2] = 0.6;     // heat (TODO: derivar de velocidad)
      jointArr[i + 3] = 0.018;   // radio de inyección
      numJoints++;
    }

    // Bones (segmentos para SDF)
    for (const [a, b] of BONES) {
      if (numBones >= MAX_BONES) break;
      const pa = getPt(id, a);
      const pb = getPt(id, b);
      if (!pa || !pb) continue;
      const i = numBones * 4;
      boneArr[i + 0] = pa.x;
      boneArr[i + 1] = pa.y;
      boneArr[i + 2] = pb.x;
      boneArr[i + 3] = pb.y;
      numBones++;
    }
  }

  // Si no hay esqueleto, ponemos un segmento dummy fuera del área para que
  // el SDF no devuelva 0 accidentalmente.
  if (numBones === 0) {
    boneArr[0] = -10; boneArr[1] = -10; boneArr[2] = -9; boneArr[3] = -10;
    numBones = 1;
  }
  if (numJoints === 0) {
    jointArr[0] = -10; jointArr[1] = -10; jointArr[2] = 0; jointArr[3] = 0;
    numJoints = 1;
  }
}

// ── p5 lifecycle ─────────────────────────────────────────────────────────────
function setup() {
  pixelDensity(1);
  // preserveDrawingBuffer permite leer el canvas con toBlob() después del frame.
  setAttributes('preserveDrawingBuffer', true);
  createCanvas(windowWidth, windowHeight, WEBGL);
  noStroke();
  frameRate(60);

  // Shader de presentación: vive en el canvas principal.
  dispShader = createShader(VERT_SRC, DISP_FRAG_SRC);

  // Buffers de simulación (cada uno con su propio contexto WebGL).
  bufA = createGraphics(SIM_W, SIM_H, WEBGL);
  bufB = createGraphics(SIM_W, SIM_H, WEBGL);
  bufA.pixelDensity(1);
  bufB.pixelDensity(1);
  bufA.noStroke();
  bufB.noStroke();

  // Shaders RD bound a cada contexto. Cuando escribimos en bufA usamos
  // rdShaderA (que vive en el contexto de bufA); cuando escribimos en
  // bufB usamos rdShaderB.
  rdShaderA = bufA.createShader(VERT_SRC, RD_FRAG_SRC);
  rdShaderB = bufB.createShader(VERT_SRC, RD_FRAG_SRC);

  // Estado inicial: U=1 en todas partes, V=0 (codificado como rojo puro).
  bufA.background(255, 0, 0);
  bufB.background(255, 0, 0);

  // Pequeña semilla central de V para arrancar el patrón aunque no haya pose.
  bufA.fill(180, 180, 0);
  bufA.rect(-20, -10, 40, 20);

  connectWS();
}

function runRDIteration() {
  const src = (pingPongFlip === 0) ? bufA : bufB;
  const dst = (pingPongFlip === 0) ? bufB : bufA;
  // El shader debe pertenecer al contexto del destino.
  const sh  = (pingPongFlip === 0) ? rdShaderB : rdShaderA;

  dst.shader(sh);
  sh.setUniform('uState',        src);
  sh.setUniform('uResolution',   [SIM_W, SIM_H]);
  sh.setUniform('uDt',           dt);
  sh.setUniform('uDu',           dU);
  sh.setUniform('uDv',           dV);
  sh.setUniform('uFeed',         baseFeed);
  sh.setUniform('uKill',         baseKill);
  sh.setUniform('uSkinStrength', skinStrength);
  sh.setUniform('uBoneCount',    numBones);
  sh.setUniform('uBones',        boneArr);
  sh.setUniform('uJointCount',   numJoints);
  sh.setUniform('uJoints',       jointArr);

  // Quad full-screen.
  dst.plane(SIM_W, SIM_H);

  pingPongFlip = 1 - pingPongFlip;
}

function draw() {
  // Actualiza uniforms de pose una vez por frame
  rebuildPoseUniforms();

  // N pasos de Gray-Scott
  for (let i = 0; i < ITERS_PER_FRAME; i++) {
    runRDIteration();
  }

  // El buffer "actual" (origen del próximo paso) es el último escrito.
  const finalBuf = (pingPongFlip === 0) ? bufA : bufB;

  // Render a pantalla con shader de presentación.
  const pal = PALETTES[paletteIdx];
  shader(dispShader);
  dispShader.setUniform('uState',    finalBuf);
  dispShader.setUniform('uColorBg',  pal[0].map(c => c / 255));
  dispShader.setUniform('uColorMid', pal[1].map(c => c / 255));
  dispShader.setUniform('uColorHi',  pal[2].map(c => c / 255));
  plane(width, height);

  // HUD
  let activePeople = 0;
  for (let id = 0; id < MAX_PERSONS; id++) if (personActive(id)) activePeople++;
  const hud = document.getElementById('hud');
  if (hud) {
    hud.innerHTML =
      `<span style="color:${connected ? '#46dc82' : '#dc5050'}">${connected ? '● OSC' : '○ Sin OSC'}</span>` +
      `&nbsp;&nbsp;personas:&nbsp;${activePeople}` +
      `&nbsp;&nbsp;|&nbsp;&nbsp;Gray-Scott f=${baseFeed.toFixed(3)} k=${baseKill.toFixed(3)}` +
      `&nbsp;&nbsp;huesos:${numBones}&nbsp;joints:${numJoints}` +
      `&nbsp;&nbsp;|&nbsp;&nbsp;<b>1-5</b> paleta&nbsp;&nbsp;<b>q/a w/s</b> f/k&nbsp;&nbsp;<b>p</b> foto+QR&nbsp;&nbsp;<b>r</b> reset&nbsp;&nbsp;<b>F</b> fullscreen` +
      (DEBUG ? `&nbsp;&nbsp;<span style="color:#ff8a3a">debug</span>` : '');
  }
}

// ── Interacción ──────────────────────────────────────────────────────────────
function resetSim() {
  bufA.background(255, 0, 0);
  bufB.background(255, 0, 0);
  bufA.fill(180, 180, 0);
  bufA.rect(-20, -10, 40, 20);
  pingPongFlip = 0;
}

function keyPressed() {
  if (key === 'r' || key === 'R') resetSim();
  if (key === 'p' || key === 'P') captureAndShare();
  if (keyCode === ESCAPE)         closeCaptureOverlay();
  if (key === 'f' || key === 'F') {
    const el = document.querySelector('canvas');
    if (el.requestFullscreen)            el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }
  // Paletas
  if (key >= '1' && key <= '5') paletteIdx = parseInt(key, 10) - 1;

  // Ajuste de parámetros Gray-Scott (q/a = feed +/-, w/s = kill +/-)
  if (key === 'q') baseFeed = Math.min(0.10, baseFeed + 0.001);
  if (key === 'a') baseFeed = Math.max(0.00, baseFeed - 0.001);
  if (key === 'w') baseKill = Math.min(0.08, baseKill + 0.001);
  if (key === 's') baseKill = Math.max(0.04, baseKill - 0.001);

  // Presets clásicos
  if (key === 'z') { baseFeed = 0.055; baseKill = 0.062; }    // coral / worms
  if (key === 'x') { baseFeed = 0.029; baseKill = 0.057; }    // negative / mitosis
  if (key === 'c') { baseFeed = 0.039; baseKill = 0.058; }    // moving spots
  if (key === 'v') { baseFeed = 0.014; baseKill = 0.054; }    // solitons
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// ── Captura + QR ───────────────────────────────────────────────────────────────────────
async function captureAndShare() {
  const overlay = document.getElementById('capture-overlay');
  const status  = overlay.querySelector('.status');
  const qrBox   = overlay.querySelector('.qr');
  const urlEl   = overlay.querySelector('.url');

  overlay.style.display = 'flex';
  status.textContent = 'Capturando frame…';
  qrBox.innerHTML = '';
  urlEl.textContent = '';
  urlEl.removeAttribute('href');

  const cv = document.querySelector('canvas');
  if (!cv) { status.textContent = 'No hay canvas para capturar.'; return; }

  // toBlob es asíncrono — envolverlo en Promise
  const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
  if (!blob) { status.textContent = 'No se pudo generar PNG (¿WebGL en blank?).'; return; }

  status.textContent = `Subiendo ${(blob.size / 1024).toFixed(0)} KB al bridge…`;

  try {
    const r = await fetch(`${HTTP_URL}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body:    blob,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    status.textContent = 'Escanea el código QR con tu teléfono para descargar tu captura.';
    urlEl.textContent  = data.url;
    urlEl.href         = data.url;

    if (typeof qrcode === 'function') {
      const qr = qrcode(0, 'M');
      qr.addData(data.url);
      qr.make();
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } else {
      qrBox.textContent = '(librería QR no disponible)';
    }
  } catch (err) {
    status.textContent = `Error subiendo: ${err.message}. Revisa que el bridge tenga el HTTP server activo (puerto 8082).`;
    console.error('[capture] error:', err);
  }
}

function closeCaptureOverlay() {
  const overlay = document.getElementById('capture-overlay');
  if (overlay) overlay.style.display = 'none';
}
