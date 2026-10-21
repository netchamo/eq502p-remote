#!/usr/bin/env node
/*
 * EQ502P Remote – bridge.
 * Runs on the Mac/PC the EQ502P is plugged into. Finds the "Bettermaker 502P" USB-MIDI port,
 * serves the control page to any phone/tablet on the same Wi-Fi and relays commands over WebSocket.
 *
 *   node server.js            – real device
 *   node server.js --mock     – simulated device (no hardware needed)
 *   PORT=8502 node server.js  – choose port (default 8502)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tinyWs = require('./lib/tiny-ws.js');
const P = require('./protocol.js');

const PORT = Number(process.env.PORT) || 8502;
const MOCK = process.argv.includes('--mock');
const ROOT = __dirname;
const SERVED = new Set(['/index.html', '/protocol.js']); // only the page itself is served
const STATE_FILE = path.join(__dirname, 'last-state.json');

/* ---------------- MIDI layer ---------------- */
function createMidi(onMessage, onStatus) {
  if (MOCK) return createMockMidi(onMessage, onStatus);
  let midi;
  try { midi = require('@julusian/midi'); }
  catch (e) {
    console.error('\n  @julusian/midi is not installed. Run "npm install" in this folder first.\n');
    process.exit(1);
  }
  const input = new midi.Input();
  const output = new midi.Output();
  input.ignoreTypes(false, true, true); // receive SysEx, ignore timing + active sensing
  input.on('message', (_dt, msg) => onMessage(msg));
  let openName = null;

  function find(port) {
    for (let i = 0; i < port.getPortCount(); i++) if (P.DEVICE_NAME_MATCH.test(port.getPortName(i))) return i;
    return -1;
  }
  function poll() {
    const oi = find(output), ii = find(input);
    if (openName && oi < 0) {
      try { output.closePort(); input.closePort(); } catch (e) {}
      openName = null; onStatus(false, null);
    }
    if (!openName && oi >= 0) {
      output.openPort(oi);
      if (ii >= 0) input.openPort(ii);
      openName = output.getPortName(oi);
      onStatus(true, openName);
    }
  }
  setImmediate(poll);
  setInterval(poll, 2000);
  return { send: (bytes) => { if (openName) output.sendMessage(bytes); }, isOpen: () => !!openName, name: () => openName };
}

/* A fake EQ502P: answers the handshake with its unit number and echoes values back. */
function createMockMidi(onMessage, onStatus) {
  const UNIT = 5;
  setTimeout(() => onStatus(true, 'Bettermaker 502P (simulated)'), 300);
  return {
    isOpen: () => true,
    name: () => 'Bettermaker 502P (simulated)',
    send(bytes) {
      const m = P.parse(bytes);
      if (!m) return;
      if (m.cmd === 0x04) setTimeout(() => onMessage([...P.HEADER, UNIT, 0x01, P.ID.MODE, 4, 0, 0xf7]), 40);
    },
  };
}

/* ---------------- controller + clients ---------------- */
const clients = new Set();
const broadcast = (obj) => { const s = JSON.stringify(obj); clients.forEach((c) => c.readyState === 1 && c.send(s)); };

let saveTimer;
const ctl = P.createController({
  send: (bytes) => midiIo.send(bytes),
  log: (dir, bytes, note) => broadcast({ type: 'log', dir, hex: P.hex(bytes), note }),
  onChange: (state) => {
    broadcast({ type: 'state', state });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { fs.writeFileSync(STATE_FILE, JSON.stringify({ mode: state.mode, channels: state.channels })); } catch (e) {} }, 500);
  },
});

try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); ctl.state.mode = s.mode; ctl.state.channels = s.channels; } catch (e) {}

let device = { connected: false, name: null };
const midiIo = createMidi(
  (msg) => { if (msg[0] === 0xf0) ctl.receive(msg); },
  (connected, name) => {
    device = { connected, name };
    console.log(connected ? '  ✓ EQ502P connected: ' + name : '  ✗ EQ502P disconnected');
    broadcast({ type: 'device', ...device });
    if (connected) {
      ctl.state.unit = null;
      ctl.hello();
      // wait for the device to answer; adopt its settings if it reports them, else restore the saved session
      setTimeout(() => {
        const src = ctl.syncAfterConnect();
        console.log(src === 'device' ? '  ↺ showing the settings reported by the device' : '  ↺ restored last saved session to the device');
      }, 900);
    }
  }
);

/* ---------------- HTTP + WebSocket ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/bridge-config.js') {
    res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
    const phoneUrls = lanAddresses().map((ip) => 'http://' + ip + ':' + PORT);
    return res.end('window.EQ502P_BRIDGE = ' + JSON.stringify({ path: '/ws', phoneUrls, mock: MOCK }) + ';');
  }
  const name = url === '/' ? '/index.html' : url;
  if (!SERVED.has(name)) { res.writeHead(404); return res.end('not found'); }
  const file = path.join(ROOT, name);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (ext === '.html') res.write('<!doctype html><html lang="he"><meta charset="utf-8">');
    res.end(data);
  });
});

tinyWs.attach(server, '/ws', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'state', state: ctl.state }));
  ws.send(JSON.stringify({ type: 'device', ...device }));
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.type === 'set') ctl.set(m.ch | 0, String(m.key), m.value, 'remote');
    else if (m.type === 'mode') ctl.setMode(m.mode, 'remote');
    else if (m.type === 'load' && m.snapshot) ctl.load(m.snapshot, 'remote');
    else if (m.type === 'recall') ctl.recallAll();
    else if (m.type === 'hello') ctl.hello();
  });
});

function lanAddresses() {
  const out = [];
  Object.values(os.networkInterfaces()).forEach((list) => (list || []).forEach((a) => { if (a.family === 'IPv4' && !a.internal) out.push(a.address); }));
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanAddresses();
  const url = 'http://' + (ips[0] || 'localhost') + ':' + PORT;
  console.log('\n  EQ502P Remote is running' + (MOCK ? ' (simulated device)' : ''));
  console.log('  On this computer:  http://localhost:' + PORT);
  ips.forEach((ip) => console.log('  On your phone:     http://' + ip + ':' + PORT));
  console.log('  Open the first link on this computer to see a QR code for your phone.');
  console.log('  Phone and computer must be on the same Wi-Fi.\n');
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    require('child_process').exec(cmd + ' http://localhost:' + PORT);
  }
  void url;
});
