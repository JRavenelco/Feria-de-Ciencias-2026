/**
 * ArtPoseAutomata.pde
 * Feria de Ciencias 2026 — RPi 5 + OAK Edition
 *
 * Recibe landmarks de pose por OSC y los usa como semillas en una
 * simulación de reacción-difusión (Gray-Scott) renderizada en la GPU
 * mediante fragment shaders GLSL (P2D / VideoCore VII de la RPi 5).
 *
 * Dependencias (Sketch → Import Library):
 *   - oscP5  (Andreas Schlegel)
 *   - netP5  (incluida con oscP5)
 *
 * OSC esperado en puerto 12000:
 *   /pose/wrist/L    [x, y, z]
 *   /pose/wrist/R    [x, y, z]
 *   /pose/elbow/L    [x, y, z]
 *   /pose/elbow/R    [x, y, z]
 *   /pose/shoulder/L [x, y, z]
 *   /pose/shoulder/R [x, y, z]
 *   /pose/nose       [x, y, z]
 */

import oscP5.*;
import netP5.*;

// ── OSC ──────────────────────────────────────────────────────────────────────
OscP5 osc;
static final int OSC_PORT = 12000;

// ── Pose state (coordenadas normalizadas 0‥1) ─────────────────────────────────
PVector wristL    = new PVector(0.30f, 0.60f, 0.40f);
PVector wristR    = new PVector(0.70f, 0.60f, 0.40f);
PVector elbowL    = new PVector(0.38f, 0.45f, 0.35f);
PVector elbowR    = new PVector(0.62f, 0.45f, 0.35f);
PVector shoulderL = new PVector(0.42f, 0.32f, 0.25f);
PVector shoulderR = new PVector(0.58f, 0.32f, 0.25f);
PVector nose      = new PVector(0.50f, 0.22f, 0.12f);

boolean poseActive = false;
int     lastPoseMs = 0;
static final int POSE_TIMEOUT_MS = 2000;

// Suavizado OSC (para evitar saltos bruscos en la visualización)
static final float OSC_ALPHA = 0.25f;

// ── Reacción-difusión Gray-Scott ─────────────────────────────────────────────
// Resolución de la simulación (reducida para CPU; el shader colorea en fullres)
static final int RD_W = 320;
static final int RD_H = 180;

float[] A = new float[RD_W * RD_H];    // concentración de sustancia A
float[] B = new float[RD_W * RD_H];    // concentración de sustancia B
float[] nA, nB;                         // buffers de siguiente frame

// Parámetros Gray-Scott (preset "corales" — orgánico y lento)
float dA   = 1.00f;
float dB   = 0.50f;
float feed = 0.0545f;
float kill = 0.062f;

// Semillas de pose: radio de inyección de B en celdas RD
static final int   SEED_RADIUS   = 14;
static final float SEED_STRENGTH = 0.35f;

// ── Shader y buffers de display ───────────────────────────────────────────────
PShader displayShader;
PImage  rdTex;                          // textura con estado A/B → GPU

// ── Trayectorias de muñecas (para el overlay de trails) ─────────────────────
static final int TRAIL_LEN = 80;
PVector[] trailL = new PVector[TRAIL_LEN];
PVector[] trailR = new PVector[TRAIL_LEN];
int trailHead = 0;

// ── Utilidades ────────────────────────────────────────────────────────────────
float[] lifeL = new float[TRAIL_LEN];
float[] lifeR = new float[TRAIL_LEN];


// ─────────────────────────────────────────────────────────────────────────────
void setup() {
  size(1280, 720, P2D);
  colorMode(HSB, 360, 100, 100, 100);
  frameRate(60);

  // Inicializar simulación RD (todo A=1, B=0 salvo semilla central)
  initRD();

  // Shader de visualización (coloriza A/B → paleta orgánica)
  displayShader = loadShader("rd_display.glsl");
  displayShader.set("resolution", float(RD_W), float(RD_H));

  rdTex = createImage(RD_W, RD_H, ARGB);

  // Inicializar buffers de trayectorias
  for (int i = 0; i < TRAIL_LEN; i++) {
    trailL[i] = new PVector(-1, -1);
    trailR[i] = new PVector(-1, -1);
  }

  // Servidor OSC
  osc = new OscP5(this, OSC_PORT);
  println("OSC escuchando en puerto " + OSC_PORT);
}


void draw() {
  background(0);

  // ── 1. Actualizar simulación RD ──────────────────────────────────────────
  injectPoseSeeds();
  stepRD();

  // ── 2. Volcar estado RD a textura y pasar al shader ─────────────────────
  updateRdTexture();
  displayShader.set("time", millis() / 1000.0f);

  // Dibujar quad fullscreen con shader de colorización
  shader(displayShader);
  image(rdTex, 0, 0, width, height);
  resetShader();

  // ── 3. Overlay: skeleton + trails ───────────────────────────────────────
  drawSkeleton();
  drawTrails();

  // ── 4. HUD ───────────────────────────────────────────────────────────────
  drawHUD();
}


