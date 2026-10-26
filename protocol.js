/*
 * Bettermaker EQ502P – USB-MIDI SysEx protocol
 * Reconstructed from the official plugin v3.0.0 (macOS VST, x86_64 slice):
 *   juce::MidiDevice::setValue(int,int,bool), MidiManager::Pimpl::handleAsyncUpdate,
 *   MidiDevice::Pimpl::MIDIReceiveCallback, Eq502pMidiBridge::setConnectedMidiDevice.
 *
 * Device shows up as a class-compliant USB-MIDI device named "Bettermaker 502P".
 *
 *   Handshake (host -> device):  F0 00 12 34 00 04 F7
 *   Set value  (host -> device): F0 00 12 34 <unit> <cmd> <id> <v & 0x7F> <(v >> 7) & 1> F7
 *        cmd 0x01 = selected channel (or both in STEREO), 0x08 = the other channel (DUAL MONO)
 *   Report     (device -> host): F0 00 12 34 <unit> <0|1> <id> <lo7> <hi7>   value = lo + (hi << 7)
 *        <unit> is learned from the first report the device sends.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EQ502P = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HEADER = [0xf0, 0x00, 0x12, 0x34];
  const CMD_SELECTED = 0x01;
  const CMD_OTHER = 0x08;
  const CMD_HELLO = 0x04;

  const ID = {
    LO_BOOST: 4,
    HI_BOOST: 5,
    LO_ATTEN: 9,
    HI_ATTEN: 10,
    HI_KCS_BOOST: 12,
    SWITCHES: 13, // LO CPS bits | HI KCS ATTEN bits
    MODE: 14, // 4 = stereo, 2 = dual mono (ch1 selected), 1 = dual mono (ch2 selected)
    ENGAGE: 15,
    HI_BANDWIDTH: 16,
  };

  const MODE_VALUE = { stereo: 4, dual: 2 };

  /* Control definitions. `steps` = raw device values in UI order. */
  const CONTROLS = {
    engage: { id: ID.ENGAGE, kind: 'toggle', on: 0x40, off: 0x00, label: 'ENGAGE' },
    loBoost: { id: ID.LO_BOOST, kind: 'knob', max: 250, label: 'LOW BOOST' },
    loAtten: { id: ID.LO_ATTEN, kind: 'knob', max: 250, label: 'LOW ATTEN' },
    loCps: { id: ID.SWITCHES, kind: 'switch', steps: [8, 4, 2, 1], names: ['20', '30', '60', '100'], unit: 'CPS', label: 'LOW FREQ' },
    hiBoost: { id: ID.HI_BOOST, kind: 'knob', max: 250, label: 'HIGH BOOST' },
    hiBandwidth: { id: ID.HI_BANDWIDTH, kind: 'step', steps: [0, 85, 172, 255], names: ['1', '2', '3', '4'], label: 'BANDWIDTH' },
    hiKcsBoost: { id: ID.HI_KCS_BOOST, kind: 'step', steps: [64, 32, 16, 8, 4, 2, 1], names: ['3', '4', '5', '8', '10', '12', '16'], unit: 'KCS', label: 'HIGH FREQ' },
    hiAtten: { id: ID.HI_ATTEN, kind: 'knob', max: 250, label: 'HIGH ATTEN' },
    hiKcsAtten: { id: ID.SWITCHES, kind: 'switch', steps: [64, 32, 16], names: ['5', '10', '20'], unit: 'KCS', label: 'ATTEN SEL' },
  };

  function defaultChannel() {
    return { engage: true, loBoost: 0, loAtten: 0, loCps: 0, hiBoost: 0, hiBandwidth: 0, hiKcsBoost: 0, hiAtten: 0, hiKcsAtten: 0 };
  }

  function hello() {
    return [...HEADER, 0x00, CMD_HELLO, 0xf7];
  }

  function setValue(unit, id, value, other) {
    const v = value & 0xff;
    return [...HEADER, unit & 0x7f, other ? CMD_OTHER : CMD_SELECTED, id & 0x7f, v & 0x7f, (v >> 7) & 0x01, 0xf7];
  }

  /* UI state of one channel -> list of [id, rawValue] (SWITCHES is packed). */
  function channelToRaw(ch) {
    const c = CONTROLS;
    const clamp = (x, m) => Math.max(0, Math.min(m, Math.round(x)));
    return [
      [ID.ENGAGE, ch.engage ? c.engage.on : c.engage.off],
      [ID.LO_BOOST, clamp(ch.loBoost, 250)],
      [ID.LO_ATTEN, clamp(ch.loAtten, 250)],
      [ID.HI_BOOST, clamp(ch.hiBoost, 250)],
      [ID.HI_ATTEN, clamp(ch.hiAtten, 250)],
      [ID.HI_BANDWIDTH, c.hiBandwidth.steps[ch.hiBandwidth] ?? 0],
      [ID.HI_KCS_BOOST, c.hiKcsBoost.steps[ch.hiKcsBoost] ?? 64],
      [ID.SWITCHES, (c.loCps.steps[ch.loCps] ?? 8) | (c.hiKcsAtten.steps[ch.hiKcsAtten] ?? 64)],
    ];
  }

  function rawFor(ch, key) {
    const id = CONTROLS[key].id;
    return channelToRaw(ch).find((p) => p[0] === id);
  }

  /* Messages to push one control (key) of channel index (0/1) given the mode. */
  function messagesFor(unit, mode, chIndex, ch, key) {
    if (mode === 'stereo' && chIndex === 1) return [];
    const [id, v] = rawFor(ch, key);
    return [setValue(unit, id, v, mode === 'dual' && chIndex === 1)];
  }

  /* Full recall: mode + every parameter of both channels. */
  function fullRecall(unit, mode, channels) {
    const out = [setValue(unit, ID.MODE, MODE_VALUE[mode] || 4, false)];
    channelToRaw(channels[0]).forEach(([id, v]) => out.push(setValue(unit, id, v, false)));
    if (mode === 'dual') channelToRaw(channels[1]).forEach(([id, v]) => out.push(setValue(unit, id, v, true)));
    return out;
  }

  function stepIndex(steps, raw, maskBits) {
    const r = maskBits ? raw & maskBits : raw;
    let i = steps.indexOf(r);
    if (i < 0) {
      // nearest for continuous-ish stepped values (bandwidth), else highest set bit
      let best = 0, d = Infinity;
      steps.forEach((s, k) => { const dd = Math.abs(s - r); if (dd < d) { d = dd; best = k; } });
      i = best;
    }
    return i;
  }

  /* Apply a raw [id,value] to a channel state object. Returns changed keys. */
  function applyRaw(ch, id, value) {
    const c = CONTROLS;
    switch (id) {
      case ID.ENGAGE: ch.engage = (value & 0x40) !== 0; return ['engage'];
      case ID.LO_BOOST: ch.loBoost = value; return ['loBoost'];
      case ID.LO_ATTEN: ch.loAtten = value; return ['loAtten'];
      case ID.HI_BOOST: ch.hiBoost = value; return ['hiBoost'];
      case ID.HI_ATTEN: ch.hiAtten = value; return ['hiAtten'];
      case ID.HI_BANDWIDTH: ch.hiBandwidth = stepIndex(c.hiBandwidth.steps, value); return ['hiBandwidth'];
      case ID.HI_KCS_BOOST: ch.hiKcsBoost = stepIndex(c.hiKcsBoost.steps, value); return ['hiKcsBoost'];
      case ID.SWITCHES:
        ch.loCps = stepIndex(c.loCps.steps, value, 0x0f);
        ch.hiKcsAtten = stepIndex(c.hiKcsAtten.steps, value, 0x70);
        return ['loCps', 'hiKcsAtten'];
      default: return [];
    }
  }

  /* Parse any SysEx frame. Returns null if not an EQ502P frame. */
  function parse(bytes) {
    const b = Array.from(bytes);
    if (b.length < 5) return null;
    for (let i = 0; i < 4; i++) if (b[i] !== HEADER[i]) return null;
    const msg = { unit: b[4], cmd: b[5], raw: b };
    if (b.length >= 9 && b[5] !== CMD_HELLO) {
      msg.id = b[6];
      msg.value = (b[7] & 0x7f) + ((b[8] & 0x7f) << 7);
    }
    return msg;
  }

  function modeFromValue(v) {
    if (v === 1 || v === 2) return 'dual';
    if (v >= 3) return 'stereo';
    return null;
  }

  const hex = (arr) => Array.from(arr).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

  /*
   * Shared controller used by the browser (Web MIDI) and by the bridge server.
   *   send(bytes)        – write one SysEx frame to the device
   *   onChange(state, info) – state changed (info.keys / info.source)
   *   log(dir, bytes, note)
   */
  function createController(opts) {
    const send = opts.send;
    const onChange = opts.onChange || function () {};
    const log = opts.log || function () {};
    // armed: commands reach the device. A new connection starts disarmed; nothing is sent
    // until the device reports its own settings or the user confirms (arm).
    // armed = live control: changes reach the device. Every new connection starts OFF; only the user turns it on.
    // lastRead = result of the last request for the device's settings.
    const state = { mode: 'stereo', unit: null, channels: [defaultChannel(), defaultChannel()], armed: true, reading: false, lastRead: null };
    const pending = new Map();
    let timer = null;

    function unit() { return state.unit == null ? 0 : state.unit; }
    function out(bytes, note) { log('out', bytes, note); send(bytes); }
    function outArmed(bytes, note) { if (state.armed) out(bytes, note); }

    function flush() {
      timer = null;
      pending.forEach((bytes) => outArmed(bytes));
      pending.clear();
    }
    function queue(key, bytes) {
      if (!state.armed) return; // held in the app until the user confirms
      pending.set(key, bytes);
      if (!timer) timer = setTimeout(flush, 20); // coalesce knob drags
    }

    function set(chIndex, key, value, source) {
      const ch = state.channels[chIndex];
      if (!ch || !(key in ch)) return;
      ch[key] = key === 'engage' ? !!value : Number(value);
      if (state.mode === 'stereo' && chIndex === 0) state.channels[1][key] = ch[key];
      messagesFor(unit(), state.mode, chIndex, ch, key).forEach((m) => queue(chIndex + ':' + m[6], m));
      onChange(state, { keys: [key], ch: chIndex, source: source || 'local' });
    }

    function setMode(mode, source) {
      if (mode !== 'stereo' && mode !== 'dual') return;
      state.mode = mode;
      if (mode === 'stereo') state.channels[1] = Object.assign({}, state.channels[0]);
      recallAll();
      onChange(state, { keys: ['mode'], source: source || 'local' });
    }

    function recallAll() {
      pending.clear();
      if (!state.armed) return;
      fullRecall(unit(), state.mode, state.channels).forEach((m) => out(m, 'recall'));
    }

    function load(snapshot, source) {
      if (snapshot.mode) state.mode = snapshot.mode;
      if (snapshot.channels) state.channels = snapshot.channels.map((c) => Object.assign(defaultChannel(), c));
      recallAll();
      onChange(state, { keys: ['*'], source: source || 'local' });
    }

    let paramReports = 0, readTimer = null;
    /* Ask the device for its settings: send the handshake, collect reports for ~0.9 s. */
    function startRead(note) {
      paramReports = 0; clearTimeout(readTimer);
      state.reading = true;
      out(helloFrame(), note);
      onChange(state, { keys: ['read'], source: 'local' });
      readTimer = setTimeout(finishRead, 900);
    }
    function finishRead() {
      readTimer = null; state.reading = false;
      const ok = paramReports >= 3;
      state.lastRead = { ok, count: paramReports, at: Date.now() };
      if (ok) log('in', [], 'device state adopted (' + paramReports + ' values)');
      onChange(state, { keys: ['read'], source: 'device' });
    }
    /* New connection: live control off, then read the device. Nothing is ever pushed by itself. */
    function hello() { state.armed = false; pending.clear(); startRead('handshake'); }
    function requestState() { startRead('request settings'); }

    /* Live control on: from now on every change goes straight to the device. apply=true also sends everything once. */
    function arm(apply) {
      state.armed = true;
      if (apply) recallAll();
      onChange(state, { keys: ['armed'], source: 'local' });
    }
    function disarm() { state.armed = false; pending.clear(); onChange(state, { keys: ['armed'], source: 'local' }); }

    /* Kept for callers: did the last read get the device's settings? */
    function syncAfterConnect() { return paramReports >= 3 ? 'device' : 'none'; }

    function receive(bytes) {
      const m = parse(bytes);
      if (!m) { log('in', bytes, 'ignored (not EQ502P)'); return; }
      let note = '';
      if (state.unit == null && m.unit != null) { state.unit = m.unit; note = 'unit ' + m.unit + ' learned'; }
      if (m.id != null) {
        paramReports++;
        if (m.id === ID.MODE) {
          const md = modeFromValue(m.value);
          if (md) state.mode = md;
          onChange(state, { keys: ['mode'], source: 'device' });
        } else {
          const keys = applyRaw(state.channels[0], m.id, m.value);
          if (state.mode === 'stereo') applyRaw(state.channels[1], m.id, m.value);
          if (keys.length) onChange(state, { keys, ch: 0, source: 'device' });
        }
      } else onChange(state, { keys: ['unit'], source: 'device' });
      log('in', bytes, note);
    }

    function snapshot() { return JSON.parse(JSON.stringify(state)); }

    return { state, set, setMode, load, recallAll, hello, receive, snapshot, syncAfterConnect, arm, disarm, requestState };
  }

  const helloFrame = hello;

  return { HEADER, ID, CONTROLS, MODE_VALUE, CMD_SELECTED, CMD_OTHER, defaultChannel, hello, setValue, channelToRaw, messagesFor, fullRecall, applyRaw, parse, modeFromValue, hex, createController, DEVICE_NAME_MATCH: /bettermaker|502p/i };
});
