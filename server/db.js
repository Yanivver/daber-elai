// Stockage simple dans un fichier JSON (suffisant pour démarrer).
// Pour la production, remplacer par une vraie base (PostgreSQL, SQLite...).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'data.json');

let data = {
  users: {},        // id -> { id, username, passHash, salt, displayName, bio, color, friends: [] }
  tokens: {},       // token -> userId
  requests: [],     // { from, to, ts }
  messages: {},     // "idA|idB" -> [{ id, from, to, text, ts }]
  privateFreqs: {}, // "12:34" -> ownerId
};

function load() {
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Erreur lecture données:', e.message);
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, DATA_FILE);
  }, 200);
}

const id = () => crypto.randomBytes(8).toString('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passHash, 'hex'));
}

const COLORS = ['#ff7a00', '#22c55e', '#3b82f6', '#e11d48', '#a855f7', '#eab308', '#14b8a6'];

module.exports = {
  load,
  save,
  get data() { return data; },

  findByUsername(username) {
    const u = username.toLowerCase();
    return Object.values(data.users).find((x) => x.username === u);
  },

  createUser(username, password) {
    const { salt, hash } = hashPassword(password);
    const user = {
      id: id(),
      username: username.toLowerCase(),
      displayName: username,
      bio: '',
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      salt,
      passHash: hash,
      friends: [],
      createdAt: Date.now(),
    };
    data.users[user.id] = user;
    save();
    return user;
  },

  checkPassword,

  createToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    data.tokens[token] = userId;
    save();
    return token;
  },

  userFromToken(token) {
    const uid = data.tokens[token];
    return uid ? data.users[uid] : null;
  },

  revokeToken(token) {
    delete data.tokens[token];
    save();
  },

  publicUser(u) {
    if (!u) return null;
    return { id: u.id, username: u.username, displayName: u.displayName, bio: u.bio, color: u.color };
  },

  areFriends(a, b) {
    return !!data.users[a]?.friends.includes(b);
  },

  convKey(a, b) {
    return [a, b].sort().join('|');
  },

  newId: id,
};
