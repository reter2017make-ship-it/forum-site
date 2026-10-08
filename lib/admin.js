'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const { db, now, hashPassword, getSettings, setSetting } = require('./db');
const F = require('./forum');

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/i;
const BANNERS = ['Команда', 'Меценат', 'Модератор', 'Эксперт', 'Победитель турнира'];

module.exports = function adminRouter({ upload, checkCsrf, UPLOADS }) {
  const r = express.Router();

  r.use((req, res, next) => {
    if (!req.user) return res.redirect('/login/?to=' + encodeURIComponent(req.originalUrl));
    if (req.user.role !== 'admin') return res.status(403).render('error', { pageTitle: 'Нет доступа', message: 'Панель управления доступна только администраторам.' });
    res.locals.adminSection = req.path.split('/')[1] || 'dashboard';
    res.locals.unreadMessages = db.prepare('SELECT COUNT(*) AS c FROM contact_messages WHERE is_read = 0').get().c;
    next();
  });
  const back = (req, res, msg, to) => {
    if (msg) res.cookie('flash', msg, { httpOnly: true, sameSite: 'lax' });
    let ref = '';
    try { const u = new URL(req.get('referer') || '', 'http://x'); if (u.host === req.get('host')) ref = u.pathname + u.search; } catch { /* ignore */ }
    res.redirect(to || ref || '/admin/');
  };
  const log = (req, action, details) => F.logAction(req.user, action, details);

  /* ---------- dashboard & statistics ---------- */
  function daysBack(n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() + 180 * 60000 - i * 86400000).toISOString().slice(0, 10));
    return out;
  }
  function series(days, sql, from = days[0]) {
    const map = new Map(db.prepare(sql).all(from).map(x => [x.d, x.c]));
    return days.map(d => ({ d, c: map.get(d) || 0 }));
  }
  const dayExpr = col => `strftime('%Y-%m-%d', ${col} + 10800, 'unixepoch')`;
  // start of a Moscow calendar day as a unix time, so date filters can use the created_at indexes
  const dayStart = d => Date.parse(d + 'T00:00:00Z') / 1000 - 10800;

  r.get('/', (req, res) => {
    const range = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const days = daysBack(range);
    const today = days[days.length - 1];
    const count = sql => db.prepare(sql).get().c;
    const totals = {
      users: count('SELECT COUNT(*) AS c FROM users'),
      threads: count('SELECT COUNT(*) AS c FROM threads'),
      posts: count('SELECT COUNT(*) AS c FROM posts'),
      files: count('SELECT COUNT(*) AS c FROM files'),
      downloads: count('SELECT COALESCE(SUM(downloads),0) AS c FROM files'),
      reactions: count('SELECT COUNT(*) AS c FROM reactions'),
      banned: count('SELECT COUNT(*) AS c FROM users WHERE is_banned = 1'),
      tournaments: count("SELECT COUNT(*) AS c FROM tournaments WHERE status != 'finished'")
    };
    const todayStats = {
      views: db.prepare('SELECT COUNT(*) AS c FROM visits WHERE day = ?').get(today).c,
      visitors: db.prepare('SELECT COUNT(DISTINCT visitor) AS c FROM visits WHERE day = ?').get(today).c,
      registrations: db.prepare('SELECT COUNT(*) AS c FROM users WHERE created_at >= ? AND created_at < ?').get(dayStart(today), dayStart(today) + 86400).c,
      posts: db.prepare('SELECT COUNT(*) AS c FROM posts WHERE created_at >= ? AND created_at < ?').get(dayStart(today), dayStart(today) + 86400).c
    };
    const charts = {
      visitors: series(days, 'SELECT day AS d, COUNT(DISTINCT visitor) AS c FROM visits WHERE day >= ? GROUP BY day'),
      views: series(days, 'SELECT day AS d, COUNT(*) AS c FROM visits WHERE day >= ? GROUP BY day'),
      registrations: series(days, `SELECT ${dayExpr('created_at')} AS d, COUNT(*) AS c FROM users WHERE created_at >= ? GROUP BY d`, dayStart(days[0])),
      posts: series(days, `SELECT ${dayExpr('created_at')} AS d, COUNT(*) AS c FROM posts WHERE created_at >= ? GROUP BY d`, dayStart(days[0]))
    };
    const topPages = db.prepare('SELECT path, COUNT(*) AS c, COUNT(DISTINCT visitor) AS u FROM visits WHERE day >= ? GROUP BY path ORDER BY c DESC LIMIT 12').all(days[0]);
    for (const p of topPages) {
      const m = p.path.match(/^\/t\/(\d+)\//);
      if (m) p.label = db.prepare('SELECT title FROM threads WHERE id = ?').get(Number(m[1]))?.title;
      const f = p.path.match(/^\/f\/([^/]+)\//);
      if (f) p.label = F.nodeBySlug(f[1])?.title;
      if (p.path === '/') p.label = 'Главная';
    }
    const topForums = db.prepare(`SELECT n.title, n.slug, COUNT(p.id) AS c FROM posts p JOIN threads t ON t.id = p.thread_id JOIN nodes n ON n.id = t.node_id
      WHERE p.created_at >= ? GROUP BY n.id ORDER BY c DESC LIMIT 8`).all(now() - range * 86400);
    const topPosters = db.prepare(`SELECT username, COUNT(*) AS c FROM posts WHERE created_at >= ? AND user_id IS NOT NULL GROUP BY user_id ORDER BY c DESC LIMIT 8`).all(now() - range * 86400);
    const latestUsers = db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 8').all();
    const latestPosts = db.prepare('SELECT p.*, t.title FROM posts p JOIN threads t ON t.id = p.thread_id ORDER BY p.created_at DESC, p.id DESC LIMIT 8').all();
    res.render('admin/dashboard', { pageTitle: 'Панель управления', totals, todayStats, charts, range, topPages, topForums, topPosters, latestUsers, latestPosts, online: F.onlineNow() });
  });

  /* ---------- nodes ---------- */
  r.get('/nodes', (req, res) => {
    const { roots } = F.nodeTree();
    res.render('admin/nodes', { pageTitle: 'Разделы форума', roots });
  });
  r.get(['/nodes/add', '/nodes/:id/edit'], (req, res) => {
    const node = req.params.id ? F.nodeById(req.params.id) : { type: req.query.type || 'forum', parent_id: Number(req.query.parent) || null, display_order: 10 };
    if (!node) return back(req, res, 'Раздел не найден.', '/admin/nodes');
    const parents = F.allNodes().filter(n => n.type !== 'link' && n.id !== node.id);
    res.render('admin/node_edit', { pageTitle: node.id ? 'Редактирование раздела' : 'Новый раздел', node, parents, prefixes: db.prepare('SELECT * FROM prefixes ORDER BY display_order').all() });
  });
  r.post(['/nodes/add', '/nodes/:id/edit'], (req, res) => {
    const b = req.body;
    const type = ['category', 'forum', 'link'].includes(b.type) ? b.type : 'forum';
    const title = String(b.title || '').trim();
    const slug = String(b.slug || '').trim();
    if (!title || !SLUG_RE.test(slug)) return back(req, res, 'Укажите название и адрес (латиница, цифры, дефис).');
    const dupe = db.prepare('SELECT id FROM nodes WHERE slug = ?').get(slug);
    if (dupe && dupe.id !== Number(req.params.id)) return back(req, res, 'Такой адрес уже используется.');
    let parent = Number(b.parent_id) || null;
    if (req.params.id && parent) {
      // forbid moving a node under its own descendant
      let cur = F.nodeById(parent);
      while (cur) { if (cur.id === Number(req.params.id)) { parent = null; break; } cur = cur.parent_id ? F.nodeById(cur.parent_id) : null; }
    }
    const vals = [parent, type, title, String(b.description || ''), slug, String(b.link_url || ''), String(b.icon || ''), Number(b.display_order) || 0, b.staff_only_post ? 1 : 0,
      b.is_game ? 1 : 0, String(b.game_schemes || '').slice(0, 1000), String(b.game_notice || '').slice(0, 5000), Number(b.game_prefix_id) || null];
    if (req.params.id) {
      db.prepare('UPDATE nodes SET parent_id=?, type=?, title=?, description=?, slug=?, link_url=?, icon=?, display_order=?, staff_only_post=?, is_game=?, game_schemes=?, game_notice=?, game_prefix_id=? WHERE id = ?').run(...vals, Number(req.params.id));
      log(req, 'Изменён раздел', title);
    } else {
      db.prepare('INSERT INTO nodes (parent_id, type, title, description, slug, link_url, icon, display_order, staff_only_post, is_game, game_schemes, game_notice, game_prefix_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals);
      log(req, 'Создан раздел', title);
    }
    back(req, res, 'Раздел сохранён.', '/admin/nodes');
  });
  r.post('/nodes/:id/delete', (req, res) => {
    const n = F.nodeById(req.params.id);
    if (n) { db.prepare('DELETE FROM nodes WHERE id = ?').run(n.id); log(req, 'Удалён раздел', n.title); }
    back(req, res, 'Раздел удалён вместе с подразделами и темами.', '/admin/nodes');
  });

  /* ---------- threads & posts ---------- */
  r.get('/threads', (req, res) => {
    const q = String(req.query.q || '').trim();
    const nodeId = Number(req.query.node) || 0;
    let where = '1=1'; const args = [];
    if (q) { where += ' AND (t.title LIKE ? OR t.username LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
    if (nodeId) { where += ' AND t.node_id = ?'; args.push(nodeId); }
    const page = Math.max(1, Number(req.query.page) || 1);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM threads t WHERE ${where}`).get(...args).c;
    const threads = db.prepare(`SELECT t.*, n.title AS node_title, (SELECT COUNT(*) FROM posts WHERE thread_id = t.id) AS posts
      FROM threads t JOIN nodes n ON n.id = t.node_id WHERE ${where} ORDER BY t.last_post_at DESC LIMIT 50 OFFSET ?`).all(...args, (page - 1) * 50);
    res.render('admin/threads', { pageTitle: 'Темы', threads, q, nodeId, page, pages: Math.max(1, Math.ceil(total / 50)), total, forums: F.allNodes().filter(n => n.type === 'forum') });
  });
  r.post('/threads/bulk', (req, res) => {
    const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
    const a = req.body.action;
    for (const id of ids) {
      if (a === 'delete') db.prepare('DELETE FROM threads WHERE id = ?').run(id);
      else if (a === 'sticky') db.prepare('UPDATE threads SET is_sticky = 1 - is_sticky WHERE id = ?').run(id);
      else if (a === 'lock') db.prepare('UPDATE threads SET is_locked = 1 - is_locked WHERE id = ?').run(id);
      else if (a === 'move' && F.nodeById(req.body.node_id)) db.prepare('UPDATE threads SET node_id = ? WHERE id = ?').run(Number(req.body.node_id), id);
    }
    if (ids.length) log(req, 'Массовое действие с темами: ' + a, ids.join(', '));
    back(req, res, ids.length ? `Готово: ${ids.length}.` : 'Ничего не выбрано.');
  });
  r.get('/posts', (req, res) => {
    const q = String(req.query.q || '').trim();
    const where = q ? 'WHERE p.body LIKE ? OR p.username LIKE ?' : '';
    const args = q ? [`%${q}%`, `%${q}%`] : [];
    const posts = db.prepare(`SELECT p.*, t.title FROM posts p JOIN threads t ON t.id = p.thread_id ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT 100`).all(...args);
    res.render('admin/posts', { pageTitle: 'Сообщения', posts, q });
  });
  r.post('/posts/:id/delete', (req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(Number(req.params.id));
    if (p) {
      db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
      F.refreshThreadLast(p.thread_id);
      log(req, 'Удалено сообщение', `#${p.id} от ${p.username}`);
    }
    back(req, res, 'Сообщение удалено.');
  });

  /* ---------- users ---------- */
  r.get('/users', (req, res) => {
    const q = String(req.query.q || '').trim();
    const role = String(req.query.role || '');
    let where = '1=1'; const args = [];
    if (q) { where += ' AND (username LIKE ? OR email LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
    if (role === 'banned') where += ' AND is_banned = 1';
    else if (role) { where += ' AND role = ?'; args.push(role); }
    const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM posts WHERE user_id = u.id) AS posts FROM users u WHERE ${where} ORDER BY u.id DESC LIMIT 200`).all(...args);
    res.render('admin/users', { pageTitle: 'Пользователи', users, q, role });
  });
  r.get('/users/:id(\\d+)', (req, res) => {
    const u = F.userById(req.params.id);
    if (!u) return back(req, res, 'Пользователь не найден.', '/admin/users');
    const st = F.userStats(u.id);
    const visits = db.prepare('SELECT COUNT(*) AS c FROM visits WHERE user_id = ?').get(u.id).c;
    res.render('admin/user_edit', { pageTitle: u.username, u, st, visits, BANNERS });
  });
  r.post('/users/:id(\\d+)', (req, res) => {
    const u = F.userById(req.params.id);
    if (!u) return back(req, res, 'Пользователь не найден.', '/admin/users');
    const b = req.body;
    const username = String(b.username || '').trim();
    if (username.length < 3) return back(req, res, 'Имя пользователя слишком короткое.');
    const dupe = db.prepare('SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?').get(username, String(b.email || ''), u.id);
    if (dupe) return back(req, res, 'Имя пользователя или e-mail уже заняты.');
    let role = ['admin', 'moderator', 'user'].includes(b.role) ? b.role : 'user';
    if (u.id === req.user.id) role = 'admin'; // never demote yourself
    const banners = [].concat(b.banners || []).filter(x => BANNERS.includes(x)).concat(String(b.extra_banners || '').split(',').map(x => x.trim()).filter(Boolean)).join(', ');
    db.prepare(`UPDATE users SET username=?, email=?, role=?, custom_title=?, banners=?, username_color=?, real_name=?, location=?, about=?, is_banned=?, ban_reason=? WHERE id = ?`)
      .run(username, String(b.email || u.email), role, String(b.custom_title || ''), banners, /^#[0-9a-f]{3,6}$/i.test(b.username_color || '') ? b.username_color : '',
        String(b.real_name || ''), String(b.location || ''), String(b.about || ''), u.id !== req.user.id && b.is_banned ? 1 : 0, String(b.ban_reason || ''), u.id);
    if (username !== u.username) {
      db.prepare('UPDATE posts SET username = ? WHERE user_id = ?').run(username, u.id);
      db.prepare('UPDATE threads SET username = ? WHERE user_id = ?').run(username, u.id);
      db.prepare('UPDATE threads SET last_post_username = ? WHERE last_post_user_id = ?').run(username, u.id);
    }
    if (b.new_password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(b.new_password)), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    if (b.is_banned && u.id !== req.user.id) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    if (b.remove_avatar && u.avatar) {
      fs.unlink(path.join(UPLOADS, 'avatars', path.basename(u.avatar)), () => {});
      db.prepare("UPDATE users SET avatar = '' WHERE id = ?").run(u.id);
    }
    log(req, 'Изменён пользователь', username + (b.is_banned ? ' (заблокирован)' : ''));
    back(req, res, 'Пользователь сохранён.');
  });
  r.post('/users/:id(\\d+)/delete', (req, res) => {
    const u = F.userById(req.params.id);
    if (!u || u.id === req.user.id) return back(req, res, 'Нельзя удалить этого пользователя.');
    if (req.body.delete_content) {
      const threadIds = db.prepare('SELECT DISTINCT thread_id FROM posts WHERE user_id = ?').all(u.id).map(x => x.thread_id);
      db.prepare('DELETE FROM threads WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM posts WHERE user_id = ?').run(u.id);
      for (const id of threadIds) if (db.prepare('SELECT 1 FROM threads WHERE id = ?').get(id)) F.refreshThreadLast(id);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    log(req, 'Удалён пользователь', u.username);
    back(req, res, 'Пользователь удалён.', '/admin/users');
  });
  r.post('/users/add', (req, res) => {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    if (username.length < 3 || !email.includes('@') || password.length < 6) return back(req, res, 'Заполните имя (3+), e-mail и пароль (6+).');
    if (db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(username, email)) return back(req, res, 'Имя или e-mail уже заняты.');
    const role = ['admin', 'moderator', 'user'].includes(req.body.role) ? req.body.role : 'user';
    db.prepare('INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(username, email, hashPassword(password), role, now());
    log(req, 'Создан пользователь', username);
    back(req, res, 'Пользователь создан.');
  });

  /* ---------- prefixes ---------- */
  r.get('/prefixes', (req, res) => res.render('admin/prefixes', { pageTitle: 'Префиксы тем', prefixes: db.prepare('SELECT p.*, (SELECT COUNT(*) FROM threads WHERE prefix_id = p.id) AS used FROM prefixes p ORDER BY display_order').all() }));
  r.post('/prefixes', (req, res) => {
    const b = req.body;
    const css = /^label--[a-z0-9-]+$/i.test(b.css || '') ? b.css : 'label--primary';
    if (b.id) db.prepare('UPDATE prefixes SET title = ?, css = ?, display_order = ? WHERE id = ?').run(String(b.title), css, Number(b.display_order) || 0, Number(b.id));
    else if (b.title) db.prepare('INSERT INTO prefixes (title, css, display_order) VALUES (?, ?, ?)').run(String(b.title), css, Number(b.display_order) || 0);
    back(req, res, 'Префикс сохранён.');
  });
  r.post('/prefixes/:id/delete', (req, res) => { db.prepare('DELETE FROM prefixes WHERE id = ?').run(Number(req.params.id)); back(req, res, 'Префикс удалён.'); });

  /* ---------- files ---------- */
  r.get('/files', (req, res) => {
    res.render('admin/files', {
      pageTitle: 'Файлы',
      files: db.prepare('SELECT f.*, c.title AS cat_title FROM files f LEFT JOIN file_categories c ON c.id = f.category_id ORDER BY f.id DESC').all(),
      cats: db.prepare('SELECT c.*, (SELECT COUNT(*) FROM files WHERE category_id = c.id) AS cnt FROM file_categories c ORDER BY display_order').all()
    });
  });
  r.post('/files/upload', upload.single('file'), checkCsrf, (req, res) => {
    const title = String(req.body.title || '').trim();
    if (!req.file || !title) { if (req.file) fs.unlink(req.file.path, () => {}); return back(req, res, 'Укажите название и файл.'); }
    db.prepare(`INSERT INTO files (category_id, user_id, username, title, tagline, description, version, original_name, stored_name, size, is_featured, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Number(req.body.category_id) || null, req.user.id, req.user.username, title, String(req.body.tagline || ''),
      String(req.body.description || ''), String(req.body.version || ''), req.file.originalname, req.file.filename, req.file.size, req.body.is_featured ? 1 : 0, now(), now());
    log(req, 'Загружен файл', title);
    back(req, res, 'Файл добавлен.');
  });
  r.post('/files/:id', (req, res) => {
    const b = req.body;
    db.prepare('UPDATE files SET title = ?, tagline = ?, version = ?, category_id = ?, is_featured = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(String(b.title || ''), String(b.tagline || ''), String(b.version || ''), Number(b.category_id) || null, b.is_featured ? 1 : 0, String(b.description || ''), now(), Number(req.params.id));
    back(req, res, 'Файл сохранён.');
  });
  r.post('/files/:id/delete', (req, res) => {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(req.params.id));
    if (f) { fs.unlink(path.join(UPLOADS, 'files', path.basename(f.stored_name)), () => {}); db.prepare('DELETE FROM files WHERE id = ?').run(f.id); log(req, 'Удалён файл', f.title); }
    back(req, res, 'Файл удалён.');
  });
  r.post('/file-categories', (req, res) => {
    const b = req.body;
    if (b.id) db.prepare('UPDATE file_categories SET title = ?, display_order = ? WHERE id = ?').run(String(b.title), Number(b.display_order) || 0, Number(b.id));
    else if (b.title) db.prepare('INSERT INTO file_categories (title, display_order) VALUES (?, ?)').run(String(b.title), Number(b.display_order) || 0);
    back(req, res, 'Категория сохранена.');
  });
  r.post('/file-categories/:id/delete', (req, res) => { db.prepare('DELETE FROM file_categories WHERE id = ?').run(Number(req.params.id)); back(req, res, 'Категория удалена.'); });

  /* ---------- tournaments ---------- */
  r.get('/tournaments', (req, res) => {
    res.render('admin/tournaments', { pageTitle: 'Турниры', list: db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM tournament_members WHERE tournament_id = t.id) AS members,
      (SELECT COUNT(*) FROM matches WHERE tournament_id = t.id) AS match_count FROM tournaments t ORDER BY id DESC`).all() });
  });
  r.get(['/tournaments/add', '/tournaments/:id'], (req, res) => {
    const t = req.params.id ? db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(req.params.id)) : { status: 'open', sport: 'Футбол' };
    if (!t) return back(req, res, 'Турнир не найден.', '/admin/tournaments');
    const matches = t.id ? db.prepare('SELECT m.*, (SELECT COUNT(*) FROM predictions WHERE match_id = m.id) AS preds FROM matches m WHERE tournament_id = ? ORDER BY start_at').all(t.id) : [];
    const members = t.id ? db.prepare(`SELECT u.username, SUM(CASE WHEN m.result IS NOT NULL AND m.result = p.pick THEN 1 ELSE 0 END) AS points
      FROM tournament_members tm JOIN users u ON u.id = tm.user_id LEFT JOIN predictions p ON p.user_id = tm.user_id AND p.match_id IN (SELECT id FROM matches WHERE tournament_id = tm.tournament_id)
      LEFT JOIN matches m ON m.id = p.match_id WHERE tm.tournament_id = ? GROUP BY u.id ORDER BY points DESC`).all(t.id) : [];
    res.render('admin/tournament_edit', { pageTitle: t.id ? t.title : 'Новый турнир', t, matches, members });
  });
  r.post(['/tournaments/add', '/tournaments/:id'], (req, res) => {
    const b = req.body;
    const status = ['open', 'active', 'finished'].includes(b.status) ? b.status : 'open';
    const vals = [String(b.title || 'Турнир'), String(b.sport || 'Футбол'), String(b.season || ''), status, String(b.description || ''), String(b.prize || ''), String(b.thread_url || ''), String(b.gold || ''), String(b.silver || ''), String(b.bronze || '')];
    let id = Number(req.params.id);
    if (id) db.prepare('UPDATE tournaments SET title=?, sport=?, season=?, status=?, description=?, prize=?, thread_url=?, gold=?, silver=?, bronze=? WHERE id = ?').run(...vals, id);
    else id = Number(db.prepare('INSERT INTO tournaments (title, sport, season, status, description, prize, thread_url, gold, silver, bronze, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...vals, now()).lastInsertRowid);
    log(req, 'Сохранён турнир', vals[0]);
    back(req, res, 'Турнир сохранён.', `/admin/tournaments/${id}`);
  });
  r.post('/tournaments/:id/auto-winners', (req, res) => {
    const id = Number(req.params.id);
    const rows = db.prepare(`SELECT u.username, SUM(CASE WHEN m.result IS NOT NULL AND m.result = p.pick THEN 1 ELSE 0 END) AS points
      FROM tournament_members tm JOIN users u ON u.id = tm.user_id LEFT JOIN predictions p ON p.user_id = tm.user_id AND p.match_id IN (SELECT id FROM matches WHERE tournament_id = tm.tournament_id)
      LEFT JOIN matches m ON m.id = p.match_id WHERE tm.tournament_id = ? GROUP BY u.id ORDER BY points DESC LIMIT 3`).all(id);
    db.prepare("UPDATE tournaments SET gold = ?, silver = ?, bronze = ?, status = 'finished' WHERE id = ?").run(rows[0]?.username || '', rows[1]?.username || '', rows[2]?.username || '', id);
    back(req, res, 'Победители определены по таблице, турнир завершён.');
  });
  r.post('/tournaments/:id/delete', (req, res) => { db.prepare('DELETE FROM tournaments WHERE id = ?').run(Number(req.params.id)); back(req, res, 'Турнир удалён.', '/admin/tournaments'); });
  r.post('/tournaments/:id/matches', (req, res) => {
    const b = req.body;
    const ts = Math.floor(new Date(String(b.start_at) + ':00+03:00').getTime() / 1000);
    if (!b.home || !b.away || !ts) return back(req, res, 'Укажите команды и время начала.');
    db.prepare('INSERT INTO matches (tournament_id, home, away, start_at) VALUES (?, ?, ?, ?)').run(Number(req.params.id), String(b.home), String(b.away), ts);
    back(req, res, 'Матч добавлен.');
  });
  r.post('/matches/:id', (req, res) => {
    const result = ['1', 'X', '2'].includes(req.body.result) ? req.body.result : null;
    if (req.body.delete) db.prepare('DELETE FROM matches WHERE id = ?').run(Number(req.params.id));
    else db.prepare('UPDATE matches SET result = ? WHERE id = ?').run(result, Number(req.params.id));
    back(req, res, req.body.delete ? 'Матч удалён.' : 'Результат сохранён.');
  });

  /* ---------- big wins widget ---------- */
  r.get('/big-wins', (req, res) => res.render('admin/big_wins', { pageTitle: 'Большие победы', rows: db.prepare('SELECT * FROM big_wins ORDER BY display_order, id').all() }));
  r.post('/big-wins', (req, res) => {
    const b = req.body;
    const vals = [String(b.title || ''), String(b.username || ''), Number(b.stake) || 0, Number(b.payout) || 0, String(b.link || ''), Number(b.display_order) || 0, String(b.win_date || '').slice(0, 20)];
    if (!vals[0] || !vals[1]) return back(req, res, 'Укажите тираж и игрока.');
    if (b.id) db.prepare('UPDATE big_wins SET title=?, username=?, stake=?, payout=?, link=?, display_order=?, win_date=? WHERE id = ?').run(...vals, Number(b.id));
    else db.prepare('INSERT INTO big_wins (title, username, stake, payout, link, display_order, win_date) VALUES (?,?,?,?,?,?,?)').run(...vals);
    back(req, res, 'Запись сохранена.');
  });
  r.post('/big-wins/:id/delete', (req, res) => { db.prepare('DELETE FROM big_wins WHERE id = ?').run(Number(req.params.id)); back(req, res, 'Запись удалена.'); });

  /* ---------- pages ---------- */
  r.get('/pages', (req, res) => res.render('admin/pages', { pageTitle: 'Страницы', pages: db.prepare('SELECT * FROM pages ORDER BY slug').all() }));
  r.get('/pages/:slug', (req, res) => {
    const p = db.prepare('SELECT * FROM pages WHERE slug = ?').get(req.params.slug);
    if (!p) return back(req, res, 'Страница не найдена.', '/admin/pages');
    res.render('admin/page_edit', { pageTitle: p.title, p });
  });
  r.post('/pages/:slug', (req, res) => {
    db.prepare('UPDATE pages SET title = ?, body = ? WHERE slug = ?').run(String(req.body.title || ''), String(req.body.body || ''), req.params.slug);
    log(req, 'Изменена страница', req.params.slug);
    back(req, res, 'Страница сохранена.');
  });

  /* ---------- settings ---------- */
  r.get('/settings', (req, res) => res.render('admin/settings', { pageTitle: 'Настройки', s: getSettings() }));
  r.post('/settings', (req, res) => {
    const b = req.body;
    for (const k of ['site_name', 'logo_main', 'logo_suffix', 'site_description', 'footer_text', 'counter_code', 'welcome_notice', 'notice_image', 'infoservice_title', 'infoservice_text', 'infoservice_link', 'infoservice_image']) setSetting(k, String(b[k] ?? ''));
    setSetting('theme_color', /^#[0-9a-f]{6}$/i.test(b.theme_color || '') ? b.theme_color : '#33354d');
    setSetting('registration_open', b.registration_open ? '1' : '0');
    setSetting('default_scheme', ['light', 'dark', 'system'].includes(b.default_scheme) ? b.default_scheme : 'system');
    const ranks = String(b.ranks || '').split('\n').map(l => l.match(/^\s*(\d+)\s*[=:]\s*(.+?)\s*$/)).filter(Boolean).map(m => ({ min: Number(m[1]), title: m[2] })).sort((a, c) => a.min - c.min);
    if (ranks.length) setSetting('ranks', JSON.stringify(ranks));
    const reactions = String(b.reactions || '').split(/\s+/).filter(Boolean).slice(0, 12);
    if (reactions.length) setSetting('reactions', JSON.stringify(reactions));
    log(req, 'Изменены настройки', '');
    back(req, res, 'Настройки сохранены.');
  });

  /* ---------- messages & log ---------- */
  r.get('/messages', (req, res) => {
    const rows = db.prepare('SELECT * FROM contact_messages ORDER BY id DESC LIMIT 200').all();
    db.prepare('UPDATE contact_messages SET is_read = 1 WHERE is_read = 0').run();
    res.render('admin/messages', { pageTitle: 'Обратная связь', rows });
  });
  r.post('/messages/:id/delete', (req, res) => { db.prepare('DELETE FROM contact_messages WHERE id = ?').run(Number(req.params.id)); back(req, res, 'Сообщение удалено.'); });
  r.get('/log', (req, res) => res.render('admin/log', { pageTitle: 'Журнал действий', rows: db.prepare('SELECT * FROM mod_log ORDER BY id DESC LIMIT 300').all() }));

  return r;
};
