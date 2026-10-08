'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const { db, now, hashPassword, verifyPassword, getSettings, tx, DATA_DIR, cached, bumpCache } = require('./lib/db');
const fmt = require('./lib/format');
const F = require('./lib/forum');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// only the proxy in front of us (nginx / ssh tunnel on this machine) may set the client IP
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.disable('x-powered-by');

const PORT = Number(process.env.PORT) || 3000;
const PER_PAGE = 20;
const UPLOADS = path.join(DATA_DIR, 'uploads');

let SECRET = db.prepare("SELECT value FROM settings WHERE key = 'secret'").get()?.value;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO settings (key, value) VALUES ('secret', ?)").run(SECRET);
}

// security headers (no visual effect)
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'"
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
const IMAGE_EXT = /^\.(png|jpe?g|gif|webp)$/;
app.use('/data/avatars', (req, res, next) => IMAGE_EXT.test(path.extname(req.path).toLowerCase()) ? next() : res.status(404).end(),
  express.static(path.join(UPLOADS, 'avatars'), { maxAge: '365d', immutable: true }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
// every write request drops the in-memory caches (forum tree, settings, avatars)
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { bumpCache(); res.on('finish', bumpCache); }
  next();
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOADS, file.fieldname === 'avatar' ? 'avatars' : 'files')),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, ''))
  }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 60 }
});
const uploadAvatar = multer({ storage: upload.storage, limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 30 } });
// real image type from the first bytes, not from what the browser claims
function sniffImage(file) {
  try {
    const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
    if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return '.png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
    if (b.toString('latin1', 0, 4) === 'GIF8') return '.gif';
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  } catch { /* unreadable */ }
  return null;
}
// what members may upload to the files section (admins are not limited)
const MEMBER_FILE_EXT = /^\.(zip|rar|7z|gz|xls|xlsx|xlsm|ods|csv|pdf|doc|docx|odt|txt|png|jpe?g|gif|webp)$/;

/* ---------- session, csrf, locals ---------- */
const cookieOpts = { httpOnly: true, sameSite: 'lax', maxAge: 365 * 86400 * 1000 };
const SESSION_TTL = 90 * 86400; // a login lasts 90 days without visits

app.use((req, res, next) => {
  if (req.secure) { const set = res.cookie.bind(res); res.cookie = (n, v, o = {}) => set(n, v, { ...o, secure: true }); }
  let vid = req.cookies.vid;
  if (!vid || !/^[a-f0-9]{32}$/.test(vid)) {
    vid = crypto.randomBytes(16).toString('hex');
    res.cookie('vid', vid, cookieOpts);
  }
  req.vid = vid;
  // bound to the login when there is one, so a token stops working after logout
  req.csrf = crypto.createHmac('sha256', SECRET).update(req.cookies.sid ? 's:' + req.cookies.sid : vid).digest('hex').slice(0, 32);

  req.user = null;
  const sid = req.cookies.sid;
  if (sid) {
    const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.last_seen > ?').get(String(sid), now() - SESSION_TTL);
    if (row) {
      req.user = row;
      if (now() - row.last_seen > 60) db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), row.id);
    }
  }
  req.settings = getSettings();
  const scheme = ['light', 'dark', 'system'].includes(req.cookies.scheme) ? req.cookies.scheme : req.settings.default_scheme || 'system';
  const style = req.cookies.style === 'old' ? 'old' : 'new';

  let flash = null;
  if (req.cookies.flash) { flash = String(req.cookies.flash).slice(0, 300); res.clearCookie('flash'); }

  Object.assign(res.locals, {
    me: req.user, settings: req.settings, csrf: req.csrf, scheme, style, flash, fmt,
    nodeUrl: F.nodeUrl, currentPath: req.path, currentUrl: req.originalUrl, query: req.query,
    isStaff: !!(req.user && ['admin', 'moderator'].includes(req.user.role)),
    isAdmin: !!(req.user && req.user.role === 'admin'),
    pageTitle: '', breadcrumbs: [], bodyClass: '',
    avatars: cached('avatars', () => Object.fromEntries(db.prepare("SELECT id, avatar FROM users WHERE avatar != ''").all().map(r => [r.id, r.avatar])))
  });
  next();
});

function flash(res, msg) { res.cookie('flash', msg, { httpOnly: true, sameSite: 'lax' }); }

function checkCsrf(req, res, next) {
  const t = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  if (t.length !== req.csrf.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(req.csrf))) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).render('error', { pageTitle: 'Ошибка', message: 'Срок действия формы истёк. Обновите страницу и попробуйте снова.' });
  }
  next();
}
// multipart bodies are parsed (and checked) only on the upload routes below; anywhere else they are refused
const UPLOAD_ROUTES = new Set(['/account/', '/files/add', '/admin/files/upload']);
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  if (req.is('multipart/form-data')) return UPLOAD_ROUTES.has(req.path) ? next() : res.status(400).render('error', { pageTitle: 'Ошибка', message: 'Неверный формат запроса.' });
  checkCsrf(req, res, next);
});

// statistics: one row per page view of an HTML page
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/admin') && !req.path.startsWith('/public') && !req.path.startsWith('/data') && !/\.\w+$/.test(req.path) && req.path !== '/favicon.ico') {
    const d = new Date(Date.now() + 180 * 60000).toISOString().slice(0, 10);
    try { db.prepare('INSERT INTO visits (day, path, user_id, visitor, created_at) VALUES (?, ?, ?, ?, ?)').run(d, req.path.slice(0, 200), req.user ? req.user.id : null, req.vid, now()); } catch { /* ignore */ }
  }
  next();
});

