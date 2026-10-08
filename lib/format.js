'use strict';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeUrl(u) {
  const url = String(u || '').trim();
  if (/^(https?:\/\/|\/)/i.test(url) && !/^\/\//.test(url)) return url;
  return '';
}

// BBCode -> HTML. Input is escaped first, so only whitelisted tags become HTML.
function bbcode(src) {
  let s = esc(String(src || '').replace(/\r\n/g, '\n'));
  const simple = { b: 'strong', i: 'em', u: 'u', s: 's' };
  for (const [tag, html] of Object.entries(simple)) {
    const re = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, 'gi');
    s = s.replace(re, `<${html}>$1</${html}>`);
  }
  s = s.replace(/\[color=(#[0-9a-f]{3,6}|[a-z]+)\]([\s\S]*?)\[\/color\]/gi, '<span style="color:$1">$2</span>');
  s = s.replace(/\[size=([1-7])\]([\s\S]*?)\[\/size\]/gi, (m, n, t) => `<span style="font-size:${[0, 10, 12, 15, 18, 22, 26, 32][n]}px">${t}</span>`);
  s = s.replace(/\[center\]([\s\S]*?)\[\/center\]/gi, '<div style="text-align:center">$1</div>');
  s = s.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (m, u, t) => {
    const url = safeUrl(u.replace(/&amp;/g, '&'));
    return url ? `<a href="${esc(url)}" class="link" rel="nofollow ugc noopener" target="${url.startsWith('/') ? '_self' : '_blank'}">${t}</a>` : t;
  });
  s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (m, u) => {
    const url = safeUrl(u.replace(/&amp;/g, '&'));
    return url ? `<a href="${esc(url)}" class="link" rel="nofollow ugc noopener" target="_blank">${u}</a>` : u;
  });
  s = s.replace(/\[img\]([\s\S]*?)\[\/img\]/gi, (m, u) => {
    const url = safeUrl(u.replace(/&amp;/g, '&'));
    return url ? `<img src="${esc(url)}" class="bbImage" loading="lazy" alt="">` : '';
  });
  s = s.replace(/\[spoiler(?:=([^\]]*))?\]([\s\S]*?)\[\/spoiler\]/gi, (m, t, body) =>
    `<details class="bbSpoiler"><summary>Спойлер${t ? ': ' + t : ''}</summary><div class="bbSpoiler-content">${body}</div></details>`);
  // quotes may be nested: replace innermost first
  let prev, depth = 0;
  do {
    prev = s;
    s = s.replace(/\[quote(?:=([^\]]*))?\]((?:(?!\[quote)[\s\S])*?)\[\/quote\]/gi, (m, who, body) =>
      `<blockquote class="bbQuote">${who ? `<div class="bbQuote-head">${who.replace(/^&quot;|&quot;$/g, '')} пишет:</div>` : ''}<div class="bbQuote-body">${body.trim()}</div></blockquote>`);
  } while (s !== prev && ++depth < 12);
  s = s.replace(/\[list\]([\s\S]*?)\[\/list\]/gi, (m, body) =>
    '<ul>' + body.split(/\[\*\]/).map(x => x.trim()).filter(Boolean).map(x => `<li>${x}</li>`).join('') + '</ul>');
  // autolink bare urls (not already inside tags)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (m, pre, u) => `${pre}<a href="${u}" class="link" rel="nofollow ugc noopener" target="_blank">${u}</a>`);
  s = s.replace(/(^|[\s>])@([\wА-Яа-яЁё.-]{2,50})/g, (m, pre, name) => `${pre}<a href="/members/${encodeURIComponent(name)}/" class="username">@${name}</a>`);
  s = s.replace(/\n/g, '<br>\n');
  s = s.replace(/<\/(blockquote|ul|details|div)><br>\n/g, '</$1>\n');
  return s;
}

