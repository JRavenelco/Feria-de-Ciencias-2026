// ─── ArtPose-Vision · Domo Generativo Multi-Persona ─────────────────────────
// JRavenelco / Feria de Ciencias 2026

const WS_URL      = 'ws://127.0.0.1:8081';
const MAX_PERSONS = 8;

const PERSON_COLORS = [
  [  0, 210, 255],  // 0 cyan
  [220,  50, 255],  // 1 magenta
  [ 50, 240,  80],  // 2 verde neón
  [255, 160,   0],  // 3 dorado
  [255,  50, 120],  // 4 rosa
  [ 80, 140, 255],  // 5 azul
  [255, 240,  50],  // 6 amarillo
  [160,  80, 255],  // 7 violeta
];

// ── Esqueleto ─────────────────────────────────────────────────────────────────
const ALL_PARTS = [
  'nose', 'shoulder/L', 'shoulder/R',
  'elbow/L', 'elbow/R', 'wrist/L', 'wrist/R',
];
const BONES = [
  ['shoulder/L', 'shoulder/R'],
  ['nose',       'shoulder/L'], ['nose',       'shoulder/R'],
  ['shoulder/L', 'elbow/L'],    ['elbow/L',    'wrist/L'],
  ['shoulder/R', 'elbow/R'],    ['elbow/R',    'wrist/R'],
];
const JOINT_SIZE = {
  'wrist/L': 22, 'wrist/R': 22,
  'elbow/L': 16, 'elbow/R': 16,
  'shoulder/L': 18, 'shoulder/R': 18,
  'nose': 14,
};

// ── Escena — mapeo pose [0-1] → coordenadas 3D ────────────────────────────────
// Persona de pie, vista frontal, cuerpo llena ~80% de pantalla
function p2s(x, y, z) {
  return [
    map(x, 0.1, 0.9, -450, 450),
    map(y, 0.0, 1.0, -400, 400),
    map(z, 0.0, 1.0,  180, -180),
  ];
}

// ── Partículas de calor ────────────────────────────────────────────────────────
const particles = [];
const PART_MAX  = 800;

function spawnParticles(sx, sy, sz, r, g, b, heat) {
  if (particles.length >= PART_MAX) return;
  const n = Math.ceil(heat * 6);
  for (let i = 0; i < n; i++) {
    particles.push({
      x: sx + (Math.random() - 0.5) * 30,
      y: sy + (Math.random() - 0.5) * 30,
      z: sz + (Math.random() - 0.5) * 30,
      vx: (Math.random() - 0.5) * 0.8,
      vy: -Math.random() * 1.2 - 0.3,   // sube lentamente
      vz: (Math.random() - 0.5) * 0.8,
      r, g, b,
      born: millis(),
      life: 600 + Math.random() * 900,
    });
  }
}

// ── OSC / Velocidad ───────────────────────────────────────────────────────────
const pose         = {};
const poseHistory  = {};
const poseVelocity = {};
let   lastPoseTime = 0;

let connected = false;
let socket;
const lastSeen = new Array(MAX_PERSONS).fill(0);
const PERSON_TIMEOUT = 3000;

// ── Cámara ────────────────────────────────────────────────────────────────────
let camX = 0.0, camY = 0.0, camZoom = 1.0;
let autoRotate = false;

// ─────────────────────────────────────────────────────────────────────────────
// Color heat: frío (base) → naranja → blanco caliente
function heatColor(base, heat) {
  if (heat < 0.5) {
    const t = heat * 2;
    return [
      Math.round(base[0] + (255 - base[0]) * t),
      Math.round(base[1] + (160 - base[1]) * t),
      Math.round(base[2] * (1 - t)),
    ];
  }
  const t = (heat - 0.5) * 2;
  return [255, Math.round(160 + 95 * t), Math.round(200 * t)];
}

function getPt(id, part) {
  let v = pose[`/pose/${id}/${part}`];
  if (!v && id === 0) v = pose[`/pose/${part}`];
  return (v && v.length >= 3) ? {x: v[0], y: v[1], z: v[2]} : null;
}

function personActive(id) {
  return millis() - lastSeen[id] < PERSON_TIMEOUT;
}

function connectWS() {
  socket = new WebSocket(WS_URL);
  socket.addEventListener('open',  () => { connected = true; });
  socket.addEventListener('close', () => { connected = false; setTimeout(connectWS, 2000); });
  socket.addEventListener('message', (e) => {
    const data = JSON.parse(e.data);
    if (!data.latestPose) return;

    const now = millis();
    const dt  = Math.max((now - lastPoseTime) / 1000, 0.016);
    lastPoseTime = now;

    for (let id = 0; id < MAX_PERSONS; id++) {
      for (const part of ALL_PARTS) {
        const key  = `/pose/${id}/${part}`;
        const newV = data.latestPose[key];
        const prev = poseHistory[key];
        if (newV && prev) {
          const dx = newV[0]-prev[0], dy = newV[1]-prev[1], dz = newV[2]-prev[2];
          const speed  = Math.sqrt(dx*dx + dy*dy + dz*dz) / dt;
          const target = Math.min(speed * 8, 1);
          const pv     = poseVelocity[key] || 0;
          poseVelocity[key] = target > pv
            ? pv * 0.3 + target * 0.7
            : pv * 0.88 + target * 0.12;
        }
        if (newV) poseHistory[key] = newV;
      }
    }

    Object.assign(pose, data.latestPose);
    for (let id = 0; id < MAX_PERSONS; id++) {
      if (pose[`/pose/${id}/wrist/L`] || pose[`/pose/${id}/wrist/R`]) lastSeen[id] = millis();
    }
    if (pose['/pose/wrist/L'] || pose['/pose/wrist/R']) lastSeen[0] = millis();
  });
}

