// AI study advisor chat: posts the question, shows the answer (server-rendered safe Markdown) or, without an AI
// provider, the database search results with match categories.
(function () {
  'use strict';
  var GEC = window.GEC || {};
  var box = document.querySelector('[data-advisor]');
  if (!box) return;
  var log = box.querySelector('[data-advisor-log]');
  var form = box.querySelector('[data-advisor-form]');
  var input = form.querySelector('input[name="question"]');
  var S = box.querySelector('[data-advisor-strings]').dataset;
  var esc = GEC.esc || function (s) { return String(s); };
  function add(cls, html) { var d = document.createElement('div'); d.className = cls; d.innerHTML = html; log.appendChild(d); d.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return d; }
  function card(item) {
    var p = item.program; var m = item.match;
    var cat = m ? '<span class="chip ' + ({ excellent: 'ok', good: 'ok', possible: 'brand', missing: 'warn', not_eligible: 'bad' }[m.category] || '') + '">' + esc(S['cat' + m.category.charAt(0).toUpperCase() + m.category.slice(1)] || m.category) + ' · ' + m.score + '%</span>' : '';
    return '<a class="list-item" href="' + esc(p.url) + '"><div class="li-body"><div class="li-title">' + esc(p.name) + (p.demo_data ? ' <span class="chip demo">' + esc(S.demo) + '</span>' : '') + '</div><div class="li-sub">' + esc(p.university) + ' · ' + esc(p.country || '') + ' · ' + esc(p.tuition_per_year) + '</div></div>' + cat + '</a>';
  }
  function render(r) {
    if (r.mode === 'ai') return '<div class="prose">' + r.html + '</div>';
    var h = '';
    if (r.aiError) h += '<p class="small subtle">' + esc(S.aiError) + '</p>';
    if (!r.programs.length) return h + '<p>' + esc(S.none) + '</p><a class="btn sm" href="/book">' + esc(S.book) + '</a>';
    h += '<p>' + esc(S.searchIntro).replace('{n}', r.total) + '</p>';
    if (r.overBudget) h += '<div class="alert warn"><p>' + esc(S.overBudget) + '</p></div>';
    return h + '<div class="card flat"><div class="divider-list">' + r.programs.map(card).join('') + '</div></div>';
  }
  function ask(q) {
    add('q', esc(q));
    var wait = add('a', '<p class="muted">' + esc(S.thinking) + '</p>');
    var csrf = form.querySelector('[name="_csrf"]').value;
    fetch('/advisor/ask', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ question: q }) })
      .then(function (res) { return res.json().then(function (j) { if (!res.ok) throw new Error((j && j.error && j.error.message) || res.status); return j; }); })
      .then(function (r) { wait.innerHTML = render(r); })
      .catch(function () { wait.innerHTML = '<p class="error-text">' + esc(S.error) + '</p>'; });
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); var q = input.value.trim(); if (!q) return; input.value = ''; ask(q); });
  box.addEventListener('click', function (e) { var b = e.target.closest('[data-advisor-example]'); if (b) ask(b.textContent.trim()); });
}());
