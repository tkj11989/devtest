'use strict';

/**
 * Voice / video calling with WebRTC, for 1:1 and group calls. Socket.IO is used
 * for signalling only; audio and video flow peer-to-peer. In a group call every
 * participant has one RTCPeerConnection per other participant (a mesh), and
 * whoever joins sends the offers to those already in the call.
 *
 * Usage:
 *   const calls = createCallController({ socket, emit, iceServers: () => [...], displayName, paintAvatar });
 *   calls.start(convId, { kind: 'audio' | 'video', group, title, key });
 */
window.createCallController = function createCallController({ socket, emit, iceServers, displayName, paintAvatar }) {
  const $ = (sel) => document.querySelector(sel);
  const screen = $('#call');
  const grid = $('#call-grid');
  const localVideo = $('#local-video');
  const stateIcon = $('#call-state-icon');

  let call = null;

  // ---------- tones (generated, no audio files needed) ----------

  let audioCtx = null;
  let toneTimer = null;
  function beep(freqs, ms) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const gain = audioCtx.createGain();
      gain.gain.value = 0.08;
      gain.connect(audioCtx.destination);
      for (const f of freqs) {
        const osc = audioCtx.createOscillator();
        osc.frequency.value = f;
        osc.connect(gain);
        osc.start();
        osc.stop(audioCtx.currentTime + ms / 1000);
      }
    } catch {
      /* audio not available */
    }
  }
  function playTone(kind) {
    stopTone();
    const ring = kind === 'ringtone'
      ? () => { beep([880, 1320], 300); setTimeout(() => beep([880, 1320], 300), 450); }
      : () => beep([425], 1000); // ringback heard by the caller
    ring();
    toneTimer = setInterval(ring, kind === 'ringtone' ? 2000 : 3000);
  }
  function stopTone() {
    clearInterval(toneTimer);
    toneTimer = null;
  }

  // ---------- UI ----------

  const ICON_TITLES = {
    calling: 'Ringing',
    call: 'In call',
    'group-call': 'Group call',
    'on-hold': 'On hold',
    'call-end': 'Call ended',
    'call-declined': 'Call declined',
  };
  function setIcon(name) {
    stateIcon.src = `icons/${name}.png`;
    stateIcon.alt = ICON_TITLES[name] || '';
  }
  const setStatus = (text) => { $('#call-status').textContent = text; };
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  function show() {
    $('#call-name').textContent = call.title;
    paintAvatar($('#call-avatar'), call.title, call.key, { group: call.group });
    screen.dataset.kind = call.kind;
    screen.classList.toggle('group', call.group);
    screen.classList.remove('hidden', 'incoming', 'active', 'show-local', 'ended', 'held');
    $('#call-mute').classList.remove('off');
    $('#call-camera').classList.remove('off');
    $('#call-hold').classList.remove('off');
    grid.textContent = '';
    clearTimeout(finishLocal.timer);
  }

  /** Refresh status text, state icon and layout from the current call. */
  function render() {
    if (!call) return;
    const peers = [...call.peers.values()];
    const connected = peers.filter((p) => p.connected);
    const showGrid = call.state === 'active' && (call.kind === 'video' || call.group);
    screen.classList.toggle('active', showGrid);
    screen.classList.toggle('show-local', call.kind === 'video' && hasLiveVideo(call.local));
    const heldBy = peers.filter((p) => p.onHold);
    screen.classList.toggle('held', call.onHold || (!call.group && heldBy.length > 0));

    if (call.state === 'incoming') {
      setIcon(call.group ? 'group-call' : 'calling');
      return;
    }
    if (call.onHold) {
      setIcon('on-hold');
      setStatus('You put the call on hold');
    } else if (!call.group && heldBy.length) {
      setIcon('on-hold');
      setStatus(`${displayName(heldBy[0].username)} put the call on hold`);
    } else if (call.connectedAt) {
      setIcon(call.group ? 'group-call' : 'call');
      const t = fmt(Math.floor((Date.now() - call.connectedAt) / 1000));
      setStatus(call.group ? `${connected.length + 1} in call · ${t}` : t);
    } else if (peers.length) {
      setIcon(call.group ? 'group-call' : 'calling');
      setStatus('Connecting…');
    } else {
      setIcon('calling');
      setStatus(call.ringing ? 'Ringing…' : 'Calling…');
    }
    screen.classList.toggle('ringing', !call.connectedAt && !peers.length);
  }

  const hasLiveVideo = (stream) => !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled);

  function makeTile(username) {
    const tile = document.createElement('div');
    tile.className = 'tile no-video';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    const avatar = document.createElement('div');
    avatar.className = 'avatar xl tile-avatar';
    paintAvatar(avatar, displayName(username), username);
    const name = document.createElement('div');
    name.className = 'tile-name';
    name.textContent = displayName(username);
    const hold = document.createElement('img');
    hold.className = 'tile-hold';
    hold.src = 'icons/on-hold.png';
    hold.alt = 'On hold';
    hold.title = `${displayName(username)} put the call on hold`;
    tile.append(video, avatar, name, hold);
    grid.appendChild(tile);
    return { tile, video };
  }

  function updateTile(p) {
    if (!call) return;
    const live = !!p.stream && p.stream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);
    p.tile.classList.toggle('no-video', call.kind !== 'video' || !live || p.onHold);
    p.tile.classList.toggle('on-hold', !!p.onHold);
    p.video.muted = !!call.onHold;
  }

  // ---------- media ----------

  async function getMedia(kind) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Calls need a secure connection (https:// or localhost)');
    }
    if (kind === 'video') {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        });
      } catch {
        // No camera (or camera blocked): carry on with audio only.
      }
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error('Microphone access was denied or no microphone was found');
    }
  }

  /** Mute, camera-off and hold all decide whether my tracks are sent. */
  function applyLocalTracks() {
    if (!call?.local) return;
    call.local.getAudioTracks().forEach((t) => { t.enabled = !call.muted && !call.onHold; });
    call.local.getVideoTracks().forEach((t) => { t.enabled = !call.cameraOff && !call.onHold; });
  }

  // ---------- peer connections (one per other participant) ----------

  function addPeer(username, initiator) {
    const c = call;
    if (c.peers.has(username)) return c.peers.get(username);
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const p = { username, pc, pending: [], stream: null, connected: false, onHold: c.heldBy.has(username), ...makeTile(username) };
    c.peers.set(username, p);
    c.local.getTracks().forEach((t) => pc.addTrack(t, c.local));
    // Ask to receive video even if we couldn't get a camera ourselves.
    if (c.kind === 'video' && c.local.getVideoTracks().length === 0) pc.addTransceiver('video', { direction: 'recvonly' });

    const send = (data) => socket.emit('call:signal', { callId: c.id, to: username, data });
    pc.onicecandidate = (e) => { if (e.candidate && call === c) send({ candidate: e.candidate }); };
    pc.ontrack = (e) => {
      if (call !== c) return;
      p.stream = e.streams[0] || new MediaStream([e.track]);
      p.video.srcObject = p.stream;
      e.track.onunmute = () => updateTile(p);
      e.track.onmute = () => updateTile(p);
      e.track.onended = () => updateTile(p);
      updateTile(p);
    };
    pc.onconnectionstatechange = () => {
      if (call !== c) return;
      if (pc.connectionState === 'connected') {
        p.connected = true;
        stopTone();
        if (!c.connectedAt) {
          c.connectedAt = Date.now();
          c.state = 'active';
          c.clock = setInterval(render, 1000);
        }
        render();
      } else if (pc.connectionState === 'failed') {
        if (!c.group) hangup('Connection failed');
        else removePeer(username);
      }
    };
    updateTile(p);

    if (initiator) {
      (async () => {
        try {
          await pc.setLocalDescription(await pc.createOffer());
          if (call === c) send({ description: pc.localDescription });
        } catch (err) {
          console.error('Could not create offer', err);
        }
      })();
    }
    render();
    return p;
  }

  function removePeer(username) {
    const p = call?.peers.get(username);
    if (!p) return;
    try { p.pc.close(); } catch { /* ignore */ }
    p.tile.remove();
    call.peers.delete(username);
    render();
  }

  async function onSignal(from, data) {
    const c = call;
    const p = c.peers.get(from) || (data.description?.type === 'offer' ? addPeer(from, false) : null);
    if (!p) return;
    try {
      if (data.description) {
        await p.pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await p.pc.setLocalDescription(await p.pc.createAnswer());
          if (call === c) socket.emit('call:signal', { callId: c.id, to: from, data: { description: p.pc.localDescription } });
        }
        for (const cand of p.pending.splice(0)) {
          try { await p.pc.addIceCandidate(cand); } catch (err) { console.warn('ICE candidate rejected', err); }
        }
      } else if (data.candidate) {
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.candidate);
        else p.pending.push(data.candidate);
      }
    } catch (err) {
      console.error('Call signalling error', err);
    }
  }

  // ---------- actions ----------

  function newCall(fields) {
    return {
      id: null,
      peers: new Map(), // username -> peer
      heldBy: new Set(), // participants who have put the call on hold
      muted: false,
      cameraOff: false,
      onHold: false,
      ...fields,
    };
  }

  /** Begin using `media` for this call; joins everyone already in it. */
  function joinWith({ participants = [], onHold = [], kind }) {
    const c = call;
    if (kind && kind !== c.kind) {
      // Joined a running call of the other kind: match it.
      c.kind = kind;
      screen.dataset.kind = kind;
      if (kind === 'audio') c.local.getVideoTracks().forEach((t) => { t.stop(); c.local.removeTrack(t); });
    }
    onHold.forEach((u) => c.heldBy.add(u));
    c.state = 'connecting';
    for (const u of participants) addPeer(u, true);
    render();
  }

  async function start(convId, { kind, group = false, title, key }) {
    if (call) return;
    call = newCall({ convId, kind, group, title, key, role: 'caller', state: 'outgoing' });
    const c = call;
    show();
    render();
    try {
      c.local = await getMedia(kind);
    } catch (err) {
      return finishLocal(err.message);
    }
    if (call !== c) return stopStream(c.local); // hung up while waiting for permission
    localVideo.srcObject = c.local;
    try {
      const res = await emit('call:start', { convId, kind });
      if (call !== c) return socket.emit('call:end', { callId: res.callId });
      c.id = res.callId;
      if (res.participants.length) {
        joinWith(res); // a group call was already running: we joined it
      } else {
        c.ringing = true;
        playTone('ringback');
        render();
      }
    } catch (err) {
      finishLocal(err.message);
    }
  }

  async function accept() {
    const c = call;
    if (!c || c.state !== 'incoming') return;
    c.state = 'connecting';
    stopTone();
    screen.classList.remove('incoming');
    render();
    try {
      c.local = await getMedia(c.kind);
    } catch (err) {
      socket.emit('call:reject', { callId: c.id });
      return finishLocal(err.message);
    }
    if (call !== c) return stopStream(c.local);
    localVideo.srcObject = c.local;
    try {
      joinWith(await emit('call:accept', { callId: c.id }));
    } catch (err) {
      finishLocal(err.message);
    }
  }

  function hangup(message = 'Call ended') {
    if (!call) return;
    if (call.id) socket.emit(call.state === 'incoming' ? 'call:reject' : 'call:end', { callId: call.id });
    finishLocal(message, call.state === 'incoming' ? 'call-declined' : 'call-end');
  }

  function toggleHold() {
    if (!call || !call.id || call.state === 'incoming') return;
    call.onHold = !call.onHold;
    applyLocalTracks();
    call.peers.forEach(updateTile);
    $('#call-hold').classList.toggle('off', call.onHold);
    $('#call-hold').title = call.onHold ? 'Resume call' : 'Put call on hold';
    socket.emit('call:hold', { callId: call.id, onHold: call.onHold });
    render();
  }

  const stopStream = (s) => s?.getTracks().forEach((t) => t.stop());

  /** Tear down media and show a short message before hiding the call screen. */
  function finishLocal(message, icon = 'call-end') {
    const c = call;
    if (!c) return;
    call = null;
    stopTone();
    clearInterval(c.clock);
    c.peers.forEach((p) => { try { p.pc.close(); } catch { /* ignore */ } });
    stopStream(c.local);
    localVideo.srcObject = null;
    grid.textContent = '';
    screen.classList.remove('active', 'show-local', 'incoming', 'ringing', 'held');
    screen.classList.add('ended');
    setIcon(icon);
    setStatus(message);
    beep([480, 620], 250);
    clearTimeout(finishLocal.timer);
    finishLocal.timer = setTimeout(() => { if (!call) screen.classList.add('hidden'); }, 1500);
  }

  // ---------- socket events ----------

  socket.on('call:incoming', ({ callId, convId, kind, group, title, from }) => {
    if (call) {
      socket.emit('call:reject', { callId });
      return;
    }
    call = newCall({
      id: callId,
      convId,
      kind,
      group,
      title: group ? title : displayName(from),
      key: group ? convId : from,
      role: 'callee',
      state: 'incoming',
    });
    show();
    screen.classList.add('incoming', 'ringing');
    const what = kind === 'video' ? 'video call' : 'voice call';
    setStatus(group ? `${displayName(from)} · Incoming group ${what}…` : `Incoming ${what}…`);
    render();
    playTone('ringtone');
  });

  socket.on('call:joined', ({ callId, username }) => {
    if (!call || call.id !== callId) return;
    stopTone();
    addPeer(username, false); // they will send us an offer
  });

  socket.on('call:left', ({ callId, username }) => {
    if (call && call.id === callId) removePeer(username);
  });

  socket.on('call:signal', ({ callId, from, data }) => {
    if (call && call.id === callId && call.local) onSignal(from, data);
  });

  socket.on('call:hold', ({ callId, username, onHold }) => {
    if (!call || call.id !== callId) return;
    if (onHold) call.heldBy.add(username);
    else call.heldBy.delete(username);
    const p = call.peers.get(username);
    if (p) {
      p.onHold = onHold;
      updateTile(p);
    }
    render();
  });

  const END_MESSAGES = {
    declined: ['Call declined', 'call-declined'],
    'no-answer': ['No answer', 'call-end'],
    cancelled: ['Call cancelled', 'call-end'],
    disconnected: ['Call ended', 'call-end'],
    'answered-elsewhere': ['Answered on another device', 'call'],
  };
  socket.on('call:ended', ({ callId, reason }) => {
    if (!call || call.id !== callId) return;
    let [msg, icon] = END_MESSAGES[reason] || ['Call ended', 'call-end'];
    if ((reason === 'cancelled' || reason === 'no-answer') && call.state === 'incoming') msg = 'Missed call';
    finishLocal(msg, icon);
  });

  // ---------- controls ----------

  $('#call-accept').addEventListener('click', accept);
  $('#call-decline').addEventListener('click', () => hangup('Call declined'));
  $('#call-hangup').addEventListener('click', () => hangup());
  $('#call-hold').addEventListener('click', toggleHold);
  $('#call-mute').addEventListener('click', (e) => {
    if (!call?.local) return;
    call.muted = !call.muted;
    applyLocalTracks();
    e.currentTarget.classList.toggle('off', call.muted);
    e.currentTarget.title = call.muted ? 'Unmute microphone' : 'Mute microphone';
  });
  $('#call-camera').addEventListener('click', (e) => {
    if (!call?.local || !call.local.getVideoTracks().length) return;
    call.cameraOff = !call.cameraOff;
    applyLocalTracks();
    e.currentTarget.classList.toggle('off', call.cameraOff);
    e.currentTarget.title = call.cameraOff ? 'Turn camera on' : 'Turn camera off';
    render();
  });
  window.addEventListener('beforeunload', () => { if (call) hangup(); });

  return {
    start,
    hangup,
    get active() { return !!call; },
    get convId() { return call?.convId || null; },
    /** Stop everything locally (e.g. on logout); the server ends the call when the socket drops. */
    dispose() { if (call) hangup(); },
  };
};
