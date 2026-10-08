'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'avatars'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'files'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'forum.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  custom_title TEXT DEFAULT '',
  banners TEXT DEFAULT '',
  username_color TEXT DEFAULT '',
  real_name TEXT DEFAULT '',
  location TEXT DEFAULT '',
  about TEXT DEFAULT '',
  avatar TEXT DEFAULT '',
  is_banned INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  slug TEXT NOT NULL UNIQUE,
  link_url TEXT DEFAULT '',
  icon TEXT DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  staff_only_post INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS prefixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  css TEXT NOT NULL DEFAULT 'label--primary',
  display_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  title TEXT NOT NULL,
  prefix_id INTEGER REFERENCES prefixes(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  last_post_at INTEGER NOT NULL,
  last_post_user_id INTEGER,
  last_post_username TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  is_sticky INTEGER NOT NULL DEFAULT 0,
  is_locked INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS threads_node ON threads(node_id, is_sticky, last_post_at);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX IF NOT EXISTS posts_thread ON posts(thread_id, created_at);
CREATE INDEX IF NOT EXISTS posts_user ON posts(user_id);
CREATE INDEX IF NOT EXISTS posts_user_time ON posts(user_id, created_at);
CREATE INDEX IF NOT EXISTS posts_time ON posts(created_at);
CREATE INDEX IF NOT EXISTS threads_last ON threads(last_post_at);
CREATE INDEX IF NOT EXISTS threads_prefix ON threads(prefix_id, last_post_at);
CREATE TABLE IF NOT EXISTS reactions (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS pages (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS big_wins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  username TEXT NOT NULL,
  stake INTEGER NOT NULL DEFAULT 0,
  payout INTEGER NOT NULL DEFAULT 0,
  link TEXT DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS file_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES file_categories(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  title TEXT NOT NULL,
  tagline TEXT DEFAULT '',
  description TEXT DEFAULT '',
  version TEXT DEFAULT '',
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  sport TEXT NOT NULL DEFAULT 'Футбол',
  season TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  description TEXT DEFAULT '',
  prize TEXT DEFAULT '',
  thread_url TEXT DEFAULT '',
  gold TEXT DEFAULT '',
  silver TEXT DEFAULT '',
  bronze TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tournament_members (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (tournament_id, user_id)
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  result TEXT DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS predictions (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pick TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, user_id)
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  user_id INTEGER,
  visitor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_day ON visits(day);
CREATE INDEX IF NOT EXISTS visits_time ON visits(created_at);
CREATE INDEX IF NOT EXISTS visits_user ON visits(user_id);
CREATE TABLE IF NOT EXISTS mod_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  user_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

const now = () => Math.floor(Date.now() / 1000);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

const DEFAULT_SETTINGS = {
  site_name: 'Форум о тотализаторах',
  logo_main: 'ФОРУМ',
  logo_suffix: ' — о тотализаторах',
  site_description: 'Сообщество о тотализаторах букмекерских контор: обсуждение тиражей, анализ матчей, прогнозы и ставки на спорт.',
  theme_color: '#33354d',
  registration_open: '1',
  default_scheme: 'system',
  footer_text: '',
  welcome_notice: `[b]{site}[/b] — сообщество ([i]форум о тотализаторах букмекерских контор[/i]), посвящённое игре в тотализатор. Здесь обсуждают матчи и тиражи, публикуют прогнозы, делятся опытом и навыками составления ставок. Цель площадки — собрать общую базу знаний о тотализаторах. На форуме можно обсудить работу БК и новости законодательства, сыграть с другими участниками в турнирах прогнозистов, заключить пари или просто поговорить о предстоящих спортивных событиях.
---
Если это ваш первый визит, рекомендуем прочитать [url=/rules/]правила сообщества[/url], а также [url=/help/]справку по форуму[/url].

Чтобы писать сообщения и получить доступ ко всем возможностям форума, необходимо [url=/register/]зарегистрироваться[/url].`,
  notice_image: '',
  infoservice_title: 'Информационный сервис',
  infoservice_text: 'Каждая ставка под микроскопом!',
  infoservice_link: '/info/',
  infoservice_image: '',
  counter_code: '',
  ranks: JSON.stringify([
    { min: 0, title: 'Новичок' },
    { min: 10, title: 'Игрок' },
    { min: 100, title: 'Участник' },
    { min: 500, title: 'Завсегдатай' },
    { min: 3000, title: 'Легенда 🍀' }
  ]),
  reactions: JSON.stringify(['👍', '🔥', '💯', '🎯', '🍀', '🚀', '🏆'])
};

function seed() {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);

  const hasNodes = db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c;
  if (!hasNodes) {
    const addNode = db.prepare(`INSERT INTO nodes (parent_id, type, title, description, slug, link_url, icon, display_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const add = (parent, type, title, slug, order, description = '', link = '', icon = '') =>
      Number(addNode.run(parent, type, title, description, slug, link, icon, order).lastInsertRowid);

    const tot = add(null, 'category', 'Тотализаторы', '1', 10);
    const bb = add(tot, 'forum', 'Балтбет', 'baltbet', 10, 'Тиражи тотализатора Балтбет: обсуждение, анализ, совместные игры.');
    add(bb, 'forum', 'ББ: открытые игры', 'bbopen', 10, 'Открытые совместные игры в тотализаторе Балтбет.');
    const mf = add(tot, 'forum', 'Марафон', 'matarhon', 20, 'Тиражи тотализатора Марафон: обсуждение, анализ, совместные игры.');
    add(mf, 'forum', 'МФ: открытые игры', 'mfopen', 10, 'Открытые совместные игры в тотализаторе Марафон.');
    const x1 = add(tot, 'forum', '1xBet', '1xbet', 30, 'Тиражи тотализатора 1xBet: обсуждение, анализ, совместные игры.');
    add(x1, 'forum', '1X: открытые игры', '1xopen', 10, 'Открытые совместные игры в тотализаторе 1xBet.');
    add(tot, 'link', 'Чемпионат Мира по футболу 2026', 'wc2026link', 40, 'Всё о ЧМ-2026 на форуме.', '/f/worldcup-2026/');
    add(tot, 'link', 'Бриф-онлайн', '68', 50, 'Онлайн-трансляция тиражей.', '/info/');
    add(tot, 'link', 'Инструменты для тотализаторов', '66', 60, 'Программы и сервисы для расчёта и анализа тиражей.', '/files/');

    const bet = add(null, 'category', 'Беттинг', '16', 20);
    add(bet, 'forum', 'Авторские статьи о тотализаторах', 'useful', 10, 'Стратегии, разборы и полезные материалы от участников.');
    add(bet, 'forum', 'Авторские прогнозы и превью к матчам', 'press', 20, 'Подробные превью и прогнозы от авторов форума.');
    const pr = add(bet, 'forum', 'Прогнозы и ставки на спорт', 'predict', 30, 'Прогнозы на спортивные события по видам спорта.');
    [['Футбол', 'football'], ['Хоккей', 'hockey'], ['Теннис', 'tennis'], ['Баскетбол', 'basketball'],
     ['Бейсбол', 'baseball'], ['Волейбол', 'volleyball'], ['Конный тотализатор', 'horse'],
     ['Национальная лотерея "Турнир"', 'lottery-turnir']].forEach(([t, s], i) => add(pr, 'forum', t, s, (i + 1) * 10));
    const pt = add(bet, 'forum', 'Пари и турниры', '23', 40, 'Пари между участниками, фрироллы и турниры прогнозистов.');
    add(pt, 'forum', 'Пари, фрироллы, турниры', 'tournament', 10);
    add(pt, 'link', 'Битва прогнозистов', '49', 20, '', '/bitva/?status=open');
    add(pt, 'forum', 'Минитурнир™', 'mini', 30);
    add(pt, 'forum', 'ЧМ-2026', 'worldcup-2026', 40);
    add(pt, 'forum', 'ЧЕ-2024', 'euro-2024', 50);
    add(pt, 'forum', 'ЧМ-2022', 'worldcup-2022', 60);
    const vg = add(bet, 'forum', 'Виртуальные игры, тестирование схем', 'virtual', 50, 'Проверка схем и систем без реальных ставок.');
    add(vg, 'forum', 'Календарь событий', 'calendar', 10);

    const com = add(null, 'category', 'Сообщество', '6', 30);
    add(com, 'forum', 'Общение', 'discuss', 10, 'Разговоры на любые темы, не связанные со ставками.');
    add(com, 'link', 'Пожелания, предложения и вопросы', 'faq', 20, 'Вопросы администрации и идеи по развитию форума.', '/f/discuss/');
    add(com, 'link', 'Инфосервис', 'infoservice', 30, 'Сервис для участников форума.', '/info/');
  }

  if (!db.prepare('SELECT COUNT(*) AS c FROM prefixes').get().c) {
    const p = db.prepare('INSERT INTO prefixes (title, css, display_order) VALUES (?, ?, ?)');
    [['🎲', 'label--baltdef', 10], ['🧩', 'label--1xdef', 20], ['🧤', 'label--mfdef', 30],
     ['Профит', 'label--profit', 40], ['Мульти', 'label--multi', 50], ['Важно', 'label--red', 60]]
      .forEach(r => p.run(...r));
  }

  if (!db.prepare('SELECT COUNT(*) AS c FROM file_categories').get().c) {
    db.prepare('INSERT INTO file_categories (title, display_order) VALUES (?, ?)').run('Софт (программы)', 10);
  }

  const addPage = db.prepare('INSERT OR IGNORE INTO pages (slug, title, body) VALUES (?, ?, ?)');
  addPage.run('rules', 'Правила', RULES);
  addPage.run('terms', 'Условия использования', 'Используя этот сайт, вы соглашаетесь соблюдать [url=/rules/]правила форума[/url].\n\nАдминистрация вправе изменять условия использования. Актуальная редакция всегда доступна на этой странице.');
  addPage.run('privacy-policy', 'Политика конфиденциальности', 'Мы храним только данные, которые вы указали при регистрации (имя пользователя, e-mail), и данные, необходимые для работы сайта (cookie сессии и настроек оформления).\n\nМы не передаём ваши данные третьим лицам, кроме случаев, предусмотренных законом.');
  addPage.run('help', 'Помощь', '[b]Как создать тему?[/b]\nОткройте нужный раздел и нажмите кнопку «Создать тему».\n\n[b]Как сменить оформление?[/b]\nВ шапке сайта переключите режим: системный, светлый или тёмный.\n\n[b]Остались вопросы?[/b]\nНапишите нам через [url=/misc/contact]обратную связь[/url].');
  addPage.run('info', 'Инфосервис', 'Инфосервис доступен участникам форума со статусом «Игрок» (10 и более сообщений).\n\nЗдесь будут собраны инструменты для анализа тиражей, статистика и онлайн-трансляции.');

  if (!db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c) {
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
    const username = process.env.ADMIN_USERNAME || 'admin';
    db.prepare(`INSERT INTO users (username, email, password_hash, role, custom_title, banners, created_at, last_seen)
      VALUES (?, ?, ?, 'admin', 'Администратор', 'Команда', ?, ?)`)
      .run(username, process.env.ADMIN_EMAIL || 'admin@example.com', hashPassword(password), now(), now());
    console.log('\n==============================================');
    console.log(' Создан администратор');
    console.log(`  логин:  ${username}`);
    console.log(`  пароль: ${password}`);
    console.log(' Смените пароль в админке после первого входа.');
    console.log('==============================================\n');
  }
}

const RULES = `[b]1. Общие положения[/b]
1.1. Форум — частное сообщество людей, интересующихся тотализаторами букмекерских контор и ставками на спорт.
1.2. Регистрируясь, вы соглашаетесь с этими правилами. Незнание правил не освобождает от ответственности.
1.3. Администрация вправе ограничить доступ любому участнику, если это нужно для сообщества.

[b]2. Учётные записи[/b]
2.1. Один человек — одна учётная запись.
2.2. Учётные записи без активности могут быть удалены. Чтобы сохранить аккаунт, напишите 10 и более сообщений.
2.3. Статус «Игрок» (10+ сообщений) открывает весь функционал форума, включая Инфосервис.

[b]3. Запрещено[/b]
3.1. Агрессивная реклама сторонних ресурсов и спам.
3.2. Ссылки на букмекерские конторы без лицензии РФ, обсуждение способов обхода блокировок.
3.3. Политика, экстремизм, оскорбления участников.
3.4. Создание тем не в своём разделе и дублирование тем.

[b]4. Совместные игры[/b]
4.1. Игровые темы оформляются по шаблону: «№ тиража: дата в время [тип игры]».
4.2. Расчёты между участниками ведутся под их личную ответственность.

[b]5. Турниры[/b]
5.1. Турниры прогнозистов проводятся по отдельным регламентам, опубликованным в теме турнира.
5.2. Призовые фонды формируются из Фонда форума.

[b]6. Модерация[/b]
6.1. За нарушения выдаются предупреждения, временная или постоянная блокировка.
6.2. Решения администрации можно обсудить в разделе «Пожелания, предложения и вопросы».`;

seed();
const DEFAULT_GAME_SCHEMES = 'купон, пакет, Б12, Б13, Б14, Б15, система';
const DEFAULT_GAME_NOTICE = '[b]Открытие игровой темы — ответственное дело.[/b] Создавайте совместную игру, [b]только если готовы уделить ей время[/b]: разобрать тираж, внести участников в список игроков (поможет гарант или модераторы), заполнять прогноз по ходу обсуждения, объяснять выбор исходов, собрать итоговую ставку и вовремя передать её гаранту.\n\n[b]Модераторы помогут[/b] участникам организовать совместную игру.';
migrate();

// Changes for databases created by earlier versions.
function migrate() {
  const cols = db.prepare('PRAGMA table_info(big_wins)').all().map(c => c.name);
  if (!cols.includes('win_date')) db.exec("ALTER TABLE big_wins ADD COLUMN win_date TEXT NOT NULL DEFAULT ''");
  const done = db.prepare("SELECT value FROM settings WHERE key = 'migr_layout_v2'").get();
  if (!done) {
    // match the original's node order: the World Cup link heads «Тотализаторы»; «Инфосервис» is a home-page block, not a node
    db.prepare("UPDATE nodes SET display_order = 5 WHERE slug = 'wc2026link' AND display_order = 40").run();
    db.prepare("DELETE FROM nodes WHERE slug = 'infoservice' AND type = 'link'").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migr_layout_v2', '1')").run();
  }
  // game forums: the «Игра» form with draw number, start, scheme, events and players instead of a free title and text
  const ncols = db.prepare('PRAGMA table_info(nodes)').all().map(c => c.name);
  if (!ncols.includes('is_game')) db.exec('ALTER TABLE nodes ADD COLUMN is_game INTEGER NOT NULL DEFAULT 0');
  if (!ncols.includes('game_schemes')) db.exec("ALTER TABLE nodes ADD COLUMN game_schemes TEXT NOT NULL DEFAULT ''");
  if (!ncols.includes('game_notice')) db.exec("ALTER TABLE nodes ADD COLUMN game_notice TEXT NOT NULL DEFAULT ''");
  if (!ncols.includes('game_prefix_id')) db.exec('ALTER TABLE nodes ADD COLUMN game_prefix_id INTEGER');
  if (!db.prepare("SELECT value FROM settings WHERE key = 'migr_game_form'").get()) {
    const pfx = t => db.prepare('SELECT id FROM prefixes WHERE title = ?').get(t)?.id ?? null;
    const set = db.prepare('UPDATE nodes SET is_game = 1, game_schemes = ?, game_notice = ?, game_prefix_id = ? WHERE slug = ? AND type = ?');
    for (const [slug, p] of [['bbopen', '🎲'], ['mfopen', '🧤'], ['1xopen', '🧩']]) set.run(DEFAULT_GAME_SCHEMES, DEFAULT_GAME_NOTICE, pfx(p), slug, 'forum');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('migr_game_form', '1')").run();
  }
}

// Read-mostly data is cached in memory and dropped on any write request (see bumpCache in server.js).
let cacheVersion = 0;
const cacheStore = new Map();
function cached(key, fn, ttlMs = 60000) {
  const c = cacheStore.get(key);
  if (c && c.v === cacheVersion && Date.now() - c.t < ttlMs) return c.val;
  const val = fn();
  cacheStore.set(key, { v: cacheVersion, t: Date.now(), val });
  return val;
}
function bumpCache() { cacheVersion++; }

function getSettings() {
  return { ...cached('settings', readSettings) };
}
function readSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  try { s.ranksList = JSON.parse(s.ranks); } catch { s.ranksList = JSON.parse(DEFAULT_SETTINGS.ranks); }
  try { s.reactionsList = JSON.parse(s.reactions); } catch { s.reactionsList = JSON.parse(DEFAULT_SETTINGS.reactions); }
  return s;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  bumpCache();
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, now, hashPassword, verifyPassword, getSettings, setSetting, tx, DATA_DIR, cached, bumpCache };
