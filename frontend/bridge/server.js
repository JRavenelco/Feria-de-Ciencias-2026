import osc from 'osc';
import { WebSocketServer } from 'ws';

const OSC_PORT = 12000;
const WS_PORT = 8081;

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
