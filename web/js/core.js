/* =========================================================
   State — lives in the server's SQLite database. S is a local copy,
   refreshed from /api/state after every change.
   ========================================================= */
const PALETTE = ['#FF7A59', '#D7FF3D', '#8B7BFF', '#7CF3FF', '#FFD166', '#FF8FD1', '#6AF0A8', '#FFA94D'];
const EMPTY = () => ({ cats: [], exps: [], incs: [], rules: [] });
let S = EMPTY();
let ME = null;               // the signed-in user, or null
let onAuthLost = () => {};   // set by app.js: show the login screen when a session expires

class ApiError extends Error { constructor(msg, status = 0) { super(msg); this.status = status; } }
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch(url, opts); } catch (e) { throw new ApiError('Can\'t reach the Ledger server. Is it running?'); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const d = data && data.detail;
    if (res.status === 401 && !url.startsWith('/api/auth/')) onAuthLost();
    throw new ApiError(typeof d === 'string' ? d : Array.isArray(d) ? d.map(x => x.msg.replace(/^Value error, /, '')).join(' ') : `Something went wrong (${res.status}).`, res.status);
  }
  return data;
}
async function load() { S = await api('GET', '/api/state'); }

const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FINE = matchMedia('(hover: hover) and (pointer: fine)').matches;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = n => (n < 0 ? '−$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US');
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dim = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const monthName = (ym, short) => parse(ym + '-01').toLocaleString('en-US', { month: short ? 'short' : 'long', year: 'numeric' });
const sum = a => a.reduce((t, e) => t + e.amount, 0);
const cat = id => S.cats.find(c => c.id === id) || { name: 'Uncategorised', color: '#6E6E7C', budget: 0 };
const FREQ = { weekly: 'week', monthly: 'month', yearly: 'year' };
const byName = (a, b) => a.name.localeCompare(b.name);
function niceDate(s) {
  const t = today(), y = ymd(new Date(Date.now() - 864e5));
  if (s === t) return 'Today'; if (s === y) return 'Yesterday';
  const d = parse(s), sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
const ICON = {
  edit: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  del: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg>',
  repeat: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
  clip: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/></svg>',
  pause: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 6v12M15 6v12"/></svg>',
  play: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
  plus: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

let view = 'overview', editExp = null, editCat = null, editInc = null, editRule = null, pickedCat = null, pickedColor = PALETTE[0];
let eTags = [], eRepeat = '', iRepeat = '', rKind = 'expense', eFile = null, eDropReceipt = false;
let filt = { q: '', cat: 0 }, sumMonth = null, booted = false;

/* =========================================================
   Motion helpers
   ========================================================= */
function odo(el, n) {
  const str = money(n), cut = str.indexOf('.');
  const sig = str.replace(/\d/g, '0');
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.innerHTML = '<span aria-hidden="true" style="display:flex">' + [...str].map((ch, i) => {
      const dimc = i >= cut ? ' dim' : '';
      return /\d/.test(ch)
        ? `<span class="od-col${dimc}"><span class="od-strip">${[...'0123456789'].map(d => `<span>${d}</span>`).join('')}</span></span>`
        : `<span class="od-sep${dimc}">${ch}</span>`;
    }).join('') + '</span>';
    void el.offsetHeight;
  }
  let k = 0;
  const strips = el.querySelectorAll('.od-strip');
  [...str].forEach(ch => {
    if (!/\d/.test(ch)) return;
    const s = strips[k];
    s.style.transitionDelay = RM ? '0ms' : (k * 45) + 'ms';
    s.style.transform = `translateY(${-ch * 10}%)`;
    k++;
  });
  el.setAttribute('aria-label', str);
}

function tween(el, to, fmt, dur = 1200) {
  const from = parseFloat(el.dataset.v || 0);
  el.dataset.v = to;
  if (RM || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = t => {
    const p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(2, -10 * p);
    el.textContent = fmt(from + (to - from) * (p === 1 ? 1 : e));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function stagger(el) {
  if (RM) return;
  [...el.children].forEach((c, i) => c.style.setProperty('--i', Math.min(i, 14)));
  el.classList.remove('stagger'); void el.offsetWidth; el.classList.add('stagger');
  clearTimeout(el._st); el._st = setTimeout(() => el.classList.remove('stagger'), 1400);
}

// Magnetic buttons + 3D tilt cards + cursor spotlight
if (FINE && !RM) {
  let raf = 0, mx = 0, my = 0;
  addEventListener('pointermove', e => {
    mx = e.clientX; my = e.clientY;
    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      $('spot').style.setProperty('--cx', mx + 'px'); $('spot').style.setProperty('--cy', my + 'px');
    });
    const m = e.target.closest && e.target.closest('.mag');
    document.querySelectorAll('.mag').forEach(b => {
      if (b !== m) { b.style.setProperty('--tx', '0px'); b.style.setProperty('--ty', '0px'); }
    });
    if (m) {
      const r = m.getBoundingClientRect();
      m.style.setProperty('--tx', ((e.clientX - r.left - r.width / 2) * 0.22) + 'px');
      m.style.setProperty('--ty', ((e.clientY - r.top - r.height / 2) * 0.32) + 'px');
    }
    const t = e.target.closest && e.target.closest('.tilt');
    if (t) {
      const r = t.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      t.style.setProperty('--ry', ((px - .5) * 14) + 'deg'); t.style.setProperty('--rx', ((.5 - py) * 12) + 'deg');
      t.style.setProperty('--mx', px * 100 + '%'); t.style.setProperty('--my', py * 100 + '%');
    }
  }, { passive: true });
  document.addEventListener('pointerout', e => {
    const t = e.target.closest && e.target.closest('.tilt');
    if (t && !t.contains(e.relatedTarget)) { t.style.setProperty('--rx', '0deg'); t.style.setProperty('--ry', '0deg'); }
  });
}

function toast(t) {
  $('toastTxt').textContent = t; $('toast').classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => $('toast').classList.remove('show'), 2400);
}

function burst(x, y, color, n = 18) {
  if (RM) return;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i'); p.className = 'spark-p'; p.style.setProperty('--c', color);
    document.body.appendChild(p);
    const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 90, s = .5 + Math.random();
    p.animate([
      { transform: `translate(${x}px,${y}px) scale(${s})`, opacity: 1 },
      { transform: `translate(${x + Math.cos(a) * d}px,${y + Math.sin(a) * d - 20}px) scale(0)`, opacity: 0 },
    ], { duration: 600 + Math.random() * 500, easing: 'cubic-bezier(.16,1,.3,1)' }).onfinish = () => p.remove();
  }
}

function flyCoin(from, color, done) {
  const st = $('orbStage').getBoundingClientRect();
  const to = { x: st.left + st.width / 2, y: st.top + st.height / 2 };
  if (RM || st.bottom < 0 || st.top > innerHeight) return done();
  const c = document.createElement('div'); c.className = 'coin'; c.style.setProperty('--c', color);
  document.body.appendChild(c);
  const ctrl = { x: (from.x + to.x) / 2 + (to.x > from.x ? -60 : 60), y: Math.min(from.y, to.y) - 260 };
  const frames = [];
  for (let i = 0; i <= 30; i++) {
    const t = i / 30, u = 1 - t;
    const x = u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x;
    const y = u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y;
    const s = t < .15 ? .4 + t * 5 : 1.15 - t * .7;
    frames.push({ transform: `translate(${x}px,${y}px) scale(${s}) rotateY(${t * 900}deg)`, opacity: t > .92 ? (1 - t) * 12 : 1 });
  }
  c.animate(frames, { duration: 950, easing: 'cubic-bezier(.45,0,.25,1)' }).onfinish = () => {
    c.remove(); burst(to.x, to.y, color, 26); done();
  };
}