const isStaff = u => !!(u && ['admin', 'moderator'].includes(u.role));
function requireUser(req, res, next) {
  if (!req.user) return res.redirect('/login/?to=' + encodeURIComponent(req.originalUrl));
  next();
}
function canPost(req, res, next) {
  if (!req.user) return res.redirect('/login/?to=' + encodeURIComponent(req.originalUrl));
  if (req.user.is_banned) return res.status(403).render('error', { pageTitle: 'Доступ ограничен', message: 'Ваша учётная запись заблокирована' + (req.user.ban_reason ? ': ' + req.user.ban_reason : '.') });
  next();
}
function notFound(res, message = 'Запрошенная страница не найдена.') {
  return res.status(404).render('error', { pageTitle: 'Ошибка', message });
}
function paginate(total, page, per = PER_PAGE) {
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(1, Number(page) || 1), pages);
  return { page: p, pages, offset: (p - 1) * per, per, total };
}

function enrichUsers(rows) {
  const s = getSettings();
  const cache = new Map();
  for (const r of rows) {
    if (!r.user_id) { r.author = null; continue; }
    if (!cache.has(r.user_id)) {
      const u = F.userById(r.user_id);
      if (u) {
        const st = F.userStats(u.id);
        u.postCount = st.posts; u.reactionCount = st.reactions;
        u.rank = u.custom_title || fmt.rankFor(st.posts, s.ranksList);
        u.bannerList = String(u.banners || '').split(',').map(x => x.trim()).filter(Boolean);
      }
      cache.set(r.user_id, u || null);
    }
    r.author = cache.get(r.user_id);
  }
  return rows;
}

function sidebarData(user) {
  return {
    files: db.prepare('SELECT id, title, tagline FROM files ORDER BY is_featured DESC, downloads DESC LIMIT 4').all(),
    bigWins: db.prepare('SELECT * FROM big_wins ORDER BY display_order, id LIMIT 6').all(),
    tournament: (() => {
      const t = db.prepare("SELECT * FROM tournaments WHERE status IN ('open','active') ORDER BY id DESC LIMIT 1").get();
      if (!t) return null;
      t.matches = db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND result IS NULL AND start_at > ? ORDER BY start_at LIMIT 2').all(t.id, now());
      for (const m of t.matches) {
        m.votes = voteCounts(m.id);
        m.mine = user ? db.prepare('SELECT pick FROM predictions WHERE match_id = ? AND user_id = ?').get(m.id, user.id)?.pick : null;
      }
      return t;
    })()
  };
}
function voteCounts(matchId) {
  const v = { '1': 0, X: 0, '2': 0 };
  for (const r of db.prepare('SELECT pick, COUNT(*) AS c FROM predictions WHERE match_id = ? GROUP BY pick').all(matchId)) v[r.pick] = r.c;
  return v;
}

/* ---------- forum ---------- */
app.get('/', (req, res) => {
  const { roots } = F.nodeTree();
  res.render('index', { pageTitle: '', roots, side: sidebarData(req.user), bodyClass: 'home' });
});

app.get('/c/:slug/', (req, res) => {
  const node = F.nodeBySlug(req.params.slug);
  if (!node || node.type !== 'category') return notFound(res);
  const { byId } = F.nodeTree();
  res.render('category', { pageTitle: node.title, node: byId.get(node.id), side: sidebarData(req.user) });
});

app.get('/link/:slug/', (req, res) => {
  const node = F.nodeBySlug(req.params.slug);
  if (!node || node.type !== 'link') return notFound(res);
  res.redirect(fmt.safeUrl(node.link_url) || '/');
});

app.get(['/f/:slug/', '/f/:slug/page-:page'], (req, res) => {
  const node = F.nodeBySlug(req.params.slug);
  if (!node || node.type !== 'forum') return notFound(res);
  const { byId } = F.nodeTree();
  const full = byId.get(node.id);
  const prefixId = Number(req.query.prefix_id) || 0;
  const where = 'node_id = ?' + (prefixId ? ' AND prefix_id = ?' : '');
  const args = prefixId ? [node.id, prefixId] : [node.id];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM threads WHERE ${where} AND is_sticky = 0`).get(...args).c;
  const pg = paginate(total, req.params.page);
  const sticky = pg.page === 1 ? db.prepare(`SELECT * FROM threads WHERE ${where} AND is_sticky = 1 ORDER BY last_post_at DESC`).all(...args) : [];
  const threads = db.prepare(`SELECT * FROM threads WHERE ${where} AND is_sticky = 0 ORDER BY last_post_at DESC LIMIT ? OFFSET ?`).all(...args, pg.per, pg.offset);
  const prefixes = db.prepare('SELECT * FROM prefixes ORDER BY display_order').all();
  const pfx = new Map(prefixes.map(p => [p.id, p]));
  const list = [...sticky, ...threads];
  const replies = new Map(list.length ? db.prepare(`SELECT thread_id, COUNT(*) - 1 AS c FROM posts WHERE thread_id IN (${list.map(() => '?').join(',')}) GROUP BY thread_id`).all(...list.map(t => t.id)).map(r => [r.thread_id, r.c]) : []);
  for (const t of list) {
    t.replies = replies.get(t.id) || 0;
    t.prefix = t.prefix_id ? pfx.get(t.prefix_id) || null : null;
  }
  res.render('forum', {
    pageTitle: node.title, node: full, sticky, threads, pg, prefixId, prefixes,
    pageQuery: prefixId ? `?prefix_id=${prefixId}` : '',
    breadcrumbs: F.breadcrumbs(node), baseUrl: `/f/${node.slug}/`
  });
});

function postableForums(user) {
  return F.allNodes().filter(n => n.type === 'forum' && (!n.staff_only_post || isStaff(user)));
}

app.get('/f/-/create-thread', canPost, (req, res) => {
  res.render('choose_forum', { pageTitle: 'Создать тему', forums: postableForums(req.user), gameOnly: req.query.type === 'game' });
});
app.get('/ob/', (req, res) => res.redirect('/f/-/create-thread?type=game'));

/* game forums: the «Игра» form builds the title and the first post from its fields */
const gameSchemes = node => String(node.game_schemes || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);
const useGameForm = (req, node) => node.is_game && !(isStaff(req.user) && (req.query.type === 'plain' || req.body?.plain));
function renderGameForm(req, res, node, form, error) {
  const t = new Date(Date.now() + 180 * 60000);
  res.status(error ? 400 : 200).render('game_create', {
    pageTitle: node.title, node, breadcrumbs: [...F.breadcrumbs(node), node], schemes: gameSchemes(node), form, error,
    defaultTime: t.toISOString().slice(11, 16)
  });
}
function createGameThread(req, res, node) {
  const b = req.body;
  const draw = String(b.draw || '').trim().replace(/^№\s*/, '');
  const date = String(b.start_date || '');
  const time = String(b.start_time || '');
  const scheme = String(b.scheme || '');
  const events = String(b.events || '').trim().slice(0, 50000);
  const players = String(b.players || '').trim().slice(0, 20000);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  let error = null;
  if (!/^\d{1,7}$/.test(draw)) error = 'Тираж: укажите только номер, цифрами, без символа №.';
  else if (!m || isNaN(Date.parse(date))) error = 'Укажите дату начала.';
  else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) error = 'Укажите время начала.';
  else if (!gameSchemes(node).includes(scheme)) error = 'Выберите схему из списка.';
  else if (events.length < 3) error = 'Заполните события тиража.';
  else if (players.length < 2) error = 'Заполните список игроков: свой логин и сумму взноса.';
  if (error) return renderGameForm(req, res, node, b, error);
  const when = `${m[3]}.${m[2]}.${m[1].slice(2)} в ${time}`;
  const title = `№${draw}: ${when} [${scheme}]`;
  const body = `[b]Тираж:[/b] №${draw}\n[b]Начало:[/b] ${when}\n[b]Схема:[/b] ${scheme}\n\n[b]События тиража[/b]\n${events}\n\n[b]Список игроков[/b]\n${players}`;
  const prefixId = node.game_prefix_id && db.prepare('SELECT 1 FROM prefixes WHERE id = ?').get(node.game_prefix_id) ? node.game_prefix_id : null;
  const t = now();
  const id = tx(() => {
    const tid = Number(db.prepare(`INSERT INTO threads (node_id, user_id, username, title, prefix_id, created_at, last_post_at, last_post_user_id, last_post_username)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(node.id, req.user.id, req.user.username, title, prefixId, t, t, req.user.id, req.user.username).lastInsertRowid);
    db.prepare('INSERT INTO posts (thread_id, user_id, username, body, created_at) VALUES (?, ?, ?, ?, ?)').run(tid, req.user.id, req.user.username, body, t);
    return tid;
  });
  res.redirect(`/t/${id}/`);
}

