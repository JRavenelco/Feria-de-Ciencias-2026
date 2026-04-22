const statusEl = document.getElementById('status');
const socket = new WebSocket('ws://127.0.0.1:8081');
const pose = {};
const trails = {
  left: [],
  right: [],
};

socket.addEventListener('open', () => {
  statusEl.textContent = 'Conectado al puente OSC';
});

socket.addEventListener('close', () => {
  statusEl.textContent = 'Puente OSC desconectado';
});

socket.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  if (!data.latestPose) {
    return;
  }

  for (const [address, values] of Object.entries(data.latestPose)) {
    pose[address] = values;
  }
});

function oscPoint(address) {
  const values = pose[address];
  if (!values || values.length < 3) {
    return null;
  }

  return {
    x: values[0],
    y: values[1],
    z: values[2],
  };
}

function normalizedToCanvas(point) {
  return {
    x: point.x * width,
    y: point.y * height,
    z: point.z,
  };
}

function pushTrail(store, point, hue) {
  store.push({
    ...point,
    hue,
    life: 1,
  });

  if (store.length > 120) {
    store.shift();
  }
}

function drawTrail(store) {
  noFill();
  beginShape();
  for (let i = 0; i < store.length; i += 1) {
    const p = store[i];
    const alpha = map(i, 0, store.length - 1 || 1, 10, 90);
    const weight = map(1 - p.z, 0, 1, 1, 14);
    stroke(p.hue, 90, 100, alpha);
    strokeWeight(weight);
    vertex(p.x, p.y);
  }
  endShape();

  for (let i = store.length - 1; i >= 0; i -= 1) {
    store[i].life *= 0.985;
    if (store[i].life < 0.08) {
      store.splice(i, 1);
    }
  }
}

function drawOrbitBrush(point, hue) {
  const radius = map(1 - point.z, 0, 1, 12, 64);
  noStroke();
  for (let i = 0; i < 10; i += 1) {
    const angle = frameCount * 0.03 + i * TWO_PI * 0.1;
    const px = point.x + cos(angle) * radius * (0.4 + i * 0.06);
    const py = point.y + sin(angle) * radius * (0.4 + i * 0.06);
    fill(hue, 80, 100, 12);
    circle(px, py, 6 + i * 0.8);
  }
}

function setup() {
  createCanvas(windowWidth, windowHeight);
  colorMode(HSL, 360, 100, 100, 100);
  background(230, 45, 6);
}

function draw() {
  fill(230, 45, 6, 8);
  rect(0, 0, width, height);

  const left = oscPoint('/pose/wrist/L');
  const right = oscPoint('/pose/wrist/R');
  const nose = oscPoint('/pose/nose');

  if (left) {
    const point = normalizedToCanvas(left);
    pushTrail(trails.left, point, 190);
    drawOrbitBrush(point, 190);
  }

  if (right) {
    const point = normalizedToCanvas(right);
    pushTrail(trails.right, point, 320);
    drawOrbitBrush(point, 320);
  }

  drawTrail(trails.left);
  drawTrail(trails.right);

  if (nose) {
    const point = normalizedToCanvas(nose);
    noStroke();
    fill(55, 100, 70, 35);
    circle(point.x, point.y, map(1 - point.z, 0, 1, 16, 52));
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
