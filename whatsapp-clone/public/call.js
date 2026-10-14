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
window.createCallController = function createCallController({ socket, emit, iceServers, displayName, paintAvatar, me = () => '', toast = () => {}, isPremium = () => true, needPremium = (m) => toast(m) }) {
  const $ = (sel) => document.querySelector(sel);
  const screen = $('#call');
  const grid = $('#call-grid');
  const localVideo = $('#local-video');
  const stateIcon = $('#call-state-icon');

  let call = null;

  // ---------- recording (only with everyone's agreement) ----------
  //
  // The server keeps track of who has agreed and tells everyone; it never receives the
  // recording. The person who asked records on their own device (a mix of everyone's audio, and
  // the video tiles for a video call) and the file is saved on that device. Anyone can stop it
  // at any time, and it stops if somebody new joins or the requester leaves.

  const recButton = $('#call-record');
  const recBadge = $('#call-rec');
  const consent = $('#record-consent');
  const names = (list) => list.map((u) => displayName(u)).join(', ');

  function paintRec() {
    const rec = call?.rec;
    const on = rec?.state === 'on';
    const pending = rec?.state === 'pending';
    recButton.classList.toggle('hidden', !call || call.state !== 'active');
    recButton.classList.toggle('on', on);
    recButton.classList.toggle('waiting', pending);
    recButton.title = on ? 'Stop recording (ends it for everyone)' : pending ? 'Cancel the recording request' : 'Record this call (everyone must agree)';
    recBadge.classList.toggle('hidden', !(on || pending));
    if (on) {
      const secs = Math.floor((Date.now() - rec.startedAt) / 1000);
      recBadge.replaceChildren(Object.assign(document.createElement('span'), { className: 'dot' }), `Recording by ${rec.by === me() ? 'you' : displayName(rec.by)} · ${fmt(Math.max(0, secs))}`);
    } else if (pending) {
      recBadge.replaceChildren(rec.by === me() ? `Waiting for ${names(rec.waiting)} to allow recording…` : `${displayName(rec.by)} asked to record this call`);
    }
  }

  /** Mix everyone's audio (and, for video, a grid of the video tiles) into one stream to record. */
  function buildRecordingStream() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = call.recCtx || new AC();
    const dest = ctx.createMediaStreamDestination();
    const addAudio = (stream) => {
      if (stream && stream.getAudioTracks().length) ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(dest);
    };
    addAudio(call.local); // muted = silent, so a muted microphone is not recorded
    call.peers.forEach((p) => addAudio(p.stream));
    const tracks = [...dest.stream.getAudioTracks()];
    let drawTimer = null;
    if (call.kind === 'video') {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const g = canvas.getContext('2d');
      const draw = () => {
        const videos = [...call.peers.values()].map((p) => p.video).concat(call.local.getVideoTracks().length ? [localVideo] : []).filter((v) => v.videoWidth);
        g.fillStyle = '#000';
        g.fillRect(0, 0, canvas.width, canvas.height);
        const n = Math.max(1, videos.length);
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const cw = canvas.width / cols;
        const chh = canvas.height / rows;
        videos.forEach((v, i) => {
          const s = Math.min(cw / v.videoWidth, chh / v.videoHeight);
          const w = v.videoWidth * s;
          const h = v.videoHeight * s;
          g.drawImage(v, (i % cols) * cw + (cw - w) / 2, Math.floor(i / cols) * chh + (chh - h) / 2, w, h);
        });
      };
      draw();
      drawTimer = setInterval(draw, 66);
      tracks.push(...canvas.captureStream(15).getVideoTracks());
    }
    return { stream: new MediaStream(tracks), ctx, drawTimer };
  }

  function startRecorder() {
    if (!call || call.recorder || !window.MediaRecorder) {
      if (!window.MediaRecorder) toast('This browser cannot record calls');
      return;
    }
    try {
      const built = buildRecordingStream();
      const video = call.kind === 'video';
      const mime = ['video/webm;codecs=vp8,opus', 'video/webm', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m) && (video || m.startsWith('audio')));
      const recorder = new MediaRecorder(built.stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const title = call.title;
      recorder.onstop = () => {
        clearInterval(built.drawTimer);
        built.ctx.close().catch(() => {});
        if (!chunks.length) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || (video ? 'video/webm' : 'audio/webm') });
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `ChatApp-call-${title.replace(/[^\w-]+/g, '_')}-${stamp}.${video ? 'webm' : 'webm'}` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        toast('Recording saved to this device');
      };
      recorder.start(1000);
      call.recorder = recorder;
    } catch (err) {
      console.error('Could not start recording', err);
      toast('Could not start recording on this device');
      socket.emit('call:record-stop', { callId: call.id }); // do not claim to be recording
    }
  }

  function stopRecorder() {
    const r = call?.recorder;
    if (!r) return;
    call.recorder = null;
    if (r.state !== 'inactive') r.stop();
  }

  const REC_NOTES = {
    declined: (ev) => `${displayName(ev.by)} did not allow recording`,
    stopped: (ev) => `${ev.by === me() ? 'You' : displayName(ev.by)} stopped the recording`,
    timeout: () => 'The recording request expired',
    'participant-joined': (ev) => `Recording stopped: ${displayName(ev.by)} joined and has not agreed`,
    'requester-left': (ev) => `Recording stopped: ${displayName(ev.by)} left the call`,
  };

  function onRecord(ev) {
    if (!call || call.id !== ev.callId) return;
    const before = call.rec?.state;
    call.rec = ev.state === 'off' ? null : ev;
    consent.classList.add('hidden');
    if (ev.state === 'pending' && ev.by !== me() && ev.waiting.includes(me())) {
      $('#record-consent-text').textContent = `${displayName(ev.by)} wants to record this call. The recording is saved only on their device. Allow it?`;
      consent.classList.remove('hidden');
    } else if (ev.state === 'on') {
      if (ev.by === me()) startRecorder();
      if (before !== 'on') toast(ev.by === me() ? 'Recording started: everyone agreed' : `${displayName(ev.by)} is recording this call (you agreed)`);
    } else if (ev.state === 'off') {
      stopRecorder();
      if (REC_NOTES[ev.reason]) toast(REC_NOTES[ev.reason](ev));
    }
    paintRec();
  }
  socket.on('call:record', onRecord);

  recButton.addEventListener('click', () => {
    if (!call?.id || call.state !== 'active') return;
    if (call.rec) {
      socket.emit('call:record-stop', { callId: call.id }, () => {});
      return;
    }
    if (!isPremium()) return needPremium('Recording calls is a Premium feature.');
    // Create the audio context now, while the click allows it; the recording itself starts when everyone has agreed.
    try { call.recCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* recording will report it */ }
    socket.emit('call:record-request', { callId: call.id }, (res) => {
      if (res?.code === 'premium_required') needPremium(res.error);
      else if (!res?.ok) toast(res?.error || 'Could not ask to record');
    });
  });
  $('#record-allow').addEventListener('click', () => {
    consent.classList.add('hidden');
    if (call?.id) socket.emit('call:record-respond', { callId: call.id, accept: true }, () => {});
  });
  $('#record-deny').addEventListener('click', () => {
    consent.classList.add('hidden');
    if (call?.id) socket.emit('call:record-respond', { callId: call.id, accept: false }, () => {});
  });

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
    paintRec();
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
    // The call is over: save whatever was recorded so far (the person who asked agreed to this, and so did everyone else).
    if (c.recorder) {
      const r = c.recorder;
      c.recorder = null;
      if (r.state !== 'inactive') r.stop();
    }
    consent.classList.add('hidden');
    recBadge.classList.add('hidden');
    recButton.classList.add('hidden');
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
