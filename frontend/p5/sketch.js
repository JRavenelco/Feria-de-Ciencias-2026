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

// ── Grid autómata ─────────────────────────────────────────────────────────────
const GRID      = 24;
const CELL_SIZE = 14;
const S_MIN = 4, S_MAX = 7, B_N = 5;
const ITER_EVERY = 6;

let cells, nextCells;
let cellR, cellG, cellB, cellAge;
let iteration = 0, iterTimer = 0;

// ── Cámara ────────────────────────────────────────────────────────────────────
let camX = -0.45, camY = 0.65, camZoom = 1.0;
let autoRotate = true;

// ── OSC / Personas ────────────────────────────────────────────────────────────
const pose = {};
let connected = false;
let socket;
const lastSeen = new Array(MAX_PERSONS).fill(0);
const PERSON_TIMEOUT = 2500;

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
  const c = Math.floor(GRID / 2);
  for (let dz = -4; dz <= 4; dz++)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++)
        if (Math.random() < 0.45) {
          const i = idx(c+dx, c+dy, c+dz);
          cells[i] = 1;
          cellR[i] = 0; cellG[i] = 180; cellB[i] = 255;
        }
}

function stepAutomata() {
  nextCells.fill(0);
  for (let z = 1; z < GRID-1; z++)
    for (let y = 1; y < GRID-1; y++)
      for (let x = 1; x < GRID-1; x++) {
        const i = idx(x,y,z);
        let n = 0;
        for (let dz=-1;dz<=1;dz++) for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
          if (!dx&&!dy&&!dz) continue;
          if (cells[idx(x+dx,y+dy,z+dz)]) n++;
        }
        if (cells[i]) {
          nextCells[i] = (n >= S_MIN && n <= S_MAX) ? 1 : 0;
        } else {
          nextCells[i] = (n === B_N) ? 1 : 0;
        }
        if (nextCells[i]) {
          cellAge[i] = cells[i] ? min(255, cellAge[i] + 1) : 0;
        } else {
          cellAge[i] = 0;
        }
      }
  const tmp = cells; cells = nextCells; nextCells = tmp;
  iteration++;
}

