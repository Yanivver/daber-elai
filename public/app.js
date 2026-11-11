import { RadioAudio } from './audio.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const fmtFreq = (v) => `${pad(Math.floor(v / 100))}:${pad(v % 100)}`;
const MAX_FREQ = 9900;

const state = {
  token: localStorage.getItem('tw_token'),
  me: null,
  friends: { friends: [], incoming: [], outgoing: [] },
  dial: Number(localStorage.getItem('tw_freq') || 0),
  room: null,        // état de la fréquence rejointe
  talking: false,
  pressed: false,
  chatWith: null,
  last: {},          // userId -> dernier message
  unread: JSON.parse(localStorage.getItem('tw_unread') || '{}'),
  view: 'radio',
};

const radio = new RadioAudio();
let socket = null;

// ---------- Utilitaires UI ----------
function toast(text, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function avatar(u, { dot } = {}) {
  const letter = esc((u?.displayName || '?').trim()[0]?.toUpperCase() || '?');
  const d = dot === undefined ? '' : `<i class="dot ${dot ? 'on' : ''}"></i>`;
  return `<div class="avatar" style="background:${esc(u?.color || '#888')}">${letter}${d}</div>`;
}

function emit(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, (res) => resolve(res || {})));
}

function userById(id) {
  if (state.me?.id === id) return state.me;
  return state.room?.members.find((m) => m.id === id) || state.friends.friends.find((f) => f.id === id);
}

// ---------- Authentification ----------
let authMode = 'login';
$$('[data-auth]').forEach((b) => b.addEventListener('click', () => {
  authMode = b.dataset.auth;
  $$('[data-auth]').forEach((x) => x.classList.toggle('active', x === b));
  $('#auth-submit').textContent = authMode === 'login' ? 'Se connecter' : 'Créer mon compte';
  $('#auth-pass').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').textContent = '';
}));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  radio.unlock().catch(() => {});
  $('#auth-error').textContent = '';
  try {
    const r = await fetch('/api/' + authMode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#auth-user').value.trim(), password: $('#auth-pass').value }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Erreur');
    state.token = data.token;
    localStorage.setItem('tw_token', data.token);
    start();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
}

async function logout() {
  if (state.talking) stopTalk();
  await fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + state.token } }).catch(() => {});
  localStorage.removeItem('tw_token');
  state.token = null;
  state.room = null;
  socket?.disconnect();
  socket = null;
  showAuth();
}

// ---------- Connexion temps réel ----------
function start() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderDial();

  socket = io({ auth: { token: state.token } });

  socket.on('connect', () => {
    $('#conn-status').className = 'conn on';
    $('#conn-status').textContent = 'En ligne';
    scan();
    loadConversations();
    // Reconnexion : on revient sur la fréquence précédente
    if (state.room) joinFreq(state.room.freq, true);
  });
  socket.on('disconnect', () => {
    $('#conn-status').className = 'conn off';
    $('#conn-status').textContent = 'Hors ligne';
    if (state.talking) stopTalk(true);
  });
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') { toast('Session expirée, reconnecte-toi', true); logout(); }
  });

  socket.on('me', (me) => { state.me = me; renderMe(); });
  socket.on('notify', ({ text }) => toast(text));
  socket.on('friends:update', (f) => { state.friends = f; renderFriends(); renderConvs(); });

  socket.on('freq:state', (s) => {
    if (state.room && s.freq === state.room.freq) { state.room = s; renderRoom(); }
  });
  socket.on('freq:kicked', ({ freq, reason }) => {
    if (state.room?.freq !== freq) return;
    if (state.talking) stopTalk(true);
    state.room = null;
    renderRoom();
    toast(`Déconnecté de ${freq} : ${reason}`, true);
  });

  socket.on('ptt:start', ({ userId }) => {
    radio.squelch();
  });
  socket.on('ptt:audio', ({ userId, chunk }) => radio.play(userId, chunk));
  socket.on('ptt:stop', ({ userId }) => {
    const wait = radio.endOf(userId);
    radio.beep(wait);
    radio.squelch(0.08, wait + 0.2);
  });

  socket.on('dm:new', (msg) => {
    const other = msg.from === state.me?.id ? msg.to : msg.from;
    state.last[other] = msg;
    const viewing = state.view === 'messages' && state.chatWith === other && !document.hidden;
    if (viewing) appendMsg(msg);
    else if (msg.from !== state.me?.id) {
      state.unread[other] = (state.unread[other] || 0) + 1;
      saveUnread();
      const f = userById(other);
      toast(`💬 ${f?.displayName || 'Message'} : ${msg.text.slice(0, 60)}`);
    }
    renderConvs();
  });
}

