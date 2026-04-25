// ─── ArtPose-Vision · Domo Generativo Multi-Persona ─────────────────────────
// Autómata celular 3D + bloom + multi-persona (Hailo YOLOv8m-pose / OAK)
// JRavenelco / Feria de Ciencias 2026

const WS_URL      = 'ws://127.0.0.1:8081';
const MAX_PERSONS = 8;

// ── Paleta de colores por persona (HSL) ──────────────────────────────────────
// Distribuidos uniformemente en el espectro, brillantes sobre fondo negro
const PERSON_COLORS = [
  [  0, 230, 255],   // 0 cyan
  [220,  60, 255],   // 1 magenta
  [ 50, 240,  80],   // 2 verde neón
  [255, 160,   0],   // 3 dorado
  [255,  50, 120],   // 4 rosa
  [ 80, 140, 255],   // 5 azul
  [255, 255,  60],   // 6 amarillo
  [160,  80, 255],   // 7 violeta
];

// ── Grid autómata ─────────────────────────────────────────────────────────────
const GRID      = 26;
const CELL_SIZE = 12;

// Reglas 3D-Life (5766 — Amoeba variant: orgánico, no explota)
const S_MIN = 5, S_MAX = 7, B_N = 6;
const ITER_EVERY = 5;

// ── Estado ───────────────────────────────────────────────────────────────────
let cells, nextCells;
let cellR, cellG, cellB;
let cellAge;          // Uint8Array — generaciones que lleva viva
let iteration = 0, iterTimer = 0;

// ── Cámara 3D ─────────────────────────────────────────────────────────────────
let camX = -0.45, camY = 0.65, camZoom = 1.0;
let autoRotate = true;

// ── OSC / Personas ────────────────────────────────────────────────────────────
const pose = {};                     // mapa crudo OSC address → [x,y,z]
let personCount = 0;
let connected   = false;
let socket;

// Última vez que se recibió OSC por persona (ms)
const lastSeen = new Array(MAX_PERSONS).fill(0);
const PERSON_TIMEOUT = 2500;

// ── Bloom — dos pasadas de render ─────────────────────────────────────────────
let gfxBloom;         // PGraphics donde se renderiza la escena
const BLOOM_LAYERS = 3;

// ─────────────────────────────────────────────────────────────────────────────
function idx(x, y, z) { return x + GRID * y + GRID * GRID * z; }

function initCells() {
  const n = GRID ** 3;
  cells     = new Uint8Array(n);
  nextCells = new Uint8Array(n);
  cellR     = new Uint8Array(n);
  cellG     = new Uint8Array(n);
  cellB     = new Uint8Array(n);
  cellAge   = new Uint8Array(n);
  iteration = 0; iterTimer = 0;
}

function seedNucleus() {
  // Núcleo inicial compacto para que el autómata arranque
  const c = Math.floor(GRID / 2);
  for (let dz = -3; dz <= 3; dz++)
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        if (Math.random() < 0.55) {
          const i = idx(c+dx, c+dy, c+dz);
          cells[i] = 1;
          cellR[i] = 0; cellG[i] = 160; cellB[i] = 230;
        }
      }
}

// ── Paso autómata ─────────────────────────────────────────────────────────────
function stepAutomata() {
  nextCells.fill(0);
  for (let z = 1; z < GRID-1; z++)
    for (let y = 1; y < GRID-1; y++)
      for (let x = 1; x < GRID-1; x++) {
        const i = idx(x,y,z);
        let n = 0;
        for (let dz=-1;dz<=1;dz++) for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
          if (dx===0&&dy===0&&dz===0) continue;
          if (cells[idx(x+dx,y+dy,z+dz)]) n++;
        }
        if (cells[i]) {
          nextCells[i] = (n>=S_MIN && n<=S_MAX) ? 1 : 0;
        } else {
          nextCells[i] = (n===B_N) ? 1 : 0;
        }
        if (nextCells[i]) {
          cellAge[i] = cells[i] ? Math.min(255, cellAge[i]+1) : 0;
        } else {
          cellAge[i] = 0;
        }
      }
  const tmp = cells; cells = nextCells; nextCells = tmp;
  iteration++;
}

// ── Siembra de pose ───────────────────────────────────────────────────────────
function seedAtNorm(nx, ny, nz, r, g, b, radius) {
  const gx = Math.round(constrain(nx,0,0.999)*GRID);
  const gy = Math.round(constrain(ny,0,0.999)*GRID);
  const gz = Math.round(constrain(nz,0,0.999)*GRID);
  for (let dz=-radius;dz<=radius;dz++)
    for (let dy=-radius;dy<=radius;dy++)
      for (let dx=-radius;dx<=radius;dx++) {
        const x=gx+dx, y=gy+dy, z=gz+dz;
        if (x<1||x>=GRID-1||y<1||y>=GRID-1||z<1||z>=GRID-1) continue;
        if (Math.random() < 0.55) {
          const i = idx(x,y,z);
          cells[i] = 1;
          cellR[i] = r; cellG[i] = g; cellB[i] = b;
        }
      }
}