app.get('/f/:slug/create-thread', canPost, (req, res) => {
  const node = F.nodeBySlug(req.params.slug);
  if (!node || node.type !== 'forum') return notFound(res);
  if (node.staff_only_post && !isStaff(req.user)) return notFound(res, 'В этом разделе темы создаёт только администрация.');
  if (useGameForm(req, node)) return renderGameForm(req, res, node, {}, null);
  res.render('thread_create', { pageTitle: 'Создать тему', node, breadcrumbs: [...F.breadcrumbs(node), node], prefixes: db.prepare('SELECT * FROM prefixes ORDER BY display_order').all(), form: {}, error: null });
});

app.post('/f/:slug/create-thread', canPost, (req, res) => {
  const node = F.nodeBySlug(req.params.slug);
  if (!node || node.type !== 'forum') return notFound(res);
  if (node.staff_only_post && !isStaff(req.user)) return notFound(res);
  if (useGameForm(req, node)) return createGameThread(req, res, node);
  const title = String(req.body.title || '').trim().slice(0, 150);
  const body = String(req.body.message || '').trim().slice(0, 50000);
  const prefixId = Number(req.body.prefix_id) || null;
  if (title.length < 3 || body.length < 2) {
    return res.render('thread_create', { pageTitle: 'Создать тему', node, breadcrumbs: [...F.breadcrumbs(node), node], prefixes: db.prepare('SELECT * FROM prefixes ORDER BY display_order').all(), form: req.body, error: 'Введите заголовок (от 3 символов) и текст сообщения.' });
  }
  const t = now();
  const id = tx(() => {
    const tid = Number(db.prepare(`INSERT INTO threads (node_id, user_id, username, title, prefix_id, created_at, last_post_at, last_post_user_id, last_post_username)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(node.id, req.user.id, req.user.username, title, prefixId, t, t, req.user.id, req.user.username).lastInsertRowid);
    db.prepare('INSERT INTO posts (thread_id, user_id, username, body, created_at) VALUES (?, ?, ?, ?, ?)').run(tid, req.user.id, req.user.username, body, t);
    return tid;
  });
  res.redirect(`/t/${id}/`);
});

function loadThread(id) {
  const t = db.prepare('SELECT * FROM threads WHERE id = ?').get(Number(id));
  if (!t) return null;
  t.node = F.nodeById(t.node_id);
  t.prefix = t.prefix_id ? db.prepare('SELECT * FROM prefixes WHERE id = ?').get(t.prefix_id) : null;
  return t;
}

app.get(['/t/:id/', '/t/:id/page-:page'], (req, res) => {
  const thread = loadThread(req.params.id);
  if (!thread) return notFound(res, 'Тема не найдена.');
  db.prepare('UPDATE threads SET view_count = view_count + 1 WHERE id = ?').run(thread.id);
  const total = db.prepare('SELECT COUNT(*) AS c FROM posts WHERE thread_id = ?').get(thread.id).c;
  const pg = paginate(total, req.params.page);
  const posts = enrichUsers(db.prepare('SELECT * FROM posts WHERE thread_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?').all(thread.id, pg.per, pg.offset));
  const firstId = db.prepare('SELECT id FROM posts WHERE thread_id = ? ORDER BY created_at, id LIMIT 1').get(thread.id)?.id;
  const reacts = new Map(posts.map(p => [p.id, []]));
  if (posts.length) for (const r of db.prepare(`SELECT r.post_id, r.emoji, r.user_id, u.username FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.post_id IN (${posts.map(() => '?').join(',')}) ORDER BY r.created_at`).all(...posts.map(p => p.id))) reacts.get(r.post_id).push(r);
  posts.forEach((p, i) => {
    p.position = pg.offset + i + 1;
    p.isFirst = p.id === firstId;
    p.reactions = reacts.get(p.id);
    p.myReaction = req.user ? (p.reactions.find(r => r.user_id === req.user.id) || {}).emoji : null;
  });
  res.render('thread', {
    pageTitle: thread.title, thread, posts, pg, baseUrl: `/t/${thread.id}/`,
    breadcrumbs: [...F.breadcrumbs(thread.node), thread.node],
    forums: isStaff(req.user) ? F.allNodes().filter(n => n.type === 'forum') : [],
    prefixes: db.prepare('SELECT * FROM prefixes ORDER BY display_order').all()
  });
});

app.post('/t/:id/reply', canPost, (req, res) => {
  const thread = loadThread(req.params.id);
  if (!thread) return notFound(res, 'Тема не найдена.');
  if (thread.is_locked && !isStaff(req.user)) return res.status(403).render('error', { pageTitle: 'Тема закрыта', message: 'Тема закрыта для новых сообщений.' });
  const body = String(req.body.message || '').trim().slice(0, 50000);
  if (body.length < 1) { flash(res, 'Сообщение не может быть пустым.'); return res.redirect(`/t/${thread.id}/`); }
  const t = now();
  const pid = tx(() => {
    const id = db.prepare('INSERT INTO posts (thread_id, user_id, username, body, created_at) VALUES (?, ?, ?, ?, ?)').run(thread.id, req.user.id, req.user.username, body, t).lastInsertRowid;
    db.prepare('UPDATE threads SET last_post_at = ?, last_post_user_id = ?, last_post_username = ? WHERE id = ?').run(t, req.user.id, req.user.username, thread.id);
    return Number(id);
  });
  res.redirect(`/posts/${pid}/`);
});

app.get('/t/:id/latest', (req, res) => {
  const p = db.prepare('SELECT id FROM posts WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(Number(req.params.id));
  if (!p) return notFound(res, 'Тема не найдена.');
  // straight to the last page, without the extra hop through /posts/:id/
  const page = Math.ceil(db.prepare('SELECT COUNT(*) AS c FROM posts WHERE thread_id = ?').get(Number(req.params.id)).c / PER_PAGE);
  res.redirect(`/t/${Number(req.params.id)}/${page > 1 ? 'page-' + page : ''}#post-${p.id}`);
});

app.get('/posts/:id/', (req, res) => {
  const p = db.prepare('SELECT id, thread_id, created_at FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!p) return notFound(res, 'Сообщение не найдено.');
  const pos = db.prepare('SELECT COUNT(*) AS c FROM posts WHERE thread_id = ? AND (created_at < ? OR (created_at = ? AND id <= ?))').get(p.thread_id, p.created_at, p.created_at, p.id).c;
  const page = Math.ceil(pos / PER_PAGE);
  res.redirect(`/t/${p.thread_id}/${page > 1 ? 'page-' + page : ''}#post-${p.id}`);
});

app.post('/posts/:id/react', canPost, (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  const emoji = String(req.body.emoji || '');
  if (!req.settings.reactionsList.includes(emoji)) return res.status(400).json({ error: 'bad reaction' });
  if (p.user_id === req.user.id) return res.status(400).json({ error: 'Нельзя реагировать на свои сообщения.' });
  const ex = db.prepare('SELECT emoji FROM reactions WHERE post_id = ? AND user_id = ?').get(p.id, req.user.id);
  if (ex && ex.emoji === emoji) db.prepare('DELETE FROM reactions WHERE post_id = ? AND user_id = ?').run(p.id, req.user.id);
  else db.prepare('INSERT INTO reactions (post_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(post_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at').run(p.id, req.user.id, emoji, now());
  if (req.get('accept')?.includes('application/json')) {
    const list = db.prepare('SELECT r.emoji, u.username FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.post_id = ? ORDER BY r.created_at').all(p.id);
    const mine = db.prepare('SELECT emoji FROM reactions WHERE post_id = ? AND user_id = ?').get(p.id, req.user.id)?.emoji || null;
    return res.json({ reactions: list, mine });
  }
  res.redirect(`/posts/${p.id}/`);
});

function canEditPost(user, post) {
  return user && !user.is_banned && (isStaff(user) || post.user_id === user.id);
}
app.get('/posts/:id/edit', canPost, (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!p || !canEditPost(req.user, p)) return notFound(res);
  const thread = loadThread(p.thread_id);
  res.render('post_edit', { pageTitle: 'Редактирование сообщения', post: p, thread, breadcrumbs: [...F.breadcrumbs(thread.node), thread.node] });
});
app.post('/posts/:id/edit', canPost, (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!p || !canEditPost(req.user, p)) return notFound(res);
  const body = String(req.body.message || '').trim().slice(0, 50000);
  if (body) db.prepare('UPDATE posts SET body = ?, edited_at = ? WHERE id = ?').run(body, now(), p.id);
  if (p.user_id !== req.user.id) F.logAction(req.user, 'Редактирование сообщения', `#${p.id} в теме ${p.thread_id}`);
  res.redirect(`/posts/${p.id}/`);
});
app.post('/posts/:id/delete', canPost, (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
  if (!p || !canEditPost(req.user, p)) return notFound(res);
  const first = db.prepare('SELECT id FROM posts WHERE thread_id = ? ORDER BY created_at, id LIMIT 1').get(p.thread_id).id;
  if (first === p.id && !isStaff(req.user)) { flash(res, 'Первое сообщение темы может удалить только модератор.'); return res.redirect(`/posts/${p.id}/`); }
  if (first === p.id) {
    const th = loadThread(p.thread_id);
    db.prepare('DELETE FROM threads WHERE id = ?').run(p.thread_id);
    F.logAction(req.user, 'Удаление темы', th.title);
    flash(res, 'Тема удалена.');
    return res.redirect(F.nodeUrl(th.node));
  }
  db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
  F.refreshThreadLast(p.thread_id);
  if (p.user_id !== req.user.id) F.logAction(req.user, 'Удаление сообщения', `#${p.id} от ${p.username}`);
  flash(res, 'Сообщение удалено.');
  res.redirect(`/t/${p.thread_id}/`);
});

app.post('/t/:id/moderate', canPost, (req, res) => {
  if (!isStaff(req.user)) return notFound(res);
  const thread = loadThread(req.params.id);
  if (!thread) return notFound(res);
  const a = req.body.action;
  if (a === 'sticky') db.prepare('UPDATE threads SET is_sticky = 1 - is_sticky WHERE id = ?').run(thread.id);
  else if (a === 'lock') db.prepare('UPDATE threads SET is_locked = 1 - is_locked WHERE id = ?').run(thread.id);
  else if (a === 'feature') db.prepare('UPDATE threads SET is_featured = 1 - is_featured WHERE id = ?').run(thread.id);
  else if (a === 'edit') {
    const title = String(req.body.title || '').trim().slice(0, 150);
    if (title) db.prepare('UPDATE threads SET title = ?, prefix_id = ? WHERE id = ?').run(title, Number(req.body.prefix_id) || null, thread.id);
  } else if (a === 'move') {
    const target = F.nodeById(req.body.node_id);
    if (target && target.type === 'forum') db.prepare('UPDATE threads SET node_id = ? WHERE id = ?').run(target.id, thread.id);
  } else if (a === 'delete') {
    db.prepare('DELETE FROM threads WHERE id = ?').run(thread.id);
    F.logAction(req.user, 'Удаление темы', thread.title);
    flash(res, 'Тема удалена.');
    return res.redirect(F.nodeUrl(thread.node));
  }
  F.logAction(req.user, 'Модерация темы: ' + a, thread.title);
  res.redirect(`/t/${thread.id}/`);
});

/* ---------- what's new, search ---------- */
function latestThreads(limit, offset = 0, where = '1=1', args = []) {
  const rows = db.prepare(`SELECT * FROM threads WHERE ${where} ORDER BY last_post_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  for (const t of rows) {
    t.node = F.nodeById(t.node_id);
    t.replies = db.prepare('SELECT COUNT(*) - 1 AS c FROM posts WHERE thread_id = ?').get(t.id).c;
    t.prefix = t.prefix_id ? db.prepare('SELECT * FROM prefixes WHERE id = ?').get(t.prefix_id) : null;
  }
  return rows;
}
app.get(['/new/', '/new/posts/'], (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS c FROM threads').get().c;
  const pg = paginate(total, req.query.page);
  res.render('whats_new', { pageTitle: 'Что нового?', whatsNew: true, threads: latestThreads(pg.per, pg.offset), pg, baseUrl: '/new/posts/?page=' });
});
app.get('/game/profit/', (req, res) => {
  const pref = db.prepare("SELECT id FROM prefixes WHERE css = 'label--profit'").get();
  const threads = pref ? latestThreads(100, 0, 'prefix_id = ?', [pref.id]) : [];
  res.render('whats_new', { pageTitle: 'Прибыльные игры', threads, pg: paginate(threads.length, 1, 100), baseUrl: '' });
});
app.get('/game/:slug/', (req, res) => {
  const n = F.nodeBySlug(req.params.slug);
  if (!n) return notFound(res);
  res.redirect(F.nodeUrl(n));
});
app.get('/search/', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  let results = [];
  if (q.length >= 2) {
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    results = db.prepare(`SELECT p.id, p.body, p.username, p.created_at, t.title, t.id AS thread_id FROM posts p JOIN threads t ON t.id = p.thread_id
      WHERE p.body LIKE ? OR t.title LIKE ? ORDER BY +p.created_at DESC, p.id DESC LIMIT 50`).all(like, like);
  }
  res.render('search', { pageTitle: 'Поиск', q, results });
});

/* ---------- auth ---------- */
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, now());
  db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), userId);
  res.cookie('sid', token, cookieOpts);
}
const safeTo = to => (typeof to === 'string' && /^\/(?![\/\\])/.test(to) && !/[\\\x00-\x1f]/.test(to)) ? to : '/';

app.get('/login/', (req, res) => res.render('login', { pageTitle: 'Вход', error: null, form: {}, to: safeTo(req.query.to) }));
// simple in-memory limits: per address and per account
const attempts = new Map();
function hit(key, max, windowMs) {
  const t = Date.now();
  let a = attempts.get(key);
  if (!a || t - a.t > windowMs) { a = { n: 0, t }; attempts.set(key, a); }
  return a.n >= max ? a : (a.n++, null);
}
const peek = (key, max, windowMs) => { const a = attempts.get(key); return !!(a && Date.now() - a.t <= windowMs && a.n >= max); };
setInterval(() => { const t = Date.now(); for (const [k, a] of attempts) if (t - a.t > 3600000) attempts.delete(k); }, 600000).unref();
app.post('/login/', (req, res) => {
  const login = String(req.body.login || '').trim();
  const ipKey = 'ip:' + req.ip, userKey = 'u:' + login.toLowerCase();
  if (peek(ipKey, 10, 15 * 60000) || peek(userKey, 30, 15 * 60000)) return res.status(429).render('login', { pageTitle: 'Вход', error: 'Слишком много попыток. Попробуйте через 15 минут.', form: req.body, to: safeTo(req.body.to) });
  const u = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login, login);
  if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) {
    hit(ipKey, 10, 15 * 60000); hit(userKey, 30, 15 * 60000);
    return res.render('login', { pageTitle: 'Вход', error: 'Неверное имя пользователя или пароль.', form: req.body, to: safeTo(req.body.to) });
  }
  attempts.delete(ipKey); attempts.delete(userKey);
  startSession(res, u.id);
  res.redirect(safeTo(req.body.to));
});
app.post('/logout/', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(String(req.cookies.sid));
  res.clearCookie('sid');
  res.redirect('/');
});

app.get('/register/', (req, res) => res.render('register', { pageTitle: 'Регистрация', error: null, form: {} }));
app.post('/register/', (req, res) => {
  const render = error => res.render('register', { pageTitle: 'Регистрация', error, form: req.body });
  if (req.settings.registration_open !== '1') return render('Регистрация временно закрыта.');
  if (peek('reg:' + req.ip, 5, 3600000)) return render('Слишком много регистраций с вашего адреса. Попробуйте позже.');
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  if (!/^[\wА-Яа-яЁё.\- ]{3,30}$/.test(username)) return render('Имя пользователя: от 3 до 30 символов, буквы, цифры, пробел, точка, дефис.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return render('Введите корректный e-mail.');
  if (password.length < 6) return render('Пароль должен быть не короче 6 символов.');
  if (password !== req.body.password2) return render('Пароли не совпадают.');
  if (!req.body.agree) return render('Необходимо принять правила форума.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return render('Это имя пользователя уже занято.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return render('Этот e-mail уже зарегистрирован.');
  const id = Number(db.prepare('INSERT INTO users (username, email, password_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(username, email, hashPassword(password), now(), now()).lastInsertRowid);
  hit('reg:' + req.ip, 5, 3600000);
  startSession(res, id);
  flash(res, 'Добро пожаловать! Регистрация завершена.');
  res.redirect('/');
});

/* ---------- members & account ---------- */
app.get('/members/', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const pg = paginate(total, req.query.page, 50);
  const users = db.prepare('SELECT * FROM users ORDER BY id LIMIT ? OFFSET ?').all(pg.per, pg.offset);
  for (const u of users) { const s = F.userStats(u.id); u.postCount = s.posts; u.reactionCount = s.reactions; u.rank = u.custom_title || fmt.rankFor(s.posts, req.settings.ranksList); }
  res.render('members', { pageTitle: 'Участники', users, pg, baseUrl: '/members/?page=' });
});
app.get('/members/:name/', (req, res) => {
  const u = F.userByName(req.params.name);
  if (!u) return notFound(res, 'Пользователь не найден.');
  const s = F.userStats(u.id);
  u.postCount = s.posts; u.reactionCount = s.reactions;
  u.rank = u.custom_title || fmt.rankFor(s.posts, req.settings.ranksList);
  u.bannerList = String(u.banners || '').split(',').map(x => x.trim()).filter(Boolean);
  const posts = db.prepare('SELECT p.*, t.title FROM posts p JOIN threads t ON t.id = p.thread_id WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id DESC LIMIT 20').all(u.id);
  const medals = db.prepare('SELECT title, gold, silver, bronze FROM tournaments WHERE status = ? AND (gold = ? OR silver = ? OR bronze = ?)').all('finished', u.username, u.username, u.username);
  res.render('member', { pageTitle: u.username, u, posts, medals });
});

app.get('/account/', requireUser, (req, res) => res.render('account', { pageTitle: 'Настройки аккаунта', error: null }));
app.post('/account/', requireUser, uploadAvatar.single('avatar'), checkCsrf, (req, res) => {
  const u = req.user;
  const realName = String(req.body.real_name || '').slice(0, 50);
  const location = String(req.body.location || '').slice(0, 50);
  const about = String(req.body.about || '').slice(0, 2000);
  db.prepare('UPDATE users SET real_name = ?, location = ?, about = ? WHERE id = ?').run(realName, location, about, u.id);
  if (req.file) {
    const ext = req.file.fieldname === 'avatar' && req.file.size <= 2 * 1024 * 1024 ? sniffImage(req.file.path) : null;
    if (!ext) {
      fs.unlink(req.file.path, () => {});
      flash(res, 'Аватар: только изображения PNG, JPG, GIF, WEBP до 2 МБ.');
      return res.redirect('/account/');
    }
    // the stored name always ends with the real image type
    const name = path.basename(req.file.filename, path.extname(req.file.filename)) + ext;
    fs.renameSync(req.file.path, path.join(UPLOADS, 'avatars', name));
    if (u.avatar) fs.unlink(path.join(UPLOADS, 'avatars', path.basename(u.avatar)), () => {});
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(name, u.id);
  }
  if (req.body.new_password) {
    if (!verifyPassword(String(req.body.current_password || ''), u.password_hash)) { flash(res, 'Текущий пароль указан неверно.'); return res.redirect('/account/'); }
    if (String(req.body.new_password).length < 6) { flash(res, 'Новый пароль слишком короткий.'); return res.redirect('/account/'); }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(req.body.new_password)), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, String(req.cookies.sid));
  }
  flash(res, 'Изменения сохранены.');
  res.redirect('/account/');
});

/* ---------- static pages ---------- */
function page(slug) { return db.prepare('SELECT * FROM pages WHERE slug = ?').get(slug); }
app.get('/rules/', (req, res) => {
  // Как в оригинале: правила оформлены закрытой темой от администрации в разделе «Общение».
  const pg = page('rules');
  const admin = db.prepare("SELECT id, username, created_at FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  const node = F.nodeBySlug('discuss');
  const post = enrichUsers([{ user_id: admin ? admin.id : null, username: admin ? admin.username : 'Администрация', body: pg ? pg.body : '', created_at: admin ? admin.created_at : now() }])[0];
  res.render('page', { pageTitle: 'Правила', page: pg, rulesPost: post, breadcrumbs: node ? [...F.breadcrumbs(node), node] : [] });
});
app.get('/help/', (req, res) => res.render('page', { pageTitle: 'Помощь', page: page('help'), helpNav: true, helpIndex: ['rules', 'terms', 'privacy-policy'].map(page).filter(Boolean) }));
app.get('/help/terms/', (req, res) => res.render('page', { pageTitle: 'Условия использования', page: page('terms'), helpNav: true }));
app.get('/help/privacy-policy/', (req, res) => res.render('page', { pageTitle: 'Политика конфиденциальности', page: page('privacy-policy'), helpNav: true }));
app.get('/info/', (req, res) => {
  const allowed = req.user && (isStaff(req.user) || F.userStats(req.user.id).posts >= 10);
  res.render('info', { pageTitle: 'Инфосервис', page: page('info'), allowed });
});

app.get('/misc/contact', (req, res) => res.render('contact', { pageTitle: 'Обратная связь', sent: false, error: null }));
app.post('/misc/contact', (req, res) => {
  const name = String(req.body.name || (req.user && req.user.username) || '').trim().slice(0, 100);
  const email = String(req.body.email || (req.user && req.user.email) || '').trim().slice(0, 200);
  const message = String(req.body.message || '').trim().slice(0, 5000);
  if (!name || !email || message.length < 5) return res.render('contact', { pageTitle: 'Обратная связь', sent: false, error: 'Заполните все поля.' });
  db.prepare('INSERT INTO contact_messages (name, email, message, user_id, created_at) VALUES (?, ?, ?, ?, ?)').run(name, email, message, req.user ? req.user.id : null, now());
  res.render('contact', { pageTitle: 'Обратная связь', sent: true, error: null });
});

app.post('/misc/preview', canPost, (req, res) => res.json({ html: fmt.bbcode(String(req.body.text || '').slice(0, 50000)) }));
app.get('/misc/style', (req, res) => res.render('style', { pageTitle: 'Выбор стиля', to: safeTo(req.query.to) }));
app.post('/misc/style', (req, res) => {
  res.cookie('style', req.body.style === 'old' ? 'old' : 'new', cookieOpts);
  res.redirect(safeTo(req.body.to));
});
app.get('/misc/scheme/:mode', (req, res) => {
  const m = ['light', 'dark', 'system'].includes(req.params.mode) ? req.params.mode : 'system';
  res.cookie('scheme', m, cookieOpts);
  res.redirect(safeTo(req.query.to));
});

/* ---------- files ---------- */
app.get(['/files/', '/files/categories/:cat/'], (req, res) => {
  const cat = req.params.cat ? db.prepare('SELECT * FROM file_categories WHERE id = ?').get(Number(req.params.cat)) : null;
  const where = cat ? 'WHERE category_id = ?' : '';
  const args = cat ? [cat.id] : [];
  const total = db.prepare(`SELECT COUNT(*) AS c FROM files ${where}`).get(...args).c;
  const pg = paginate(total, req.query.page);
  const files = db.prepare(`SELECT * FROM files ${where} ORDER BY is_featured DESC, updated_at DESC LIMIT ? OFFSET ?`).all(...args, pg.per, pg.offset);
  const cats = db.prepare('SELECT c.*, (SELECT COUNT(*) FROM files f WHERE f.category_id = c.id) AS cnt FROM file_categories c ORDER BY display_order').all();
  const stats = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(downloads),0) AS downloads, COALESCE(SUM(size),0) AS size FROM files').get();
  const featured = db.prepare('SELECT id, title FROM files WHERE is_featured = 1 ORDER BY updated_at DESC LIMIT 10').all();
  res.render('files', { pageTitle: cat ? cat.title : 'Файлы', files, cats, cat, stats, featured, pg, baseUrl: (cat ? `/files/categories/${cat.id}/` : '/files/') + '?page=' });
});
app.get('/files/add', canPost, (req, res) => res.render('file_add', { pageTitle: 'Добавить файл', cats: db.prepare('SELECT * FROM file_categories ORDER BY display_order').all(), error: null }));
app.post('/files/add', canPost, upload.single('file'), checkCsrf, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 100);
  if (req.file && (req.file.fieldname !== 'file' || !MEMBER_FILE_EXT.test(path.extname(req.file.originalname).toLowerCase()))) {
    fs.unlink(req.file.path, () => {});
    return res.render('file_add', { pageTitle: 'Добавить файл', cats: db.prepare('SELECT * FROM file_categories ORDER BY display_order').all(), error: 'Этот тип файла нельзя загрузить. Разрешены архивы, таблицы, документы и изображения.' });
  }
  if (!req.file || !title) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.render('file_add', { pageTitle: 'Добавить файл', cats: db.prepare('SELECT * FROM file_categories ORDER BY display_order').all(), error: 'Укажите название и выберите файл.' });
  }
  const t = now();
  const id = db.prepare(`INSERT INTO files (category_id, user_id, username, title, tagline, description, version, original_name, stored_name, size, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Number(req.body.category_id) || null, req.user.id, req.user.username, title,
    String(req.body.tagline || '').slice(0, 150), String(req.body.description || '').slice(0, 20000), String(req.body.version || '').slice(0, 30),
    req.file.originalname.slice(0, 200), req.file.filename, req.file.size, t, t).lastInsertRowid;
  res.redirect(`/files/${id}/`);
});
app.get('/files/:id/', (req, res) => {
  const f = db.prepare('SELECT f.*, c.title AS cat_title FROM files f LEFT JOIN file_categories c ON c.id = f.category_id WHERE f.id = ?').get(Number(req.params.id));
  if (!f) return notFound(res, 'Файл не найден.');
  res.render('file_view', { pageTitle: f.title, f });
});
app.get('/files/:id/download', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.id));
  if (!f) return notFound(res, 'Файл не найден.');
  if (!req.user) return res.redirect('/login/?to=' + encodeURIComponent(`/files/${f.id}/`));
  const file = path.join(UPLOADS, 'files', path.basename(f.stored_name));
  if (!fs.existsSync(file)) return notFound(res, 'Файл не найден на сервере.');
  res.download(file, f.original_name, err => { if (!err) db.prepare('UPDATE files SET downloads = downloads + 1 WHERE id = ?').run(f.id); });
});