// ---------- Navigation ----------
function showView(v) {
  state.view = v;
  $$('.view').forEach((el) => el.classList.toggle('hidden', el.id !== 'view-' + v));
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'radio') scan();
  if (v === 'profile') renderProfile();
  if (v === 'messages' && state.chatWith) openChat(state.chatWith);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

function renderMe() {
  const me = state.me;
  $('#me-chip').innerHTML = `${avatar(me)}<span>${esc(me.displayName)}</span>`;
  if (state.view === 'profile') renderProfile();
}

// ---------- Radio ----------
function renderDial() {
  $('#freq-a').textContent = pad(Math.floor(state.dial / 100));
  $('#freq-b').textContent = pad(state.dial % 100);
  const joined = state.room && state.room.freq === fmtFreq(state.dial);
  $('#btn-join').textContent = joined ? 'Quitter' : state.room ? `Aller sur ${fmtFreq(state.dial)}` : 'Rejoindre';
  $('#btn-join').classList.toggle('danger', !!joined);
  $('#btn-join').classList.toggle('primary', !joined);
}

function setDial(v) {
  if (v < 0) v = MAX_FREQ;
  if (v > MAX_FREQ) v = 0;
  state.dial = v;
  localStorage.setItem('tw_freq', v);
  renderDial();
}

$$('[data-step]').forEach((b) => b.addEventListener('click', () => {
  const step = Number(b.dataset.step);
  let v = state.dial + step;
  // Les minutes vont de 00 à 99
  if (Math.abs(step) === 1) {
    const a = Math.floor(state.dial / 100);
    let m = (state.dial % 100) + step;
    if (m > 99) m = 0;
    if (m < 0) m = 99;
    v = a * 100 + m;
    if (v > MAX_FREQ) v = a === 99 ? 9900 : v;
  }
  setDial(v);
}));

$('#btn-type').addEventListener('click', () => {
  const input = prompt('Fréquence (00:00 à 99:00)', fmtFreq(state.dial));
  if (input == null) return;
  const m = input.trim().match(/^(\d{1,2})\s*[:.,h ]?\s*(\d{1,2})?$/);
  const v = m ? Number(m[1]) * 100 + Number(m[2] || 0) : NaN;
  if (!m || Number(m[2] || 0) > 99 || v > MAX_FREQ) return toast('Fréquence invalide (00:00 à 99:00)', true);
  setDial(v);
  joinFreq(fmtFreq(v));
});

$('#btn-join').addEventListener('click', () => {
  radio.unlock().catch(() => {});
  const f = fmtFreq(state.dial);
  if (state.room?.freq === f) leaveFreq();
  else joinFreq(f);
});

async function joinFreq(freq, silent = false) {
  const res = await emit('freq:join', { freq });
  if (res.error) {
    if (!silent) toast(res.error, true);
    if (silent) { state.room = null; renderRoom(); }
    return;
  }
  state.room = res.state;
  const [a, b] = freq.split(':').map(Number);
  setDial(a * 100 + b);
  renderRoom();
  radio.squelch(0.2);
  // Demande d'accès au micro dès l'entrée sur la fréquence
  radio.ensureMic().catch((e) => toast('Micro : ' + e.message, true));
}

async function leaveFreq() {
  if (state.talking) stopTalk();
  await emit('freq:leave');
  state.room = null;
  renderRoom();
  scan();
}

$('#btn-lock').addEventListener('click', async () => {
  if (!state.room) return;
  const makePrivate = !state.room.private;
  const res = await emit('freq:setPrivate', { private: makePrivate });
  if (res.error) toast(res.error, true);
  else toast(makePrivate ? '🔒 Fréquence privée : réservée à tes amis' : 'Fréquence publique');
});

