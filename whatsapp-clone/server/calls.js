'use strict';

const crypto = require('crypto');

/** Mesh calls send every participant's media to every other participant; keep groups small. */
const MAX_PARTICIPANTS = 6;

/**
 * Voice/video call signalling for 1:1 and group calls.
 *
 * The server never touches media: it rings the invitees, tells participants who
 * joins and leaves, relays WebRTC offers/answers/ICE candidates between
 * participants, and writes a call entry into the chat history at the end.
 * Every participant connects directly to every other one (a "mesh"); whoever
 * joins sends the offers to those already in the call.
 *
 *   call:start   ring the chat's other members (or join the group call already running)
 *   call:accept  join a call I'm being rung for; ack lists who is already in it
 *   call:reject  decline ringing
 *   call:end     leave the call (a 1:1 call ends when either side leaves)
 *   call:signal  { to, data } relayed to that participant
 *   call:hold    { onHold } shown to the other participants
 *   call:record-request / call:record-respond / call:record-stop: recording needs EVERYONE
 *                in the call to agree first (see "recording consent" below)
 *
 * Server -> client: call:incoming, call:joined, call:left, call:signal,
 * call:hold, call:ended, and call:state (to every chat member, so group
 * members can see and join a running call).
 */
/**
 * `notify(username, event, payload)` reaches all of a user's devices (and their webhooks);
 * per-socket events (joined/left/signal/hold) go only to the sockets in the call.
 */
