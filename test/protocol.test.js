const test = require('node:test');
const assert = require('node:assert');
const P = require('../protocol.js');

test('handshake matches plugin bytes (F0 00 12 34 00 04 F7)', () => {
  assert.deepStrictEqual(P.hello(), [0xf0, 0x00, 0x12, 0x34, 0x00, 0x04, 0xf7]);
});

test('setValue layout matches juce::MidiDevice::setValue', () => {
  // unit 3, id LO_BOOST, value 200 -> lo7 = 200 & 127 = 72, hi = 1
  assert.deepStrictEqual(P.setValue(3, 4, 200, false), [0xf0, 0, 0x12, 0x34, 3, 0x01, 4, 72, 1, 0xf7]);
  assert.strictEqual(P.setValue(3, 4, 10, true)[5], 0x08);
  assert.strictEqual(P.setValue(0, 4, 10, false).length, 10);
});

test('switch byte packs LO CPS and KCS ATTEN', () => {
  const ch = P.defaultChannel();
  ch.loCps = 3; // 100 cps -> 0x01
  ch.hiKcsAtten = 2; // 20 kcs -> 0x10
  const sw = P.channelToRaw(ch).find((p) => p[0] === P.ID.SWITCHES)[1];
  assert.strictEqual(sw, 0x11);
  const back = P.defaultChannel();
  P.applyRaw(back, P.ID.SWITCHES, sw);
  assert.strictEqual(back.loCps, 3);
  assert.strictEqual(back.hiKcsAtten, 2);
});

test('stepped values round-trip', () => {
  const ch = P.defaultChannel();
  for (let i = 0; i < 7; i++) {
    ch.hiKcsBoost = i;
    const v = P.channelToRaw(ch).find((p) => p[0] === P.ID.HI_KCS_BOOST)[1];
    const b = P.defaultChannel();
    P.applyRaw(b, P.ID.HI_KCS_BOOST, v);
    assert.strictEqual(b.hiKcsBoost, i);
  }
  for (let i = 0; i < 4; i++) {
    ch.hiBandwidth = i;
    const v = P.channelToRaw(ch).find((p) => p[0] === P.ID.HI_BANDWIDTH)[1];
    const b = P.defaultChannel();
    P.applyRaw(b, P.ID.HI_BANDWIDTH, v);
    assert.strictEqual(b.hiBandwidth, i);
  }
});

test('parse device report', () => {
  const m = P.parse([0xf0, 0, 0x12, 0x34, 7, 0x01, 5, 0x48, 0x01, 0xf7]);
  assert.strictEqual(m.unit, 7);
  assert.strictEqual(m.id, 5);
  assert.strictEqual(m.value, 200);
  assert.strictEqual(P.parse([0xf0, 0x7e, 0, 6, 2, 0xf7]), null);
});

test('stereo sends only ch1, dual uses cmd 08 for ch2', () => {
  const ch = P.defaultChannel();
  assert.strictEqual(P.messagesFor(1, 'stereo', 1, ch, 'loBoost').length, 0);
  assert.strictEqual(P.messagesFor(1, 'dual', 1, ch, 'loBoost')[0][5], 0x08);
  const all = P.fullRecall(1, 'dual', [ch, ch]);
  assert.deepStrictEqual(all[0], P.setValue(1, 14, 2, false));
  assert.strictEqual(all.length, 1 + 8 + 8);
  assert.strictEqual(P.fullRecall(1, 'stereo', [ch, ch]).length, 9);
});

test('after connect: adopt device values if it reports them, else push saved session', () => {
  const sent = [];
  const c = P.createController({ send: (b) => sent.push(b) });
  c.state.channels[0].loBoost = 120; // saved session
  c.hello();
  c.receive([0xf0, 0, 0x12, 0x34, 5, 1, P.ID.LO_BOOST, 0x48, 1, 0xf7]);
  c.receive([0xf0, 0, 0x12, 0x34, 5, 1, P.ID.HI_BOOST, 10, 0, 0xf7]);
  c.receive([0xf0, 0, 0x12, 0x34, 5, 1, P.ID.MODE, 4, 0, 0xf7]);
  const before = sent.length;
  assert.strictEqual(c.syncAfterConnect(), 'device');
  assert.strictEqual(sent.length, before);
  assert.strictEqual(c.state.channels[0].loBoost, 200);

  const c2 = P.createController({ send: (b) => sent.push(b) });
  c2.hello();
  c2.receive([0xf0, 0, 0x12, 0x34, 5, 1, P.ID.MODE, 4, 0, 0xf7]); // only unit/mode reply
  assert.strictEqual(c2.syncAfterConnect(), 'saved');
});
