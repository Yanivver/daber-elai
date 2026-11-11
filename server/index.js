const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const db = require('./db');

db.load();

const MAX_PER_FREQ = 8;
const MAX_FREQ = 99 * 100; // 99:00
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
const PUBLIC = path.join(__dirname, '..', 'public');
// Première page : l'image דבר אלי sur fond noir. L'application est sur /app.
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'splash.html')));
app.get('/app', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.use(express.static(PUBLIC, { index: false }));

// ---------- Authentification (REST) ----------
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,20}$/;

app.post('/api/register', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: "Nom d'utilisateur : 3 à 20 caractères (lettres, chiffres, _ . -)" });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum' });
  if (db.findByUsername(username)) return res.status(409).json({ error: "Ce nom d'utilisateur est déjà pris" });
  const user = db.createUser(username, password);
  res.json({ token: db.createToken(user.id), user: db.publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const user = db.findByUsername(username);
  if (!user || !db.checkPassword(user, password)) {
    return res.status(401).json({ error: 'Identifiants incorrects' });
  }
  res.json({ token: db.createToken(user.id), user: db.publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  db.revokeToken(token);
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

// ---------- État en mémoire ----------
// freq -> { members: Map<userId, socketId>, talker: userId|null }
const rooms = new Map();
// userId -> Set<socketId>
const online = new Map();

function normalizeFreq(f) {
  if (typeof f !== 'string') return null;
  const m = f.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  if (a > 99 || b > 99 || a * 100 + b > MAX_FREQ) return null;
  return `${String(a).padStart(2, '0')}:${String(b).padStart(2, '0')}`;
}

function roomState(freq) {
  const room = rooms.get(freq);
  const owner = db.data.privateFreqs[freq] || null;
  return {
    freq,
    private: !!owner,
    owner: owner ? db.publicUser(db.data.users[owner]) : null,
    talker: room?.talker || null,
    members: room ? [...room.members.keys()].map((id) => db.publicUser(db.data.users[id])) : [],
    max: MAX_PER_FREQ,
  };
}

function broadcastRoom(freq) {
  io.to('f:' + freq).emit('freq:state', roomState(freq));
}

function canJoin(freq, uid) {
  const owner = db.data.privateFreqs[freq];
  return !owner || owner === uid || db.areFriends(owner, uid);
}

function userFreq(uid) {
  for (const [freq, room] of rooms) if (room.members.has(uid)) return freq;
  return null;
}

function leaveFreq(socket, notify = true) {
  const freq = socket.data.freq;
  if (!freq) return;
  const room = rooms.get(freq);
  socket.leave('f:' + freq);
  socket.data.freq = null;
  if (room && room.members.get(socket.data.uid) === socket.id) {
    room.members.delete(socket.data.uid);
    if (room.talker === socket.data.uid) {
      room.talker = null;
      io.to('f:' + freq).emit('ptt:stop', { userId: socket.data.uid });
    }
    if (room.members.size === 0) rooms.delete(freq);
  }
  if (notify) broadcastRoom(freq);
  notifyFriendsPresence(socket.data.uid);
}

function kickFromFreq(uid, freq, reason) {
  const room = rooms.get(freq);
  const sid = room?.members.get(uid);
  const s = sid && io.sockets.sockets.get(sid);
  if (!s) return;
  leaveFreq(s);
  s.emit('freq:kicked', { freq, reason });
}

function emitToUser(uid, event, payload) {
  for (const sid of online.get(uid) || []) io.to(sid).emit(event, payload);
}

function friendsPayload(uid) {
  const me = db.data.users[uid];
  return {
    friends: me.friends.map((fid) => ({
      ...db.publicUser(db.data.users[fid]),
      online: online.has(fid),
      freq: userFreq(fid),
    })),
    incoming: db.data.requests.filter((r) => r.to === uid).map((r) => db.publicUser(db.data.users[r.from])),
    outgoing: db.data.requests.filter((r) => r.from === uid).map((r) => db.publicUser(db.data.users[r.to])),
  };
}

function pushFriends(uid) {
  emitToUser(uid, 'friends:update', friendsPayload(uid));
}

function notifyFriendsPresence(uid) {
  const u = db.data.users[uid];
  if (!u) return;
  for (const fid of u.friends) pushFriends(fid);
}

// ---------- Temps réel ----------
io.use((socket, next) => {
  const user = db.userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.uid = user.id;
  next();
});

io.on('connection', (socket) => {
  const uid = socket.data.uid;
  if (!online.has(uid)) online.set(uid, new Set());
  online.get(uid).add(socket.id);
  socket.join('u:' + uid);

  socket.emit('me', db.publicUser(db.data.users[uid]));
  pushFriends(uid);
  notifyFriendsPresence(uid);

  const ack = (cb) => (typeof cb === 'function' ? cb : () => {});

  // ----- Profil -----
  socket.on('profile:update', (p = {}, cb) => {
    cb = ack(cb);
    const u = db.data.users[uid];
    const displayName = String(p.displayName ?? u.displayName).trim().slice(0, 30);
    if (displayName.length < 1) return cb({ error: 'Le nom ne peut pas être vide' });
    u.displayName = displayName;
    u.bio = String(p.bio ?? u.bio).slice(0, 160);
    if (/^#[0-9a-fA-F]{6}$/.test(p.color || '')) u.color = p.color;
    db.save();
    const pub = db.publicUser(u);
    emitToUser(uid, 'me', pub);
    notifyFriendsPresence(uid);
    const f = userFreq(uid);
    if (f) broadcastRoom(f);
    cb({ ok: true, user: pub });
  });

  // ----- Fréquences -----
  socket.on('freq:join', ({ freq } = {}, cb) => {
    cb = ack(cb);
    freq = normalizeFreq(freq);
    if (!freq) return cb({ error: 'Fréquence invalide (00:00 à 99:00)' });
    if (socket.data.freq === freq) return cb({ ok: true, state: roomState(freq) });
    if (!canJoin(freq, uid)) return cb({ error: 'Fréquence privée : réservée aux amis du propriétaire' });

    const room = rooms.get(freq) || { members: new Map(), talker: null };
    // Si l'utilisateur est déjà connecté sur cette fréquence depuis un autre appareil, on le remplace
    const existing = room.members.get(uid);
    if (!existing && room.members.size >= MAX_PER_FREQ) {
      return cb({ error: `Fréquence pleine (${MAX_PER_FREQ}/${MAX_PER_FREQ})` });
    }
    leaveFreq(socket);
    // Un utilisateur ne peut être que sur une seule fréquence à la fois (tous appareils confondus)
    const prev = userFreq(uid);
    if (prev) kickFromFreq(uid, prev, 'Connecté depuis un autre appareil');

    room.members.set(uid, socket.id);
    rooms.set(freq, room);
    socket.join('f:' + freq);
    socket.data.freq = freq;
    broadcastRoom(freq);
    notifyFriendsPresence(uid);
    cb({ ok: true, state: roomState(freq) });
  });

  socket.on('freq:leave', (_, cb) => {
    leaveFreq(socket);
    ack(cb)({ ok: true });
  });

  socket.on('freq:setPrivate', ({ private: makePrivate } = {}, cb) => {
    cb = ack(cb);
    const freq = socket.data.freq;
    if (!freq) return cb({ error: "Rejoins d'abord une fréquence" });
    const owner = db.data.privateFreqs[freq];
    if (makePrivate) {
      if (owner && owner !== uid) return cb({ error: 'Cette fréquence appartient déjà à quelqu\'un' });
      const room = rooms.get(freq);
      const strangers = [...room.members.keys()].filter((m) => m !== uid && !db.areFriends(uid, m));
      if (strangers.length) {
        return cb({ error: "Impossible : des personnes qui ne sont pas tes amis sont sur cette fréquence" });
      }
      db.data.privateFreqs[freq] = uid;
    } else {
      if (owner !== uid) return cb({ error: 'Seul le propriétaire peut rendre la fréquence publique' });
      delete db.data.privateFreqs[freq];
    }
    db.save();
    broadcastRoom(freq);
    cb({ ok: true });
  });

  socket.on('freq:scan', (_, cb) => {
    const list = [...rooms.keys()].sort().map((f) => {
      const s = roomState(f);
      return { freq: f, count: s.members.length, max: MAX_PER_FREQ, private: s.private, allowed: canJoin(f, uid) };
    });
    const mine = Object.entries(db.data.privateFreqs).filter(([, o]) => o === uid).map(([f]) => f);
    ack(cb)({ active: list, mine });
  });

  // ----- Push-to-talk (audio) -----
  socket.on('ptt:start', (_, cb) => {
    cb = ack(cb);
    const room = rooms.get(socket.data.freq);
    if (!room) return cb({ error: 'Pas sur une fréquence' });
    if (room.talker && room.talker !== uid) return cb({ error: 'Canal occupé', talker: room.talker });
    room.talker = uid;
    socket.to('f:' + socket.data.freq).emit('ptt:start', { userId: uid });
    broadcastRoom(socket.data.freq);
    cb({ ok: true });
  });

  socket.on('ptt:audio', (chunk) => {
    const room = rooms.get(socket.data.freq);
    if (!room || room.talker !== uid) return;
    if (!(chunk instanceof Buffer) || chunk.length > 64000) return;
    socket.to('f:' + socket.data.freq).volatile.emit('ptt:audio', { userId: uid, chunk });
  });

  socket.on('ptt:stop', () => {
    const room = rooms.get(socket.data.freq);
    if (!room || room.talker !== uid) return;
    room.talker = null;
    socket.to('f:' + socket.data.freq).emit('ptt:stop', { userId: uid });
    broadcastRoom(socket.data.freq);
  });

  // ----- Amis -----
  socket.on('friends:request', ({ username } = {}, cb) => {
    cb = ack(cb);
    const target = db.findByUsername(String(username || '').trim());
    if (!target) return cb({ error: 'Utilisateur introuvable' });
    if (target.id === uid) return cb({ error: 'Tu ne peux pas t\'ajouter toi-même 🙂' });
    if (db.areFriends(uid, target.id)) return cb({ error: 'Vous êtes déjà amis' });
    const reverse = db.data.requests.find((r) => r.from === target.id && r.to === uid);
    if (reverse) {
      // L'autre m'avait déjà demandé : on accepte directement
      acceptRequest(target.id, uid);
      return cb({ ok: true, accepted: true });
    }
    if (db.data.requests.some((r) => r.from === uid && r.to === target.id)) {
      return cb({ error: 'Demande déjà envoyée' });
    }
    db.data.requests.push({ from: uid, to: target.id, ts: Date.now() });
    db.save();
    pushFriends(uid);
    pushFriends(target.id);
    emitToUser(target.id, 'notify', { text: `${db.data.users[uid].displayName} veut t'ajouter en ami` });
    cb({ ok: true });
  });

  function acceptRequest(from, to) {
    db.data.requests = db.data.requests.filter((r) => !(r.from === from && r.to === to) && !(r.from === to && r.to === from));
    const a = db.data.users[from], b = db.data.users[to];
    if (!a.friends.includes(to)) a.friends.push(to);
    if (!b.friends.includes(from)) b.friends.push(from);
    db.save();
    pushFriends(from);
    pushFriends(to);
  }

  socket.on('friends:respond', ({ userId, accept } = {}, cb) => {
    cb = ack(cb);
    const req = db.data.requests.find((r) => r.from === userId && r.to === uid);
    if (!req) return cb({ error: 'Demande introuvable' });
    if (accept) {
      acceptRequest(userId, uid);
      emitToUser(userId, 'notify', { text: `${db.data.users[uid].displayName} a accepté ta demande d'ami` });
    } else {
      db.data.requests = db.data.requests.filter((r) => r !== req);
      db.save();
      pushFriends(uid);
      pushFriends(userId);
    }
    cb({ ok: true });
  });

  socket.on('friends:cancel', ({ userId } = {}, cb) => {
    db.data.requests = db.data.requests.filter((r) => !(r.from === uid && r.to === userId));
    db.save();
    pushFriends(uid);
    pushFriends(userId);
    ack(cb)({ ok: true });
  });

  socket.on('friends:remove', ({ userId } = {}, cb) => {
    const me = db.data.users[uid], other = db.data.users[userId];
    if (!other) return ack(cb)({ error: 'Utilisateur introuvable' });
    me.friends = me.friends.filter((x) => x !== userId);
    other.friends = other.friends.filter((x) => x !== uid);
    db.save();
    // Retirer l'ex-ami de mes fréquences privées (et inversement)
    for (const [freq, owner] of Object.entries(db.data.privateFreqs)) {
      if (owner === uid) kickFromFreq(userId, freq, 'Tu n\'es plus ami avec le propriétaire');
      if (owner === userId) kickFromFreq(uid, freq, 'Tu n\'es plus ami avec le propriétaire');
    }
    pushFriends(uid);
    pushFriends(userId);
    ack(cb)({ ok: true });
  });

  // ----- Messages privés -----
  socket.on('dm:history', ({ userId } = {}, cb) => {
    cb = ack(cb);
    if (!db.areFriends(uid, userId)) return cb({ error: 'Vous devez être amis' });
    cb({ ok: true, messages: (db.data.messages[db.convKey(uid, userId)] || []).slice(-200) });
  });

  socket.on('dm:conversations', (_, cb) => {
    const me = db.data.users[uid];
    const last = {};
    for (const fid of me.friends) {
      const msgs = db.data.messages[db.convKey(uid, fid)];
      if (msgs?.length) last[fid] = msgs[msgs.length - 1];
    }
    ack(cb)({ ok: true, last });
  });

  socket.on('dm:send',({ to, text } = {}, cb) => {
    cb = ack(cb);
    text = String(text || '').trim().slice(0, 2000);
    if (!text) return cb({ error: 'Message vide' });
    if (!db.areFriends(uid, to)) return cb({ error: 'Vous devez être amis pour discuter' });
    const key = db.convKey(uid, to);
    const msg = { id: db.newId(), from: uid, to, text, ts: Date.now() };
    (db.data.messages[key] ||= []).push(msg);
    if (db.data.messages[key].length > 1000) db.data.messages[key].splice(0, db.data.messages[key].length - 1000);
    db.save();
    emitToUser(to, 'dm:new', msg);
    emitToUser(uid, 'dm:new', msg);
    cb({ ok: true, message: msg });
  });

  socket.on('disconnect', () => {
    leaveFreq(socket);
    const set = online.get(uid);
    set?.delete(socket.id);
    if (set && set.size === 0) online.delete(uid);
    notifyFriendsPresence(uid);
  });
});

server.listen(PORT, () => {
  console.log(`📻 דבר אלי en ligne sur http://localhost:${PORT}`);
});

// HTTPS local (pour le micro sur iPhone en Wi-Fi) si un certificat existe dans certs/
const fs = require('fs');
const https = require('https');
const certDir = path.join(__dirname, '..', 'certs');
if (fs.existsSync(path.join(certDir, 'cert.pem'))) {
  const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
  const secure = https.createServer(
    { key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) },
    app,
  );
  io.attach(secure);
  secure.listen(HTTPS_PORT, '0.0.0.0', () => console.log(`🔒 HTTPS local sur le port ${HTTPS_PORT}`));
}
