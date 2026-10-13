'use strict';

const crypto = require('crypto');

/**
 * One-to-one voice/video call signalling.
 *
 * The server never touches media: it rings the callee, relays WebRTC
 * offers/answers/ICE candidates between the two sockets taking part, and
 * writes a call entry into the chat history when the call finishes.
 *
 * Flow:
 *   caller  call:start  -> callee gets call:incoming (on every device)
 *   callee  call:accept -> caller gets call:accepted, other callee devices get call:ended
 *   both    call:signal -> relayed to the other participant's socket
 *   either  call:end / call:reject / disconnect / ring timeout -> both get call:ended
 */
function createCallManager({ io, store, isOnline, userRoom, postMessage, handle, ringTimeoutMs = 30000 }) {
  const calls = new Map(); // callId -> call

  const inCall = (u) => [...calls.values()].some((c) => c.from === u || c.to === u);

  function logCall(convId, from, kind, status, duration = 0) {
    const conv = store.getConversation(convId);
    postMessage(conv, store.addCallMessage(convId, from, { kind, status, duration }));
  }

  function finish(call, reason) {
    if (!calls.has(call.id)) return;
    calls.delete(call.id);
    clearTimeout(call.timer);

    let status;
    let duration = 0;
    if (call.answeredAt) {
      status = 'completed';
      duration = Math.round((Date.now() - call.answeredAt) / 1000);
    } else {
      status = reason === 'declined' ? 'declined' : 'missed';
    }

    // Every device of both users: dismisses ringing on devices that didn't answer.
    for (const u of [call.from, call.to]) {
      io.to(userRoom(u)).emit('call:ended', { callId: call.id, reason, status, duration });
    }
    logCall(call.convId, call.from, call.kind, status, duration);
  }

  const participant = (callId, username) => {
    const call = calls.get(callId);
    if (!call || (call.from !== username && call.to !== username)) throw new Error('Call not found');
    return call;
  };

  function attach(socket) {
    const me = socket.data.username;

    socket.on('call:start', handle(({ convId, kind }) => {
      if (kind !== 'audio' && kind !== 'video') throw new Error('Invalid call type');
      const conv = store.getConversation(convId);
      if (!conv || !conv.members.includes(me)) throw new Error('Not a member of this chat');
      if (conv.type !== 'direct') throw new Error('Group calls are not supported yet');
      if (inCall(me)) throw new Error('You are already in a call');

      const peer = conv.members.find((m) => m !== me);
      const name = store.publicUser(peer)?.displayName || peer;
      if (!isOnline(peer)) {
        logCall(convId, me, kind, 'missed');
        throw new Error(`${name} is not available right now`);
      }
      if (inCall(peer)) {
        logCall(convId, me, kind, 'missed');
        throw new Error(`${name} is on another call`);
      }

      const call = {
        id: crypto.randomBytes(8).toString('hex'),
        convId,
        kind,
        from: me,
        to: peer,
        callerSocket: socket.id,
        calleeSocket: null,
        answeredAt: null,
      };
      call.timer = setTimeout(() => finish(call, 'no-answer'), ringTimeoutMs);
      calls.set(call.id, call);

      io.to(userRoom(peer)).emit('call:incoming', {
        callId: call.id,
        convId,
        kind,
        from: me,
        user: store.publicUser(me),
      });
      return { callId: call.id };
    }));

    socket.on('call:accept', handle(({ callId }) => {
      const call = participant(callId, me);
      if (call.to !== me) throw new Error('Only the callee can accept');
      if (call.answeredAt) throw new Error('Call already answered');
      clearTimeout(call.timer);
      call.answeredAt = Date.now();
      call.calleeSocket = socket.id;
      io.to(call.callerSocket).emit('call:accepted', { callId });
      // Stop ringing on my other devices.
      socket.to(userRoom(me)).emit('call:ended', { callId, reason: 'answered-elsewhere' });
      return {};
    }));

    socket.on('call:reject', handle(({ callId }) => {
      const call = participant(callId, me);
      if (call.answeredAt) throw new Error('Call already answered');
      finish(call, 'declined');
      return {};
    }));

    socket.on('call:end', handle(({ callId }) => {
      const call = participant(callId, me);
      finish(call, call.answeredAt ? 'ended' : 'cancelled');
      return {};
    }));

    // WebRTC offer/answer/ICE candidate relay.
    socket.on('call:signal', ({ callId, data } = {}) => {
      const call = calls.get(callId);
      if (!call || !call.answeredAt || !data) return;
      let target = null;
      if (socket.id === call.callerSocket) target = call.calleeSocket;
      else if (socket.id === call.calleeSocket) target = call.callerSocket;
      if (target) io.to(target).emit('call:signal', { callId, data });
    });

    socket.on('disconnect', () => {
      for (const call of [...calls.values()]) {
        if (call.callerSocket === socket.id || call.calleeSocket === socket.id) finish(call, 'disconnected');
      }
    });
  }

  return { attach, calls };
}

module.exports = { createCallManager };
