// Question renderers. Each mounts into `box` and calls ctx.done({correct}) exactly once.
import { esc, norm } from './util.js';
import { sound, haptic } from './audio.js';
import { MAP } from './content/geo.js';

const $ = (el, s) => el.querySelector(s);
const btn = (cls, txt, attrs = '') => `<button class="${cls}" ${attrs}>${txt}</button>`;
function prompt(q) {
  let h = '';
  if (q.instr) h += `<div class="instr">${esc(q.instr)}</div>`;
  if (q.img) h += `<div class="qimg" aria-hidden="true">${esc(q.img)}</div>`;
  if (q.image) h += `<img class="qimg" alt="" src="${esc(q.image)}" style="max-width:100%;max-height:180px;display:block;margin:0 auto 8px">`;
  h += `<div class="qtext">${esc(q.q)}</div>`;
  if (q.clues && q.type !== 'lock') h += `<ul class="clues">${q.clues.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`;
  if (q.seq) h += `<div class="${typeof q.seq[0] === 'number' && q.type === 'input' ? 'planks' : 'tiles'}" aria-label="Sequence">${q.seq.map((v) => `<span class="${typeof q.seq[0] === 'number' && q.type === 'input' ? 'plank' : 'tile'}${v === '?' || v === '❓' ? ' q' : ''}">${esc(v)}</span>`).join('')}</div>`;
  if (q.matrix) h += `<div class="matrix" aria-label="3 by 3 grid">${q.matrix.map((v) => `<span class="tile${v === '❓' ? ' q' : ''}">${esc(v)}</span>`).join('')}</div>`;
  if (q.audio) h += `<audio controls src="${esc(q.audio)}"></audio>`;
  return h;
}
const R = {};

R.mcq = (q, box, ctx) => {
  box.innerHTML = prompt(q) + `<div class="opts" role="group">${q.options.map((o, i) => `<button class="opt" data-i="${i}"><span>${esc(o)}</span><span class="tag"></span></button>`).join('')}</div>`;
  let over = false; const bs = [...box.querySelectorAll('.opt')];
  bs.forEach((b) => b.addEventListener('click', () => {
    if (over) return; over = true; const i = +b.dataset.i; const ok = i === q.answer;
    bs.forEach((x, j) => { x.disabled = true; if (j === q.answer) { x.classList.add('good'); $(x, '.tag').textContent = '✓'; } else if (j === i) { x.classList.add('bad'); $(x, '.tag').textContent = '✗'; } else x.classList.add('dim'); });
    ctx.done({ correct: ok, given: q.options[i] });
  }));
  return { hint() { const wrong = bs.filter((b, j) => j !== q.answer && !b.disabled && !b.classList.contains('dim')); wrong.slice(0, Math.max(1, Math.min(2, wrong.length - 1))).forEach((b) => { b.classList.add('dim'); b.disabled = true; }); return true; } };
};

R.input = (q, box, ctx) => {
  const isNum = typeof q.answer === 'number' || /^-?\d+(\.\d+)?$/.test(String(q.answer));
  box.innerHTML = prompt(q) + `<label class="field"><span class="muted small">Your answer</span><input type="text" id="ans" ${isNum ? 'inputmode="decimal"' : ''} autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Answer"></label>${btn('btn block', 'Check ✓', 'id="chk"')}`;
  const inp = $(box, '#ans'); let over = false; setTimeout(() => inp.focus({ preventScroll: true }), 50);
  const accepts = [String(q.answer), ...(q.accept || [])].map((a) => norm(a));
  const check = () => {
    if (over) return; const v = inp.value.trim(); if (!v) { inp.classList.add('shake'); setTimeout(() => inp.classList.remove('shake'), 300); return; }
    over = true; let ok = accepts.includes(norm(v)); if (!ok && isNum) { const n = parseFloat(v.replace(/,/g, '')); ok = Number.isFinite(n) && Math.abs(n - Number(q.answer)) < 1e-9; }
    inp.disabled = true; $(box, '#chk').hidden = true; inp.style.borderColor = ok ? 'var(--good)' : 'var(--bad)'; ctx.done({ correct: ok, given: v });
  };
  $(box, '#chk').addEventListener('click', check); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });
  return { hint() { if (!inp.disabled) { inp.placeholder = `Starts with “${String(q.answer)[0]}” · ${String(q.answer).length} character(s)`; } return true; } };
};