function plain(src, len = 200) {
  const t = String(src || '').replace(/\[quote[\s\S]*?\[\/quote\]/gi, '').replace(/\[[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > len ? t.slice(0, len) + '…' : t;
}

const pad = n => String(n).padStart(2, '0');
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const TZ = process.env.TZ_OFFSET_MIN ? Number(process.env.TZ_OFFSET_MIN) : 180; // Москва

function local(ts) { return new Date((ts + TZ * 60) * 1000); }
function dmy(ts) { const d = local(ts); return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${String(d.getUTCFullYear()).slice(2)}`; }
function hm(ts) { const d = local(ts); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
function fullDate(ts) { const d = local(ts); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} в ${hm(ts)}`; }

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function ago(ts) {
  if (!ts) return '';
  const nowS = Math.floor(Date.now() / 1000);
  const diff = nowS - ts;
  if (diff < 60) return 'Сейчас';
  if (diff < 3600) return `${Math.floor(diff / 60)} мин.`;
  const today = dmy(nowS), yest = dmy(nowS - 86400);
  if (dmy(ts) === today) return `Сегодня в ${hm(ts)}`;
  if (dmy(ts) === yest) return `Вчера в ${hm(ts)}`;
  return dmy(ts);
}

function num(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
function money(n) { return (Number(n) || 0).toLocaleString('ru-RU').replace(/,/g, ' ') + ' ₽'; }
function bytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' МБ';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' КБ';
  return n + ' байт';
}

function rankFor(postCount, ranks) {
  let title = '';
  for (const r of ranks) if (postCount >= r.min) title = r.title;
  return title;
}

const AVATAR_COLORS = ['#c2185b', '#7b1fa2', '#512da8', '#303f9f', '#1976d2', '#0288d1', '#00796b', '#388e3c', '#689f38', '#f57c00', '#e64a19', '#5d4037', '#455a64'];
function avatarColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// Line icons (24x24, stroke) used across the layout.
const ICONS = {
  comments: '<path d="M3.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3a2 2 0 0 1-2-2z"/><path d="M16.5 8.5h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2v3l-3.5-3h-4.5a2 2 0 0 1-2-2v-1"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3.6-3.6a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M14 10a4 4 0 0 0-5.7 0l-3.6 3.6a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  file: '<path d="M6 2.5h8l4.5 4.5v14.5H6z"/><path d="M14 2.5V7h4.5M9 11.5h6.5M9 14.5h6.5M9 17.5h6.5"/>',
  bolt: '<path d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6z"/>',
  edit: '<path d="M11 4.5H4.5v15h15V13"/><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  university: '<path d="M2.5 9 12 3.5 21.5 9zM4 9.5h16M3 20.5h18M4.5 18h15M6 10v8M10 10v8M14 10v8M18 10v8"/>',
  angles: '<path d="m5 6 6 6-6 6M12 6l6 6-6 6"/>',
  user: '<circle cx="12" cy="8" r="4.5"/><path d="M3.5 21a8.5 8.5 0 0 1 17 0z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="1.5"/><path d="M7.5 10.5V7a4.5 4.5 0 0 1 9 0v3.5"/>',
  share: '<circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1"/>',
  home: '<path d="M3 11 12 3.5l9 7.5"/><path d="M5.5 9v11.5h5v-6h3v6h5V9"/>',
  signin: '<path d="M14 3.5h5.5v17H14"/><path d="M3 12h11M10 8l4 4-4 4"/>',
  key: '<circle cx="15.5" cy="8.5" r="5"/><path d="m11.8 12-8.3 8.3v.2h3v-2h2v-2h2l1.3-1.3"/><circle cx="16.5" cy="7.5" r="1"/>',
  adjust: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>',
  toggle: '<rect x="1.5" y="6" width="21" height="12" rx="6"/><circle cx="16.5" cy="12" r="4" fill="currentColor"/>',
  trophy: '<path d="M7 3.5h10v5a5 5 0 0 1-10 0z" fill="currentColor"/><path d="M7 5H3.5v1.5A3.5 3.5 0 0 0 7 10M17 5h3.5v1.5A3.5 3.5 0 0 1 17 10M12 13.5v4M8 20.5h8M9.5 17.5h5v3h-5z"/>',
  caret: '<path d="m6 9 6 6 6-6"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.5 0 2-1 1.6-2.1-.5-1.3.4-2.4 1.7-2.4H18a3 3 0 0 0 3-3 9 9 0 0 0-9-10.5z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="15" cy="7" r="1.2"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 20.5h16"/>',
  bars: '<path d="M3.5 6h17M3.5 12h17M3.5 18h17"/>',
  reply: '<path d="M10 5 3.5 11l6.5 6v-4c4 0 7.5 1 10.5 5-1-5-4-9.5-10.5-10z"/>',
  thumbs: '<path d="M7 10.5v10H3.5v-10zM7 10.5l4-7.5a2 2 0 0 1 2.7 1.7L13 9.5h6a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 17.7 20.5H7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14.5a5 5 0 0 0 8 0"/><circle cx="9" cy="10" r=".8" fill="currentColor"/><circle cx="15" cy="10" r=".8" fill="currentColor"/>',
  bold: '<path d="M7 4.5h6a3.75 3.75 0 0 1 0 7.5H7zM7 12h7a4 4 0 0 1 0 8H7z"/>',
  textsize: '<path d="M2.5 7.5V5.5h10v2M7.5 5.5v13M11.5 12v-1.5h9V12M16 10.5v8"/>',
  dots: '<circle cx="12" cy="5.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="18.5" r="1.2" fill="currentColor"/>',
  eraser: '<path d="m4.5 15.5 9.5-9.5a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8z"/><path d="M8 19h12M9.5 10.5l5 5"/>',
  preview: '<path d="M6 2.5h8l4.5 4.5v6"/><path d="M14 2.5V7h4.5M6 2.5v19h6"/><circle cx="16.5" cy="17" r="3"/><path d="m18.7 19.2 2.3 2.3"/>',
  save: '<path d="M4.5 3.5h12l3 3v14h-15z"/><path d="M8 3.5v5h7v-5M7.5 20.5v-6h9v6"/>'
};
function icon(name, cls = '') {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg class="ico ico--${name}${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// National-team names -> flag emoji for the tournament widget.
const FLAGS = {
  'россия': 'RU', 'франция': 'FR', 'англия': 'GB-ENG', 'испания': 'ES', 'аргентина': 'AR', 'бразилия': 'BR', 'германия': 'DE',
  'италия': 'IT', 'португалия': 'PT', 'нидерланды': 'NL', 'голландия': 'NL', 'бельгия': 'BE', 'хорватия': 'HR', 'уругвай': 'UY',
  'мексика': 'MX', 'сша': 'US', 'канада': 'CA', 'япония': 'JP', 'корея': 'KR', 'южная корея': 'KR', 'марокко': 'MA', 'сенегал': 'SN',
  'швейцария': 'CH', 'дания': 'DK', 'швеция': 'SE', 'норвегия': 'NO', 'польша': 'PL', 'сербия': 'RS', 'австрия': 'AT', 'чехия': 'CZ',
  'турция': 'TR', 'украина': 'UA', 'шотландия': 'GB-SCT', 'уэльс': 'GB-WLS', 'колумбия': 'CO', 'эквадор': 'EC', 'чили': 'CL',
  'парагвай': 'PY', 'перу': 'PE', 'австралия': 'AU', 'иран': 'IR', 'саудовская аравия': 'SA', 'катар': 'QA', 'египет': 'EG',
  'нигерия': 'NG', 'гана': 'GH', 'камерун': 'CM', 'тунис': 'TN', 'алжир': 'DZ', 'кот-д’ивуар': 'CI', 'венгрия': 'HU', 'греция': 'GR',
  'словакия': 'SK', 'словения': 'SI', 'румыния': 'RO', 'грузия': 'GE', 'беларусь': 'BY', 'казахстан': 'KZ', 'узбекистан': 'UZ', 'ирландия': 'IE'
};
function flag(name) {
  const code = FLAGS[String(name || '').trim().toLowerCase()];
  if (!code) return '';
  if (code.startsWith('GB-')) {
    const tag = code.slice(3).toLowerCase();
    return String.fromCodePoint(0x1F3F4, ...[...('gb' + tag)].map(c => 0xE0000 + c.charCodeAt(0)), 0xE007F);
  }
  return String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

module.exports = { icon, flag, esc, bbcode, plain, ago, dmy, hm, fullDate, num, money, bytes, plural, rankFor, avatarColor, safeUrl };
