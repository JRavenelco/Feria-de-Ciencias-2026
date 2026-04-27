import osc from 'osc';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

const OSC_PORT  = 12000;
const WS_PORT   = 8081;
const HTTP_PORT = 8082;

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const CAPTURES_DIR = path.join(__dirname, 'captures');
fs.mkdirSync(CAPTURES_DIR, { recursive: true });

// Detecta la primera IP IPv4 no-loopback (para que el QR apunte a una URL
// accesible desde los celulares de los visitantes en la misma red).
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}
const LAN_IP = getLanIp();

const wss = new WebSocketServer({ port: WS_PORT });
const udpPort = new osc.UDPPort({
  localAddress: '0.0.0.0',
  localPort: OSC_PORT,
  metadata: true,
});

const latestPose = new Map();

// Contadores de diagnóstico
let oscCount = 0;
let lastSender = null;
const oscAddrs = new Set();

function normalizeArgs(args = []) {
  return args.map((entry) => entry.value);
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}

udpPort.on('message', (oscMessage, _timeTag, info) => {
  oscCount++;
  oscAddrs.add(oscMessage.address);
  if (info && info.address) lastSender = `${info.address}:${info.port}`;

  const values = normalizeArgs(oscMessage.args);
  latestPose.set(oscMessage.address, values);
  broadcast({
    type: 'osc',
    address: oscMessage.address,
    values,
    latestPose: Object.fromEntries(latestPose.entries()),
    receivedAt: Date.now(),
  });
});

// errores de udpPort (puerto en uso, etc.)
udpPort.on('error', (err) => {
  console.error('[osc] error:', err.message);
});

udpPort.on('ready', () => {
  console.log(`OSC bridge escuchando UDP en 0.0.0.0:${OSC_PORT}`);
  console.log(`WebSocket disponible en ws://127.0.0.1:${WS_PORT}`);
  console.log(`HTTP captures   en http://${LAN_IP}:${HTTP_PORT}/  (LAN)`);
});

// ── HTTP server: capturas + QR ───────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // CORS abierto: el sketch puede vivir en localhost:3000 y subir aquí.
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ── POST /upload — recibe un PNG en el body, guarda y devuelve URL ──
  if (req.method === 'POST' && u.pathname === '/upload') {
    const chunks = [];
    let total = 0;
    const MAX = 25 * 1024 * 1024;   // 25 MB hard cap
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'imagen demasiado grande' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf      = Buffer.concat(chunks);
        const id       = randomUUID();
        const filename = `${id}.png`;
        fs.writeFileSync(path.join(CAPTURES_DIR, filename), buf);
        const url = `http://${LAN_IP}:${HTTP_PORT}/c/${filename}`;
        console.log(`[capture] ${filename} (${(buf.length / 1024).toFixed(1)} KB) → ${url}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url, id }));
      } catch (err) {
        console.error('[capture] error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── GET /c/:uuid.png — descarga la captura ──
  if (req.method === 'GET' && u.pathname.startsWith('/c/')) {
    const fname = path.basename(u.pathname);
    if (!/^[0-9a-f-]+\.png$/i.test(fname)) {
      res.writeHead(400); res.end('nombre inválido'); return;
    }
    const fp = path.join(CAPTURES_DIR, fname);
    if (!fs.existsSync(fp)) { res.writeHead(404); res.end('no encontrado'); return; }
    res.writeHead(200, {
      'Content-Type':        'image/png',
      'Content-Disposition': `attachment; filename="artpose-${fname}"`,
      'Cache-Control':       'public, max-age=3600',
    });
    fs.createReadStream(fp).pipe(res);
    return;
  }

  // ── GET / — landing simple para verificar que el HTTP está vivo ──
  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const count = fs.readdirSync(CAPTURES_DIR).filter(f => f.endsWith('.png')).length;
    res.end(`<!doctype html><meta charset="utf-8"><title>ArtPose Bridge</title>
      <body style="font-family:monospace;background:#0c0e1c;color:#a0beff;padding:24px">
      <h2>ArtPose Bridge</h2>
      <p>LAN IP: <b>${LAN_IP}</b></p>
      <p>WS:   ws://${LAN_IP}:${WS_PORT}</p>
      <p>HTTP: http://${LAN_IP}:${HTTP_PORT}</p>
      <p>Capturas guardadas: <b>${count}</b></p>
      </body>`);
    return;
  }

  res.writeHead(404); res.end();
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  // ya se imprimió arriba al ready de OSC
});

// Reporte periódico para confirmar que SI están llegando paquetes y de quién.
setInterval(() => {
  const wsCount = wss.clients.size;
  if (oscCount === 0) {
    console.log(`[diag] sin paquetes UDP. ws_clients=${wsCount}.  ` +
      `revisar firewall Windows (UDP/${OSC_PORT}) y --host del publisher.`);
  } else {
    console.log(`[diag] osc_msgs=${oscCount}  addrs=${oscAddrs.size}  ` +
      `last_sender=${lastSender}  ws_clients=${wsCount}`);
  }
  oscCount = 0;
  oscAddrs.clear();
}, 3000);

wss.on('connection', (socket) => {
  socket.send(
    JSON.stringify({
      type: 'snapshot',
      latestPose: Object.fromEntries(latestPose.entries()),
      receivedAt: Date.now(),
    }),
  );
});

udpPort.open();