// ─── Inicialización RD ───────────────────────────────────────────────────────
void initRD() {
  nA = new float[RD_W * RD_H];
  nB = new float[RD_W * RD_H];

  for (int i = 0; i < A.length; i++) {
    A[i] = 1.0f;
    B[i] = 0.0f;
  }

  // Semilla inicial en el centro
  int cx = RD_W / 2, cy = RD_H / 2;
  for (int dy = -6; dy <= 6; dy++) {
    for (int dx = -6; dx <= 6; dx++) {
      int idx = (cy + dy) * RD_W + (cx + dx);
      if (idx >= 0 && idx < A.length) {
        A[idx] = 0.5f;
        B[idx] = 0.25f;
      }
    }
  }
}


// ─── Un paso de Gray-Scott (CPU, grid 320×180) ────────────────────────────────
void stepRD() {
  for (int y = 1; y < RD_H - 1; y++) {
    for (int x = 1; x < RD_W - 1; x++) {
      int i  = y * RD_W + x;
      int iN = (y - 1) * RD_W + x;
      int iS = (y + 1) * RD_W + x;
      int iE = y * RD_W + (x + 1);
      int iW = y * RD_W + (x - 1);

      // Laplaciano 5-punto
      float lapA = A[iN] + A[iS] + A[iE] + A[iW] - 4 * A[i];
      float lapB = B[iN] + B[iS] + B[iE] + B[iW] - 4 * B[i];

      float a = A[i], b = B[i];
      float reaction = a * b * b;

      nA[i] = constrain(a + dA * lapA - reaction + feed * (1.0f - a), 0, 1);
      nB[i] = constrain(b + dB * lapB + reaction - (kill + feed) * b, 0, 1);
    }
  }

  // Swap buffers
  float[] tmp = A; A = nA; nA = tmp;
  tmp = B; B = nB; nB = tmp;
}


// ─── Inyectar sustancia B en las posiciones de la pose ───────────────────────
void injectPoseSeeds() {
  boolean live = poseActive && (millis() - lastPoseMs < POSE_TIMEOUT_MS);

  // Inyectar en muñecas (fuerza máxima) y codos (fuerza media)
  injectSeed(wristL,  live ? SEED_STRENGTH      : 0);
  injectSeed(wristR,  live ? SEED_STRENGTH      : 0);
  injectSeed(elbowL,  live ? SEED_STRENGTH * 0.5f : 0);
  injectSeed(elbowR,  live ? SEED_STRENGTH * 0.5f : 0);
  injectSeed(nose,    live ? SEED_STRENGTH * 0.3f : 0);
}

void injectSeed(PVector normPos, float strength) {
  if (strength <= 0) return;
  int cx = (int)(normPos.x * RD_W);
  int cy = (int)(normPos.y * RD_H);
  for (int dy = -SEED_RADIUS; dy <= SEED_RADIUS; dy++) {
    for (int dx = -SEED_RADIUS; dx <= SEED_RADIUS; dx++) {
      float dist = sqrt(dx * dx + dy * dy);
      if (dist > SEED_RADIUS) continue;
      int nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= RD_W || ny < 0 || ny >= RD_H) continue;
      int idx = ny * RD_W + nx;
      float falloff = (1.0f - dist / SEED_RADIUS);
      B[idx] = constrain(B[idx] + strength * falloff, 0, 1);
      A[idx] = constrain(A[idx] - strength * falloff * 0.5f, 0, 1);
    }
  }
}


// ─── Volcar A/B al PImage que pasa al shader ─────────────────────────────────
void updateRdTexture() {
  rdTex.loadPixels();
  for (int i = 0; i < RD_W * RD_H; i++) {
    int av = (int)(A[i] * 255);
    int bv = (int)(B[i] * 255);
    rdTex.pixels[i] = 0xFF000000 | (av << 16) | (bv << 8);
  }
  rdTex.updatePixels();
  displayShader.set("tex", rdTex);
}


// ─── Overlay: skeleton (Processing 2D) ───────────────────────────────────────
void drawSkeleton() {
  boolean live = poseActive && (millis() - lastPoseMs < POSE_TIMEOUT_MS);
  float alpha = live ? 80 : 30;

  strokeWeight(2);
  noFill();

  // Brazo izquierdo
  stroke(190, 80, 100, alpha);
  drawBone(shoulderL, elbowL);
  drawBone(elbowL, wristL);

  // Brazo derecho
  stroke(320, 80, 100, alpha);
  drawBone(shoulderR, elbowR);
  drawBone(elbowR, wristR);

  // Hombros
  stroke(50, 60, 90, alpha * 0.7f);
  drawBone(shoulderL, shoulderR);

  // Muñecas — punto brillante
  drawJoint(wristL, 190, live);
  drawJoint(wristR, 320, live);
  drawJoint(nose,    50, live);
}