function renderRoom() {
  const r = state.room;
  const lcd = $('#lcd');
  lcd.classList.toggle('joined', !!r);
  lcd.classList.toggle('live', !!r?.talker);
  $('#ptt').disabled = !r;
  $('#btn-lock').disabled = !r || (r.private && r.owner?.id !== state.me?.id);
  $('#btn-lock').textContent = r?.private ? '🔒' : '🔓';
  $('#lcd-lock').textContent = r?.private ? `🔒 ${r.owner?.displayName || ''}` : '';
  $('#lcd-count').textContent = r ? `👤 ${r.members.length}/${r.max}` : '';
  $('#members-count').textContent = r ? `${r.freq} · ${r.members.length}/${r.max}` : '';

  const talker = r?.talker ? userById(r.talker) : null;
  const busy = r?.talker && r.talker !== state.me?.id;
  $('#ptt').classList.toggle('busy', !!busy);
  $('#lcd-status').textContent = !r ? 'PRÊT' : state.talking ? '● ÉMISSION' : busy ? '◉ RÉCEPTION' : 'EN ÉCOUTE';
  $('#lcd-talker').textContent = state.talking ? 'Tu parles…' : talker ? `${talker.displayName} parle…` : ' ';
  $('.ptt-label').textContent = busy ? 'CANAL OCCUPÉ' : state.talking ? 'TU PARLES…' : 'MAINTENIR POUR PARLER';

  $('#members').innerHTML = !r
    ? '<li class="muted">Rejoins une fréquence pour voir qui est là.</li>'
    : r.members.map((m) => {
        const isMe = m.id === state.me?.id;
        const isFriend = state.friends.friends.some((f) => f.id === m.id);
        const pending = state.friends.outgoing.some((f) => f.id === m.id);
        return `<li class="${r.talker === m.id ? 'talking' : ''}">
          ${avatar(m)}
          <div class="grow"><div class="name">${esc(m.displayName)}${isMe ? ' (toi)' : ''}${r.owner?.id === m.id ? ' 👑' : ''}</div>
          <div class="sub">@${esc(m.username)}${m.bio ? ' · ' + esc(m.bio) : ''}</div></div>
          ${!isMe && !isFriend && !pending ? `<button class="btn small" data-add="${esc(m.username)}">+ Ami</button>` : ''}
          ${pending ? '<span class="sub">Demande envoyée</span>' : ''}
        </li>`;
      }).join('');
  renderDial();
}

$('#members').addEventListener('click', async (e) => {
  const u = e.target.closest('[data-add]')?.dataset.add;
  if (u) addFriend(u);
});

async function scan() {
  if (!socket?.connected) return;
  const res = await emit('freq:scan');
  const items = res.active || [];
  const mineInactive = (res.mine || []).filter((f) => !items.some((i) => i.freq === f));
  $('#scan').innerHTML = (items.length || mineInactive.length)
    ? [...items.map((i) => `<li>
          <div class="grow"><div class="name">${i.private ? '🔒' : '📡'} ${i.freq}</div>
          <div class="sub">${i.count}/${i.max} personne${i.count > 1 ? 's' : ''}${i.private ? ' · privée' : ''}</div></div>
          ${i.allowed && i.count < i.max && state.room?.freq !== i.freq ? `<button class="btn small" data-go="${i.freq}">Écouter</button>` : ''}
          ${i.count >= i.max ? '<span class="sub">Pleine</span>' : ''}
        </li>`),
       ...mineInactive.map((f) => `<li>
          <div class="grow"><div class="name">🔒 ${f}</div><div class="sub">Ta fréquence privée · vide</div></div>
          <button class="btn small" data-go="${f}">Ouvrir</button></li>`)].join('')
    : '<li class="muted">Aucune fréquence active pour le moment. Lance-toi !</li>';
}
$('#btn-scan').addEventListener('click', scan);
$('#scan').addEventListener('click', (e) => {
  const f = e.target.closest('[data-go]')?.dataset.go;
  if (f) { radio.unlock().catch(() => {}); joinFreq(f); }
});

$('#volume').addEventListener('input', (e) => radio.setVolume(Number(e.target.value)));

// ----- Push-to-talk -----
async function startTalk() {
  if (!state.room || state.pressed) return;
  state.pressed = true;
  $('#ptt').classList.add('active');
  try {
    await radio.ensureMic();
  } catch (e) {
    toast('Micro : ' + e.message, true);
    state.pressed = false;
    $('#ptt').classList.remove('active');
    return;
  }
  const res = await emit('ptt:start');
  if (res.error) {
    toast(res.error, true);
    state.pressed = false;
    $('#ptt').classList.remove('active');
    return;
  }
  if (!state.pressed) { socket.emit('ptt:stop'); return; } // relâché avant la réponse
  state.talking = true;
  radio.onChunk = (buf) => socket.emit('ptt:audio', buf);
  radio.transmitting = true;
  radio.beep(0, [1500]);
  navigator.vibrate?.(30);
  renderRoom();
}

function stopTalk(silent = false) {
  state.pressed = false;
  $('#ptt').classList.remove('active');
  if (!state.talking) return;
  state.talking = false;
  // On laisse passer le dernier bloc audio avant de couper
  setTimeout(() => {
    radio.transmitting = false;
    if (!silent && socket?.connected) socket.emit('ptt:stop');
  }, 150);
  radio.beep(0.15);
  renderRoom();
}