R.order = (q, box, ctx) => {
  const letter = q.tile === 'letter'; const tileCls = letter ? 'btile letter' : 'btile';
  const bank = q.shuffled.map((t, i) => ({ t, i, used: false })); const line = [];
  box.innerHTML = prompt(q) + `<div class="line" id="line" aria-label="Your answer"></div><div class="tiles" id="bank"></div>${btn('btn block', 'Check ✓', 'id="chk" disabled')}`;
  let over = false;
  const draw = () => {
    $(box, '#line').innerHTML = line.length ? line.map((b, k) => `<button class="${tileCls}" data-k="${k}" aria-label="Remove ${esc(b.t)}">${esc(b.t)}</button>`).join('') : '<span class="muted small">Tap the tiles below in the right order</span>';
    $(box, '#bank').innerHTML = bank.map((b, i) => `<button class="${tileCls}${b.used ? ' used' : ''}" data-i="${i}">${esc(b.t)}</button>`).join('');
    $(box, '#chk').disabled = line.length !== bank.length || over;
    $(box, '#line').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { if (over) return; const x = line.splice(+b.dataset.k, 1)[0]; x.used = false; sound.tap(); draw(); }));
    $(box, '#bank').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { if (over) return; const x = bank[+b.dataset.i]; if (x.used) return; x.used = true; line.push(x); sound.tap(); draw(); }));
  };
  draw();
  const join = (a) => a.join(letter ? '' : ' ');
  $(box, '#chk').addEventListener('click', () => {
    if (over) return; over = true; const got = line.map((b) => b.t); const ok = join(got) === join(q.items) || (q.alts || []).some((a) => join(a) === join(got));
    $(box, '#line').querySelectorAll('button').forEach((b, k) => b.classList.add(got[k] === q.items[k] ? 'good' : 'bad'));
    if (q.dates && !ok) { /* shown in explanation */ } $(box, '#chk').hidden = true;
    ctx.done({ correct: ok, given: join(got), reveal: join(q.items) + (q.dates ? '  (' + q.dates.join(' → ') + ')' : '') });
  });
  return { hint() { if (over) return false; // place the next correct tile
    const need = q.items[line.length]; if (line.length && line.some((b, k) => b.t !== q.items[k])) { while (line.length) { line.pop().used = false; } }
    const nextNeed = q.items[line.length]; const b = bank.find((x) => !x.used && x.t === nextNeed); if (b) { b.used = true; line.push(b); draw(); } return true; } };
};

R.match = (q, box, ctx) => {
  const lefts = q.pairs.map((p, i) => ({ t: p[0], i })); const rights = q.right.map((t) => ({ t, i: q.pairs.findIndex((p) => p[1] === t) }));
  box.innerHTML = prompt(q) + `<div class="cols"><div id="L"></div><div id="Rt"></div></div><div class="muted small center" id="mm"></div>`;
  let sel = null, mistakes = 0, matched = 0, over = false; const done = new Set();
  const draw = () => {
    $(box, '#L').innerHTML = lefts.map((l) => `<button class="btile ${done.has(l.i) ? 'done' : ''} ${sel === l.i ? 'sel' : ''}" data-i="${l.i}">${esc(l.t)}</button>`).join('');
    $(box, '#Rt').innerHTML = rights.map((r) => `<button class="btile ${done.has(r.i) ? 'done' : ''}" data-i="${r.i}">${esc(r.t)}</button>`).join('');
    $(box, '#L').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { if (over) return; sel = +b.dataset.i; sound.tap(); draw(); }));
    $(box, '#Rt').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      if (over || sel === null) return; const i = +b.dataset.i;
      if (i === sel) { done.add(i); matched++; sound.correct(); sel = null; if (matched === q.pairs.length) { over = true; draw(); ctx.done({ correct: mistakes <= (q.pairs.length >= 4 ? 1 : 0), given: `${mistakes} mistake(s)` }); return; } }
      else { mistakes++; sound.wrong(); haptic(40); b.classList.add('bad', 'shake'); sel = null; $(box, '#mm').textContent = `Mistakes: ${mistakes}`; setTimeout(draw, 350); return; }
      draw();
    }));
  };
  draw();
  return { hint() { if (over) return false; const l = lefts.find((x) => !done.has(x.i)); if (l) { sel = l.i; draw(); } return true; } };
};

