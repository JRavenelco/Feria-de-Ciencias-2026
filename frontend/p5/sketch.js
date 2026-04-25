// ─── ArtPose-Vision · Escena 3D Autómata Celular ────────────────────────────
// Basado en autocelula3d_processing.pde (JRavenelco/automata-vision-jetson)
// Traducido a p5.js WebGL con control por pose OSC

const WS_URL = 'ws://127.0.0.1:8081';

// ── Grid ──────────────────────────────────────────────────────────────────────
const GRID      = 24;   // 24³ = 13 824 celdas
const CELL_SIZE = 13;   // px entre centros
const BOX_SIZE  = CELL_SIZE * 0.76;

// ── Reglas del autómata (inspiradas en autocelula3d_processing.pde) ───────────
const SURVIVE_MIN = 4;
const SURVIVE_MAX = 7;
const BIRTH_N     = 5;
const ITER_EVERY  = 7;  // frames entre pasos

// ── Estado del autómata ───────────────────────────────────────────────────────
let cells;       // Uint8Array  [GRID³]
let nextCells;   // buffer doble
let cellR;       // Uint8Array color R
let cellG;       // Uint8Array color G
let cellB;       // Uint8Array color B
let iteration   = 0;
let iterTimer   = 0;

// ── Cámara ────────────────────────────────────────────────────────────────────
let camAngleX  = -0.52;
let camAngleY  = 0.72;
let camZoom    = 1.0;

// ── OSC / WebSocket ───────────────────────────────────────────────────────────
const pose      = {};
let   connected = false;
let   socket;

// ── HUD font ──────────────────────────────────────────────────────────────────
let monoFont;

// ─────────────────────────────────────────────────────────────────────────────

function idx(x, y, z) {
  return x + GRID * y + GRID * GRID * z;
}

function initCells() {
  const n = GRID * GRID * GRID;
  cells     = new Uint8Array(n);
  nextCells = new Uint8Array(n);
  cellR     = new Uint8Array(n);
  cellG     = new Uint8Array(n);
  cellB     = new Uint8Array(n);
  iteration = 0;
  iterTimer = 0;
}

function countNeighbors(x, y, z) {
  let n = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < 0 || nx >= GRID || ny < 0 || ny >= GRID || nz < 0 || nz >= GRID) continue;
        if (cells[idx(nx, ny, nz)]) n++;
      }
    }
  }
  return n;
}

function stepAutomata() {
  nextCells.fill(0);
  for (let z = 1; z < GRID - 1; z++) {
    for (let y = 1; y < GRID - 1; y++) {
      for (let x = 1; x < GRID - 1; x++) {
        const i = idx(x, y, z);
        const n = countNeighbors(x, y, z);
        if (cells[i]) {
          nextCells[i] = (n >= SURVIVE_MIN && n <= SURVIVE_MAX) ? 1 : 0;
        } else {
          nextCells[i] = (n === BIRTH_N) ? 1 : 0;
        }
        if (nextCells[i] && !cells[i]) {
          // célula nueva: hereda promedio de vecinos activos (simplificado: queda sin color hasta semilla)
          cellR[i] = cellG[i] = cellB[i] = 0;
        }
      }
    }
  }
  const tmp = cells; cells = nextCells; nextCells = tmp;
  iteration++;
}

function seedAtNormalized(nx, ny, nz, r, g, b, radius) {
  const gx = Math.round(constrain(nx, 0, 0.9999) * GRID);
  const gy = Math.round(constrain(ny, 0, 0.9999) * GRID);
  const gz = Math.round(constrain(nz, 0, 0.9999) * GRID);
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = gx + dx, y = gy + dy, z = gz + dz;
        if (x < 1 || x >= GRID - 1 || y < 1 || y >= GRID - 1 || z < 1 || z >= GRID - 1) continue;
        if (random() < 0.62) {
          const i = idx(x, y, z);
          cells[i] = 1;
          cellR[i]  = r;
          cellG[i]  = g;
          cellB[i]  = b;
        }
      }
    }
  }
}

function oscPoint(address) {
  const v = pose[address];
  if (!v || v.length < 3) return null;
  return { x: v[0], y: v[1], z: v[2] };
}

function connectWS() {
  socket = new WebSocket(WS_URL);
  socket.addEventListener('open',    ()  => { connected = true; });
  socket.addEventListener('close',   ()  => { connected = false; setTimeout(connectWS, 2000); });
  socket.addEventListener('message', (e) => {
    const data = JSON.parse(e.data);
    if (data.latestPose) Object.assign(pose, data.latestPose);
  });
}