const ptt = $('#ptt');
ptt.addEventListener('pointerdown', (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); startTalk(); });
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => ptt.addEventListener(ev, () => stopTalk()));
ptt.addEventListener('contextmenu', (e) => e.preventDefault());

const typing = () => ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && !typing() && state.view === 'radio' && state.room) { e.preventDefault(); startTalk(); }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !typing()) stopTalk();
});
window.addEventListener('blur', () => stopTalk());

// ---------- Amis ----------
async function addFriend(username) {
  const res = await emit('friends:request', { username });
  if (res.error) return toast(res.error, true);
  toast(res.accepted ? 'Vous êtes maintenant amis 🎉' : "Demande d'ami envoyée");
}

$('#add-friend').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#add-friend-name');
  await addFriend(input.value.trim().replace(/^@/, ''));
  input.value = '';
});

function renderFriends() {
  const { friends, incoming, outgoing } = state.friends;
  $('#incoming-card').classList.toggle('hidden', !incoming.length);
  $('#outgoing-card').classList.toggle('hidden', !outgoing.length);
  const badge = $('#badge-friends');
  badge.textContent = incoming.length;
  badge.classList.toggle('hidden', !incoming.length);

  $('#incoming').innerHTML = incoming.map((u) => `<li>${avatar(u)}
    <div class="grow"><div class="name">${esc(u.displayName)}</div><div class="sub">@${esc(u.username)}</div></div>
    <div class="actions"><button class="btn small primary" data-accept="${u.id}">Accepter</button>
    <button class="btn small" data-decline="${u.id}">Refuser</button></div></li>`).join('');

  $('#outgoing').innerHTML = outgoing.map((u) => `<li>${avatar(u)}
    <div class="grow"><div class="name">${esc(u.displayName)}</div><div class="sub">@${esc(u.username)} · en attente</div></div>
    <button class="btn small" data-cancel="${u.id}">Annuler</button></li>`).join('');

  const sorted = [...friends].sort((a, b) => (b.online - a.online) || a.displayName.localeCompare(b.displayName));
  $('#friends').innerHTML = sorted.length ? sorted.map((u) => `<li>${avatar(u, { dot: u.online })}
    <div class="grow"><div class="name">${esc(u.displayName)}</div>
    <div class="sub">@${esc(u.username)} · ${u.online ? (u.freq ? `sur 📻 ${u.freq}` : 'en ligne') : 'hors ligne'}</div></div>
    <div class="actions">
      ${u.freq && u.freq !== state.room?.freq ? `<button class="btn small primary" data-go="${u.freq}">📻 Rejoindre</button>` : ''}
      <button class="btn small" data-chat="${u.id}">💬</button>
      <button class="btn small" data-remove="${u.id}" title="Retirer">✕</button>
    </div></li>`).join('')
    : '<li class="muted">Pas encore d\'amis. Ajoute quelqu\'un avec son nom d\'utilisateur !</li>';

  if (state.room) renderRoom();
}

$('#view-friends').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  if (d.accept) { await emit('friends:respond', { userId: d.accept, accept: true }); toast('Ami ajouté 🎉'); }
  if (d.decline) await emit('friends:respond', { userId: d.decline, accept: false });
  if (d.cancel) await emit('friends:cancel', { userId: d.cancel });
  if (d.remove) {
    const u = userById(d.remove);
    if (confirm(`Retirer ${u?.displayName || 'cet ami'} de tes amis ?`)) await emit('friends:remove', { userId: d.remove });
  }
  if (d.chat) { state.chatWith = d.chat; showView('messages'); }
  if (d.go) { radio.unlock().catch(() => {}); await joinFreq(d.go); showView('radio'); }
});

// ---------- Messages ----------
function saveUnread() {
  localStorage.setItem('tw_unread', JSON.stringify(state.unread));
  const total = Object.values(state.unread).reduce((a, b) => a + b, 0);
  $('#badge-messages').textContent = total;
  $('#badge-messages').classList.toggle('hidden', !total);
}

async function loadConversations() {
  const res = await emit('dm:conversations');
  state.last = res.last || {};
  renderConvs();
  saveUnread();
}