R.sort = (q, box, ctx) => {
  const items = q.items.map(([t, b], i) => ({ t, b, i, at: null })); let sel = null, over = false;
  box.innerHTML = prompt(q) + `<div class="tiles" id="pool"></div><div class="grid2" id="bk">${q.buckets.map((b, i) => `<div class="bucket" data-b="${i}" role="button" tabindex="0" aria-label="Put selected item in ${esc(b)}"><b>${esc(b)}</b><div class="tiles" style="justify-content:flex-start"></div></div>`).join('')}</div>${btn('btn block', 'Check ✓', 'id="chk" disabled style="margin-top:12px"')}`;
  const chip = (it) => `<button class="btile ${sel === it.i ? 'sel' : ''}" draggable="true" data-i="${it.i}">${esc(it.t)}</button>`;
  const draw = () => {
    $(box, '#pool').innerHTML = items.filter((x) => x.at === null).map(chip).join('') || '<span class="muted small">All sorted — check your answer!</span>';
    box.querySelectorAll('.bucket').forEach((bk) => { bk.querySelector('.tiles').innerHTML = items.filter((x) => x.at === +bk.dataset.b).map(chip).join(''); });
    $(box, '#chk').disabled = items.some((x) => x.at === null) || over;
    box.querySelectorAll('.btile').forEach((c) => { c.addEventListener('click', (e) => { if (over) return; e.stopPropagation(); const it = items[+c.dataset.i]; if (it.at !== null) { it.at = null; sel = null; } else sel = sel === it.i ? null : it.i; sound.tap(); draw(); });
      c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.dataset.i); }); });
    box.querySelectorAll('.bucket').forEach((bk) => {
      const put = (i) => { if (over) return; items[i].at = +bk.dataset.b; sel = null; sound.tap(); draw(); };
      bk.onclick = () => { if (sel !== null) put(sel); }; bk.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && sel !== null) { e.preventDefault(); put(sel); } };
      bk.ondragover = (e) => { e.preventDefault(); bk.classList.add('over'); }; bk.ondragleave = () => bk.classList.remove('over'); bk.ondrop = (e) => { e.preventDefault(); bk.classList.remove('over'); const i = +e.dataTransfer.getData('text/plain'); if (!Number.isNaN(i)) put(i); };
    });
  };
  draw();
  $(box, '#chk').addEventListener('click', () => {
    if (over) return; over = true; const wrong = items.filter((x) => x.at !== x.b).length; $(box, '#chk').hidden = true;
    box.querySelectorAll('.bucket').forEach((bk) => bk.querySelectorAll('.btile').forEach((c) => c.classList.add(items[+c.dataset.i].at === items[+c.dataset.i].b ? 'good' : 'bad')));
    ctx.done({ correct: wrong === 0, given: `${items.length - wrong}/${items.length} placed correctly` });
  });
  return { hint() { if (over) return false; const it = items.find((x) => x.at !== x.b); if (it) { it.at = it.b; draw(); } return true; } };
};

R.lab = (q, box, ctx) => {
  const pick = q.slots.map(() => null); let over = false;
  box.innerHTML = prompt(q) + `<p class="muted">${esc(q.scenario || '')}</p><div class="lab-flask" aria-hidden="true">🧪</div>` + q.slots.map((s, i) => `<div class="field"><span>${esc(s.label)}</span><div class="choices" data-s="${i}">${s.options.map((o, j) => `<button class="choice" aria-pressed="false" data-j="${j}">${esc(o)}</button>`).join('')}</div></div>`).join('') + btn('btn block gold', '⚗️ Run experiment', 'id="run" disabled');
  box.querySelectorAll('.choices').forEach((c) => c.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { if (over) return; const s = +c.dataset.s; pick[s] = +b.dataset.j; c.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b)); sound.tap(); $(box, '#run').disabled = pick.some((p) => p === null); })));
  $(box, '#run').addEventListener('click', () => {
    if (over) return; over = true; box.classList.add('lab-run'); $(box, '#run').hidden = true; let wrong = 0;
    box.querySelectorAll('.choices').forEach((c) => { const s = +c.dataset.s; c.querySelectorAll('button').forEach((b, j) => { b.disabled = true; if (j === q.slots[s].answer) b.style.background = '#dcfce7'; else if (j === pick[s]) b.style.background = '#fee2e2'; }); if (pick[s] !== q.slots[s].answer) wrong++; });
    setTimeout(() => ctx.done({ correct: wrong === 0, given: `${q.slots.length - wrong}/${q.slots.length} settings correct` }), ctx.fast ? 0 : 900);
  });
  return { hint() { if (over) return false; const s = pick.findIndex((p, i) => p !== q.slots[i].answer); if (s >= 0) { pick[s] = q.slots[s].answer; const c = box.querySelector(`.choices[data-s="${s}"]`); c.querySelectorAll('button').forEach((x, j) => x.setAttribute('aria-pressed', j === pick[s])); $(box, '#run').disabled = pick.some((p) => p === null); } return true; } };
};

