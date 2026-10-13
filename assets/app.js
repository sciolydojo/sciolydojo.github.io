/* A&P Practice: static question browser for the JSON files in data/.
 *
 * Routes (hash-based so it works from any GitHub Pages subpath):
 *   #/                                   home
 *   #/<system>                           random question from a system
 *   #/<system>/<tag>                     random question from a system + tag
 *   #/<system>[/<tag>]/q/<questionId>    a specific question within that category
 */
(function () {
  'use strict';

  const SYSTEMS = ['respiratory', 'digestive', 'immune'];
  const TYPE_LABEL = {
    multiple_choice: 'Choose one',
    multiple_select: 'Choose all that apply',
    true_false: 'True or false',
    fill_in: 'Fill in the blank',
    short_answer: 'Short answer',
  };
  const GROUPS = [
    { kind: 'topic', title: 'Topics from the 2026 rules' },
    { kind: 'structure', title: 'Body parts & cells' },
    { kind: 'format', title: 'Question style' },
    { kind: 'level', title: 'Competition level' },
  ];

  const app = document.getElementById('app');
  const dialog = document.getElementById('ref-dialog');
  const dialogBody = document.getElementById('ref-body');

  const state = {
    index: null,
    files: {},            // system -> file JSON
    byId: new Map(),      // question id -> question
    systemOf: new Map(),  // question id -> system
    tags: new Map(),      // tag id -> tag definition
    sources: new Map(),   // source id -> source
    view: null,           // current question view
  };

  /* ---------------- helpers ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function storageGet(key) {
    try { return JSON.parse(sessionStorage.getItem(key)); } catch (e) { return null; }
  }

  function storageSet(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode etc. */ }
  }

  function systemTitle(system) {
    return state.files[system] ? state.files[system].title : system;
  }

  function tagLabel(tagId) {
    const t = state.tags.get(tagId);
    return t ? t.label : tagId;
  }

  /** Text with cross-question references turned into buttons that open the referenced question. */
  function richText(q, field) {
    const text = q[field] || '';
    const refs = (q.refs || []).filter(r => r.field === field).sort((a, b) => a.start - b.start);
    if (!refs.length) return esc(text);
    const chars = Array.from(text); // offsets are code points
    let out = '';
    let pos = 0;
    for (const r of refs) {
      if (r.start < pos) continue;
      out += esc(chars.slice(pos, r.start).join(''));
      const label = chars.slice(r.start, r.end).join('');
      const target = r.targets && r.targets[0];
      if (target && state.byId.has(target.id)) {
        out += `<button type="button" class="ref-link" data-ref="${esc(target.id)}" title="Open question ${esc(target.number)}">${esc(label)}</button>`;
      } else {
        out += esc(label);
      }
      pos = r.end;
    }
    return out + esc(chars.slice(pos).join(''));
  }

  function paragraphs(text, firstClass) {
    return String(text).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => {
      const cls = /^Big idea:/i.test(p) ? 'big-idea' : '';
      return `<p class="${cls}">${esc(p)}</p>`;
    }).join('');
  }

  function imagesHtml(q) {
    if (!q.images || !q.images.length) return '';
    return `<div class="figures">${q.images.map(src =>
      `<a href="data/${esc(src)}" target="_blank" rel="noopener"><img src="data/${esc(src)}" alt="Figure for question ${esc(q.number)}" loading="lazy"></a>`
    ).join('')}</div>`;
  }

  function sourceLine(q) {
    const s = state.sources.get(q.source);
    return `${esc(s ? s.name : q.source)} · #${esc(q.number)}`;
  }

  function formatAnswer(q) {
    const a = q.answer;
    switch (q.type) {
      case 'multiple_choice': {
        const c = (q.choices || []).find(c => c.id === a);
        return c ? `${c.id}. ${c.text}` : String(a);
      }
      case 'multiple_select':
        return a.map(id => {
          const c = (q.choices || []).find(c => c.id === id);
          return c ? `${c.id}. ${c.text}` : id;
        }).join('\n');
      case 'true_false':
        return a ? 'True' : 'False';
      case 'fill_in':
        return a.map((alts, i) => (a.length > 1 ? `${blankLabel(q, i)}: ` : '') + alts.join(' / ')).join('\n');
      default:
        return String(a);
    }
  }

  /* ---------------- grading ---------------- */

  function norm(s) {
    return String(s).toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[’'`]/g, '')
      .replace(/[^a-z0-9.]+/g, ' ')
      .replace(/\.(?=\s|$)/g, '')
      .trim()
      .replace(/^(the|a|an) /, '');
  }

  function singular(s) {
    return s.split(' ').map(w => (w.length > 3 && /es$/.test(w) && !/ses$/.test(w)) ? w.slice(0, -2)
      : (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) ? w.slice(0, -1) : w).join(' ');
  }

  function blankMatches(input, alts) {
    const n = norm(input);
    if (!n) return false;
    return alts.some(alt => {
      const a = norm(alt);
      return a === n || singular(a) === singular(n);
    });
  }

  function blankLabel(q, i) {
    const n = q.answer.length;
    if (n > 3 && /label/i.test(q.prompt) && n <= 26) return `Label ${String.fromCharCode(65 + i)}`;
    return `Blank ${i + 1}`;
  }

  /* ---------------- category picking ---------------- */

  function questionsFor(system, tag) {
    const file = state.files[system];
    if (!file) return [];
    return file.questions.filter(q => !tag || (q.tags || []).includes(tag));
  }

  /** Random question without repeats until the whole category has been seen (per browser tab). */
  function pickQuestion(system, tag, avoidId) {
    const pool = questionsFor(system, tag);
    if (!pool.length) return null;
    const key = `bag:${system}:${tag || ''}`;
    const valid = new Set(pool.map(q => q.id));
    let bag = (storageGet(key) || []).filter(id => valid.has(id));
    if (!bag.length) {
      bag = shuffle(pool.map(q => q.id));
      if (bag.length > 1 && bag[bag.length - 1] === avoidId) bag.unshift(bag.pop());
    }
    const id = bag.pop();
    storageSet(key, bag);
    return id;
  }

  function categoryHash(system, tag) {
    return '#/' + encodeURIComponent(system) + (tag ? '/' + encodeURIComponent(tag) : '');
  }

  /* ---------------- home ---------------- */

  function renderHome() {
    document.title = 'A&P Practice';
    const cards = SYSTEMS.filter(s => state.files[s]).map(system => {
      const qs = state.files[system].questions;
      const counts = new Map();
      for (const q of qs) for (const t of q.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
      const tagsHere = [...state.tags.values()].filter(t => counts.get(t.id) && (!t.system || t.system === system));

      const link = (t, extraClass) => `
        <a class="tag-link ${extraClass || ''}" href="${categoryHash(system, t.id)}">
          <span class="name">${esc(t.label)}${t.rule ? `<span class="rule">${esc(t.rule)}</span>` : ''}${t.stateOnly ? '<span class="pill">State/Nat’l</span>' : ''}</span>
          <span class="count">${counts.get(t.id)}</span>
        </a>`;

      const groups = GROUPS.map(g => {
        const items = tagsHere.filter(t => t.kind === g.kind);
        if (!items.length) return '';
        if (g.kind === 'topic') {
          const conditions = tagsHere.filter(t => t.kind === 'condition');
          const lis = items.map(t => {
            const kids = conditions.filter(c => c.parent === t.id);
            return `<li>${link(t)}${kids.length ? `<ul class="tag-list sub">${kids.map(c => `<li>${link(c)}</li>`).join('')}</ul>` : ''}</li>`;
          }).join('');
          return `<section class="tag-group"><h3>${g.title}</h3><ul class="tag-list">${lis}</ul></section>`;
        }
        if (g.kind === 'structure') {
          return `<section class="tag-group"><h3>${g.title}</h3><ul class="tag-list">${items.map(t => `<li>${link(t)}</li>`).join('')}</ul></section>`;
        }
        return `<section class="tag-group"><h3>${g.title}</h3><div class="chips">${items.map(t => link(t)).join('')}</div></section>`;
      }).join('');

      return `
        <section class="system-card" data-system="${esc(system)}" aria-labelledby="h-${esc(system)}">
          <div class="system-head">
            <h2 id="h-${esc(system)}">${esc(systemTitle(system))}</h2>
            <a class="btn" href="${categoryHash(system)}">Random question · ${qs.length}</a>
          </div>
          ${groups}
        </section>`;
    }).join('');

    app.innerHTML = `
      <h1>Anatomy &amp; Physiology practice</h1>
      <p class="lede">Pick a body system or a topic to get a random question. Answer it, press Submit (or Enter), and read the explanation.</p>
      <div class="systems">${cards}</div>`;
  }

  /* ---------------- question ---------------- */

  function renderQuestion(system, tag, q) {
    const label = tag ? tagLabel(tag) : 'All topics';
    document.title = `${label} · ${systemTitle(system)} · A&P Practice`;
    state.view = { system, tag, q, submitted: false };

    const meta = [
      `<span>${sourceLine(q)}</span>`,
      `<span>${esc(TYPE_LABEL[q.type] || q.type)}</span>`,
      q.points ? `<span>${q.points} pt${q.points === 1 ? '' : 's'}</span>` : '',
    ].join('');

    app.innerHTML = `
      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="#/">Home</a> › <a href="${categoryHash(system)}">${esc(systemTitle(system))}</a>${tag ? ` › <a href="${categoryHash(system, tag)}">${esc(label)}</a>` : ''}
      </nav>
      <article class="q-card">
        <div class="q-meta">${meta}</div>
        ${q.context ? `<div class="context">${richText(q, 'context')}</div>` : ''}
        <p class="prompt" id="q-prompt">${richText(q, 'prompt')}</p>
        ${imagesHtml(q)}
        <form id="q-form" novalidate>
          ${inputsHtml(q)}
          <div class="actions" id="q-actions">
            <button type="submit" class="btn" id="submit-btn">Submit</button>
          </div>
          <p class="hint">Press Enter to submit${q.type === 'short_answer' ? ' (Shift + Enter for a new line)' : ''}.</p>
        </form>
        <div id="q-feedback" aria-live="polite"></div>
      </article>`;

    document.getElementById('q-form').addEventListener('submit', e => { e.preventDefault(); submit(); });
    const first = app.querySelector('#q-form input[type=text], #q-form textarea');
    if (first && window.matchMedia('(pointer: fine)').matches) first.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function inputsHtml(q) {
    switch (q.type) {
      case 'multiple_choice':
      case 'multiple_select': {
        const kind = q.type === 'multiple_choice' ? 'radio' : 'checkbox';
        return `<fieldset><legend>${TYPE_LABEL[q.type]}</legend><div class="options">${q.choices.map(c => `
          <div class="option" data-id="${esc(c.id)}">
            <label>
              <input type="${kind}" name="choice" value="${esc(c.id)}">
              <span class="opt-id">${esc(c.id)}.</span>
              <span class="opt-text">${esc(c.text)}</span>
              <span class="opt-status"></span>
            </label>
            <div class="opt-expl">${esc(c.explanation || '')}</div>
          </div>`).join('')}</div></fieldset>`;
      }
      case 'true_false':
        return `<fieldset><legend>${TYPE_LABEL.true_false}</legend><div class="options">${['true', 'false'].map(v => `
          <div class="option" data-id="${v}">
            <label>
              <input type="radio" name="choice" value="${v}">
              <span class="opt-text">${v === 'true' ? 'True' : 'False'}</span>
              <span class="opt-status"></span>
            </label>
          </div>`).join('')}</div></fieldset>`;
      case 'fill_in':
        return `<div class="blanks">${q.answer.map((_, i) => `
          <div class="blank">
            <label for="blank-${i}">${q.answer.length > 1 ? esc(blankLabel(q, i)) : 'Your answer'}</label>
            <input type="text" id="blank-${i}" autocomplete="off" autocapitalize="off" spellcheck="false">
          </div>`).join('')}</div>`;
      default:
        return `<div class="blank"><label for="short">Your answer</label><textarea id="short" rows="4"></textarea></div>`;
    }
  }

  function submit() {
    const v = state.view;
    if (!v || v.submitted) return;
    v.submitted = true;
    const q = v.q;
    const form = document.getElementById('q-form');
    let resultHtml = '';
    let detailHtml = '';

    if (q.type === 'multiple_choice' || q.type === 'multiple_select' || q.type === 'true_false') {
      const picked = [...form.querySelectorAll('input[name=choice]:checked')].map(i => i.value);
      const right = q.type === 'true_false' ? [String(q.answer)]
        : q.type === 'multiple_choice' ? [q.answer] : q.answer;
      form.classList.add('answered');
      form.querySelectorAll('.option').forEach(opt => {
        const id = opt.dataset.id;
        const isRight = right.includes(id);
        const isPicked = picked.includes(id);
        if (isRight) opt.classList.add('is-correct');
        if (isPicked && !isRight) opt.classList.add('is-wrong');
        opt.querySelector('.opt-status').textContent =
          isRight && isPicked ? '✓ Your answer' : isRight ? '✓ Correct answer' : isPicked ? '✗ Your answer' : '';
      });
      const ok = picked.length === right.length && picked.every(p => right.includes(p));
      const yours = picked.length ? picked.map(p => q.type === 'true_false' ? (p === 'true' ? 'True' : 'False') : p).join(', ') : 'no answer';
      const expected = q.type === 'true_false' ? (q.answer ? 'True' : 'False') : right.join(', ');
      resultHtml = ok
        ? `<div class="result good">Correct! The answer is ${esc(expected)}.</div>`
        : `<div class="result bad">Not quite. You chose ${esc(yours)}; the correct answer is ${esc(expected)}.</div>`;
    } else if (q.type === 'fill_in') {
      const inputs = [...form.querySelectorAll('.blank input')];
      const rows = q.answer.map((alts, i) => {
        const val = inputs[i].value.trim();
        const ok = blankMatches(val, alts);
        return { label: q.answer.length > 1 ? blankLabel(q, i) : 'Answer', val, alts, ok };
      });
      const score = rows.filter(r => r.ok).length;
      const all = score === rows.length;
      resultHtml = rows.length === 1
        ? (all ? `<div class="result good">Correct!</div>` : `<div class="result bad">Not quite. Compare your answer below.</div>`)
        : `<div class="result ${all ? 'good' : score ? 'neutral' : 'bad'}">${score} of ${rows.length} correct.</div>`;
      detailHtml = `<div class="table-wrap"><table class="compare">
        <thead><tr><th scope="col"></th><th scope="col">Your answer</th><th scope="col">Expected</th><th scope="col"></th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${esc(r.label)}</td>
          <td>${r.val ? esc(r.val) : '<span class="empty">(blank)</span>'}</td>
          <td>${esc(r.alts.join(' / '))}</td>
          <td class="mark ${r.ok ? 'ok' : 'no'}">${r.ok ? '✓' : '✗'}</td>
        </tr>`).join('')}</tbody></table></div>
        <p class="hint">Spelling counts, but capitals, “the”, and plurals don’t. If your answer means the same thing, give yourself credit.</p>`;
      inputs.forEach(i => { i.readOnly = true; });
    } else {
      const ta = form.querySelector('textarea');
      const val = ta.value.trim();
      ta.readOnly = true;
      resultHtml = `<div class="result neutral">Compare your answer with the expected answer.</div>`;
      detailHtml = `<div class="answer-box">
        <div><span class="label">Your answer</span>${val ? esc(val) : '<span class="empty">(no answer)</span>'}</div>
        <div><span class="label">Expected answer</span>${esc(q.answer)}</div>
      </div>`;
    }

    form.querySelectorAll('input[type=radio], input[type=checkbox]').forEach(i => { i.disabled = true; });

    const notices = [];
    const note = q.note ? richText(q, 'note') : '';
    if (q.answerSource === 'corrected' && q.officialAnswer !== undefined) {
      const official = formatAnswer(Object.assign({}, q, { answer: q.officialAnswer }));
      notices.push(`<div class="notice"><strong>Answer key corrected:</strong> the original test’s key said “${esc(official)}”. ${note}</div>`);
    } else if (q.uncertain) {
      notices.push(`<div class="notice"><strong>Heads up:</strong> experts could disagree about this question’s answer. ${note.replace(/^Uncertain:\s*/, '')}</div>`);
    } else if (note) {
      notices.push(`<div class="notice"><strong>Note:</strong> ${note}</div>`);
    }

    const feedback = document.getElementById('q-feedback');
    feedback.innerHTML = `
      ${resultHtml}
      ${detailHtml}
      ${q.explanation ? `<section class="explanation"><h2>Explanation</h2>${paragraphs(q.explanation)}</section>` : ''}
      ${notices.join('')}
      ${q.advancedExplanation ? `<details class="more"><summary>More detail (advanced)</summary><div class="more-body">${richText(q, 'advancedExplanation')}</div></details>` : ''}`;

    const actionsHtml = id => `
      <a class="btn next-btn" id="${id}" href="${categoryHash(v.system, v.tag)}">Another question</a>
      <a class="btn secondary" href="#/">Home</a>`;
    document.getElementById('q-actions').innerHTML = actionsHtml('next-btn');
    feedback.insertAdjacentHTML('beforeend', `<div class="actions">${actionsHtml('next-btn-2')}</div>`);
    form.querySelector('.hint').textContent = 'Press Enter for another question.';
    app.querySelectorAll('.next-btn').forEach(b => b.addEventListener('click', e => { e.preventDefault(); nextQuestion(); }));
    resultFocus(feedback);
  }

  function resultFocus(feedback) {
    const r = feedback.querySelector('.result');
    if (r) r.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function nextQuestion() {
    const v = state.view;
    if (!v) return;
    const id = pickQuestion(v.system, v.tag, v.q.id);
    location.hash = categoryHash(v.system, v.tag) + '/q/' + encodeURIComponent(id);
  }

  /* ---------------- referenced-question dialog ---------------- */

  function openRef(id) {
    const q = state.byId.get(id);
    if (!q) return;
    document.getElementById('ref-title').textContent = `Question ${q.number}`;
    const choices = q.choices && q.choices.length
      ? `<ul class="ref-choices">${q.choices.map(c => `<li><b>${esc(c.id)}.</b>${esc(c.text)}</li>`).join('')}</ul>` : '';
    dialogBody.innerHTML = `
      <div class="q-meta"><span>${sourceLine(q)}</span><span>${esc(TYPE_LABEL[q.type] || q.type)}</span></div>
      ${q.context ? `<div class="context">${esc(q.context)}</div>` : ''}
      <p class="prompt">${esc(q.prompt)}</p>
      ${imagesHtml(q)}
      ${choices}
      <details class="more"><summary>Show answer</summary>
        <div class="more-body"><strong>Answer:</strong> ${esc(formatAnswer(q))}</div>
        ${q.explanation ? `<div class="explanation">${paragraphs(q.explanation)}</div>` : ''}
      </details>`;
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }

  dialog.addEventListener('click', e => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-ref]');
    if (b) { e.preventDefault(); openRef(b.dataset.ref); }
  });

  /* ---------------- keyboard ---------------- */

  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    if (dialog.open) return;
    const v = state.view;
    if (!v || !location.hash.includes('/q/')) return;
    const t = e.target;
    if (t && t.tagName === 'TEXTAREA' && e.shiftKey) return;            // new line in short answers
    if (t && t.matches && t.matches('summary, .ref-link, a:not(.next-btn), button:not(#submit-btn)')) return;
    e.preventDefault();
    if (!v.submitted) submit(); else nextQuestion();
  });

  /* ---------------- routing ---------------- */

  function route() {
    if (dialog.open) dialog.close();
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (!parts.length) { state.view = null; renderHome(); return; }

    const system = parts[0];
    if (!state.files[system]) { notFound(); return; }
    let tag = null;
    let qid = null;
    if (parts[1] === 'q') qid = parts[2];
    else { tag = parts[1] || null; if (parts[2] === 'q') qid = parts[3]; }
    if (tag && !state.tags.has(tag)) { notFound(); return; }

    if (!qid) {
      const id = pickQuestion(system, tag, null);
      if (!id) { notFound('There are no questions in this category yet.'); return; }
      history.replaceState(null, '', categoryHash(system, tag) + '/q/' + encodeURIComponent(id));
      qid = id;
    }
    const q = state.byId.get(qid);
    if (!q || state.systemOf.get(qid) !== system) { notFound(); return; }
    renderQuestion(system, tag, q);
  }

  function notFound(msg) {
    state.view = null;
    app.innerHTML = `<h1>Not found</h1><p class="lede">${esc(msg || 'That page doesn’t exist.')}</p><p><a class="btn" href="#/">Back to home</a></p>`;
  }

  /* ---------------- startup ---------------- */

  async function load() {
    const getJson = url => fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });
    const index = await getJson('data/index.json');
    state.index = index;
    for (const t of index.tags || []) state.tags.set(t.id, t);
    for (const s of index.sources || []) state.sources.set(s.id, s);
    const files = await Promise.all(index.files.map(f => getJson('data/' + f.file)));
    files.forEach((data, i) => {
      const system = index.files[i].system;
      state.files[system] = data;
      for (const q of data.questions) { state.byId.set(q.id, q); state.systemOf.set(q.id, system); }
    });
  }

  load().then(() => {
    window.addEventListener('hashchange', route);
    route();
  }).catch(err => {
    console.error(err);
    app.innerHTML = `<p class="error">Couldn’t load the questions (${esc(err.message)}). If you opened this file directly, serve the folder with a web server instead (for example <code>python3 -m http.server</code>).</p>`;
  });
})();