/* ---------- tournaments ---------- */
const STATUS = { open: 'Открыт', active: 'Идёт', finished: 'Завершён' };
app.locals.TOURNAMENT_STATUS = STATUS;

function standings(tid) {
  return db.prepare(`SELECT u.username, u.id AS user_id,
      SUM(CASE WHEN m.result IS NOT NULL AND m.result = p.pick THEN 1 ELSE 0 END) AS points,
      SUM(CASE WHEN m.result IS NOT NULL THEN 1 ELSE 0 END) AS played
    FROM tournament_members tm JOIN users u ON u.id = tm.user_id
    LEFT JOIN predictions p ON p.user_id = tm.user_id AND p.match_id IN (SELECT id FROM matches WHERE tournament_id = tm.tournament_id)
    LEFT JOIN matches m ON m.id = p.match_id
    WHERE tm.tournament_id = ? GROUP BY u.id ORDER BY points DESC, u.username`).all(tid);
}

app.get('/bitva/', (req, res) => {
  const status = STATUS[req.query.status] ? req.query.status : '';
  const sport = String(req.query.sport || '');
  let where = '1=1'; const args = [];
  if (status) { where += ' AND status = ?'; args.push(status); }
  if (sport) { where += ' AND sport = ?'; args.push(sport); }
  const list = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM tournament_members WHERE tournament_id = t.id) AS members,
    (SELECT COUNT(*) FROM matches WHERE tournament_id = t.id) AS match_count FROM tournaments t WHERE ${where} ORDER BY t.id DESC`).all(...args);
  const sports = db.prepare('SELECT DISTINCT sport FROM tournaments ORDER BY sport').all().map(r => r.sport);
  res.render('tournaments', { pageTitle: 'Турниры', list, status, sport, sports });
});
app.get('/bitva/hall-of-fame', (req, res) => {
  const sport = String(req.query.sport || ''); const season = String(req.query.season || '');
  let where = "status = 'finished'"; const args = [];
  if (sport) { where += ' AND sport = ?'; args.push(sport); }
  if (season) { where += ' AND season = ?'; args.push(season); }
  const list = db.prepare(`SELECT * FROM tournaments WHERE ${where} ORDER BY id DESC`).all(...args);
  const sports = db.prepare("SELECT DISTINCT sport FROM tournaments WHERE status = 'finished'").all().map(r => r.sport);
  const seasons = db.prepare("SELECT DISTINCT season FROM tournaments WHERE status = 'finished' AND season != '' ORDER BY season DESC").all().map(r => r.season);
  const names = [...new Set(list.flatMap(t => [t.gold, t.silver, t.bronze]).filter(Boolean))];
  const members = new Set(names.length ? db.prepare(`SELECT username FROM users WHERE username IN (${names.map(() => '?').join(',')})`).all(...names).map(r => r.username) : []);
  res.render('hall_of_fame', { pageTitle: 'Зал славы', list, members, sport, season, sports, seasons, breadcrumbs: [{ title: '👑 Турниры', url: '/bitva/?status=open' }] });
});
app.get('/bitva/:id/', (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(req.params.id));
  if (!t) return notFound(res, 'Турнир не найден.');
  const matches = db.prepare('SELECT * FROM matches WHERE tournament_id = ? ORDER BY start_at').all(t.id);
  const joined = req.user ? !!db.prepare('SELECT 1 FROM tournament_members WHERE tournament_id = ? AND user_id = ?').get(t.id, req.user.id) : false;
  for (const m of matches) {
    m.votes = voteCounts(m.id);
    m.mine = req.user ? db.prepare('SELECT pick FROM predictions WHERE match_id = ? AND user_id = ?').get(m.id, req.user.id)?.pick : null;
    m.started = m.start_at <= now();
  }
  res.render('tournament', { pageTitle: t.title, t, matches, joined, table: standings(t.id), breadcrumbs: [{ title: 'Турниры', url: '/bitva/' }] });
});
app.post('/bitva/:id/join', canPost, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(req.params.id));
  if (!t || t.status === 'finished') return notFound(res);
  db.prepare('INSERT OR IGNORE INTO tournament_members (tournament_id, user_id, joined_at) VALUES (?, ?, ?)').run(t.id, req.user.id, now());
  flash(res, 'Вы участвуете в турнире.');
  res.redirect(`/bitva/${t.id}/`);
});
app.post('/bitva/:id/predict', canPost, (req, res) => {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(req.params.id));
  if (!t || t.status === 'finished') return notFound(res);
  db.prepare('INSERT OR IGNORE INTO tournament_members (tournament_id, user_id, joined_at) VALUES (?, ?, ?)').run(t.id, req.user.id, now());
  const matches = db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND result IS NULL AND start_at > ?').all(t.id, now());
  const up = db.prepare('INSERT INTO predictions (match_id, user_id, pick, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(match_id, user_id) DO UPDATE SET pick = excluded.pick, created_at = excluded.created_at');
  let n = 0;
  for (const m of matches) {
    const pick = req.body['m' + m.id];
    if (['1', 'X', '2'].includes(pick)) { up.run(m.id, req.user.id, pick, now()); n++; }
  }
  flash(res, n ? `Прогнозы сохранены: ${n}.` : 'Нет открытых матчей для прогноза.');
  res.redirect(req.body.to === 'home' ? '/' : `/bitva/${t.id}/`);
});

/* ---------- admin ---------- */
app.use('/admin', require('./lib/admin')({ upload, checkCsrf, UPLOADS }));

app.use((req, res) => notFound(res));
app.use((err, req, res, next) => {
  if (req.file) fs.unlink(req.file.path, () => {});
  if (err instanceof multer.MulterError || err.type === 'entity.too.large' || err.type === 'entity.parse.failed') {
    const message = err.code === 'LIMIT_FILE_SIZE' || err.type === 'entity.too.large' ? 'Файл или текст слишком большой.' : 'Неверный формат запроса.';
    return res.status(400).render('error', { pageTitle: 'Ошибка', message });
  }
  console.error(err);
  res.status(500).render('error', { pageTitle: 'Ошибка', message: 'Произошла ошибка на сервере.' });
});

if (require.main === module) {
  app.listen(PORT, process.env.HOST || undefined, () => console.log(`Форум запущен: http://localhost:${PORT}`));
}
module.exports = app;