R.multi = (q, box, ctx) => {
  const sel = new Set(); let over = false; const cur = q.cur || globalThis.__KV_CUR || '$';
  box.innerHTML = prompt(q) + `<div class="opts">${q.options.map((o, i) => { const t = typeof o === 'string' ? o : o.t; return `<button class="opt" data-i="${i}" aria-pressed="false"><span>${esc(t)}</span>${o.price !== undefined ? `<span class="tag">${cur}${o.price}</span>` : ''}</button>`; }).join('')}</div>${q.budget ? `<p class="center" id="tot"></p>` : ''}${btn('btn block', 'Check ✓', 'id="chk" style="margin-top:12px"')}`;
  const upd = () => { if (!q.budget) return; const tot = [...sel].reduce((s, i) => s + (q.options[i].price || 0), 0); const el = $(box, '#tot'); el.innerHTML = `Total <b>${cur}${tot}</b> of <b>${cur}${q.budget}</b> ${tot > q.budget ? '<span class="pill bad">over budget</span>' : '<span class="pill good">within budget</span>'}`; };
  upd();
  const bs = [...box.querySelectorAll('.opt')];
  bs.forEach((b) => b.addEventListener('click', () => { if (over) return; const i = +b.dataset.i; sel.has(i) ? sel.delete(i) : sel.add(i); b.classList.toggle('sel', sel.has(i)); b.setAttribute('aria-pressed', sel.has(i)); sound.tap(); upd(); }));
  $(box, '#chk').addEventListener('click', () => {
    if (over) return; over = true; const A = new Set(q.answers); const ok = A.size === sel.size && [...A].every((i) => sel.has(i)); $(box, '#chk').hidden = true;
    bs.forEach((b, i) => { b.disabled = true; b.classList.remove('sel'); if (A.has(i)) { b.classList.add('good'); b.querySelector('span').insertAdjacentText('beforeend', ' ✓'); } else if (sel.has(i)) b.classList.add('bad'); });
    ctx.done({ correct: ok, given: [...sel].map((i) => (q.options[i].t || q.options[i])).join(', ') });
  });
  return { hint() { if (over) return false; const i = q.answers.find((x) => !sel.has(x)); if (i !== undefined) { sel.add(i); bs[i].classList.add('sel'); bs[i].setAttribute('aria-pressed', true); upd(); } return true; } };
};

R.memory = (q, box, ctx) => {
  let over = false, phase = 'show', k = 0;
  const showHtml = () => `<div class="tiles" style="font-size:2rem">${q.show.map((s) => `<span class="tile" style="font-size:2rem;min-width:56px;min-height:56px">${esc(s)}</span>`).join('')}</div><div class="bar"><i id="cd" style="width:100%;transition:width ${q.showMs}ms linear"></i></div>`;
  const start = () => {
    phase = 'show'; box.innerHTML = prompt(q) + `<div id="mm">${showHtml()}</div>`; requestAnimationFrame(() => requestAnimationFrame(() => { const c = $(box, '#cd'); if (c) c.style.width = '0%'; }));
    clearTimeout(box._t); box._t = setTimeout(recall, ctx.fast ? 10 : q.showMs);
  };
  const recall = () => {
    if (over) return; phase = 'recall'; k = 0; const picked = [];
    $(box, '#mm').innerHTML = `<p class="muted center">Tap them in the order you saw (${q.show.length} items)</p><div class="line" id="pk" aria-live="polite">&nbsp;</div><div class="tiles" id="ch">${q.choices.map((c, i) => `<button class="btile" style="font-size:1.8rem" data-i="${i}">${esc(c)}</button>`).join('')}</div>`;
    box.querySelectorAll('#ch button').forEach((b) => b.addEventListener('click', () => {
      if (over) return; const v = q.choices[+b.dataset.i]; const need = q.show[k]; b.disabled = true; picked.push(v);
      $(box, '#pk').textContent = picked.join(' ');
      if (v !== need) { over = true; b.classList.add('bad'); box.querySelectorAll('#ch button').forEach((x) => (x.disabled = true)); ctx.done({ correct: false, given: picked.join(' '), reveal: q.show.join(' ') }); return; }
      b.classList.add('good'); sound.tap(); k++; if (k === q.show.length) { over = true; ctx.done({ correct: true, given: picked.join(' ') }); }
    }));
  };
  start();
  return { hint() { if (phase === 'recall' && !over) { const m = $(box, '#mm'); const prev = m.innerHTML; m.innerHTML = showHtml(); clearTimeout(box._t); box._t = setTimeout(() => { if (!over) { m.innerHTML = prev; recall(); } }, 1500 + q.show.length * 400); return true; } return false; } };
};