// ─── setup ───────────────────────────────────────────────────────────────────
function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  colorMode(RGB, 255);
  frameRate(60);
  setAttributes('antialias', true);
  connectWS();
}

// ─── draw ────────────────────────────────────────────────────────────────────
function draw() {
  background(4, 6, 16);

  // Luz ambiental muy tenue — el glow emissive es la luz principal
  ambientLight(15, 18, 30);

  // Point lights desde muñecas y nariz (reactivos al calor)
  for (let id = 0; id < MAX_PERSONS; id++) {
    if (!personActive(id)) continue;
    const base = PERSON_COLORS[id % PERSON_COLORS.length];
    for (const part of ['wrist/L', 'wrist/R', 'nose']) {
      const pt = getPt(id, part);
      if (!pt) continue;
      const heat = poseVelocity[`/pose/${id}/${part}`] || 0;
      const [r, g, b] = heatColor(base, heat);
      const [sx, sy, sz] = p2s(pt.x, pt.y, pt.z);
      const ints = 0.7 + heat * 1.3;
      pointLight(r * ints, g * ints, b * ints, sx, sy, sz + 80);
    }
  }

  // ── Cámara ───────────────────────────────────────────────────────────────
  if (autoRotate) camY += 0.003;
  rotateX(camX);
  rotateY(camY);
  scale(camZoom);

  // ── Partículas ────────────────────────────────────────────────────────────
  const now = millis();
  noStroke();
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    const age   = now - p.born;
    if (age > p.life) { particles.splice(i, 1); continue; }
    const alpha = 1 - age / p.life;
    p.x += p.vx; p.y += p.vy; p.z += p.vz;
    emissiveMaterial(p.r * alpha * 0.7, p.g * alpha * 0.7, p.b * alpha * 0.7);
    specularMaterial(p.r, p.g, p.b);
    push();
    translate(p.x, p.y, p.z);
    sphere(4 * alpha + 1, 5, 4);
    pop();
  }

  // ── Esqueleto ─────────────────────────────────────────────────────────────
  for (let id = 0; id < MAX_PERSONS; id++) {
    if (!personActive(id)) continue;
    const base = PERSON_COLORS[id % PERSON_COLORS.length];

    // Huesos — líneas brillantes
    for (const [pA, pB] of BONES) {
      const ptA = getPt(id, pA);
      const ptB = getPt(id, pB);
      if (!ptA || !ptB) continue;
      const hA = poseVelocity[`/pose/${id}/${pA}`] || 0;
      const hB = poseVelocity[`/pose/${id}/${pB}`] || 0;
      const [r, g, b] = heatColor(base, (hA + hB) * 0.5);
      stroke(r, g, b, 210);
      strokeWeight(5);
      noFill();
      const [x1, y1, z1] = p2s(ptA.x, ptA.y, ptA.z);
      const [x2, y2, z2] = p2s(ptB.x, ptB.y, ptB.z);
      line(x1, y1, z1, x2, y2, z2);
    }

    // Articulaciones — esferas con glow emissive
    noStroke();
    for (const part of ALL_PARTS) {
      const pt = getPt(id, part);
      if (!pt) continue;
      const heat = poseVelocity[`/pose/${id}/${part}`] || 0;
      const [r, g, b] = heatColor(base, heat);
      const [sx, sy, sz] = p2s(pt.x, pt.y, pt.z);
      const rad = JOINT_SIZE[part] || 16;

      // Spawn partículas si se mueve rápido
      if (heat > 0.3) spawnParticles(sx, sy, sz, r, g, b, heat);

      emissiveMaterial(r * 0.55, g * 0.55, b * 0.55);
      specularMaterial(r, g, b);
      shininess(90);
      push();
      translate(sx, sy, sz);
      sphere(rad, 12, 8);
      pop();
    }
  }

  // ── HUD DOM ───────────────────────────────────────────────────────────────
  let activePeople = 0;
  for (let id = 0; id < MAX_PERSONS; id++) if (personActive(id)) activePeople++;
  const hud = document.getElementById('hud');
  if (hud) {
    hud.innerHTML =
      `<span style="color:${connected ? '#46dc82' : '#dc5050'}">${connected ? '● OSC' : '○ Sin OSC'}</span>` +
      `&nbsp;&nbsp;personas:&nbsp;${activePeople}&nbsp;&nbsp;|&nbsp;&nbsp;` +
      `partículas:&nbsp;${particles.length}&nbsp;&nbsp;|&nbsp;&nbsp;` +
      `R&nbsp;reset&nbsp;|&nbsp;F&nbsp;fullscreen&nbsp;|&nbsp;Espacio&nbsp;rotación`;
  }
}

// ─── Interacción ─────────────────────────────────────────────────────────────
function mouseDragged() {
  autoRotate = false;
  camY += (mouseX - pmouseX) * 0.009;
  camX += (mouseY - pmouseY) * 0.009;
}

function mouseWheel(event) {
  camZoom = constrain(camZoom * (1 - event.delta * 0.001), 0.2, 4.0);
  return false;
}

function keyPressed() {
  if (key === 'r' || key === 'R') { particles.length = 0; }
  if (key === 'f' || key === 'F') {
    const el = document.querySelector('canvas');
    if (el.requestFullscreen)            el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }
  if (key === ' ') autoRotate = !autoRotate;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