function oscPoint(addr) {
  const v = pose[addr];
  return (v && v.length >= 3) ? {x:v[0], y:v[1], z:v[2]} : null;
}

function personActive(id) {
  return millis() - lastSeen[id] < PERSON_TIMEOUT;
}

// ── Colores de célula por edad ────────────────────────────────────────────────
// Joven (age=0) → brillante; vieja (age>40) → color base; moribunda → apagada
function cellColor(i) {
  const age = cellAge[i];
  const t   = Math.min(age / 40, 1.0);
  // Nace muy brillante (casi blanco) y envejece hacia el color siembra
  const r = lerp(255, cellR[i], t);
  const g = lerp(255, cellG[i], t);
  const b = lerp(255, cellB[i], t);
  return [r, g, b];
}

// ── WebSocket OSC ─────────────────────────────────────────────────────────────
function connectWS() {
  socket = new WebSocket(WS_URL);
  socket.addEventListener('open',    () => { connected = true; });
  socket.addEventListener('close',   () => { connected = false; setTimeout(connectWS, 2000); });
  socket.addEventListener('message', (e) => {
    const data = JSON.parse(e.data);
    if (!data.latestPose) return;
    Object.assign(pose, data.latestPose);

    // Marcar personas activas
    for (let id = 0; id < MAX_PERSONS; id++) {
      if (pose[`/pose/${id}/wrist/L`] || pose[`/pose/${id}/wrist/R`]) {
        lastSeen[id] = millis();
      }
    }
    // Persona 0 legacy (OAK single-person)
    if (pose['/pose/wrist/L'] || pose['/pose/wrist/R']) {
      lastSeen[0] = millis();
    }

    const countArr = data.latestPose['/pose/count'];
    if (countArr) personCount = countArr[0] || 0;
  });
}

// ─── p5.js ───────────────────────────────────────────────────────────────────
function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  colorMode(RGB, 255);
  frameRate(60);

  gfxBloom = createGraphics(windowWidth, windowHeight, WEBGL);
  gfxBloom.colorMode(RGB, 255);

  initCells();
  seedNucleus();
  connectWS();
}

function draw() {
  // ── 1. Renderizar escena en gfxBloom ──────────────────────────────────────
  drawScene(gfxBloom);

  // ── 2. Bloom: repintar el gfx sobre sí mismo con blendMode ADD + blur ─────
  background(0);
  blendMode(BLEND);
  image(gfxBloom, -width/2, -height/2);  // base

  // Capas aditivas desplazadas para el halo (bloom suave)
  blendMode(ADD);
  tint(255, 60);
  for (let layer = 1; layer <= BLOOM_LAYERS; layer++) {
    const spread = layer * 2.5;
    image(gfxBloom, -width/2 - spread, -height/2);
    image(gfxBloom, -width/2 + spread, -height/2);
    image(gfxBloom, -width/2, -height/2 - spread);
    image(gfxBloom, -width/2, -height/2 + spread);
  }
  noTint();
  blendMode(BLEND);

  // ── 3. HUD 2D ─────────────────────────────────────────────────────────────
  drawHUD();
}