R.hunt = (q, box, ctx) => {
  const sel = new Set(); let over = false; const target = new Set(q.cells);
  box.innerHTML = prompt(q) + `<div class="hunt" style="grid-template-columns:repeat(${q.n},1fr)">${q.grid.map((c, i) => `<button data-i="${i}" aria-label="Letter ${esc(c)}">${esc(c)}</button>`).join('')}</div><p class="muted small center">Tap the letters that make the word, then check.</p>${btn('btn block', 'Check ✓', 'id="chk" disabled')}`;
  const bs = [...box.querySelectorAll('.hunt button')];
  bs.forEach((b) => b.addEventListener('click', () => { if (over) return; const i = +b.dataset.i; sel.has(i) ? sel.delete(i) : sel.add(i); b.classList.toggle('sel', sel.has(i)); sound.tap(); $(box, '#chk').disabled = sel.size < 2; }));
  $(box, '#chk').addEventListener('click', () => { if (over) return; over = true; const ok = sel.size === target.size && [...sel].every((i) => target.has(i)); $(box, '#chk').hidden = true; bs.forEach((b, i) => { b.disabled = true; b.classList.remove('sel'); if (target.has(i)) b.classList.add('good'); else if (sel.has(i)) b.classList.add('bad'); }); ctx.done({ correct: ok, given: [...sel].map((i) => q.grid[i]).join('') }); });
  return { hint() { if (over) return false; const f = q.cells[0]; sel.add(f); bs[f].classList.add('sel'); $(box, '#chk').disabled = sel.size < 2; return true; } };
};