void drawBone(PVector a, PVector b) {
  line(a.x * width, a.y * height, b.x * width, b.y * height);
}

void drawJoint(PVector pt, float hue, boolean live) {
  float z = pt.z;
  float sz = map(z, 0, 1, 24, 8);
  float bright = live ? 95 : 50;
  noStroke();
  fill(hue, 90, bright, 90);
  ellipse(pt.x * width, pt.y * height, sz, sz);
}


// ─── Overlay: trails de muñecas ──────────────────────────────────────────────
void drawTrails() {
  // Actualizar trayectorias cada frame
  trailL[trailHead] = wristL.copy();
  trailR[trailHead] = wristR.copy();

  for (int i = 0; i < TRAIL_LEN - 1; i++) {
    int idx  = (trailHead - i + TRAIL_LEN) % TRAIL_LEN;
    int idxN = (trailHead - i - 1 + TRAIL_LEN) % TRAIL_LEN;
    float t = 1.0f - (float)i / TRAIL_LEN;

    strokeWeight(map(trailL[idx].z, 0, 1, 3, 1) * t);
    stroke(190, 85, 95, t * 70);
    if (trailL[idx].x >= 0 && trailL[idxN].x >= 0)
      line(trailL[idx].x * width, trailL[idx].y * height,
           trailL[idxN].x * width, trailL[idxN].y * height);

    strokeWeight(map(trailR[idx].z, 0, 1, 3, 1) * t);
    stroke(320, 85, 95, t * 70);
    if (trailR[idx].x >= 0 && trailR[idxN].x >= 0)
      line(trailR[idx].x * width, trailR[idx].y * height,
           trailR[idxN].x * width, trailR[idxN].y * height);
  }

  trailHead = (trailHead + 1) % TRAIL_LEN;
}


// ─── HUD ─────────────────────────────────────────────────────────────────────
void drawHUD() {
  fill(0, 0, 90, 85);
  noStroke();
  textSize(13);
  boolean live = poseActive && (millis() - lastPoseMs < POSE_TIMEOUT_MS);
  String status = live ? "POSE ACTIVA" : "esperando pose...";
  text("OSC :" + OSC_PORT + "  |  " + status + "  |  " + int(frameRate) + " fps", 14, height - 12);

  // Controles
  textSize(11);
  fill(0, 0, 70, 60);
  text("R: reiniciar RD  |  +/-: feed/kill  |  ESC: salir", 14, height - 28);
}


// ─── Teclado ─────────────────────────────────────────────────────────────────
void keyPressed() {
  if (key == 'r' || key == 'R') initRD();
  if (key == '+' || key == '=') feed = constrain(feed + 0.001f, 0.01f, 0.1f);
  if (key == '-' || key == '_') feed = constrain(feed - 0.001f, 0.01f, 0.1f);
  if (key == ']') kill = constrain(kill + 0.001f, 0.04f, 0.08f);
  if (key == '[') kill = constrain(kill - 0.001f, 0.04f, 0.08f);
}


// ─── Recepción OSC ────────────────────────────────────────────────────────────
void oscEvent(OscMessage msg) {
  String addr = msg.addrPattern();

  if (!msg.checkTypetag("fff")) return;   // esperamos [x, y, z]
  float x = msg.get(0).floatValue();
  float y = msg.get(1).floatValue();
  float z = msg.get(2).floatValue();

  switch (addr) {
    case "/pose/wrist/L":    wristL    = lerpVec(wristL,    x, y, z); break;
    case "/pose/wrist/R":    wristR    = lerpVec(wristR,    x, y, z); break;
    case "/pose/elbow/L":    elbowL    = lerpVec(elbowL,    x, y, z); break;
    case "/pose/elbow/R":    elbowR    = lerpVec(elbowR,    x, y, z); break;
    case "/pose/shoulder/L": shoulderL = lerpVec(shoulderL, x, y, z); break;
    case "/pose/shoulder/R": shoulderR = lerpVec(shoulderR, x, y, z); break;
    case "/pose/nose":       nose      = lerpVec(nose,      x, y, z); break;
    default: return;
  }

  poseActive  = true;
  lastPoseMs  = millis();
}

PVector lerpVec(PVector prev, float x, float y, float z) {
  return new PVector(
    lerp(prev.x, x, OSC_ALPHA),
    lerp(prev.y, y, OSC_ALPHA),
    lerp(prev.z, z, OSC_ALPHA)
  );
}