// ─── p5.js ───────────────────────────────────────────────────────────────────

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  colorMode(RGB, 255);
  frameRate(30);
  initCells();
  connectWS();
  // Sembrar un núcleo inicial para que haya algo que ver desde el primer frame
  for (let i = 0; i < 220; i++) {
    const x = floor(random(2, GRID - 2));
    const y = floor(random(2, GRID - 2));
    const z = floor(random(2, GRID - 2));
    const ii = idx(x, y, z);
    cells[ii] = 1;
    cellR[ii] = floor(random(0, 80));
    cellG[ii] = floor(random(100, 200));
    cellB[ii] = floor(random(180, 255));
  }
}

function draw() {
  background(12, 14, 28);

  // ── Luces ──────────────────────────────────────────────────────────────────
  ambientLight(55, 60, 80);
  directionalLight(180, 210, 255,  0.5,  0.7, -1.0);
  directionalLight( 40,  30,  80, -0.4, -0.3,  0.6);
  pointLight(0, 140, 255, 0, 0, 400);

  // ── Cámara / transform de escena ──────────────────────────────────────────
  const wristL = oscPoint('/pose/wrist/L');
  const wristR = oscPoint('/pose/wrist/R');

  camAngleY += 0.004;
  if (wristL) camAngleX = lerp(camAngleX, map(wristL.y, 0, 1, -0.75, 0.15), 0.04);

  rotateX(camAngleX);
  rotateY(camAngleY);
  scale(camZoom);

  // ── Cubo contenedor wireframe (como dibujarCuboTransparente en .pde) ───────
  noFill();
  stroke(70, 150, 255, 55);
  strokeWeight(0.6);
  box(GRID * CELL_SIZE);

  // ── Siembra por pose ───────────────────────────────────────────────────────
  if (wristL) seedAtNormalized(wristL.x, wristL.y, wristL.z,   0, 190, 255, 2);
  if (wristR) seedAtNormalized(wristR.x, wristR.y, wristR.z, 215,  55, 255, 2);

  // ── Paso del autómata ──────────────────────────────────────────────────────
  iterTimer++;
  if (iterTimer >= ITER_EVERY) {
    stepAutomata();
    iterTimer = 0;
  }

  // ── Dibujar células activas ────────────────────────────────────────────────
  noStroke();
  const half = (GRID * CELL_SIZE) * 0.5;
  let activeCount = 0;

  for (let z = 0; z < GRID; z++) {
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const i = idx(x, y, z);
        if (!cells[i]) continue;
        activeCount++;

        const px = -half + x * CELL_SIZE + CELL_SIZE * 0.5;
        const py = -half + y * CELL_SIZE + CELL_SIZE * 0.5;
        const pz = -half + z * CELL_SIZE + CELL_SIZE * 0.5;

        // Herencia de color: células sin siembra directa toman color base azul
        const r = cellR[i] || 0;
        const g = cellG[i] || 140;
        const b = cellB[i] || 220;

        fill(r, g, b);
        push();
        translate(px, py, pz);
        box(BOX_SIZE);
        pop();
      }
    }
  }

  // ── HUD 2D overlay ─────────────────────────────────────────────────────────
  push();
  ortho(-width / 2, width / 2, -height / 2, height / 2);
  camera();
  noLights();
  noStroke();

  const connColor = connected ? color(70, 210, 130) : color(210, 70, 70);
  const connLabel = connected ? 'OSC conectado' : 'Sin conexión OSC';

  fill(8, 12, 28, 175);
  rect(-width / 2, -height / 2, 340, 44, 0, 0, 8, 0);

  fill(connColor);
  textSize(13);
  textAlign(LEFT, TOP);
  text(`Autómata Celular 3D  |  iter: ${iteration}  |  células: ${activeCount}  |  ${connLabel}`,
       -width / 2 + 12, -height / 2 + 14);
  pop();
}

// ─── Interacción ─────────────────────────────────────────────────────────────

function mouseDragged() {
  camAngleY += (mouseX - pmouseX) * 0.009;
  camAngleX += (mouseY - pmouseY) * 0.009;
}

function mouseWheel(event) {
  camZoom = constrain(camZoom * (1 - event.delta * 0.001), 0.25, 3.5);
  return false;
}

function keyPressed() {
  // R → reiniciar autómata
  if (key === 'r' || key === 'R') initCells();
  // T → sembrar aleatoriamente
  if (key === 't' || key === 'T') {
    for (let i = 0; i < 300; i++) {
      const x = floor(random(2, GRID - 2));
      const y = floor(random(2, GRID - 2));
      const z = floor(random(2, GRID - 2));
      const ii = idx(x, y, z);
      cells[ii] = 1;
      cellR[ii] = floor(random(0, 60));
      cellG[ii] = floor(random(120, 210));
      cellB[ii] = floor(random(180, 255));
    }
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