const km = (a, b) => { const R = 6371, rad = Math.PI / 180; const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
export const mapSvg = () => `<svg viewBox="0 0 360 180" role="img" aria-label="Stylised world map: tap to place a pin"><rect width="360" height="180" fill="#a5d8ff"/>${[...Array(5)].map((_, i) => `<line x1="0" x2="360" y1="${(i + 1) * 30}" y2="${(i + 1) * 30}" stroke="#ffffff55" stroke-width=".5"/>`).join('')}${MAP.land.map((p, i) => `<polygon points="${p.map(([lon, lat]) => `${lon + 180},${90 - lat}`).join(' ')}" fill="${['#86d36b', '#d9f0a3', '#8ad07e', '#a0d96f', '#f2d479', '#9ad86a', '#f0c36c', '#f6c453', '#86d36b', '#f1a7c8', '#c3e88d', '#9be18e', '#f8fafc'][i % 13]}" stroke="#4d8f3c" stroke-width=".6"/>`).join('')}<g id="pins"></g></svg>`;
R.map = (q, box, ctx) => {
  let pin = null, over = false; box.innerHTML = prompt(q) + `<div class="mapwrap">${mapSvg()}</div><p class="muted small center" id="mi">Tap the map to place your pin</p>${btn('btn block', 'Confirm location 📍', 'id="chk" disabled')}`;
  const svg = $(box, 'svg'), pins = $(box, '#pins');
  const toGeo = (e) => { const r = svg.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * 360, y = ((e.clientY - r.top) / r.height) * 180; return { lon: x - 180, lat: 90 - y }; };
  const drawPin = (p, fill, r = 2.6) => `<circle cx="${p.lon + 180}" cy="${90 - p.lat}" r="${r}" fill="${fill}" stroke="#fff" stroke-width=".8"/>`;
  svg.addEventListener('click', (e) => { if (over) return; pin = toGeo(e); pins.innerHTML = drawPin(pin, '#7c3aed'); sound.tap(); $(box, '#chk').disabled = false; });
  $(box, '#chk').addEventListener('click', () => {
    if (over || !pin) return; over = true; $(box, '#chk').hidden = true; const d = Math.hypot(pin.lat - q.target.lat, (pin.lon - q.target.lon) * Math.cos(q.target.lat * Math.PI / 180)); const ok = d <= q.tol;
    pins.innerHTML = `<circle cx="${q.target.lon + 180}" cy="${90 - q.target.lat}" r="${q.tol}" fill="#22c55e33" stroke="#16a34a" stroke-width=".6"/>` + drawPin(q.target, '#16a34a') + drawPin(pin, ok ? '#16a34a' : '#dc2626');
    $(box, '#mi').textContent = `Your pin was about ${Math.round(km(pin, q.target) / 10) * 10} km away.`;
    ctx.done({ correct: ok, given: `${Math.round(km(pin, q.target))} km away` });
  });
  return { hint() { if (over) return false; pins.innerHTML = `<circle cx="${q.target.lon + 180}" cy="${90 - q.target.lat}" r="${q.tol * 2.2}" fill="#fde04755" stroke="#f59e0b" stroke-width=".6" stroke-dasharray="2"/>` + (pin ? drawPin(pin, '#7c3aed') : ''); return true; } };
};

R.lock = (q, box, ctx) => {
  const d = [0, 0, 0]; let tries = 0, over = false;
  box.innerHTML = prompt(q) + `<ul class="clues">${q.clues.map((c) => `<li>${esc(c)}</li>`).join('')}</ul><div class="dials" role="group" aria-label="Combination lock">${d.map((_, i) => `<div class="dial"><button class="btn small ghost" data-i="${i}" data-s="1" aria-label="Increase digit ${i + 1}">▲</button><b id="d${i}">0</b><button class="btn small ghost" data-i="${i}" data-s="-1" aria-label="Decrease digit ${i + 1}">▼</button></div>`).join('')}</div><p class="center muted small" id="tr">3 tries</p>${btn('btn block gold', '🔓 Try this code', 'id="chk"')}`;
  box.querySelectorAll('.dial .btn').forEach((b) => b.addEventListener('click', () => { if (over) return; const i = +b.dataset.i; d[i] = (d[i] + +b.dataset.s + 10) % 10; $(box, `#d${i}`).textContent = d[i]; sound.tap(); }));
  $(box, '#chk').addEventListener('click', () => {
    if (over) return; tries++; const code = d.join('');
    if (code === String(q.answer)) { over = true; $(box, '#chk').hidden = true; ctx.done({ correct: true, given: code }); }
    else if (tries >= 3) { over = true; $(box, '#chk').hidden = true; ctx.done({ correct: false, given: code, reveal: q.answer }); }
    else { sound.wrong(); haptic(40); $(box, '.dials').classList.add('shake'); setTimeout(() => $(box, '.dials')?.classList.remove('shake'), 300); $(box, '#tr').textContent = `Wrong code — ${3 - tries} ${3 - tries === 1 ? 'try' : 'tries'} left`; }
  });
  return { hint() { if (over) return false; const i = d.findIndex((x, k) => String(x) !== q.answer[k]); if (i >= 0) { d[i] = +q.answer[i]; $(box, `#d${i}`).textContent = d[i]; } return true; } };
};

export function mountQuestion(q, box, ctx) {
  const r = R[q.type]; if (!r) { box.innerHTML = `<p>Unsupported question type “${esc(q.type)}”.</p>`; setTimeout(() => ctx.done({ correct: true, given: 'skipped' }), 0); return { hint: () => false }; }
  let finished = false; const wrapped = { ...ctx, done: (res) => { if (finished) return; finished = true; ctx.done(res); } };
  return r(q, box, wrapped);
}
export const correctAnswerText = (q) => {
  switch (q.type) {
    case 'mcq': return q.options[q.answer]; case 'input': return String(q.answer); case 'order': return q.items.join(q.tile === 'letter' ? '' : ' → ');
    case 'match': return q.pairs.map((p) => `${p[0]} = ${p[1]}`).join('; '); case 'sort': return q.items.map((i) => `${i[0]} → ${q.buckets[i[1]]}`).join('; ');
    case 'lab': return q.slots.map((s) => `${s.label}: ${s.options[s.answer]}`).join('; '); case 'multi': return q.answers.map((i) => q.options[i].t || q.options[i]).join(', ');
    case 'memory': return q.show.join(' '); case 'hunt': return q.word; case 'map': return q.label || 'See map'; case 'lock': return String(q.answer); default: return '';
  }
};
