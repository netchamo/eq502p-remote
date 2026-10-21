'use strict';
/* Minimal RFC 6455 WebSocket server: text frames, ping/pong, close. Enough for a LAN remote. */
const crypto = require('crypto');
const { EventEmitter } = require('events');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Socket extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock; this.readyState = 1; this.buf = Buffer.alloc(0); this.frags = [];
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._parse(); });
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }
  _closed() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  _parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 1 << 20) { this.sock.destroy(); return; }
      const maskOff = off; if (masked) off += 4;
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[maskOff + (i & 3)];
      this.buf = b.subarray(off + len);
      if (op === 0x8) { this._frame(0x8, Buffer.alloc(0)); this.sock.end(); this._closed(); return; }
      if (op === 0x9) { this._frame(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.frags.push(payload);
        if (fin) { const msg = Buffer.concat(this.frags); this.frags = []; this.emit('message', msg.toString('utf8')); }
      }
    }
  }
  _frame(op, data) {
    if (this.readyState !== 1) return;
    const len = data.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
    this.sock.write(Buffer.concat([head, data]));
  }
  send(text) { this._frame(0x1, Buffer.from(String(text), 'utf8')); }
  close() { this._frame(0x8, Buffer.alloc(0)); this.sock.end(); }
}

function attach(server, path, onConnection) {
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if ((req.url || '').split('?')[0] !== path || !key) { sock.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sock.setNoDelay(true);
    onConnection(new Socket(sock));
  });
}

module.exports = { attach };
