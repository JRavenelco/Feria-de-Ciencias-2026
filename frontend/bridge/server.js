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

udpPort.on('message', (oscMessage) => {
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

udpPort.on('ready', () => {
  console.log(`OSC bridge escuchando UDP en 0.0.0.0:${OSC_PORT}`);
  console.log(`WebSocket disponible en ws://127.0.0.1:${WS_PORT}`);
});

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
