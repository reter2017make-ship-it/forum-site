'use strict';
const { db, now, cached } = require('./db');

function allNodes() {
  return db.prepare('SELECT * FROM nodes ORDER BY display_order, id').all();
}

// Builds the tree and rolls thread/post counters and the latest thread up through parents.
// Cached until the next write request; callers must not modify the result.
function nodeTree() { return cached('nodeTree', buildNodeTree); }
function buildNodeTree() {
  const nodes = allNodes();
  const stats = db.prepare(`SELECT t.node_id, COUNT(DISTINCT t.id) AS threads, COUNT(p.id) AS posts
    FROM threads t LEFT JOIN posts p ON p.thread_id = t.id GROUP BY t.node_id`).all();
  const last = db.prepare(`SELECT t.* FROM threads t
    JOIN (SELECT node_id, MAX(last_post_at) AS m FROM threads GROUP BY node_id) x
    ON x.node_id = t.node_id AND x.m = t.last_post_at`).all();
  const byId = new Map();
  for (const n of nodes) byId.set(n.id, Object.assign(n, { children: [], threads: 0, posts: 0, last: null }));
  for (const s of stats) { const n = byId.get(s.node_id); if (n) { n.threads = s.threads; n.posts = s.posts; } }
  const pfx = new Map(db.prepare('SELECT * FROM prefixes').all().map(p => [p.id, p]));
  const ids = [...new Set(last.map(t => t.last_post_user_id).filter(Boolean))];
  const who = new Map(ids.length ? db.prepare(`SELECT id, username, role, username_color, avatar FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(u => [u.id, u]) : []);
  for (const t of last) {
    t.prefix = t.prefix_id ? pfx.get(t.prefix_id) || null : null;
    t.lastUser = who.get(t.last_post_user_id) || null;
    const n = byId.get(t.node_id);
    if (n && (!n.last || t.last_post_at > n.last.last_post_at)) n.last = t;
  }
  const roots = [];
  for (const n of nodes) (n.parent_id && byId.get(n.parent_id) ? byId.get(n.parent_id).children : roots).push(n);
  const roll = n => {
    for (const c of n.children) {
      roll(c);
      n.threads += c.threads; n.posts += c.posts;
      if (c.last && (!n.last || c.last.last_post_at > n.last.last_post_at)) n.last = c.last;
    }
  };
  roots.forEach(roll);
  return { roots, byId };
}

function nodeBySlug(slug) { return db.prepare('SELECT * FROM nodes WHERE slug = ?').get(String(slug)); }
function nodeById(id) { return db.prepare('SELECT * FROM nodes WHERE id = ?').get(Number(id)); }

function breadcrumbs(node) {
  const out = [];
  let cur = node && node.parent_id ? nodeById(node.parent_id) : null;
  while (cur) { out.unshift(cur); cur = cur.parent_id ? nodeById(cur.parent_id) : null; }
  return out;
}

function nodeUrl(n) {
  if (n.type === 'category') return `/c/${n.slug}/`;
  if (n.type === 'link') return `/link/${n.slug}/`;
  return `/f/${n.slug}/`;
}

function userStats(userId) {
  const posts = db.prepare('SELECT COUNT(*) AS c FROM posts WHERE user_id = ?').get(userId).c;
  const reactions = db.prepare('SELECT COUNT(*) AS c FROM reactions r JOIN posts p ON p.id = r.post_id WHERE p.user_id = ? AND r.user_id != ?').get(userId, userId).c;
  return { posts, reactions };
}

function userByName(name) { return db.prepare('SELECT * FROM users WHERE username = ?').get(String(name)); }
function userById(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)); }

function onlineNow() {
  const since = now() - 15 * 60;
  const users = db.prepare('SELECT id, username, role, username_color FROM users WHERE last_seen >= ? ORDER BY username').all(since);
  const guests = db.prepare('SELECT COUNT(DISTINCT visitor) AS c FROM visits WHERE created_at >= ? AND user_id IS NULL').get(since).c;
  return { users, guests, total: users.length + guests };
}

function logAction(user, action, details = '') {
  db.prepare('INSERT INTO mod_log (user_id, username, action, details, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(user ? user.id : null, user ? user.username : 'система', action, String(details).slice(0, 500), now());
}

function refreshThreadLast(threadId) {
  const p = db.prepare('SELECT user_id, username, created_at FROM posts WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(threadId);
  if (!p) { db.prepare('DELETE FROM threads WHERE id = ?').run(threadId); return false; }
  db.prepare('UPDATE threads SET last_post_at = ?, last_post_user_id = ?, last_post_username = ? WHERE id = ?')
    .run(p.created_at, p.user_id, p.username, threadId);
  return true;
}

module.exports = { allNodes, nodeTree, nodeBySlug, nodeById, breadcrumbs, nodeUrl, userStats, userByName, userById, onlineNow, logAction, refreshThreadLast };