function createCallManager({ io, store, isOnline, notify, postMessage, handle, assertCallsOn = () => {}, assertRecordingOn = () => {}, ringTimeoutMs = 30000, recordConsentMs = 30000, recordCooldownMs = 30000 }) {
  const calls = new Map(); // callId -> call

  // ---------- recording consent ----------
  //
  // Recording a call is only allowed when every person in it has agreed. The server keeps the
  // consent state and tells everyone (a recording indicator must always be visible); the audio
  // and video never reach the server: the person who asked records on their own device.
  //
  //   pending  someone asked; waiting for everyone else to accept (30 seconds)
  //   on       everyone agreed: the requester's device records
  //
  // Anyone can stop it at any time (withdrawing consent ends it for everyone). If someone new
  // joins, recording stops: they have not agreed. If the requester leaves, it stops.

  const recView = (call) => (call.rec
    ? { state: call.rec.state, by: call.rec.by, startedAt: call.rec.startedAt || null, waiting: call.rec.state === 'pending' ? [...call.participants.keys()].filter((u) => !call.rec.accepted.has(u)) : [] }
    : { state: 'off' });

  const tellRec = (call, extra = {}) => {
    for (const sid of call.participants.values()) io.to(sid).emit('call:record', { callId: call.id, ...recView(call), ...extra });
  };

  function endRec(call, reason, by) {
    if (!call.rec) return;
    clearTimeout(call.rec.timer);
    call.rec = null;
    tellRec(call, { reason, ...(by ? { by } : {}) });
  }

  /** Everyone still in the call has agreed: recording starts. */
  function maybeStartRec(call) {
    const rec = call.rec;
    if (!rec || rec.state !== 'pending') return;
    if ([...call.participants.keys()].every((u) => rec.accepted.has(u))) {
      clearTimeout(rec.timer);
      rec.state = 'on';
      rec.startedAt = Date.now();
      call.recorded = true;
      tellRec(call);
    }
  }

  const inCall = (u) => [...calls.values()].some((c) => c.participants.has(u) || c.ringing.has(u));
  const callForConv = (convId) => [...calls.values()].find((c) => c.convId === convId) || null;

  /** Summary of a running call, for chat members who are not in it. */
  const describe = (call) => ({
    callId: call.id,
    kind: call.kind,
    group: call.group,
    participants: [...call.participants.keys()],
    startedBy: call.from,
  });

  function announce(call, active = calls.has(call.id)) {
    const conv = store.getConversation(call.convId);
    if (!conv) return;
    for (const m of conv.members) {
      notify(m, 'call:state', { convId: call.convId, call: active ? describe(call) : null });
    }
  }

  function finish(call, reason) {
    if (!calls.has(call.id)) return;
    calls.delete(call.id);
    clearTimeout(call.timer);
    clearTimeout(call.rec?.timer);

    let status;
    let duration = 0;
    if (call.answeredAt) {
      status = 'completed';
      duration = Math.round((Date.now() - call.answeredAt) / 1000);
    } else {
      status = reason === 'declined' ? 'declined' : 'missed';
    }

    // Every device of everyone involved: also dismisses ringing on devices that didn't answer.
    for (const u of new Set([call.from, ...call.invited, ...call.joined])) {
      notify(u, 'call:ended', { callId: call.id, reason, status, duration });
    }
    announce(call, false);
    const conv = store.getConversation(call.convId);
    postMessage(conv, store.addCallMessage(call.convId, call.from, { kind: call.kind, status, duration, group: call.group, recorded: !!call.recorded }, [...call.joined]));
  }

  /** End the call once nobody (or only one person, with nobody left ringing) remains. */
  function settle(call, reason) {
    const n = call.participants.size;
    if (n === 0 || (n === 1 && call.ringing.size === 0)) finish(call, reason);
    else announce(call);
  }

  function stopRinging(call, username, reason) {
    if (!call.ringing.delete(username)) return;
    notify(username, 'call:ended', { callId: call.id, reason });
  }

  function join(call, socket, username) {
    if (call.participants.size >= MAX_PARTICIPANTS) throw new Error(`Calls are limited to ${MAX_PARTICIPANTS} people`);
    const others = [...call.participants.keys()];
    // Someone new has not agreed to be recorded: recording stops (they can ask again together).
    if (call.rec) endRec(call, 'participant-joined', username);
    call.ringing.delete(username);
    call.participants.set(username, socket.id);
    call.joined.add(username);
    if (!call.answeredAt && others.length) call.answeredAt = Date.now();
    for (const u of others) io.to(call.participants.get(u)).emit('call:joined', { callId: call.id, username });
    // Stop ringing on my other devices.
    socket.to(`user:${username}`).emit('call:ended', { callId: call.id, reason: 'answered-elsewhere' });
    announce(call);
    return { participants: others, onHold: [...call.onHold], recording: recView(call) };
  }

  function leave(call, username, reason) {
    if (!call.participants.delete(username)) return;
    call.onHold.delete(username);
    for (const sid of call.participants.values()) io.to(sid).emit('call:left', { callId: call.id, username });
    if (call.rec) {
      if (call.rec.by === username) endRec(call, 'requester-left', username);
      else if (call.group && call.participants.size >= 2) maybeStartRec(call); // whoever it was waiting for is gone
    }
    if (!call.group) {
      finish(call, call.answeredAt ? reason : 'cancelled');
      return;
    }
    if (call.participants.size === 0) call.ringing.forEach((u) => stopRinging(call, u, 'cancelled'));
    settle(call, call.answeredAt ? reason : 'cancelled');
  }

  const participantCall = (callId, username) => {
    const call = calls.get(callId);
    if (!call || !call.participants.has(username)) throw new Error('Call not found');
    return call;
  };

  function attach(socket) {
    const me = socket.data.username;

    socket.on('call:start', handle(({ convId, kind }) => {
      assertCallsOn();
      if (kind !== 'audio' && kind !== 'video') throw new Error('Invalid call type');
      const conv = store.getConversation(convId);
      if (!conv || !conv.members.includes(me)) throw new Error('Not a member of this chat');

      // A group call is already running in this chat: join it.
      const running = callForConv(convId);
      if (running && running.group && !running.participants.has(me)) {
        if (inCall(me) && !running.ringing.has(me)) throw new Error('You are already in a call');
        return { callId: running.id, kind: running.kind, group: true, ...join(running, socket, me) };
      }
      if (inCall(me)) throw new Error('You are already in a call');

      const others = conv.members.filter((m) => m !== me);
      const group = conv.type === 'group';
      const logMissed = () => postMessage(conv, store.addCallMessage(convId, me, { kind, status: 'missed', group }, []));
      let ring;
      if (!group) {
        const peer = others[0];
        const name = store.publicUser(peer)?.displayName || peer;
        if (store.hasBlocked(me, peer)) throw new Error(`Unblock ${name} to call them`);
        // Blocked by them: they're simply never available.
        if (store.hasBlocked(peer, me) || !isOnline(peer)) {
          if (!store.hasBlocked(peer, me)) logMissed();
          throw new Error(`${name} is not available right now`);
        }
        if (inCall(peer)) {
          logMissed();
          throw new Error(`${name} is on another call`);
        }
        ring = [peer];
      } else {
        ring = others.filter((u) => isOnline(u) && !inCall(u)).slice(0, MAX_PARTICIPANTS - 1);
        if (!ring.length) {
          logMissed();
          throw new Error('No one in this group is available right now');
        }
      }

      const call = {
        id: crypto.randomBytes(8).toString('hex'),
        convId,
        kind,
        group,
        from: me,
        invited: new Set(ring),
        ringing: new Set(ring),
        participants: new Map([[me, socket.id]]), // username -> socket id
        joined: new Set([me]),
        onHold: new Set(),
        answeredAt: null,
      };
      call.timer = setTimeout(() => {
        call.ringing.forEach((u) => stopRinging(call, u, 'no-answer'));
        settle(call, 'no-answer');
      }, ringTimeoutMs);
      calls.set(call.id, call);

      const title = group ? conv.name : null;
      for (const u of ring) {
        notify(u, 'call:incoming', {
          callId: call.id,
          convId,
          kind,
          group,
          title,
          from: me,
          user: store.publicUser(me),
          participants: [me],
        });
      }
      announce(call);
      return { callId: call.id, kind, group, participants: [], onHold: [] };
    }));

    socket.on('call:accept', handle(({ callId }) => {
      const call = calls.get(callId);
      if (!call || !(call.ringing.has(me) || (call.group && store.isMember(call.convId, me)))) {
        throw new Error('Call not found');
      }
      if (call.participants.has(me)) throw new Error('Already in this call');
      return join(call, socket, me);
    }));

    socket.on('call:reject', handle(({ callId }) => {
      const call = calls.get(callId);
      if (!call || !call.ringing.has(me)) throw new Error('Call not found');
      if (!call.group) {
        finish(call, 'declined');
      } else {
        stopRinging(call, me, 'declined');
        settle(call, call.answeredAt ? 'ended' : 'declined');
      }
      return {};
    }));

    socket.on('call:end', handle(({ callId }) => {
      const call = participantCall(callId, me);
      if (call.participants.get(me) !== socket.id) throw new Error('This call is on another device');
      leave(call, me, 'ended');
      return {};
    }));

    // WebRTC offer/answer/ICE candidate relay between two participants.
    socket.on('call:signal', ({ callId, to, data } = {}) => {
      const call = calls.get(callId);
      if (!call || !data || call.participants.get(me) !== socket.id) return;
      const target = call.participants.get(to);
      if (target) io.to(target).emit('call:signal', { callId, from: me, data });
    });

    // ----- recording consent -----

    socket.on('call:record-request', handle(({ callId }) => {
      assertRecordingOn();
      const call = participantCall(callId, me);
      if (call.participants.get(me) !== socket.id) throw new Error('This call is on another device');
      if (!call.answeredAt || call.participants.size < 2) throw new Error('Recording needs at least two people in the call');
      if (call.rec) throw new Error(call.rec.state === 'on' ? 'This call is already being recorded' : 'A recording request is already waiting for answers');
      const wait = (call.recCooldown?.get(me) || 0) - Date.now();
      if (wait > 0) throw new Error(`Someone declined. Wait ${Math.ceil(wait / 1000)} seconds before asking again.`);
      call.rec = { state: 'pending', by: me, accepted: new Set([me]) };
      call.rec.timer = setTimeout(() => endRec(call, 'timeout'), recordConsentMs);
      tellRec(call, { expiresIn: Math.round(recordConsentMs / 1000) });
      return recView(call);
    }));

    socket.on('call:record-respond', handle(({ callId, accept }) => {
      const call = participantCall(callId, me);
      if (!call.rec || call.rec.state !== 'pending') throw new Error('There is no recording request to answer');
      if (!accept) {
        (call.recCooldown = call.recCooldown || new Map()).set(call.rec.by, Date.now() + recordCooldownMs);
        endRec(call, 'declined', me);
        return {};
      }
      call.rec.accepted.add(me);
      if (call.rec.state === 'pending') tellRec(call, { accepted: me });
      maybeStartRec(call);
      return recView(call);
    }));

    // Withdrawing consent: anyone can end the recording, any time.
    socket.on('call:record-stop', handle(({ callId }) => {
      const call = participantCall(callId, me);
      if (!call.rec) return {};
      endRec(call, 'stopped', me);
      return {};
    }));

    socket.on('call:hold', handle(({ callId, onHold }) => {
      const call = participantCall(callId, me);
      if (onHold) call.onHold.add(me);
      else call.onHold.delete(me);
      for (const [u, sid] of call.participants) {
        if (u !== me) io.to(sid).emit('call:hold', { callId, username: me, onHold: !!onHold });
      }
      return {};
    }));

    socket.on('disconnect', () => {
      for (const call of [...calls.values()]) {
        if (call.participants.get(me) === socket.id) leave(call, me, 'disconnected');
      }
    });
  }

  return { attach, calls, activeCallFor: (convId) => { const c = callForConv(convId); return c ? describe(c) : null; } };
}

module.exports = { createCallManager, MAX_PARTICIPANTS };