function seedAtNorm(nx, ny, nz, r, g, b, radius) {
  const gx = Math.round(constrain(nx, 0, 0.999) * GRID);
  const gy = Math.round(constrain(ny, 0, 0.999) * GRID);
  const gz = Math.round(constrain(nz, 0, 0.999) * GRID);
  for (let dz = -radius; dz <= radius; dz++)
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = gx+dx, y = gy+dy, z = gz+dz;
        if (x<1||x>=GRID-1||y<1||y>=GRID-1||z<1||z>=GRID-1) continue;
        if (Math.random() < 0.6) {
          const i = idx(x, y, z);
          cells[i] = 1;
          cellR[i] = r; cellG[i] = g; cellB[i] = b;
        }
      }
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
  socket.addEventListener('open',    () => { connected = true; });
  socket.addEventListener('close',   () => { connected = false; setTimeout(connectWS, 2000); });
  socket.addEventListener('message', (e) => {
    const data = JSON.parse(e.data);
    if (!data.latestPose) return;
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
  initCells();
  seedNucleus();
  connectWS();
}

// ─── draw ────────────────────────────────────────────────────────────────────
function draw() {
  background(6, 8, 20);

  // ── Luces de escena ────────────────────────────────────────────────────────
  ambientLight(30, 35, 55);
  directionalLight(80, 110, 180, 0.3, 0.6, -1.0);
  directionalLight(20, 15,  50, -0.3, -0.4, 0.5);

  // Point lights desde muñecas activas
  for (let id = 0; id < MAX_PERSONS; id++) {
    if (!personActive(id)) continue;
    const col = PERSON_COLORS[id % PERSON_COLORS.length];
    for (const part of ['wrist/L', 'wrist/R']) {
      const pt = getPt(id, part);
      if (!pt) continue;
      const px = map(pt.x, 0, 1, -width * 0.45, width * 0.45);
      const py = map(pt.y, 0, 1, -height * 0.45, height * 0.45);
      pointLight(col[0], col[1], col[2], px, py, 350);
    }
  }

  // ── Siembra de pose ────────────────────────────────────────────────────────
  for (let id = 0; id < MAX_PERSONS; id++) {
    if (!personActive(id)) continue;
    const col = PERSON_COLORS[id % PERSON_COLORS.length];
    const seeds = [['wrist/L',2],['wrist/R',2],['elbow/L',1],['elbow/R',1]];
    for (const [part, r] of seeds) {
      const pt = getPt(id, part);
      if (pt) seedAtNorm(pt.x, pt.y, pt.z, col[0], col[1], col[2], r);
    }
  }

  // ── Paso autómata ──────────────────────────────────────────────────────────
  if (++iterTimer >= ITER_EVERY) { stepAutomata(); iterTimer = 0; }

  // ── Cámara ─────────────────────────────────────────────────────────────────
  if (autoRotate) camY += 0.005;
  rotateX(camX);
  rotateY(camY);
  scale(camZoom);

  // ── Cubo wireframe ─────────────────────────────────────────────────────────
  noFill();
  stroke(40, 90, 200, 45);
  strokeWeight(0.6);
  box(GRID * CELL_SIZE);
  noStroke();

  // ── Dibujar células ────────────────────────────────────────────────────────
  const half    = GRID * CELL_SIZE * 0.5;
  const SRAD    = CELL_SIZE * 0.5;
  let   active  = 0;

  for (let z = 0; z < GRID; z++)
    for (let y = 0; y < GRID; y++)
      for (let x = 0; x < GRID; x++) {
        const i = idx(x, y, z);
        if (!cells[i]) continue;
        active++;

        const age = cellAge[i];
        const t   = Math.min(age / 35, 1.0);
        // Joven = blanco brillante → envejece hacia color siembra
        const r = lerp(255, cellR[i] || 0,   t);
        const g = lerp(255, cellG[i] || 160, t);
        const b = lerp(255, cellB[i] || 255, t);

        // emissiveMaterial hace que la esfera brille sin depender solo de luces
        emissiveMaterial(r * 0.35, g * 0.35, b * 0.35);
        specularMaterial(r, g, b);
        shininess(60);

        push();
        translate(
          -half + x * CELL_SIZE + CELL_SIZE * 0.5,
          -half + y * CELL_SIZE + CELL_SIZE * 0.5,
          -half + z * CELL_SIZE + CELL_SIZE * 0.5
        );
        sphere(SRAD, 6, 5);
        pop();
      }

  // ── HUD DOM ────────────────────────────────────────────────────────────────
  let activePeople = 0;
  for (let id = 0; id < MAX_PERSONS; id++) if (personActive(id)) activePeople++;
  const hud = document.getElementById('hud');
  if (hud) {
    hud.innerHTML =
      `<span style="color:${connected ? '#46dc82' : '#dc5050'}">${connected ? '● OSC' : '○ Sin OSC'}</span>` +
      `&nbsp;&nbsp;iter:&nbsp;${iteration}&nbsp;|&nbsp;células:&nbsp;${active}&nbsp;|&nbsp;personas:&nbsp;${activePeople}`;
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
  if (key === 'r' || key === 'R') { initCells(); seedNucleus(); }
  if (key === 't' || key === 'T') {
    for (let i = 0; i < 500; i++) {
      const x = floor(random(2, GRID-2)), y = floor(random(2, GRID-2)), z = floor(random(2, GRID-2));
      const col = PERSON_COLORS[floor(random(PERSON_COLORS.length))];
      const ii = idx(x, y, z);
      cells[ii] = 1; cellR[ii] = col[0]; cellG[ii] = col[1]; cellB[ii] = col[2];
    }
  }
  if (key === 'f' || key === 'F') {
    const el = document.querySelector('canvas');
    if (el.requestFullscreen)       el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }
  if (key === ' ') autoRotate = !autoRotate;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