function timeStr(ts) {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

function renderConvs() {
  const list = [...state.friends.friends].sort((a, b) => (state.last[b.id]?.ts || 0) - (state.last[a.id]?.ts || 0));
  $('#convs').innerHTML = list.length ? list.map((u) => {
    const last = state.last[u.id];
    const n = state.unread[u.id] || 0;
    return `<li data-open="${u.id}" style="cursor:pointer">${avatar(u, { dot: u.online })}
      <div class="grow"><div class="name">${esc(u.displayName)}</div>
      <div class="sub">${last ? (last.from === state.me?.id ? 'Toi : ' : '') + esc(last.text) : 'Démarre la conversation'}</div></div>
      ${last ? `<span class="sub">${timeStr(last.ts)}</span>` : ''}
      ${n ? `<i class="badge" style="position:static">${n}</i>` : ''}</li>`;
  }).join('') : '<li class="muted">Ajoute des amis pour pouvoir leur écrire.</li>';
}

$('#convs').addEventListener('click', (e) => {
  const id = e.target.closest('[data-open]')?.dataset.open;
  if (id) openChat(id);
});

async function openChat(id) {
  const u = userById(id);
  if (!u) { state.chatWith = null; return; }
  state.chatWith = id;
  delete state.unread[id];
  saveUnread();
  renderConvs();
  $('#conv-list').classList.add('hidden');
  $('#chat').classList.remove('hidden');
  $('#chat-title').innerHTML = `${avatar(u, { dot: u.online })}<span>${esc(u.displayName)}</span>`;
  $('#chat-msgs').innerHTML = '<p class="muted">Chargement…</p>';
  const res = await emit('dm:history', { userId: id });
  if (state.chatWith !== id) return;
  $('#chat-msgs').innerHTML = '';
  if (res.error) return toast(res.error, true);
  (res.messages || []).forEach(appendMsg);
  if (!res.messages?.length) $('#chat-msgs').innerHTML = '<p class="muted" id="chat-empty">Aucun message. Dis bonjour 👋</p>';
  $('#chat-input').focus();
}

function appendMsg(m) {
  $('#chat-empty')?.remove();
  const el = document.createElement('div');
  el.className = 'msg' + (m.from === state.me?.id ? ' mine' : '');
  el.innerHTML = `${esc(m.text)}<time>${timeStr(m.ts)}</time>`;
  const box = $('#chat-msgs');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

$('#chat-back').addEventListener('click', () => {
  state.chatWith = null;
  $('#chat').classList.add('hidden');
  $('#conv-list').classList.remove('hidden');
});

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || !state.chatWith) return;
  input.value = '';
  const res = await emit('dm:send', { to: state.chatWith, text });
  if (res.error) { toast(res.error, true); input.value = text; }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.view === 'messages' && state.chatWith) openChat(state.chatWith);
});

// ---------- Profil ----------
const COLORS = ['#ff7a00', '#22c55e', '#3b82f6', '#e11d48', '#a855f7', '#eab308', '#14b8a6', '#f472b6', '#94a3b8'];
let pickedColor = null;

function renderProfile() {
  const me = state.me;
  if (!me) return;
  pickedColor = pickedColor || me.color;
  $('#profile-avatar').outerHTML = `<div class="avatar big" id="profile-avatar" style="background:${esc(pickedColor)}">${esc((($('#profile-name').value || me.displayName).trim()[0] || '?').toUpperCase())}</div>`;
  $('#profile-username').textContent = '@' + me.username;
  if (document.activeElement?.id !== 'profile-name' && !$('#profile-name').dataset.dirty) $('#profile-name').value = me.displayName;
  if (document.activeElement?.id !== 'profile-bio' && !$('#profile-bio').dataset.dirty) $('#profile-bio').value = me.bio || '';
  $('#colors').innerHTML = COLORS.map((c) => `<button type="button" data-color="${c}" style="background:${c}" class="${c === pickedColor ? 'sel' : ''}"></button>`).join('');
}

$('#colors').addEventListener('click', (e) => {
  const c = e.target.dataset.color;
  if (c) { pickedColor = c; renderProfile(); }
});
['profile-name', 'profile-bio'].forEach((id) => $('#' + id).addEventListener('input', (e) => {
  e.target.dataset.dirty = '1';
  if (id === 'profile-name') renderProfile();
}));

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await emit('profile:update', {
    displayName: $('#profile-name').value,
    bio: $('#profile-bio').value,
    color: pickedColor,
  });
  if (res.error) return toast(res.error, true);
  delete $('#profile-name').dataset.dirty;
  delete $('#profile-bio').dataset.dirty;
  toast('Profil enregistré ✅');
});

$('#btn-logout').addEventListener('click', logout);

// ---------- Démarrage ----------
if (state.token) start();
else showAuth();
saveUnread();