function drawScene(g) {
  g.background(6, 8, 18);

  // Luces dinámicas desde muñecas
  g.ambientLight(25, 28, 45);
  g.directionalLight(100, 130, 200, 0.4, 0.6, -1.0);

  // Añadir point light en cada muñeca activa
  for (let id = 0; id < MAX_PERSONS; id++) {
    if (!personActive(id)) continue;
    const col = PERSON_COLORS[id % PERSON_COLORS.length];
    const wL  = getPt(id, 'wrist/L');
    const wR  = getPt(id, 'wrist/R');
    if (wL) {
      const px = map(wL.x, 0, 1, -width*0.4, width*0.4);
      const py = map(wL.y, 0, 1, -height*0.4, height*0.4);
      g.pointLight(col[0], col[1], col[2], px, py, 300);
    }
    if (wR) {
      const px = map(wR.x, 0, 1, -width*0.4, width*0.4);
      const py = map(wR.y, 0, 1, -height*0.4, height*0.4);
      g.pointLight(col[0], col[1], col[2], px, py, 300);
    }
  }

  // Siembra de pose → células
  for (let id = 0; id < MAX_PERSONS; id++) {
    if (!personActive(id)) continue;
    const col = PERSON_COLORS[id % PERSON_COLORS.length];
    const pts = ['wrist/L','wrist/R','elbow/L','elbow/R'];
    const radii = [2, 2, 1, 1];
    pts.forEach((part, pi) => {
      const pt = getPt(id, part);
      if (pt) seedAtNorm(pt.x, pt.y, pt.z, col[0], col[1], col[2], radii[pi]);
    });
  }

  // Paso autómata
  iterTimer++;
  if (iterTimer >= ITER_EVERY) { stepAutomata(); iterTimer = 0; }

  // Cámara
  if (autoRotate) camY += 0.006;
  g.rotateX(camX);
  g.rotateY(camY);
  g.scale(camZoom);

  // Cubo wireframe
  g.noFill();
  g.stroke(50, 100, 200, 40);
  g.strokeWeight(0.5);
  g.box(GRID * CELL_SIZE);

  // Dibujar células como esferas
  g.noStroke();
  const half = GRID * CELL_SIZE * 0.5;
  const SPHERE_R = CELL_SIZE * 0.52;

  for (let z = 0; z < GRID; z++)
    for (let y = 0; y < GRID; y++)
      for (let x = 0; x < GRID; x++) {
        const i = idx(x,y,z);
        if (!cells[i]) continue;
        const [r,gr,b] = cellColor(i);
        g.fill(r, gr, b);
        g.push();
        g.translate(
          -half + x*CELL_SIZE + CELL_SIZE*0.5,
          -half + y*CELL_SIZE + CELL_SIZE*0.5,
          -half + z*CELL_SIZE + CELL_SIZE*0.5
        );
        g.sphere(SPHERE_R, 5, 4);   // low-poly para rendimiento
        g.pop();
      }
}

// ── Helpers OSC multi-persona ─────────────────────────────────────────────────
function getPt(id, part) {
  // Intenta dirección multi-persona, luego legacy (id=0)
  let v = pose[`/pose/${id}/${part}`];
  if (!v && id === 0) v = pose[`/pose/${part}`];
  return (v && v.length >= 3) ? {x:v[0], y:v[1], z:v[2]} : null;
}

// ── HUD ───────────────────────────────────────────────────────────────────────
function drawHUD() {
  push();
  ortho(-width/2, width/2, -height/2, height/2);
  camera();
  noLights();
  noStroke();

  // Contar células activas
  let active = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i]) active++;

  // Contar personas activas
  let activePeople = 0;
  for (let id = 0; id < MAX_PERSONS; id++) if (personActive(id)) activePeople++;

  fill(6, 8, 18, 190);
  rect(-width/2, -height/2, width, 38, 0, 0, 6, 6);

  textSize(13); textAlign(LEFT, TOP);
  const connStr = connected ? '● OSC' : '○ Sin OSC';
  const connCol = connected ? color(80, 220, 130) : color(220, 80, 80);
  fill(connCol);
  text(connStr, -width/2 + 14, -height/2 + 12);

  fill(180, 200, 255);
  text(`iter: ${iteration}  |  células: ${active}  |  personas: ${activePeople}  |  F: fullscreen  |  R: reiniciar`,
       -width/2 + 90, -height/2 + 12);

  // Indicadores de color por persona
  for (let id = 0; id < MAX_PERSONS; id++) {
    if (!personActive(id)) continue;
    const col = PERSON_COLORS[id % PERSON_COLORS.length];
    fill(col[0], col[1], col[2]);
    const bx = width/2 - 22 - id * 22;
    ellipse(bx, -height/2 + 19, 14, 14);
    fill(255);
    textSize(9); textAlign(CENTER, CENTER);
    text(id, bx, -height/2 + 19);
  }

  pop();
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
  if (key === 'r' || key === 'R') { initCells(); seedNucleus(); }
  if (key === 't' || key === 'T') {
    for (let i = 0; i < 400; i++) {
      const x = floor(random(2,GRID-2)), y = floor(random(2,GRID-2)), z = floor(random(2,GRID-2));
      const col = PERSON_COLORS[floor(random(PERSON_COLORS.length))];
      const ii = idx(x,y,z);
      cells[ii] = 1; cellR[ii] = col[0]; cellG[ii] = col[1]; cellB[ii] = col[2];
    }
  }
  if (key === 'f' || key === 'F') {
    const el = document.querySelector('canvas');
    if (el) el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen();
  }
  if (key === ' ') autoRotate = !autoRotate;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  gfxBloom.resizeCanvas(windowWidth, windowHeight);
}
