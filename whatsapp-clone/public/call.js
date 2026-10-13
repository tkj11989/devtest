'use strict';

/**
 * Voice / video calling with WebRTC. Socket.IO is used for signalling only;
 * audio and video flow peer-to-peer between the two browsers.
 *
 * Usage: const calls = createCallController({ socket, emit, iceServers: () => [...], displayName, paintAvatar });
 *        calls.start(convId, peerUsername, 'audio' | 'video');
 */
window.createCallController = function createCallController({ socket, emit, iceServers, displayName, paintAvatar }) {
  const $ = (sel) => document.querySelector(sel);
  const screen = $('#call');
  const remoteVideo = $('#remote-video');
  const localVideo = $('#local-video');

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

  function show() {
    const name = displayName(call.peer);
    $('#call-name').textContent = name;
    paintAvatar($('#call-avatar'), name, call.peer);
    screen.dataset.kind = call.kind;
    screen.classList.remove('hidden', 'show-remote', 'show-local', 'incoming');
    $('#call-mute').classList.remove('off');
    $('#call-camera').classList.remove('off');
  }
  const setStatus = (text) => { $('#call-status').textContent = text; };
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  function updateVideoLayout() {
    if (!call) return;
    const hasVideo = (stream) => !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled);
    screen.classList.toggle('show-local', call.kind === 'video' && hasVideo(call.local));
    screen.classList.toggle('show-remote', call.kind === 'video' && !!call.remote && call.remote.getVideoTracks().length > 0);
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

  // ---------- peer connection ----------

  const signal = (data) => socket.emit('call:signal', { callId: call.id, data });

  function createPeer() {
    const c = call;
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    c.pc = pc;
    c.pendingCandidates = [];
    c.local.getTracks().forEach((t) => pc.addTrack(t, c.local));
    // Ask to receive video even if we couldn't get a camera ourselves.
    if (c.kind === 'video' && c.local.getVideoTracks().length === 0) pc.addTransceiver('video', { direction: 'recvonly' });

    pc.onicecandidate = (e) => { if (e.candidate && call === c) signal({ candidate: e.candidate }); };
    pc.ontrack = (e) => {
      if (call !== c) return;
      c.remote = e.streams[0] || new MediaStream([e.track]);
      remoteVideo.srcObject = c.remote;
      e.track.onunmute = updateVideoLayout;
      e.track.onended = updateVideoLayout;
      updateVideoLayout();
    };
    pc.onconnectionstatechange = () => {
      if (call !== c) return;
      if (pc.connectionState === 'connected') onConnected();
      else if (pc.connectionState === 'failed') hangup('Connection failed');
    };
    return pc;
  }

  function onConnected() {
    if (call.connectedAt) return;
    call.connectedAt = Date.now();
    screen.classList.remove('ringing');
    const tick = () => setStatus(fmt(Math.floor((Date.now() - call.connectedAt) / 1000)));
    tick();
    call.clock = setInterval(tick, 1000);
    updateVideoLayout();
  }

  async function flushCandidates() {
    const c = call;
    for (const cand of c.pendingCandidates.splice(0)) {
      try { await c.pc.addIceCandidate(cand); } catch (err) { console.warn('ICE candidate rejected', err); }
    }
  }

  // ---------- actions ----------

  async function start(convId, peer, kind) {
    if (call) return;
    call = { id: null, convId, peer, kind, role: 'caller' };
    const c = call;
    show();
    screen.classList.add('ringing');
    setStatus('Calling…');
    try {
      c.local = await getMedia(kind);
    } catch (err) {
      return finishLocal(err.message);
    }
    if (call !== c) return stopStream(c.local); // hung up while waiting for permission
    localVideo.srcObject = c.local;
    updateVideoLayout();
    try {
      const { callId } = await emit('call:start', { convId, kind });
      if (call !== c) return socket.emit('call:end', { callId });
      c.id = callId;
      setStatus('Ringing…');
      playTone('ringback');
    } catch (err) {
      finishLocal(err.message);
    }
  }

  async function accept() {
    const c = call;
    if (!c || c.role !== 'callee' || c.accepted) return;
    c.accepted = true;
    stopTone();
    screen.classList.remove('incoming');
    setStatus('Connecting…');
    try {
      c.local = await getMedia(c.kind);
    } catch (err) {
      socket.emit('call:reject', { callId: c.id });
      return finishLocal(err.message);
    }
    if (call !== c) return stopStream(c.local);
    localVideo.srcObject = c.local;
    updateVideoLayout();
    createPeer(); // must exist before the caller's offer arrives
    try {
      await emit('call:accept', { callId: c.id });
    } catch (err) {
      finishLocal(err.message);
    }
  }

  function hangup(message = 'Call ended') {
    if (!call) return;
    if (call.id) {
      const ev = call.role === 'callee' && !call.accepted ? 'call:reject' : 'call:end';
      socket.emit(ev, { callId: call.id });
    }
    finishLocal(message);
  }

  const stopStream = (s) => s?.getTracks().forEach((t) => t.stop());

  /** Tear down media and show a short message before hiding the call screen. */
  function finishLocal(message) {
    const c = call;
    if (!c) return;
    call = null;
    stopTone();
    clearInterval(c.clock);
    try { c.pc?.close(); } catch { /* ignore */ }
    stopStream(c.local);
    remoteVideo.srcObject = null;
    localVideo.srcObject = null;
    screen.classList.remove('show-remote', 'show-local', 'incoming', 'ringing');
    setStatus(message);
    beep([480, 620], 250);
    clearTimeout(finishLocal.timer);
    finishLocal.timer = setTimeout(() => { if (!call) screen.classList.add('hidden'); }, 1500);
  }

  // ---------- socket events ----------

  socket.on('call:incoming', ({ callId, convId, kind, from }) => {
    if (call) {
      socket.emit('call:reject', { callId });
      return;
    }
    clearTimeout(finishLocal.timer);
    call = { id: callId, convId, peer: from, kind, role: 'callee' };
    show();
    screen.classList.add('incoming', 'ringing');
    setStatus(kind === 'video' ? 'Incoming video call…' : 'Incoming voice call…');
    playTone('ringtone');
  });

  socket.on('call:accepted', async ({ callId }) => {
    const c = call;
    if (!c || c.id !== callId) return;
    stopTone();
    setStatus('Connecting…');
    const pc = createPeer();
    try {
      await pc.setLocalDescription(await pc.createOffer());
      if (call === c) signal({ description: pc.localDescription });
    } catch (err) {
      hangup('Could not start the call');
    }
  });

  socket.on('call:signal', async ({ callId, data }) => {
    const c = call;
    if (!c || c.id !== callId || !c.pc) return;
    try {
      if (data.description) {
        await c.pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await c.pc.setLocalDescription(await c.pc.createAnswer());
          if (call === c) signal({ description: c.pc.localDescription });
        }
        await flushCandidates();
      } else if (data.candidate) {
        if (c.pc.remoteDescription) await c.pc.addIceCandidate(data.candidate);
        else c.pendingCandidates.push(data.candidate);
      }
    } catch (err) {
      console.error('Call signalling error', err);
    }
  });

  const END_MESSAGES = {
    declined: 'Call declined',
    'no-answer': 'No answer',
    cancelled: 'Call cancelled',
    disconnected: 'Call ended',
    'answered-elsewhere': 'Answered on another device',
  };
  socket.on('call:ended', ({ callId, reason }) => {
    if (!call || call.id !== callId) return;
    let msg = END_MESSAGES[reason] || 'Call ended';
    if (reason === 'cancelled' && call.role === 'callee') msg = 'Missed call';
    finishLocal(msg);
  });

  // ---------- controls ----------

  $('#call-accept').addEventListener('click', accept);
  $('#call-hangup').addEventListener('click', () => hangup(call?.role === 'callee' && !call.accepted ? 'Call declined' : 'Call ended'));
  $('#call-mute').addEventListener('click', (e) => {
    if (!call?.local) return;
    const tracks = call.local.getAudioTracks();
    const muted = tracks.some((t) => t.enabled);
    tracks.forEach((t) => { t.enabled = !muted; });
    e.currentTarget.classList.toggle('off', muted);
    e.currentTarget.title = muted ? 'Unmute microphone' : 'Mute microphone';
  });
  $('#call-camera').addEventListener('click', (e) => {
    if (!call?.local) return;
    const tracks = call.local.getVideoTracks();
    if (!tracks.length) return;
    const off = tracks.some((t) => t.enabled);
    tracks.forEach((t) => { t.enabled = !off; });
    e.currentTarget.classList.toggle('off', off);
    e.currentTarget.title = off ? 'Turn camera on' : 'Turn camera off';
    updateVideoLayout();
  });
  window.addEventListener('beforeunload', () => { if (call) hangup(); });

  return {
    start,
    hangup,
    get active() { return !!call; },
    /** Stop everything locally (e.g. on logout); the server ends the call when the socket drops. */
    dispose() { if (call) hangup(); },
  };
};
