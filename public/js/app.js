(function () {
  'use strict';
  var csrf = document.querySelector('meta[name="csrf"]');
  csrf = csrf ? csrf.content : '';

  // dropdown menus
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest('[data-menu-trigger]');
    document.querySelectorAll('.menu.is-open').forEach(function (m) {
      if (!trigger || m !== trigger.closest('.menu')) closeMenu(m);
    });
    if (trigger) {
      e.preventDefault();
      var open = trigger.closest('.menu').classList.toggle('is-open');
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  });
  function closeMenu(m) {
    m.classList.remove('is-open');
    var t = m.querySelector('[data-menu-trigger]');
    if (t) t.setAttribute('aria-expanded', 'false');
  }
  // Escape closes menus and the off-canvas panel
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.menu.is-open').forEach(closeMenu);
    var oc = document.getElementById('offCanvas');
    if (oc) oc.classList.remove('is-open');
  });

  // off-canvas navigation
  document.querySelectorAll('[data-offcanvas-open]').forEach(function (b) {
    b.addEventListener('click', function () { document.getElementById('offCanvas').classList.add('is-open'); });
  });
  document.querySelectorAll('[data-offcanvas-close]').forEach(function (b) {
    b.addEventListener('click', function () { document.getElementById('offCanvas').classList.remove('is-open'); });
  });

  // confirm destructive actions (the pressed button may carry its own question) and block double submits
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var need = form.getAttribute('data-require-checked');
    if (need && !form.querySelector('input[name="' + need + '"]:checked')) { e.preventDefault(); window.alert('Ничего не выбрано.'); return; }
    var msg = (e.submitter && e.submitter.getAttribute('data-confirm')) || form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    if (form.dataset.busy) { e.preventDefault(); return; }
    form.dataset.busy = '1';
    setTimeout(function () { delete form.dataset.busy; }, 8000);
  });
  window.addEventListener('pageshow', function () {
    document.querySelectorAll('form[data-busy]').forEach(function (f) { delete f.dataset.busy; });
  });

  // BBCode editor toolbar
  function wrap(ta, open, close, placeholder) {
    var s = ta.selectionStart, en = ta.selectionEnd, v = ta.value;
    var sel = v.slice(s, en) || placeholder || '';
    ta.value = v.slice(0, s) + open + sel + close + v.slice(en);
    ta.focus();
    ta.selectionStart = s + open.length;
    ta.selectionEnd = s + open.length + sel.length;
  }
  document.querySelectorAll('[data-editor]').forEach(function (bar) {
    var ta = document.getElementById(bar.getAttribute('data-editor'));
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tag]');
      if (!b) return;
      e.preventDefault();
      var menu = b.closest('.menu');
      if (menu) closeMenu(menu);
      var tag = b.getAttribute('data-tag');
      if (tag === 'url') {
        var u = window.prompt('Адрес ссылки:', 'https://');
        if (u) wrap(ta, '[url=' + u + ']', '[/url]', 'текст ссылки');
      } else if (tag === 'img') {
        var i = window.prompt('Адрес изображения:', 'https://');
        if (i) wrap(ta, '[img]' + i, '[/img]', '');
      } else if (tag === 'emoji') {
        wrap(ta, b.textContent, '', '');
      } else if (tag === 'list') {
        wrap(ta, '[list]\n[*]', '\n[*]\n[/list]', 'пункт');
      } else if (tag === 'size' || tag === 'color') {
        wrap(ta, '[' + tag + '=' + b.getAttribute('data-val') + ']', '[/' + tag + ']', '');
      } else if (tag === 'clear') {
        // strip BBCode from the selection, or from the whole text when nothing is selected
        var s0 = ta.selectionStart, e0 = ta.selectionEnd, all = s0 === e0;
        var a0 = all ? 0 : s0, z0 = all ? ta.value.length : e0;
        var plain = ta.value.slice(a0, z0).replace(/\[\/?(b|i|u|s|url|img|quote|spoiler|list|center|size|color|\*)(=[^\]]*)?\]/gi, '');
        ta.value = ta.value.slice(0, a0) + plain + ta.value.slice(z0);
        ta.focus();
      } else {
        wrap(ta, '[' + tag + ']', '[/' + tag + ']', '');
      }
    });
  });

  // editor preview: render the BBCode on the server and show it in place of the text area
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-preview]');
    if (!btn) return;
    e.preventDefault();
    var id = btn.getAttribute('data-preview');
    var ta = document.getElementById(id), box = document.getElementById('preview-' + id);
    if (!ta || !box) return;
    if (!box.hidden) { box.hidden = true; ta.hidden = false; btn.setAttribute('aria-pressed', 'false'); ta.focus(); return; }
    fetch('/misc/preview', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ text: ta.value, _csrf: csrf }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        box.innerHTML = d.html || '<span class="u-muted">Нечего показать.</span>';
        box.hidden = false; ta.hidden = true; btn.setAttribute('aria-pressed', 'true');
      })
      .catch(function () { window.alert('Не удалось показать предпросмотр.'); });
  });
  // a hidden required field must not block sending: switch back from preview before submit
  document.addEventListener('submit', function (e) {
    e.target.querySelectorAll('[data-preview][aria-pressed="true"]').forEach(function (b) { b.click(); });
  }, true);

  // quote / mention into the quick reply
  document.addEventListener('click', function (e) {
    var q = e.target.closest('[data-quote]');
    var m = e.target.closest('[data-mention]');
    var ta = document.getElementById('message');
    if (!ta || (!q && !m)) return;
    e.preventDefault();
    if (q) {
      var src = document.getElementById('raw-' + q.getAttribute('data-quote'));
      ta.value += (ta.value ? '\n' : '') + '[quote="' + q.getAttribute('data-author') + '"]' + (src ? src.value.replace(/\[quote[\s\S]*?\[\/quote\]\s*/gi, '').trim() : '') + '[/quote]\n';
    } else {
      ta.value += '@' + m.getAttribute('data-mention') + ' ';
    }
    ta.focus();
    ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // reactions without page reload
  var reacting = {};
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-react]');
    if (!btn) return;
    e.preventDefault();
    if (reacting[btn.getAttribute('data-post')]) return;
    var postId = btn.getAttribute('data-post');
    var body = new URLSearchParams({ emoji: btn.getAttribute('data-react'), _csrf: csrf });
    reacting[postId] = true;
    fetch('/posts/' + postId + '/react', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { window.alert(d.error); return; }
        var bar = document.getElementById('reactions-' + postId);
        var trigger = document.getElementById('react-trigger-' + postId);
        if (trigger) {
          trigger.textContent = d.mine ? d.mine + ' Реакция' : '👍 Нравится';
          trigger.classList.toggle('is-active', !!d.mine);
          // the main button removes the current reaction, or adds the first one when there is none
          var first = document.querySelector('.reactPicker-list [data-post="' + postId + '"][data-react]');
          trigger.setAttribute('data-react', d.mine || (first ? first.getAttribute('data-react') : '👍'));
        }
        if (!bar) return;
        if (!d.reactions.length) { bar.innerHTML = ''; return; }
        var emojis = [];
        d.reactions.forEach(function (r) { if (emojis.indexOf(r.emoji) < 0) emojis.push(r.emoji); });
        var names = d.reactions.map(function (r) { return r.username; });
        var txt = names.slice(0, 3).join(', ') + (names.length > 3 ? ' и ещё ' + (names.length - 3) : '');
        bar.textContent = '';
        var em = document.createElement('span'); em.className = 'reactionsBar-emoji'; em.textContent = emojis.join('');
        bar.appendChild(em); bar.appendChild(document.createTextNode(' ' + txt));
      })
      .catch(function () { window.alert('Не удалось сохранить реакцию.'); })
      .then(function () { reacting[postId] = false; });
  });

  // admin: select all checkboxes
  document.querySelectorAll('[data-check-all]').forEach(function (cb) {
    cb.addEventListener('change', function () {
      document.querySelectorAll('input[name="' + cb.getAttribute('data-check-all') + '"]').forEach(function (x) { x.checked = cb.checked; });
    });
  });

  // share link: copy the post URL
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-share]');
    if (!a) return;
    e.preventDefault();
    var url = new URL(a.getAttribute('href'), location.href).href;
    if (navigator.share) { navigator.share({ url: url }).catch(function () {}); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { a.title = 'Ссылка скопирована'; }, function () { window.prompt('Ссылка на сообщение:', url); });
    else window.prompt('Ссылка на сообщение:', url);
  });
})();
