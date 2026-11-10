/* Science Olympiad practice: static question browser.
 *
 * Events and where their data lives:
 *   Anatomy & Physiology  data/index.json + data/<system>.json   (groups = body systems)
 *   Disease Detectives    data/dd/questions.json, tags.json, tests.json   (groups = rule topics; copied from dd_data/)
 *
 * Routes (hash-based so it works from any GitHub Pages subpath):
 *   #/                                  home (pick an event)
 *   #/<event>                           event page: its groups and subcategories (ap, dd)
 *   #/<group>                           random question from a group (e.g. respiratory, outbreak-investigation)
 *   #/<group>/<tag>                     random question from a group + tag
 *   #/<group>[/<tag>]/q/<questionId>    a specific question within that category
 */
(function () {
  'use strict';

  const TYPE_LABEL = {
    multiple_choice: 'Choose one',
    multiple_select: 'Choose all that apply',
    true_false: 'True or false',
    fill_in: 'Fill in the blank',
    short_answer: 'Short answer',
    match: 'Matching',
    calc: 'Calculation',
    fill_text: 'Fill in the blank',
    free: 'Free response',
  };

  const app = document.getElementById('app');
  const dialog = document.getElementById('ref-dialog');
  const dialogBody = document.getElementById('ref-body');

  /* ---------------- helpers ---------------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  function getJson(url) {
    return fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });
  }

  /** Plain text: paragraphs split on blank lines, single newlines kept. */
  function plainParagraphs(text) {
    return String(text).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => {
      const cls = /^Big idea:/i.test(p) ? ' class="big-idea"' : '';
      return `<p${cls}>${esc(p).replace(/\n/g, '<br>')}</p>`;
    }).join('');
  }

  /* Small, safe markdown subset used by the Disease Detectives data:
     paragraphs, pipe tables, - / 1. lists, # headings, **bold**, *italic*, `code`. */
  function mdInline(s) {
    return esc(s)
      .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*?[^*\s]|[^*\s])\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }

  function md(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    let para = [];
    const flush = () => { if (para.length) { out.push(`<p>${para.map(mdInline).join('<br>')}</p>`); para = []; } };
    const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { flush(); i++; continue; }
      if (/^\s*\|/.test(line)) {
        flush();
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
        const sepIdx = rows.findIndex(r => /^\s*\|?\s*:?-{2,}/.test(r));
        const head = sepIdx === 1 ? cells(rows[0]) : null;
        const body = rows.filter((r, k) => k !== sepIdx && !(head && k === 0)).map(cells);
        out.push(`<div class="table-wrap"><table class="md-table">${head ? `<thead><tr>${head.map(c => `<th scope="col">${mdInline(c)}</th>`).join('')}</tr></thead>` : ''}<tbody>${body.map(r => `<tr>${r.map(c => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if (/^\s*[-*•] /.test(line)) {
        flush();
        const items = [];
        while (i < lines.length && /^\s*[-*•] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•] /, ''));
        out.push(`<ul>${items.map(t => `<li>${mdInline(t)}</li>`).join('')}</ul>`);
        continue;
      }
      if (/^\s*\d+[.)] /.test(line) && (para.length === 0)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)] /.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)] /, ''));
        out.push(`<ol>${items.map(t => `<li>${mdInline(t)}</li>`).join('')}</ol>`);
        continue;
      }
      const h = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (h) { flush(); out.push(`<p><strong>${mdInline(h[1])}</strong></p>`); i++; continue; }
      para.push(line.trim());
      i++;
    }
    flush();
    return out.join('');
  }

  /* ---------------- grading helpers ---------------- */

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

  function textMatches(input, alts) {
    const n = norm(input);
    if (!n) return false;
    return alts.some(alt => {
      const a = norm(alt);
      return a === n || singular(a) === singular(n);
    });
  }

  /** Matching answers look like "P. Fulminant", "g. John Snow", "I. Agent or H. Pathogen (both accepted)" or just "Fomite". */
  function matchAlternatives(answer) {
    const a = String(answer).replace(/\((?:both|either)[^)]*\)/ig, '').trim();
    const alts = [];
    for (const part of a.split(/\s+or\s+|\s*\/\s*/i)) {
      const m = part.trim().match(/^([A-Za-z]{1,2})[.)]\s+(.+)$/);
      if (m) { alts.push(m[1]); alts.push(m[2]); alts.push(`${m[1]} ${m[2]}`); }
      else if (part.trim()) alts.push(part.trim());
    }
    return alts;
  }

  function parseNumber(s) {
    const m = String(s).replace(/,(?=\d{3}\b)/g, '').match(/^\s*[-−]?\d*\.?\d+\s*%?\s*$/);
    if (!m) return null;
    return { value: parseFloat(m[0].replace('−', '-').replace('%', '')), percent: /%/.test(m[0]) };
  }

  /** The single expected number of a calculation answer (the number after the last "="), or null if it has several parts. */
  function expectedNumber(answer) {
    const a = String(answer);
    if (/[;\n]/.test(a) || /\b[A-E][.)]\s/.test(a)) return null;
    const tail = a.includes('=') ? a.slice(a.lastIndexOf('=') + 1) : a;
    const m = tail.replace(/,(?=\d{3}\b)/g, '').match(/^\s*[≈~]?\s*([-−]?\d*\.?\d+)/);
    return m ? parseFloat(m[1].replace('−', '-')) : null;
  }

  function numbersAgree(got, want) {
    const close = (x, y) => Math.abs(x - y) <= Math.max(Math.abs(y) * 0.01, 1e-9) ||
      Math.abs(x - y) <= 0.5 * Math.pow(10, -decimals(x)); // student rounded
    return [got, got / 100, got * 100].some(x => close(x, want));
  }

  function decimals(x) {
    const s = String(x);
    return s.includes('.') ? s.split('.')[1].length : 0;
  }

  /* ---------------- events ---------------- */

  const AP = {
    id: 'ap',
    title: 'Anatomy & Physiology',
    blurb: 'Respiratory, digestive and immune systems.',
    colors: { respiratory: 'var(--c1)', digestive: 'var(--c2)', immune: 'var(--c3)' },
    tagSections: [
      { kind: 'topic', title: 'Topics from the 2026 rules', nest: true },
      { kind: 'structure', title: 'Body parts & cells' },
      { kind: 'format', title: 'Question style', chips: true },
      { kind: 'level', title: 'Competition level', chips: true },
    ],
    async load() {
      const index = await getJson('data/index.json');
      this.tags = new Map((index.tags || []).map(t => [t.id, t]));
      const sources = new Map((index.sources || []).map(s => [s.id, s]));
      const files = await Promise.all(index.files.map(f => getJson('data/' + f.file)));
      this.groups = index.files.map((f, i) => {
        const qs = files[i].questions.map(q => normalizeAp(q, f.system, sources));
        return { id: f.system, title: files[i].title, questions: qs, color: this.colors[f.system] };
      });
    },
    tagsForGroup(group) {
      return [...this.tags.values()].filter(t => !t.system || t.system === group.id);
    },
  };

  function normalizeAp(q, system, sources) {
    const s = sources.get(q.source);
    const notices = [];
    const note = q.note ? richText(q, 'note') : '';
    if (q.answerSource === 'corrected' && q.officialAnswer !== undefined) {
      const official = formatAnswer(Object.assign({}, q, { answer: q.officialAnswer }));
      notices.push(`<strong>Answer key corrected:</strong> the original test’s key said “${esc(official)}”. ${note}`);
    } else if (q.uncertain) {
      notices.push(`<strong>Heads up:</strong> experts could disagree about this question’s answer. ${note.replace(/^Uncertain:\s*/, '')}`);
    } else if (note) {
      notices.push(`<strong>Note:</strong> ${note}`);
    }
    return Object.assign({}, q, {
      event: 'ap',
      sourceName: s ? s.name : q.source,
      imageUrls: (q.images || []).map(p => 'data/' + p),
      contextHtml: q.context ? `<div class="context plain">${richText(q, 'context')}</div>` : '',
      promptHtml: `<p class="prompt plain">${richText(q, 'prompt')}</p>`,
      explanationHtml: q.explanation ? plainParagraphs(q.explanation) : '',
      advancedHtml: q.advancedExplanation ? richText(q, 'advancedExplanation') : '',
      notices,
    });
  }

  const DD = {
    id: 'dd',
    title: 'Disease Detectives',
    blurb: 'Epidemiology: surveillance, outbreak investigation, and disease patterns, control and prevention.',
    palette: ['var(--c4)', 'var(--c5)', 'var(--c6)'],
    tagSections: [
      { kind: 'rule', title: 'Topics from the 2026 rules' },
      { kind: 'format', title: 'Question style', chips: true },
    ],
    async load() {
      const [questions, taxonomy, tests] = await Promise.all([
        getJson('data/dd/questions.json'), getJson('data/dd/tags.json'), getJson('data/dd/tests.json')]);
      const testName = new Map(tests.map(t => [t.id, t.tournament]));
      this.tags = new Map();
      for (const topic of taxonomy.topics) {
        for (const t of topic.tags) {
          this.tags.set(t.id, { id: t.id, label: t.name, kind: 'rule', rule: t.rule, description: t.description, topic: topic.id });
        }
      }
      for (const t of [
        { id: 'calculation', label: 'Calculation', test: q => q.type === 'calc' },
        { id: 'case-study', label: 'Case study', test: q => !!(q.scenario_text && q.scenario_text.length > 200 && q.type !== 'match') },
        { id: 'diagram', label: 'Figure / table', test: q => (q.figures || []).length + (q.scenario_figures || []).length > 0 || /^\s*\|/m.test((q.scenario_text || '') + '\n' + q.prompt) },
      ]) this.tags.set(t.id, { id: t.id, label: t.label, kind: 'format', test: t.test });
      const formats = [...this.tags.values()].filter(t => t.kind === 'format');

      const inScope = questions.filter(q => q.in_scope !== false);
      const all = inScope.map(q => normalizeDd(q, testName, formats));
      this.groups = taxonomy.topics.map((topic, i) => ({
        id: topic.id,
        title: topic.name,
        rule: topic.rule,
        color: this.palette[i % this.palette.length],
        questions: all.filter(q => (q.topics || []).includes(topic.id)),
      }));
    },
    tagsForGroup(group) {
      return [...this.tags.values()].filter(t => t.kind !== 'rule' || t.topic === group.id);
    },
  };

  const DD_TYPES = { mc: 'multiple_choice', multi: 'multiple_select', tf: 'true_false', short: 'short_answer',
    free: 'free', fill: 'fill_text', match: 'match', calc: 'calc' };

  function normalizeDd(q, testName, formats) {
    const type = DD_TYPES[q.type] || 'short_answer';
    const notices = [];
    const note = q.key_note ? md(q.key_note).replace(/^<p>|<\/p>$/g, '') : '';
    if (q.answer_status === 'key_corrected') {
      notices.push(`<strong>Answer key corrected:</strong> the original test’s key said “${esc(q.original_key_answer ?? '')}”. ${note}`);
    } else if (q.answer_status === 'key_questionable') {
      notices.push(`<strong>Heads up:</strong> the answer key for this question is debatable. ${note}`);
    } else if (q.answer_status === 'derived') {
      notices.push('<strong>Note:</strong> this test had no answer key, so this answer was worked out independently.');
    }
    const images = [...(q.scenario_figures || []), ...(q.figures || [])].filter((p, i, a) => a.indexOf(p) === i);
    const nq = {
      event: 'dd',
      id: q.id,
      number: q.number,
      points: q.points,
      type,
      sourceName: testName.get(q.test_id) || q.test_id,
      choices: (q.choices || []).map(c => ({ id: c.label, text: c.text })),
      answer: q.answer,
      answerText: q.answer_text,
      imageUrls: images.map(p => 'data/dd/' + p),
      contextHtml: q.scenario_text ? `<div class="context md">${md(q.scenario_text)}</div>` : '',
      promptHtml: `<div class="prompt md">${md(q.prompt)}</div>`,
      explanationHtml: q.explanation ? md(q.explanation) : '',
      advancedHtml: '',
      notices,
      topics: q.topics || [],
    };
    nq.tags = [...(q.tags || []), ...formats.filter(t => t.test(q)).map(t => t.id)];
    return nq;
  }

  const EVENTS = [AP, DD];
  const state = { view: null, loading: new Map() };
  const groupIndex = new Map();   // group id -> { event, group }
  const byId = new Map();         // question id -> { event, group(s), question }

  function ensureLoaded(ev) {
    if (!state.loading.has(ev.id)) {
      state.loading.set(ev.id, ev.load().then(() => {
        for (const g of ev.groups) {
          groupIndex.set(g.id, { event: ev, group: g });
          for (const q of g.questions) byId.set(q.id, q);
        }
      }));
    }
    return state.loading.get(ev.id);
  }

  /** Which event a route's first segment belongs to, without loading data. */
  const KNOWN_GROUPS = {
    respiratory: AP, digestive: AP, immune: AP,
    'background-surveillance': DD, 'outbreak-investigation': DD, 'patterns-control-prevention': DD,
  };

  /* ---------------- A&P text with cross-question references ---------------- */

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
      if (target) {
        out += `<button type="button" class="ref-link" data-ref="${esc(target.id)}" title="Open question ${esc(target.number)}">${esc(label)}</button>`;
      } else {
        out += esc(label);
      }
      pos = r.end;
    }
    return out + esc(chars.slice(pos).join(''));
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
        return q.answerText || String(a);
    }
  }

  function blankLabel(q, i) {
    const n = q.answer.length;
    if (n > 3 && /label/i.test(q.prompt) && n <= 26) return `Label ${String.fromCharCode(65 + i)}`;
    return `Blank ${i + 1}`;
  }

  function imagesHtml(q) {
    if (!q.imageUrls || !q.imageUrls.length) return '';
    return `<div class="figures">${q.imageUrls.map(src =>
      `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="Figure for question ${esc(q.number)}" loading="lazy"></a>`
    ).join('')}</div>`;
  }

  /* ---------------- category picking ---------------- */

  function questionsFor(group, tag) {
    return group.questions.filter(q => !tag || (q.tags || []).includes(tag));
  }

  /** Random question without repeats until the whole category has been seen (per browser tab). */
  function pickQuestion(group, tag, avoidId) {
    const pool = questionsFor(group, tag);
    if (!pool.length) return null;
    const key = `bag:${group.id}:${tag || ''}`;
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

  function categoryHash(groupId, tag) {
    return '#/' + encodeURIComponent(groupId) + (tag ? '/' + encodeURIComponent(tag) : '');
  }

  /* ---------------- pages ---------------- */

  function renderHome() {
    document.title = 'SciOly Practice';
    state.view = null;
    app.innerHTML = `
      <h1>Science Olympiad practice</h1>
      <p class="lede">Pick an event, then a topic, to get random practice questions with explanations.</p>
      <div class="systems">${EVENTS.map(ev => `
        <section class="system-card event-card" style="--sys: ${ev === AP ? 'var(--c1)' : 'var(--c4)'}">
          <div class="system-head">
            <h2>${esc(ev.title)}</h2>
            <a class="btn" href="#/${ev.id}">Practice</a>
          </div>
          <p class="event-blurb">${esc(ev.blurb)}</p>
        </section>`).join('')}
      </div>`;
  }

  function renderEvent(ev) {
    document.title = `${ev.title} · SciOly Practice`;
    state.view = null;
    const cards = ev.groups.map(group => {
      const qs = group.questions;
      const counts = new Map();
      for (const q of qs) for (const t of q.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
      const tagsHere = ev.tagsForGroup(group).filter(t => counts.get(t.id));

      const link = t => `
        <a class="tag-link" href="${categoryHash(group.id, t.id)}"${t.description ? ` title="${esc(t.description)}"` : ''}>
          <span class="name">${esc(t.label)}${t.rule ? `<span class="rule">${esc(t.rule)}</span>` : ''}${t.stateOnly ? '<span class="pill">State/Nat’l</span>' : ''}</span>
          <span class="count">${counts.get(t.id)}</span>
        </a>`;

      const sections = ev.tagSections.map(sec => {
        const items = tagsHere.filter(t => t.kind === sec.kind);
        if (!items.length) return '';
        if (sec.chips) return `<section class="tag-group"><h3>${sec.title}</h3><div class="chips">${items.map(link).join('')}</div></section>`;
        const lis = items.map(t => {
          const kids = sec.nest ? tagsHere.filter(c => c.kind === 'condition' && c.parent === t.id) : [];
          return `<li>${link(t)}${kids.length ? `<ul class="tag-list sub">${kids.map(c => `<li>${link(c)}</li>`).join('')}</ul>` : ''}</li>`;
        }).join('');
        return `<section class="tag-group"><h3>${sec.title}</h3><ul class="tag-list">${lis}</ul></section>`;
      }).join('');

      return `
        <section class="system-card" style="--sys: ${group.color}" aria-labelledby="h-${esc(group.id)}">
          <div class="system-head">
            <h2 id="h-${esc(group.id)}">${esc(group.title)}${group.rule ? ` <span class="rule">${esc(group.rule)}</span>` : ''}</h2>
            <a class="btn" href="${categoryHash(group.id)}">Random question · ${qs.length}</a>
          </div>
          ${sections}
        </section>`;
    }).join('');

    app.innerHTML = `
      <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a> › ${esc(ev.title)}</nav>
      <h1>${esc(ev.title)}</h1>
      <p class="lede">Pick a group or a topic to get a random question. Answer it, press Submit (or Enter), and read the explanation.</p>
      <div class="systems">${cards}</div>`;
  }

  function renderQuestion(ev, group, tag, q) {
    const tagDef = tag ? ev.tags.get(tag) : null;
    const label = tagDef ? tagDef.label : 'All topics';
    document.title = `${label} · ${group.title} · ${ev.title}`;
    state.view = { ev, group, tag, q, submitted: false };

    const meta = [
      `<span>${esc(q.sourceName)} · #${esc(q.number)}</span>`,
      `<span>${esc(TYPE_LABEL[q.type] || q.type)}</span>`,
      q.points ? `<span>${q.points} pt${q.points === 1 ? '' : 's'}</span>` : '',
    ].join('');

    app.innerHTML = `
      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="#/">Home</a> › <a href="#/${ev.id}">${esc(ev.title)}</a> › <a href="${categoryHash(group.id)}">${esc(group.title)}</a>${tag ? ` › <a href="${categoryHash(group.id, tag)}">${esc(label)}</a>` : ''}
      </nav>
      <article class="q-card">
        <div class="q-meta">${meta}</div>
        ${q.contextHtml}
        ${q.promptHtml}
        ${imagesHtml(q)}
        <form id="q-form" novalidate>
          ${inputsHtml(q)}
          <div class="actions" id="q-actions">
            <button type="submit" class="btn" id="submit-btn">Submit</button>
          </div>
          <p class="hint">Press Enter to submit${usesTextarea(q) ? ' (Shift + Enter for a new line)' : ''}.</p>
        </form>
        <div id="q-feedback" aria-live="polite"></div>
      </article>`;

    document.getElementById('q-form').addEventListener('submit', e => { e.preventDefault(); submit(); });
    const first = app.querySelector('#q-form input[type=text], #q-form textarea');
    if (first && window.matchMedia('(pointer: fine)').matches) first.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function usesTextarea(q) {
    return q.type === 'short_answer' || q.type === 'free' || (q.type === 'calc' && expectedNumber(q.answer) === null) ||
      (q.type === 'fill_text' && /;/.test(String(q.answer))) || (q.type === 'match' && /;/.test(String(q.answer)));
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
            ${c.explanation ? `<div class="opt-expl">${esc(c.explanation)}</div>` : ''}
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
      default: {
        if (!usesTextarea(q)) {
          const placeholder = q.type === 'match' ? 'Letter or term' : q.type === 'calc' ? 'Your number' : '';
          return `<div class="blank"><label for="short">Your answer</label><input type="text" id="short" autocomplete="off" autocapitalize="off" spellcheck="false"${placeholder ? ` placeholder="${placeholder}"` : ''}></div>`;
        }
        const hint = (q.type === 'fill_text' || q.type === 'match') ? '<p class="hint">Separate the blanks with semicolons.</p>' : '';
        return `<div class="blank"><label for="short">Your answer</label><textarea id="short" rows="4"></textarea>${hint}</div>`;
      }
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
        return { label: q.answer.length > 1 ? blankLabel(q, i) : 'Answer', val, alts, ok: textMatches(val, alts) };
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
      const box = form.querySelector('#short');
      const val = box.value.trim();
      box.readOnly = true;
      const expected = q.event === 'dd' ? md(q.answerText || String(q.answer)) : esc(q.answer);
      let verdict = null; // true, false or null (compare yourself)
      if (q.type === 'match' && !/;/.test(String(q.answer))) {
        verdict = textMatches(val, matchAlternatives(q.answer));
      } else if (q.type === 'calc') {
        const want = expectedNumber(q.answer);
        const got = parseNumber(val);
        if (want !== null && got) verdict = numbersAgree(got.value, want) ? true : null;
      } else if (val && (q.type === 'fill_text' || q.type === 'short_answer')) {
        if (textMatches(val, [String(q.answerText || q.answer)])) verdict = true;
      }
      resultHtml = verdict === true ? `<div class="result good">Correct!</div>`
        : verdict === false ? `<div class="result bad">Not quite. Compare your answer below.</div>`
        : `<div class="result neutral">Compare your answer with the expected answer.</div>`;
      detailHtml = `<div class="answer-box">
        <div><span class="label">Your answer</span>${val ? esc(val) : '<span class="empty">(no answer)</span>'}</div>
        <div class="expected"><span class="label">Expected answer</span>${expected}</div>
      </div>`;
    }

    form.querySelectorAll('input[type=radio], input[type=checkbox]').forEach(i => { i.disabled = true; });

    const feedback = document.getElementById('q-feedback');
    feedback.innerHTML = `
      ${resultHtml}
      ${detailHtml}
      ${q.explanationHtml ? `<section class="explanation"><h2>Explanation</h2>${q.explanationHtml}</section>` : ''}
      ${q.notices.map(n => `<div class="notice">${n}</div>`).join('')}
      ${q.advancedHtml ? `<details class="more"><summary>More detail (advanced)</summary><div class="more-body">${q.advancedHtml}</div></details>` : ''}`;

    const actionsHtml = id => `
      <a class="btn next-btn" id="${id}" href="${categoryHash(v.group.id, v.tag)}">Another question</a>
      <a class="btn secondary" href="#/">Home</a>`;
    document.getElementById('q-actions').innerHTML = actionsHtml('next-btn');
    feedback.insertAdjacentHTML('beforeend', `<div class="actions">${actionsHtml('next-btn-2')}</div>`);
    form.querySelector(':scope > .hint').textContent = 'Press Enter for another question.';
    app.querySelectorAll('.next-btn').forEach(b => b.addEventListener('click', e => { e.preventDefault(); nextQuestion(); }));
    const r = feedback.querySelector('.result');
    if (r) r.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function nextQuestion() {
    const v = state.view;
    if (!v) return;
    const id = pickQuestion(v.group, v.tag, v.q.id);
    location.hash = categoryHash(v.group.id, v.tag) + '/q/' + encodeURIComponent(id);
  }

  /* ---------------- referenced-question dialog (A&P) ---------------- */

  function openRef(id) {
    const q = byId.get(id);
    if (!q) return;
    document.getElementById('ref-title').textContent = `Question ${q.number}`;
    const choices = q.choices && q.choices.length
      ? `<ul class="ref-choices">${q.choices.map(c => `<li><b>${esc(c.id)}.</b>${esc(c.text)}</li>`).join('')}</ul>` : '';
    dialogBody.innerHTML = `
      <div class="q-meta"><span>${esc(q.sourceName)} · #${esc(q.number)}</span><span>${esc(TYPE_LABEL[q.type] || q.type)}</span></div>
      ${q.context ? `<div class="context plain">${esc(q.context)}</div>` : ''}
      <p class="prompt plain">${esc(q.prompt)}</p>
      ${imagesHtml(q)}
      ${choices}
      <details class="more"><summary>Show answer</summary>
        <div class="more-body"><strong>Answer:</strong> ${esc(formatAnswer(q))}</div>
        ${q.explanationHtml ? `<div class="explanation">${q.explanationHtml}</div>` : ''}
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
    if (t && t.tagName === 'TEXTAREA' && e.shiftKey) return;            // new line in long answers
    if (t && t.matches && t.matches('summary, .ref-link, a:not(.next-btn), button:not(#submit-btn)')) return;
    e.preventDefault();
    if (!v.submitted) submit(); else nextQuestion();
  });

  /* ---------------- routing ---------------- */

  async function route() {
    if (dialog.open) dialog.close();
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (!parts.length) { renderHome(); return; }

    const ev = EVENTS.find(e => e.id === parts[0]) || KNOWN_GROUPS[parts[0]];
    if (!ev) { notFound(); return; }
    const hashAtStart = location.hash;
    if (!state.loading.has(ev.id)) app.innerHTML = '<p class="loading">Loading questions…</p>';
    try {
      await ensureLoaded(ev);
    } catch (err) {
      console.error(err);
      app.innerHTML = `<p class="error">Couldn’t load the questions (${esc(err.message)}). If you opened this file directly, serve the folder with a web server instead (for example <code>python3 -m http.server</code>).</p>`;
      return;
    }
    if (location.hash !== hashAtStart) return; // the user navigated away while loading

    if (parts[0] === ev.id) { renderEvent(ev); return; }

    const entry = groupIndex.get(parts[0]);
    if (!entry) { notFound(); return; }
    const group = entry.group;
    let tag = null;
    let qid = null;
    if (parts[1] === 'q') qid = parts[2];
    else { tag = parts[1] || null; if (parts[2] === 'q') qid = parts[3]; }
    if (tag && !ev.tags.has(tag)) { notFound(); return; }

    if (!qid) {
      const id = pickQuestion(group, tag, null);
      if (!id) { notFound('There are no questions in this category yet.'); return; }
      history.replaceState(null, '', categoryHash(group.id, tag) + '/q/' + encodeURIComponent(id));
      qid = id;
    }
    const q = group.questions.find(x => x.id === qid);
    if (!q) { notFound(); return; }
    renderQuestion(ev, group, tag, q);
  }

  function notFound(msg) {
    state.view = null;
    app.innerHTML = `<h1>Not found</h1><p class="lede">${esc(msg || 'That page doesn’t exist.')}</p><p><a class="btn" href="#/">Back to home</a></p>`;
  }

  window.addEventListener('hashchange', route);
  route();
})();
