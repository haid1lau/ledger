/* =========================================================
   Rendering
   ========================================================= */
function monthData(ym) {
  const ex = S.exps.filter(e => e.date.startsWith(ym));
  const per = S.cats.map(c => ({ c, spent: sum(ex.filter(e => e.cat === c.id)) }));
  const inc = S.incs.filter(e => e.date.startsWith(ym));
  return { ex, spent: sum(ex), per, inc, earned: sum(inc) };
}

function banner(html) {
  let b = $('banner');
  if (!html) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('div'); b.id = 'banner'; b.className = 'alert banner'; b.setAttribute('role', 'alert'); document.querySelector('main').prepend(b); }
  b.innerHTML = html;
}

// Each section draws on its own, so one failing part can't leave the rest of the app empty.
function render() {
  const parts = [renderOverview, renderExpenses, renderIncome, renderBudgets, renderRules, renderSummary, renderCatPick,
    () => { $('tagList').innerHTML = allTags().map(t => `<option value="${esc(t)}">`).join(''); }];
  const failed = parts.filter(fn => { try { fn(); return false; } catch (err) { console.error(err); return true; } });
  if (failed.length) banner('Part of the page didn\'t draw. Your data is safe on the server. Try a hard refresh (<b>⌘⇧R</b>, or <b>Ctrl+Shift+R</b>).');
}

function renderOverview() {
  const ym = today().slice(0, 7), d = new Date().getDate(), days = dim(ym);
  const { ex, spent, per, earned } = monthData(ym);
  const budget = S.cats.reduce((a, c) => a + c.budget, 0), pct = budget > 0 ? spent / budget : 0;
  $('monthChip').textContent = `${monthName(ym)} · Day ${d} of ${days}`;
  odo($('heroNum'), spent);
  const chip = $('pctChip');
  chip.textContent = budget > 0 ? `${(pct * 100).toFixed(1)}% of ${money0(budget)}` : 'No budgets set';
  chip.classList.toggle('over', pct > 1);
  const left = budget - spent, dl = days - d + 1;
  $('heroSub').textContent = budget > 0
    ? (left >= 0 ? `${money(left)} left · about ${money0(left / dl)} a day for ${dl} day${dl > 1 ? 's' : ''}` : `${money(-left)} over budget`)
    : (S.cats.length ? 'Give categories a budget to track your pace' : 'Create a category to get started');
  $('meterFill').style.width = Math.min(pct, 1) * 100 + '%';
  $('meterFill').classList.toggle('over', pct > 1);
  $('meterPace').style.left = (d / days * 100) + '%';
  $('paceLbl').textContent = `even pace · ${Math.round(d / days * 100)}%`;
  $('budgetLbl').textContent = money0(budget);
  Orb.set(pct, per.filter(p => p.spent > 0).map(p => ({ name: p.c.name, amt: p.spent, color: p.c.color, share: spent ? p.spent / spent : 0 })));

  // stats with 14-day sparks
  const last = [...Array(14)].map((_, i) => ymd(new Date(Date.now() - (13 - i) * 864e5)));
  const daily = last.map(s => sum(S.exps.filter(e => e.date === s)));
  const upTo = (list, i) => sum(list.filter(e => e.date.startsWith(ym) && e.date <= last[i]));
  const dayTotals = {}; ex.forEach(e => dayTotals[e.date] = (dayTotals[e.date] || 0) + e.amount);
  const big = Object.entries(dayTotals).sort((a, b) => b[1] - a[1])[0];
  const spark = (vals, hiIdx) => { const m = Math.max(...vals, 1); return `<div class="spark">${vals.map((v, j) => `<i style="--j:${j};height:${Math.max(8, v / m * 100)}%" class="${j === hiIdx ? 'hi' : ''}"></i>`).join('')}</div>`; };
  const maxIdx = daily.indexOf(Math.max(...daily));
  const cards = [
    ['Remaining', budget - spent, money, budget > 0 ? `of ${money0(budget)}` : 'no budget', spark(daily.map((_, i) => Math.max(0, budget - sum(S.exps.filter(e => e.date.startsWith(ym) && e.date <= last[i])))), 13)],
    ['Daily average', spent / d, money, `${d} day${d > 1 ? 's' : ''} in`, spark(daily, 13)],
    ['Net saved', earned - spent, money, earned > 0 ? `${Math.round((earned - spent) / earned * 100)}% of income` : 'no income yet this month', spark(last.map((_, i) => Math.max(0, upTo(S.incs, i) - upTo(S.exps, i))), 13)],
    ['Biggest day', big ? big[1] : 0, money, big ? niceDate(big[0]) : '—', spark(daily, maxIdx)],
  ];
  const st = $('stats');
  if (st.children.length !== 4) {
    st.innerHTML = cards.map((c, i) => `<div class="stat tilt" data-in style="--i:${i + 5}"><div class="stat-top"><span>${c[0]}</span><span class="mono"></span></div><div class="stat-num"></div><div class="sp"></div></div>`).join('');
  }
  cards.forEach((c, i) => {
    const el = st.children[i];
    el.querySelector('.mono').textContent = c[3];
    tween(el.querySelector('.stat-num'), c[1], c[2]);
    const sp = el.querySelector('.sp'); if (sp.dataset.k !== c[4]) { sp.dataset.k = c[4]; sp.innerHTML = c[4]; }
  });

  // recent
  const sorted = S.exps.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  $('viewAll').textContent = sorted.length ? `View all ${sorted.length}` : '';
  $('recent').innerHTML = !S.cats.length
    ? `<div class="welcome"><p>Ledger tracks spending against a monthly budget per category. Start with a category, or load a few months of sample data to see everything move.</p><div class="row"><button class="btn primary mag" data-act="newCat">Create a category</button><button class="btn ghost" data-act="sample">Load sample data</button></div></div>`
    : sorted.length
      ? sorted.slice(0, 6).map(rowHTML).join('')
      : `<div class="welcome"><p>No expenses yet. Press <b>N</b> anywhere to log one.</p><div class="row"><button class="btn primary mag" data-act="newExp">Log an expense</button></div></div>`;

  // where it went
  const used = per.filter(p => p.spent > 0).sort((a, b) => b.spent - a.spent);
  const overs = per.filter(p => p.c.budget > 0 && p.spent > p.c.budget);
  $('where').innerHTML = used.length
    ? `<div class="stack">${used.map((p, j) => `<i style="--j:${j};flex:${p.spent};background:${p.c.color}"></i>`).join('')}</div>
       <div class="legend">${used.map(p => `<div class="lg" style="--c:${p.c.color}"><span class="sw"></span><span class="n">${esc(p.c.name)}</span><span class="p">${(p.spent / spent * 100).toFixed(1)}%</span><span class="a">${money(p.spent)}</span></div>`).join('')}</div>
       ${overs.length
         ? overs.map(p => `<div class="alert">${esc(p.c.name)} is ${money(p.spent - p.c.budget)} over budget${dl > 1 ? ` with ${dl} days to go` : ''}.</div>`).join('')
         : budget > 0 ? `<div class="ok-note">Every category is within budget.</div>` : ''}`
    : `<p class="empty">Nothing spent in ${monthName(ym)} yet.</p>`;
}

const allTags = () => [...new Set(S.exps.flatMap(e => e.tags))].sort();
const tagsHTML = tags => tags.map(t => `<button type="button" class="tchip" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
const metaHTML = e => (e.rule ? `<span class="meta" title="Added by a recurring rule">${ICON.repeat}</span>` : '')
  + (e.receipt ? `<a class="meta" href="${esc(e.receipt)}" target="_blank" rel="noopener" title="View receipt" aria-label="View receipt">${ICON.clip}</a>` : '');
const nameHTML = e => e.note ? esc(e.note) : '<span style="color:var(--muted)">Untitled</span>';

function rowHTML(e) {
  const c = cat(e.cat);
  return `<div class="erow" style="--c:${c.color}"><div class="av">${esc(c.name[0] || '?')}</div><div class="e-main"><span class="e-name">${nameHTML(e)}${metaHTML(e)}</span><span class="e-sub">${esc(c.name)} · ${niceDate(e.date)}</span></div><span class="e-amt">${money(e.amount)}</span></div>`;
}

function renderExpenses() {
  const cats = S.cats.slice().sort(byName);
  if (filt.cat && !S.cats.some(c => c.id === filt.cat)) filt.cat = 0;
  $('filters').innerHTML = [{ id: 0, name: 'All', color: '' }, ...cats].map(c =>
    `<button class="fchip" data-fcat="${c.id}" aria-pressed="${filt.cat === c.id}" ${c.color ? `style="--c:${c.color}"` : ''}>${c.color ? '<span class="sw"></span>' : ''}${esc(c.name)}</button>`).join('');
  const words = filt.q.toLowerCase().split(/\s+/).filter(Boolean);
  const tagQ = words.filter(w => w.startsWith('#')).map(w => w.slice(1)).filter(Boolean), q = words.filter(w => !w.startsWith('#')).join(' ');
  const list = S.exps.filter(e => (!filt.cat || e.cat === filt.cat)
      && tagQ.every(t => e.tags.includes(t))
      && (!q || (e.note || '').toLowerCase().includes(q) || cat(e.cat).name.toLowerCase().includes(q) || e.tags.some(t => t.includes(q))))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  if (!list.length) {
    $('expList').innerHTML = `<p class="empty">${S.exps.length ? 'No expenses match.' : 'No expenses yet.'}</p>`; return;
  }
  const groups = [];
  list.forEach(e => { const g = groups[groups.length - 1]; if (g && g.date === e.date) g.items.push(e); else groups.push({ date: e.date, items: [e] }); });
  $('expList').innerHTML = groups.slice(0, 60).map(g => `<div class="day"><div class="day-h"><span>${niceDate(g.date)}</span><span>${money(sum(g.items))}</span></div>${g.items.map(e => {
    const c = cat(e.cat);
    return `<div class="erow full" data-row="${e.id}" style="--c:${c.color}"><div class="av">${esc(c.name[0] || '?')}</div><div class="e-main"><span class="e-name">${nameHTML(e)}${metaHTML(e)}</span><span class="e-sub tag"><span class="sw"></span>${esc(c.name)}${tagsHTML(e.tags)}</span></div><div class="acts"><button class="icon-btn" data-act="editExp" data-id="${e.id}" aria-label="Edit ${esc(e.note || 'expense')}">${ICON.edit}</button><button class="icon-btn" data-act="delExp" data-id="${e.id}" aria-label="Delete ${esc(e.note || 'expense')}">${ICON.del}</button></div><span class="e-amt">${money(e.amount)}</span></div>`;
  }).join('')}</div>`).join('');
}

function renderBudgets() {
  const ym = today().slice(0, 7), { per } = monthData(ym), C = 2 * Math.PI * 52;
  const cats = per.slice().sort((a, b) => byName(a.c, b.c));
  $('bgrid').innerHTML = cats.map(({ c, spent }) => {
    const r = c.budget > 0 ? spent / c.budget : 0, over = c.budget > 0 && spent > c.budget;
    const n = S.exps.filter(e => e.cat === c.id).length;
    return `<article class="bcard tilt${over ? ' over' : ''}" style="--c:${over ? '#FF7A59' : c.color}">
      <div class="bhead"><div style="min-width:0"><div class="bname">${esc(c.name)}</div><div class="bsub">${n} expense${n === 1 ? '' : 's'} all time</div></div>
        <div class="bacts"><button class="icon-btn" data-act="editCat" data-id="${c.id}" aria-label="Edit ${esc(c.name)}">${ICON.edit}</button><button class="icon-btn" data-act="delCat" data-id="${c.id}" aria-label="Delete ${esc(c.name)}">${ICON.del}</button></div></div>
      <div class="bbody"><div class="ring"><svg width="120" height="120" viewBox="0 0 120 120"><circle class="trk" cx="60" cy="60" r="52" fill="none" stroke-width="10"/><circle class="val" cx="60" cy="60" r="52" fill="none" stroke-width="10" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-off="${C * (1 - Math.min(r, 1))}"/></svg>
        <div class="ring-c"><b>${c.budget > 0 ? Math.round(r * 100) + '%' : '—'}</b><span>${c.budget > 0 ? 'used' : 'no budget'}</span></div></div>
        <div class="bnums"><span class="big">${money(spent)}</span><span class="of">of ${money0(c.budget)} this month</span><span class="st">${c.budget > 0 ? (over ? `Over by ${money(spent - c.budget)}` : `${money(c.budget - spent)} to spare`) : 'Set a budget to track'}</span></div></div>
    </article>`;
  }).join('') + `<button class="newcard" data-act="newCat"><span class="plus">${ICON.plus}</span>New category</button>`;
  requestAnimationFrame(() => requestAnimationFrame(() => $('bgrid').querySelectorAll('.val').forEach(v => v.style.strokeDashoffset = v.dataset.off)));
}

function renderSummary() {
  const cur = today().slice(0, 7);
  const months = [...new Set([cur, ...S.exps.map(e => e.date.slice(0, 7))])].sort().reverse();
  if (!sumMonth || !months.includes(sumMonth)) sumMonth = cur;
  $('months').innerHTML = months.map(m => `<button class="mbtn" data-month="${m}" aria-pressed="${m === sumMonth}">${monthName(m, true)}</button>`).join('');
  const { ex, spent, per, inc, earned } = monthData(sumMonth), budget = S.cats.reduce((a, c) => a + c.budget, 0);
  const days = dim(sumMonth), isCur = sumMonth === cur;
  const nDays = isCur ? new Date().getDate() : days;
  $('sumTop').innerHTML = `
    <div class="sum-k tilt"><span>Total spent</span><b>${money(spent)}</b><span>${budget > 0 ? `${Math.round(spent / budget * 100)}% of ${money0(budget)} budget` : 'no budget set'}</span></div>
    <div class="sum-k tilt"><span>Income</span><b>${money(earned)}</b><span>${inc.length ? `${inc.length} payment${inc.length > 1 ? 's' : ''}` : 'none logged'}</span></div>
    <div class="sum-k tilt"><span>Net saved</span><b class="${earned - spent < 0 ? 'neg' : ''}">${money(earned - spent)}</b><span>${earned > 0 ? `${Math.round((earned - spent) / earned * 100)}% savings rate` : 'log income to see this'}</span></div>
    <div class="sum-k tilt"><span>Per day</span><b>${money(spent / nDays)}</b><span>${ex.length} expense${ex.length === 1 ? '' : 's'} over ${nDays} day${nDays > 1 ? 's' : ''}</span></div>`;
  const tot = [...Array(days)].map((_, i) => sum(ex.filter(e => +e.date.slice(8) === i + 1)));
  const max = Math.max(...tot, 1), td = new Date().getDate();
  $('dailyMax').textContent = `peak ${money0(max === 1 && !tot.some(Boolean) ? 0 : max)}`;
  $('daily').innerHTML = tot.map((v, i) => {
    const h = Math.max(3, v / max * 100);
    return `<div class="dbar${v ? ' has' : ''}${isCur && i + 1 === td ? ' today' : ''}" style="--j:${i};--h:${h}%"><i style="height:${h}%"></i><span class="tip">${parse(sumMonth + '-' + pad(i + 1)).toLocaleString('en-US', { month: 'short', day: 'numeric' })} · ${money(v)}</span></div>`;
  }).join('');
  $('daxis').innerHTML = `<span>1</span><span>${Math.ceil(days / 2)}</span><span>${days}</span>`;
  const rows = per.slice().sort((a, b) => b.spent - a.spent || byName(a.c, b.c));
  $('sumBars').innerHTML = rows.length ? rows.map(({ c, spent: sp }) => {
    const over = c.budget > 0 && sp > c.budget, w = c.budget > 0 ? Math.min(sp / c.budget, 1) * 100 : (sp > 0 ? 100 : 0);
    return `<div class="hbar" style="--c:${c.color}"><span class="n"><span class="sw"></span>${esc(c.name)}</span><div class="htrack${over ? ' over' : ''}"><i data-w="${w}"></i></div><span class="a">${money(sp)} <small>/ ${money0(c.budget)}</small>${over ? `<span class="over-t">Over by ${money(sp - c.budget)}</span>` : ''}</span></div>`;
  }).join('') : '<p class="empty">No categories yet.</p>';
  const tagTot = {};
  ex.forEach(e => e.tags.forEach(t => { tagTot[t] = tagTot[t] || { amt: 0, n: 0 }; tagTot[t].amt += e.amount; tagTot[t].n++; }));
  const tags = Object.entries(tagTot).sort((a, b) => b[1].amt - a[1].amt), tmax = tags.length ? tags[0][1].amt : 1;
  $('sumTags').innerHTML = tags.length ? tags.map(([t, v]) =>
    `<div class="hbar" style="--c:var(--acc)"><span class="n"><button type="button" class="tchip big" data-tag="${esc(t)}">#${esc(t)}</button></span><div class="htrack"><i data-w="${v.amt / tmax * 100}"></i></div><span class="a">${money(v.amt)} <small>· ${v.n}</small></span></div>`).join('')
    : `<p class="empty">No tagged expenses in ${monthName(sumMonth)}. Add tags like <b>#work</b> or <b>#trip</b> when you log an expense.</p>`;
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('#sumBars i[data-w],#sumTags i[data-w]').forEach(i => i.style.width = i.dataset.w + '%')));
}

const monthKeys = n => [...Array(n)].map((_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (n - 1 - i)); return ymd(d).slice(0, 7); });

function renderIncome() {
  const ym = today().slice(0, 7), { spent, earned } = monthData(ym);
  const months = monthKeys(6).map(m => ({ m, ...monthData(m) }));
  const withInc = months.filter(x => x.earned > 0), avg = withInc.length ? sum(withInc.map(x => ({ amount: x.earned }))) / withInc.length : 0;
  $('incTop').innerHTML = `
    <div class="sum-k tilt"><span>Income this month</span><b>${money(earned)}</b><span>${monthName(ym)}</span></div>
    <div class="sum-k tilt"><span>Spent this month</span><b>${money(spent)}</b><span>${earned > 0 ? `${Math.round(spent / earned * 100)}% of income` : '—'}</span></div>
    <div class="sum-k tilt"><span>Net saved</span><b class="${earned - spent < 0 ? 'neg' : ''}">${money(earned - spent)}</b><span>${earned > 0 ? `${Math.round((earned - spent) / earned * 100)}% savings rate` : 'log income to see this'}</span></div>
    <div class="sum-k tilt"><span>Average income</span><b>${money(avg)}</b><span>${withInc.length ? `over ${withInc.length} month${withInc.length > 1 ? 's' : ''} with income` : 'last 6 months'}</span></div>`;

  const max = Math.max(1, ...months.map(x => Math.max(x.earned, x.spent)));
  $('netBars').innerHTML = months.map((x, j) => {
    const net = x.earned - x.spent;
    return `<div class="nb"><div class="nb-bars"><i class="in" style="--j:${j};height:${x.earned / max * 100}%" title="Income ${money(x.earned)}"></i><i class="out" style="--j:${j};height:${x.spent / max * 100}%" title="Spent ${money(x.spent)}"></i></div>
      <b class="${net < 0 ? 'neg' : ''}">${x.earned || x.spent ? (net < 0 ? '' : '+') + money0(net) : '—'}</b><span>${monthName(x.m, true)}</span></div>`;
  }).join('') + `<div class="nb-key"><span><i class="in"></i>Income</span><span><i class="out"></i>Spent</span></div>`;

  const list = S.incs.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  if (!list.length) {
    $('incList').innerHTML = `<div class="panel"><div class="welcome"><p>Log your pay and other income to see how much you keep each month. Set your salary to repeat monthly so you only enter it once.</p><div class="row"><button class="btn primary mag" data-act="newInc">Add income</button></div></div></div>`;
    return;
  }
  const groups = [];
  list.forEach(e => { const m = e.date.slice(0, 7), g = groups[groups.length - 1]; if (g && g.m === m) g.items.push(e); else groups.push({ m, items: [e] }); });
  $('incList').innerHTML = groups.slice(0, 24).map(g => `<div class="day"><div class="day-h"><span>${monthName(g.m)}</span><span>${money(sum(g.items))}</span></div>${g.items.map(e =>
    `<div class="erow full" style="--c:var(--acc)"><div class="av">+</div><div class="e-main"><span class="e-name">${nameHTML(e)}${e.rule ? `<span class="meta" title="Added by a recurring rule">${ICON.repeat}</span>` : ''}</span><span class="e-sub">${niceDate(e.date)}</span></div><div class="acts"><button class="icon-btn" data-act="editInc" data-id="${e.id}" aria-label="Edit ${esc(e.note || 'income')}">${ICON.edit}</button><button class="icon-btn" data-act="delInc" data-id="${e.id}" aria-label="Delete ${esc(e.note || 'income')}">${ICON.del}</button></div><span class="e-amt pos">+${money(e.amount)}</span></div>`).join('')}</div>`).join('');
}

const perMonth = r => r.freq === 'weekly' ? r.amount * 52 / 12 : r.freq === 'yearly' ? r.amount / 12 : r.amount;
function renderRules() {
  const rules = S.rules.slice().sort((a, b) => (b.active - a.active) || a.next.localeCompare(b.next));
  const out = sum(rules.filter(r => r.active && r.kind === 'expense').map(r => ({ amount: perMonth(r) })));
  const inn = sum(rules.filter(r => r.active && r.kind === 'income').map(r => ({ amount: perMonth(r) })));
  $('ruleList').innerHTML = rules.length
    ? rules.map(r => {
      const c = r.kind === 'expense' ? cat(r.cat) : { name: 'Income', color: 'var(--acc)' };
      return `<div class="erow full${r.active ? '' : ' paused'}" style="--c:${c.color}"><div class="av">${ICON.repeat}</div><div class="e-main"><span class="e-name">${nameHTML(r)}</span><span class="e-sub tag"><span class="sw"></span>${esc(c.name)} · every ${FREQ[r.freq]} · ${r.active ? `next ${niceDate(r.next)}` : 'paused'}</span></div>
        <div class="acts"><button class="icon-btn" data-act="toggleRule" data-id="${r.id}" aria-label="${r.active ? 'Pause' : 'Resume'} ${esc(r.note || 'rule')}">${r.active ? ICON.pause : ICON.play}</button><button class="icon-btn" data-act="editRule" data-id="${r.id}" aria-label="Edit ${esc(r.note || 'rule')}">${ICON.edit}</button><button class="icon-btn" data-act="delRule" data-id="${r.id}" aria-label="Delete ${esc(r.note || 'rule')}">${ICON.del}</button></div>
        <span class="e-amt${r.kind === 'income' ? ' pos' : ''}">${r.kind === 'income' ? '+' : ''}${money(r.amount)}</span></div>`;
    }).join('') + `<div class="kv rule-tot"><span>Committed each month</span><span>${money(out)} out${inn ? ` · ${money(inn)} in` : ''}</span></div>`
    : '<p class="empty">Nothing recurring yet. You can also set an expense to repeat when you log it.</p>';
}

/* =========================================================
   Navigation
   ========================================================= */
function moveInd() {
  const b = document.querySelector(`.nav-btn[data-view="${view}"]`);
  if (!b) return;
  $('navInd').style.width = b.offsetWidth + 'px';
  $('navInd').style.transform = `translateX(${b.offsetLeft}px)`;
}
function showView(name, instant) {
  document.querySelectorAll('.nav-btn').forEach(b => b.setAttribute('aria-selected', b.dataset.view === name));
  const prev = $('v-' + view), next = $('v-' + name);
  const enter = () => {
    document.querySelectorAll('.view').forEach(v => { v.hidden = v !== next; v.classList.remove('leaving', 'entering'); });
    next.querySelectorAll('[data-in]').forEach((el, i) => el.style.setProperty('--i', el.style.getPropertyValue('--i') || i));
    if (!RM) { void next.offsetWidth; next.classList.add('entering'); setTimeout(() => next.classList.remove('entering'), 1600); }
    if (name === 'budgets') { renderBudgets(); $('bgrid').querySelectorAll('.bcard.over').forEach(c => c.classList.add('shake')); }
    if (name === 'summary') renderSummary();
    if (name === 'ask') Ask.shown();
  };
  view = name; moveInd();
  if (instant || RM || prev === next) return enter();
  prev.classList.add('leaving'); setTimeout(enter, 200);
  scrollTo({ top: 0, behavior: 'smooth' });
}

/* =========================================================
   Sheets
   ========================================================= */
let lastFocus = null;
function openSheet(id, focusEl) {
  lastFocus = document.activeElement;
  const s = $(id); s.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => s.classList.add('open')));
  setTimeout(() => focusEl && focusEl.focus(), 60);
}
function closeSheet(id, keepFocus) {
  const s = $(id); if (s.hidden) return;
  s.classList.remove('open');
  setTimeout(() => { s.hidden = true; }, RM ? 0 : 380);
  if (!keepFocus && lastFocus && lastFocus.focus) lastFocus.focus();
}
const openSheetId = () => ['pal', 'sheetExp', 'sheetCat', 'sheetInc', 'sheetRule', 'sheetData', 'sheetAcct'].find(id => !$(id).hidden && $(id).classList.contains('open'));

function renderCatPick() {
  const ym = today().slice(0, 7), { per } = monthData(ym);
  const cats = per.slice().sort((a, b) => byName(a.c, b.c));
  if (!cats.some(p => p.c.id === pickedCat)) pickedCat = cats.length ? cats[0].c.id : null;
  $('catPick').innerHTML = cats.map(({ c, spent }) => {
    const left = c.budget - spent;
    return `<button type="button" class="cp" role="radio" aria-checked="${c.id === pickedCat}" data-pick="${c.id}" style="--c:${c.color}"><span class="ball"></span><span class="t"><span>${esc(c.name)}</span><span>${c.budget > 0 ? (left < 0 ? `${money0(-left)} over` : `${money0(left)} left`) : 'no budget'}</span></span></button>`;
  }).join('');
  $('eHint').hidden = cats.length > 0;
  $('eSave').disabled = !cats.length;
  renderImpact();
}

function renderImpact() {
  const amt = parseFloat($('eAmt').value) || 0, c = S.cats.find(x => x.id === pickedCat);
  if (!c) { $('impact').innerHTML = '<span class="eyebrow">Live impact</span><p class="hint">Pick a category to see how this lands.</p>'; return; }
  const date = $('eDate').value || today(), ym = date.slice(0, 7);
  const prev = editExp ? S.exps.find(e => e.id === editExp) : null;
  const base = sum(S.exps.filter(e => e.cat === c.id && e.date.startsWith(ym) && e.id !== editExp));
  const after = base + amt, r = c.budget > 0 ? after / c.budget : 0, CC = 2 * Math.PI * 40;
  const monthAfter = sum(S.exps.filter(e => e.date.startsWith(ym) && e.id !== editExp)) + amt;
  const budget = S.cats.reduce((a, x) => a + x.budget, 0);
  const isCur = ym === today().slice(0, 7), dl = isCur ? dim(ym) - new Date().getDate() + 1 : 0;
  const over = c.budget > 0 && after > c.budget;
  const note = c.budget > 0
    ? (over ? `This puts ${esc(c.name)} ${money(after - c.budget)} over its ${money0(c.budget)} budget.` : `${money(c.budget - after)} of ${money0(c.budget)} still free after this.`)
    : `${esc(c.name)} has no budget yet.`;
  const ring = $('impRing');
  const html = `<span class="eyebrow">Live impact · ${monthName(ym)}</span>
    <div class="imp-row"><div class="imp-ring"><svg width="96" height="96" viewBox="0 0 96 96"><circle cx="48" cy="48" r="40" fill="none" stroke="#1F1F2A" stroke-width="9"/><circle class="val" id="impRing" cx="48" cy="48" r="40" fill="none" stroke="${over ? '#FF7A59' : c.color}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${CC}" stroke-dashoffset="${ring ? ring.style.strokeDashoffset || CC : CC}"/></svg><b>${c.budget > 0 ? Math.round(r * 100) + '%' : '—'}</b></div>
      <div style="display:flex;flex-direction:column;gap:4px;min-width:0"><span class="imp-name">${esc(c.name)}</span><span class="imp-note${over ? ' over' : ''}">${note}</span></div></div>
    <div class="hr"></div>
    <div class="kv"><span>Month total after this</span><span>${money(monthAfter)}</span></div>
    ${budget > 0 && isCur ? `<div class="kv"><span>Safe daily spend</span><span>${money(Math.max(0, budget - monthAfter) / dl)}</span></div>` : ''}
    ${prev ? `<div class="kv"><span>Was</span><span>${money(prev.amount)}</span></div>` : ''}`;
  $('impact').innerHTML = html;
  requestAnimationFrame(() => { const v = $('impRing'); if (v) v.style.strokeDashoffset = CC * (1 - Math.min(r, 1)); });
}

function setDay(s) {
  $('eDate').value = s;
  const t = today(), y = ymd(new Date(Date.now() - 864e5));
  document.querySelectorAll('.seg[data-day]').forEach(b => b.setAttribute('aria-pressed', (b.dataset.day === '0' && s === t) || (b.dataset.day === '1' && s === y)));
}
function sizeAmt() { const v = $('eAmt').value || $('eAmt').placeholder; $('eAmt').style.width = Math.max(2, v.length + .3) + 'ch'; }

function setSegs(groupId, attr, val) { $(groupId).querySelectorAll(`[data-${attr}]`).forEach(b => b.setAttribute('aria-pressed', b.dataset[attr] === val)); }

function renderTags() {
  $('tagChips').innerHTML = eTags.map((t, i) => `<button type="button" class="tchip" data-untag="${i}" aria-label="Remove tag ${esc(t)}">#${esc(t)} ×</button>`).join('');
}
function commitTagInput() {
  const parts = $('eTags').value.split(/[,\s]+/).map(t => t.replace(/^#/, '').toLowerCase().trim()).filter(Boolean);
  parts.forEach(t => { if (!eTags.includes(t) && eTags.length < 12) eTags.push(t.slice(0, 32)); });
  $('eTags').value = ''; renderTags();
}

function renderReceipt() {
  const e = editExp ? S.exps.find(x => x.id === editExp) : null;
  const pick = `<button type="button" class="btn ghost" data-act="pickFile">${ICON.clip} Attach a photo or PDF</button>`;
  if (eFile) {
    const img = eFile.type.startsWith('image/') && !/heic/.test(eFile.type);
    if (img) { URL.revokeObjectURL(renderReceipt.url); renderReceipt.url = URL.createObjectURL(eFile); }
    $('receipt').innerHTML = `${img ? `<img src="${renderReceipt.url}" alt="">` : `<span class="rdoc">${ICON.clip}</span>`}<span class="rname">${esc(eFile.name)}<small>attaches when you save</small></span><button type="button" class="link" data-act="rmReceipt">Remove</button>`;
  } else if (e && e.receipt && !eDropReceipt) {
    const img = !/\.pdf$/.test(e.receipt);
    $('receipt').innerHTML = `${img ? `<img src="${esc(e.receipt)}" alt="">` : `<span class="rdoc">${ICON.clip}</span>`}<span class="rname"><a class="link" href="${esc(e.receipt)}" target="_blank" rel="noopener">View receipt</a></span><button type="button" class="link" data-act="pickFile">Replace</button><button type="button" class="link" data-act="rmReceipt">Remove</button>`;
  } else $('receipt').innerHTML = pick;
}

function openExp(id) {
  editExp = id || null;
  const e = id ? S.exps.find(x => x.id === id) : null;
  $('expForm').reset();
  $('eAmt').value = e ? e.amount.toFixed(2) : '';
  $('eName').value = e ? e.note : '';
  if (e) pickedCat = e.cat;
  setDay(e ? e.date : today());
  eTags = e ? e.tags.slice() : []; renderTags();
  eRepeat = ''; setSegs('eRepeat', 'rep', '');
  $('repeatField').hidden = !!e;
  const rule = e && e.rule && S.rules.find(r => r.id === e.rule);
  $('eRuleNote').hidden = !rule;
  if (rule) $('eRuleNote').innerHTML = `Added by a recurring rule (every ${FREQ[rule.freq]}). Changes here only affect this one. <button type="button" class="link" data-act="editRule" data-id="${rule.id}">Edit the rule</button>`;
  eFile = null; eDropReceipt = false; $('eFile').value = ''; renderReceipt();
  $('expTitle').textContent = e ? 'Edit expense' : 'New expense';
  $('eSaveTxt').textContent = e ? 'Save changes' : 'Drop it in the orb';
  sizeAmt(); renderCatPick();
  openSheet('sheetExp', S.cats.length ? $('eAmt') : $('eHint').querySelector('button'));
}

function openCat(id) {
  editCat = id || null;
  const c = id ? S.cats.find(x => x.id === id) : null;
  $('catForm').reset();
  $('cName').value = c ? c.name : '';
  $('cBudget').value = c ? c.budget : '';
  pickedColor = c ? c.color : PALETTE[S.cats.length % PALETTE.length];
  $('catTitle').textContent = c ? 'Edit category' : 'New category';
  $('cSave').textContent = c ? 'Save category' : 'Add category';
  renderSwatches();
  openSheet('sheetCat', $('cName'));
}
function renderSwatches() {
  $('swatches').innerHTML = PALETTE.map(p => `<button type="button" class="swb" role="radio" aria-label="Colour ${p}" aria-checked="${p === pickedColor}" data-sw="${p}" style="--c:${p}"></button>`).join('');
}

const cleanAmt = el => { const v = el.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1').replace(/^(\d*\.\d{0,2}).*$/, '$1'); if (v !== el.value) el.value = v; };
['iAmt', 'rAmt'].forEach(k => $(k).addEventListener('input', () => { cleanAmt($(k)); if (k === 'rAmt') ruleHint(); }));
$('eTags').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ',') { if ($('eTags').value.trim()) { e.preventDefault(); commitTagInput(); } }
  else if (e.key === 'Backspace' && !$('eTags').value && eTags.length) { eTags.pop(); renderTags(); }
});
$('eTags').addEventListener('blur', commitTagInput);
$('eFile').addEventListener('change', () => { const f = $('eFile').files[0]; if (!f) return; if (f.size > 10 * 1024 * 1024) return toast('That file is over 10 MB.'); eFile = f; eDropReceipt = false; renderReceipt(); });
$('eAmt').addEventListener('input', () => {
  const el = $('eAmt'); cleanAmt(el);
  sizeAmt(); el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  renderImpact();
});
$('eDate').addEventListener('change', () => { setDay($('eDate').value); renderImpact(); });

async function busy(btn, fn) {
  if (btn.disabled) return; btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}

$('expForm').addEventListener('submit', ev => {
  ev.preventDefault();
  commitTagInput();
  const rec = { cat: pickedCat, amount: Math.round(parseFloat($('eAmt').value) * 100) / 100, date: $('eDate').value, note: $('eName').value.trim(), tags: eTags };
  if (!S.cats.some(c => c.id === rec.cat)) return toast('Pick a category first.');
  if (!(rec.amount > 0)) { const w = $('amtWrap'); w.classList.remove('bad'); void w.offsetWidth; w.classList.add('bad'); $('eAmt').focus(); return toast('Enter an amount above zero.'); }
  if (!rec.date) return toast('Pick a date.');
  const wasEdit = !!editExp, color = cat(rec.cat).color, rep = eRepeat;
  busy($('eSave'), async () => {
    let saved;
    try { saved = wasEdit ? await api('PUT', `/api/expenses/${editExp}`, rec) : await api('POST', '/api/expenses', { ...rec, repeat: rep || null }); }
    catch (err) { return toast(err.message); }
    let warn = '';
    try {
      if (eFile) { const fd = new FormData(); fd.append('file', eFile); await api('POST', `/api/expenses/${saved.id}/receipt`, fd); }
      else if (eDropReceipt) await api('DELETE', `/api/expenses/${saved.id}/receipt`);
    } catch (err) { warn = `Saved, but the receipt didn't upload: ${err.message}`; }
    await load().catch(err => toast(err.message));
    const r = $('eSave').getBoundingClientRect(), from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    closeSheet('sheetExp', true);
    if (wasEdit) { render(); return toast(warn || 'Expense updated.'); }
    const land = () => { render(); Orb.splash(); toast(warn || `${money(rec.amount)} added to ${cat(rec.cat).name}${rep ? `, repeating every ${FREQ[rep]}` : ''}.`); };
    const away = view !== 'overview' || scrollY > 40;
    if (view !== 'overview') showView('overview'); else scrollTo({ top: 0, behavior: 'smooth' });
    setTimeout(() => flyCoin(from, color, land), away ? 520 : 120);
  });
});

$('catForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const name = $('cName').value.trim(), budget = Math.max(0, parseFloat($('cBudget').value) || 0);
  if (!name) { $('cName').focus(); return toast('Name can\'t be empty.'); }
  if (S.cats.some(c => c.id !== editCat && c.name.toLowerCase() === name.toLowerCase())) return toast('That category already exists.');
  const body = { name, budget, color: pickedColor }, wasEdit = !!editCat;
  busy($('cSave'), async () => {
    try {
      const c = wasEdit ? await api('PUT', `/api/categories/${editCat}`, body) : await api('POST', '/api/categories', body);
      if (!wasEdit) pickedCat = c.id;
      await load();
    } catch (err) { return toast(err.message); }
    toast(wasEdit ? 'Category updated.' : `${name} added.`);
    closeSheet('sheetCat'); render();
  });
});

/* ---------- income sheet ---------- */
function openInc(id) {
  editInc = id || null;
  const e = id ? S.incs.find(x => x.id === id) : null;
  $('incForm').reset();
  $('iAmt').value = e ? e.amount.toFixed(2) : '';
  $('iNote').value = e ? e.note : '';
  $('iDate').value = e ? e.date : today();
  iRepeat = ''; setSegs('iRepeat', 'rep', '');
  $('iRepeatField').hidden = !!e;
  const rule = e && e.rule && S.rules.find(r => r.id === e.rule);
  $('iRuleNote').hidden = !rule;
  if (rule) $('iRuleNote').innerHTML = `Added by a recurring rule. Changes here only affect this one. <button type="button" class="link" data-act="editRule" data-id="${rule.id}">Edit the rule</button>`;
  $('incTitle').textContent = e ? 'Edit income' : 'New income';
  $('iSave').textContent = e ? 'Save changes' : 'Add income';
  openSheet('sheetInc', $('iAmt'));
}
$('incForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const rec = { amount: Math.round(parseFloat($('iAmt').value) * 100) / 100, note: $('iNote').value.trim(), date: $('iDate').value };
  if (!(rec.amount > 0)) { $('iAmt').focus(); return toast('Enter an amount above zero.'); }
  if (!rec.date) return toast('Pick a date.');
  const wasEdit = !!editInc, rep = iRepeat;
  busy($('iSave'), async () => {
    try {
      if (wasEdit) await api('PUT', `/api/incomes/${editInc}`, rec); else await api('POST', '/api/incomes', { ...rec, repeat: rep || null });
      await load();
    } catch (err) { return toast(err.message); }
    closeSheet('sheetInc'); render();
    toast(wasEdit ? 'Income updated.' : `${money(rec.amount)} income added${rep ? `, repeating every ${FREQ[rep]}` : ''}.`);
  });
});

/* ---------- recurring sheet ---------- */
function ruleHint() {
  const amt = parseFloat($('rAmt').value) || 0, f = $('rFreq').value, nx = $('rNext').value;
  const bits = [];
  if (amt > 0 && f !== 'monthly') bits.push(`About ${money(perMonth({ amount: amt, freq: f }))} a month.`);
  if (nx && nx <= today()) bits.push(`Everything from ${niceDate(nx)} up to today is added as soon as you save.`);
  else if (nx) bits.push(`The next one is added on ${niceDate(nx)}.`);
  $('rHint').textContent = bits.join(' ');
}
function setKind(k) {
  rKind = k; setSegs('rKind', 'kind', k);
  $('rCatField').hidden = k !== 'expense';
}
function openRule(id) {
  editRule = id || null;
  const r = id ? S.rules.find(x => x.id === id) : null;
  $('ruleForm').reset();
  $('rCat').innerHTML = S.cats.slice().sort(byName).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  setKind(r ? r.kind : (S.cats.length ? 'expense' : 'income'));
  $('rAmt').value = r ? r.amount.toFixed(2) : '';
  $('rNote').value = r ? r.note : '';
  $('rFreq').value = r ? r.freq : 'monthly';
  if (r && r.cat) $('rCat').value = r.cat;
  const d = new Date(); d.setMonth(d.getMonth() + 1, 1);
  $('rNext').value = r ? r.next : ymd(d);
  $('ruleTitle').textContent = r ? 'Edit recurring' : 'New recurring';
  $('rSave').textContent = r ? 'Save changes' : 'Add recurring';
  ruleHint();
  openSheet('sheetRule', $('rAmt'));
}
['rFreq', 'rNext'].forEach(k => $(k).addEventListener('change', ruleHint));
$('ruleForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const prev = editRule ? S.rules.find(x => x.id === editRule) : null;
  const rec = { kind: rKind, cat: rKind === 'expense' ? +$('rCat').value : null, amount: Math.round(parseFloat($('rAmt').value) * 100) / 100,
    note: $('rNote').value.trim(), tags: prev ? prev.tags : [], freq: $('rFreq').value, next: $('rNext').value, active: prev ? prev.active : true };
  if (rKind === 'expense' && !S.cats.length) return toast('Create a category first.');
  if (!(rec.amount > 0)) { $('rAmt').focus(); return toast('Enter an amount above zero.'); }
  if (!rec.next) return toast('Pick the next date.');
  const wasEdit = !!editRule;
  busy($('rSave'), async () => {
    try {
      if (wasEdit) await api('PUT', `/api/rules/${editRule}`, rec); else await api('POST', '/api/rules', rec);
      await load();
    } catch (err) { return toast(err.message); }
    closeSheet('sheetRule'); render();
    toast(wasEdit ? 'Recurring updated.' : `${rec.note || 'Recurring item'} added, every ${FREQ[rec.freq]}.`);
  });
});

/* ---------- import / export sheet ---------- */
let csvFile = null;
function openData() { csvFile = null; $('csvFile').value = ''; $('dropTxt').textContent = 'Choose a CSV file, or drop it here'; $('csvPreview').innerHTML = ''; openSheet('sheetData', $('sheetData').querySelector('a')); }
async function csvSend(commit) {
  const fd = new FormData(); fd.append('file', csvFile); fd.append('commit', commit);
  const dc = $('csvCat'); if (dc && dc.value) fd.append('default_cat', dc.value);
  return api('POST', '/api/import/csv', fd);
}
async function csvPreview(f) {
  csvFile = f; $('dropTxt').textContent = f.name;
  $('csvPreview').innerHTML = '<p class="hint">Reading…</p>';
  let r;
  try { r = await csvSend(false); } catch (err) { $('csvPreview').innerHTML = `<div class="alert">${esc(err.message)}</div>`; return; }
  const n = r.expenses + r.income;
  if (!n) { $('csvPreview').innerHTML = `<div class="ok-note">Nothing new to import${r.duplicates ? ` — all ${r.duplicates} rows are already in Ledger` : ''}.</div>`; return; }
  $('csvPreview').innerHTML = `
    <div class="kv"><span>New expenses</span><span>${r.expenses}</span></div>
    <div class="kv"><span>New income</span><span>${r.income}</span></div>
    ${r.duplicates ? `<div class="kv"><span>Already in Ledger (skipped)</span><span>${r.duplicates}</span></div>` : ''}
    ${r.new_categories.length ? `<p class="hint">New categories will be created: ${r.new_categories.map(esc).join(', ')}.</p>` : ''}
    ${r.needs_category ? `<div class="field"><label class="flabel" for="csvCat">Put uncategorised expenses in</label><select id="csvCat" class="inp">${S.cats.slice().sort(byName).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}<option value="">A new “Imported” category</option></select></div>` : ''}
    <div class="ptable">${r.preview.map(x => `<div><span>${niceDate(x.date)}</span><span>${esc(x.note) || '—'}</span><span class="${x.kind === 'income' ? 'pos' : ''}">${x.kind === 'income' ? '+' : ''}${money(x.amount)}</span></div>`).join('')}${n > r.preview.length ? `<p class="hint">…and ${n - r.preview.length} more</p>` : ''}</div>
    <div class="sheet-foot"><button type="button" class="btn primary mag" data-act="csvCommit">Import ${n} row${n > 1 ? 's' : ''}</button></div>`;
}
$('csvFile').addEventListener('change', () => { const f = $('csvFile').files[0]; if (f) csvPreview(f); });
$('drop').addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.add('over'); });
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', e => { e.preventDefault(); $('drop').classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) csvPreview(f); });

$('q').addEventListener('input', () => { filt.q = $('q').value; renderExpenses(); });

/* =========================================================
   Sample data
   ========================================================= */
async function loadSample() {
  const defs = [['Dining', 420], ['Groceries', 520], ['Transport', 220], ['Home', 380], ['Fun', 180]];
  const cats = defs.map(([name, budget], i) => ({ id: i + 1, name, budget, color: PALETTE[i] }));
  const id = n => cats.find(c => c.name === n).id;
  const items = {
    Dining: [['Kopi and kaya toast', 6.4], ['Chicken rice', 5.5], ['Laksa at the hawker centre', 7.8], ['Team lunch', 38, 'work'], ['Omakase dinner', 168, 'date-night'], ['Bubble tea', 6.2], ['Brunch with friends', 54]],
    Groceries: [['FairPrice weekly shop', 84.15], ['Cold Storage top-up', 32.6], ['Fruit and veg', 18.4], ['Bakery', 12.9]],
    Transport: [['Grab ride', 14.8], ['MRT top-up', 30, 'work'], ['Taxi home', 22.5], ['Bike share', 3.2]],
    Home: [['Electricity bill', 92.33], ['Cleaning supplies', 21.4], ['Desk lamp', 45, 'work']],
    Fun: [['Cinema, two tickets', 31, 'date-night'], ['Concert ticket', 98], ['Bouldering session', 26], ['Book', 24.9]],
  };
  let seed = 20261009; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const now = new Date(), exps = [], incs = [];
  for (let mo = 2; mo >= 0; mo--) {
    const y = now.getFullYear(), m = now.getMonth() - mo, d0 = new Date(y, m, 1), last = mo ? new Date(y, m + 1, 0).getDate() : now.getDate();
    for (let d = 1; d <= last; d++) {
      const n = rnd() < .15 ? 0 : rnd() < .45 ? 1 : rnd() < .8 ? 2 : 3;
      for (let k = 0; k < n; k++) {
        const cn = Object.keys(items)[Math.floor(rnd() * 5)], pool = items[cn], [note, amt, tag] = pool[Math.floor(rnd() * pool.length)];
        if (cn === 'Home' && rnd() < .5) continue;
        exps.push({ cat: id(cn), amount: Math.round(amt * (0.85 + rnd() * .3) * 100) / 100, date: ymd(new Date(d0.getFullYear(), d0.getMonth(), d)), note, tags: tag ? [tag] : [] });
      }
    }
    if (mo === 1) incs.push({ amount: 850, date: ymd(new Date(y, m, 14)), note: 'Freelance design invoice' });
  }
  // recurring: salary on the 25th and two bills on the 3rd, starting three months back so they back-fill
  const start = day => ymd(new Date(now.getFullYear(), now.getMonth() - 2, day));
  const rules = [
    { kind: 'income', amount: 5200, note: 'Salary', freq: 'monthly', next: start(25) },
    { kind: 'expense', cat: id('Home'), amount: 49.9, note: 'Internet', freq: 'monthly', next: start(3) },
    { kind: 'expense', cat: id('Fun'), amount: 15.98, note: 'Streaming subscription', freq: 'monthly', next: start(3) },
  ];
  try { await api('POST', '/api/import/json', { cats, exps, incs, rules }); await load(); }
  catch (err) { return toast(err.message); }
  render(); Orb.splash(); toast('Sample data loaded.');
}

/* =========================================================
   Command palette
   ========================================================= */
let palSel = 0, palItems = [];
function palRender() {
  const q = $('palQ').value.trim().toLowerCase();
  const acts = [
    { g: 'Actions', label: 'New expense', k: 'N', run: () => openExp() },
    { g: 'Actions', label: 'New income', run: () => openInc() },
    { g: 'Actions', label: 'New recurring', run: () => openRule() },
    { g: 'Actions', label: 'New category', run: () => openCat() },
    { g: 'Actions', label: 'Import / export', run: openData },
    { g: 'Actions', label: 'Download CSV', run: () => { location.href = '/api/export.csv'; } },
    { g: 'Account', label: 'Account settings', run: openAcct },
    { g: 'Account', label: 'Log out', run: logout },
    { g: 'Go to', label: 'Overview', run: () => showView('overview') },
    { g: 'Go to', label: 'Expenses', run: () => showView('expenses') },
    { g: 'Go to', label: 'Income', run: () => showView('income') },
    { g: 'Go to', label: 'Budgets', run: () => showView('budgets') },
    { g: 'Go to', label: 'Summary', run: () => showView('summary') },
    { g: 'Go to', label: 'Ask about your spending', run: () => showView('ask') },
  ];
  if (!S.exps.length) acts.push({ g: 'Actions', label: 'Load sample data', run: loadSample });
  const hits = q ? S.exps.filter(e => (e.note || '').toLowerCase().includes(q) || cat(e.cat).name.toLowerCase().includes(q) || e.tags.some(t => ('#' + t).includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8)
    .map(e => ({ g: 'Expenses', label: e.note || 'Untitled', k: `${money(e.amount)} · ${niceDate(e.date)}`, c: cat(e.cat).color, run: () => openExp(e.id) })) : [];
  palItems = [...acts.filter(a => !q || a.label.toLowerCase().includes(q)), ...hits];
  palSel = Math.min(palSel, Math.max(palItems.length - 1, 0));
  let g = '';
  $('palList').innerHTML = palItems.length ? palItems.map((it, i) => {
    const h = it.g !== g ? `<div class="pal-g">${it.g}</div>` : ''; g = it.g;
    return h + `<button class="pi" role="option" data-pi="${i}" aria-selected="${i === palSel}" ${it.c ? `style="--c:${it.c}"` : ''}><span class="sw"></span>${esc(it.label)}${it.k ? `<span class="k">${esc(it.k)}</span>` : ''}</button>`;
  }).join('') : '<p class="empty" style="padding:14px">Nothing found.</p>';
}
function openPal() { $('palQ').value = ''; palSel = 0; palRender(); openSheet('pal', $('palQ')); }
function runPal(i) { const it = palItems[i]; if (!it) return; closeSheet('pal', true); setTimeout(it.run, 120); }
$('palQ').addEventListener('input', () => { palSel = 0; palRender(); });
$('palQ').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palItems.length) % Math.max(palItems.length, 1); palRender();
    const s = $('palList').querySelector('[aria-selected=true]'); s && s.scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'Enter') { e.preventDefault(); runPal(palSel); }
});

/* =========================================================
   Events
   ========================================================= */
document.addEventListener('click', ev => {
  const t = ev.target.closest('[data-view],[data-go],[data-act],[data-close],[data-pick],[data-sw],[data-day],[data-fcat],[data-month],[data-pi],[data-tag],[data-untag],[data-rep],[data-kind]');
  if (!t) return;
  const d = t.dataset;
  if (d.view) return showView(d.view);
  if (d.go) return showView(d.go);
  if ('close' in d) return closeSheet(t.closest('.sheet').id);
  if (d.pick) { pickedCat = +d.pick; document.querySelectorAll('.cp').forEach(b => b.setAttribute('aria-checked', b === t)); return renderImpact(); }
  if (d.sw) { pickedColor = d.sw; return document.querySelectorAll('.swb').forEach(b => b.setAttribute('aria-checked', b === t)); }
  if (d.day) { setDay(ymd(new Date(Date.now() - d.day * 864e5))); return renderImpact(); }
  if (d.fcat !== undefined) { filt.cat = +d.fcat; renderExpenses(); return stagger($('expList')); }
  if (d.month) { sumMonth = d.month; renderSummary(); return stagger($('daily')); }
  if (d.pi) return runPal(+d.pi);
  if (d.tag) { filt.q = $('q').value = '#' + d.tag; filt.cat = 0; renderExpenses(); return showView('expenses'); }
  if (d.untag !== undefined) { eTags.splice(+d.untag, 1); renderTags(); return $('eTags').focus(); }
  if (d.rep !== undefined) { const g = t.parentElement.id; if (g === 'eRepeat') eRepeat = d.rep; else iRepeat = d.rep; return setSegs(g, 'rep', d.rep); }
  if (d.kind) { setKind(d.kind); return ruleHint(); }

  const id = +d.id, act = d.act;
  if (act === 'newExp') return openExp();
  if (act === 'newCat') { closeSheet('sheetExp', true); return setTimeout(() => openCat(), $('sheetExp').hidden ? 0 : 200); }
  if (act === 'sample') { closeSheet('sheetExp', true); return loadSample(); }
  if (act === 'palette') return openPal();
  if (act === 'editExp') return openExp(id);
  if (act === 'editCat') return openCat(id);
  if (act === 'newInc') return openInc();
  if (act === 'editInc') return openInc(id);
  if (act === 'newRule') return openRule();
  if (act === 'editRule') { ['sheetExp', 'sheetInc'].forEach(x => closeSheet(x, true)); return setTimeout(() => openRule(id), 200); }
  if (act === 'data') return openData();
  if (act === 'account') return openAcct();
  if (act === 'logout') return logout();
  if (act === 'authMode') return showAuth(d.mode);
  if (act === 'retry') return api('GET', '/api/auth/me').then(r => { banner(); return enterApp(r.user); }, err => err.status === 401 ? (banner(), showAuth()) : toast(err.message));
  if (act === 'pickFile') return $('eFile').click();
  if (act === 'rmReceipt') { eFile = null; eDropReceipt = true; $('eFile').value = ''; return renderReceipt(); }
  if (act === 'csvCommit') {
    return busy(t, async () => {
      let r;
      try { r = await csvSend(true); await load(); } catch (err) { return toast(err.message); }
      closeSheet('sheetData'); render(); toast(`Imported ${r.imported} row${r.imported === 1 ? '' : 's'}.`);
    });
  }
  if (act === 'toggleRule') {
    const r = S.rules.find(x => x.id === id);
    return busy(t, async () => {
      try { await api('PUT', `/api/rules/${id}`, { ...r, active: !r.active }); await load(); } catch (err) { return toast(err.message); }
      render(); toast(r.active ? 'Paused. Nothing new will be added until you resume it.' : 'Resumed.');
    });
  }
  const DEL = { delExp: ['expenses', 'Expense deleted.'], delCat: ['categories', 'Category deleted.'], delInc: ['incomes', 'Income deleted.'], delRule: ['rules', 'Recurring deleted. What it already added stays.'] };
  if (DEL[act]) {   // two-step delete: first click arms, second confirms
    if (!t.classList.contains('armed')) {
      t.classList.add('armed'); t.setAttribute('aria-label', 'Click again to delete');
      t.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.15)' }, { transform: 'scale(1)' }], { duration: 350, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      toast('Click again to delete.');
      return void setTimeout(() => t.classList.remove('armed'), 2500);
    }
    if (act === 'delCat' && S.exps.some(x => x.cat === id)) return toast('This category still has expenses. Move or delete them first.');
    busy(t, async () => {
      try { await api('DELETE', `/api/${DEL[act][0]}/${id}`); } catch (err) { return toast(err.message); }
      const el = t.closest('.erow,.bcard');
      const finish = () => load().then(() => { render(); toast(DEL[act][1]); }, err => toast(err.message));
      if (!el || RM) return finish();
      const h = el.offsetHeight, row = !el.classList.contains('bcard');
      el.style.overflow = 'hidden';
      el.animate([
        { opacity: 1, transform: 'none', height: h + 'px', marginBottom: '0px' },
        { opacity: 0, transform: 'translateX(40px) scale(.96)', height: h + 'px', offset: .5 },
        { opacity: 0, transform: 'translateX(40px) scale(.96)', height: row ? '0px' : h + 'px', paddingTop: '0px', paddingBottom: '0px', marginBottom: row ? '-4px' : '0px' },
      ], { duration: 480, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' }).onfinish = finish;
    });
  }
});

document.addEventListener('keydown', e => {
  if (!ME) return;
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return $('pal').hidden ? openPal() : closeSheet('pal'); }
  if (e.key === 'Escape') { const s = openSheetId(); if (s) { e.preventDefault(); closeSheet(s); } return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || openSheetId()) return;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openExp(); }
  const map = { 1: 'overview', 2: 'expenses', 3: 'income', 4: 'budgets', 5: 'summary', 6: 'ask' };
  if (map[e.key]) showView(map[e.key]);
});
// keep focus inside an open sheet
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const s = openSheetId(); if (!s) return;
  const f = [...$(s).querySelectorAll('button,input,[tabindex]')].filter(x => !x.disabled && x.offsetParent);
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
});

addEventListener('resize', moveInd);
if (!/Mac|iPhone|iPad/.test(navigator.platform)) $('kbdHint').textContent = 'Ctrl K';

/* =========================================================
   Boot
   ========================================================= */
Orb.init();
showView('overview', true);
/* =========================================================
   Accounts
   ========================================================= */
let authMode = 'login';
async function showAuth(mode, note) {
  ME = null; S = EMPTY();
  ['pal', 'sheetExp', 'sheetCat', 'sheetInc', 'sheetRule', 'sheetData', 'sheetAcct'].forEach(id => closeSheet(id, true));
  banner(); render(); Ask.reset();                      // drop the previous user's data from the page
  document.body.classList.add('signed-out'); $('auth').hidden = false; Login.show();
  let st = { signups_open: true, has_users: true };
  try { st = await api('GET', '/api/auth/status'); } catch (e) {}
  authMode = !st.signups_open ? 'login' : mode || (st.has_users ? 'login' : 'signup');
  const up = authMode === 'signup';
  Login.morph(() => {
    Login.title(up ? (st.has_users ? 'Create your account' : 'Set up Ledger') : 'Welcome back');
    $('authSub').textContent = note || (up ? (st.has_users ? 'Your expenses are private to your account.' : 'Create the first account on this server.') : 'Log in to see your budgets and expenses.');
    $('authSaveTxt').textContent = up ? 'Create account' : 'Log in';
    $('aPass').autocomplete = up ? 'new-password' : 'current-password';
    $('authSwitch').innerHTML = !st.signups_open || !st.has_users ? ''
      : up ? 'Already have an account? <button type="button" class="link" data-act="authMode" data-mode="login">Log in</button>'
        : 'New here? <button type="button" class="link" data-act="authMode" data-mode="signup">Create an account</button>';
    $('authErr').hidden = true;
    Login.setMode(authMode);
  });
  setTimeout(() => ($('aEmail').value ? $('aPass') : $('aEmail')).focus(), 50);
}
onAuthLost = () => { if (ME) showAuth('login', 'You were signed out. Log in again to continue.'); };

async function enterApp(user) {
  ME = user;
  $('acctBtn').textContent = (user.email[0] || '?').toUpperCase();
  $('acctBtn').title = user.email;
  document.body.classList.remove('signed-out'); $('auth').hidden = true; Login.hide();
  $('authForm').reset();
  await load();
  render(); moveInd();
}

$('authForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const body = { email: $('aEmail').value.trim(), password: $('aPass').value };
  const err = m => { $('authErr').hidden = true; $('authErr').textContent = m; void $('authErr').offsetWidth; $('authErr').hidden = false; Login.fail(); };
  if (!body.email || !body.password) return err('Enter your email and password.');
  if (authMode === 'signup' && body.password.length < 8) return err('Use at least 8 characters for your password.');
  busy($('authSave'), async () => {
    let r;
    Login.busy(true);
    try { r = await api('POST', authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login', body); }
    catch (e) { return err(e.message); }
    await Login.success();
    try { await enterApp(r.user); } catch (e) { return toast(e.message); }
    toast(authMode === 'signup' ? 'Account created.' : 'Logged in.');
  });
});

function openAcct() {
  $('acctEmail').textContent = ME ? ME.email : '';
  $('pwForm').reset(); $('delForm').reset();
  openSheet('sheetAcct', $('sheetAcct').querySelector('[data-act=logout]'));
}
async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch (e) {}
  showAuth('login', 'You\'re logged out.');
}
$('pwForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const body = { current: $('pwCur').value, new: $('pwNew').value };
  if (body.new.length < 8) { $('pwNew').focus(); return toast('Use at least 8 characters for the new password.'); }
  busy($('pwSave'), async () => {
    try { await api('POST', '/api/auth/password', body); } catch (e) { return toast(e.message); }
    $('pwForm').reset(); toast('Password updated. Other devices were signed out.');
  });
});
$('delForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const b = $('delSave');
  if (!$('delPass').value) { $('delPass').focus(); return toast('Enter your password to confirm.'); }
  if (!b.classList.contains('armed')) {   // two-step, like other deletes
    b.classList.add('armed'); b.textContent = 'Click again to delete everything';
    return void setTimeout(() => { b.classList.remove('armed'); b.textContent = 'Delete my account'; }, 4000);
  }
  busy(b, async () => {
    try { await api('POST', '/api/auth/delete-account', { password: $('delPass').value }); } catch (e) { return toast(e.message); }
    showAuth('signup', 'Your account and all its data were deleted.');
  });
});

if (location.protocol === 'file:') {
  banner('This page was opened as a file, so it can\'t reach your data. Run <b>./run.sh</b> and open <b>http://localhost:5178</b> instead.');
} else {
  api('GET', '/api/auth/me').then(r => enterApp(r.user), err => {
    if (err.status === 401) return showAuth();
    render();
    banner(`${esc(err.message)} Your data is safe on the server. Start it with <b>./run.sh</b>, then reload. <button class="link" data-act="retry">Try again</button>`);
  }).catch(err => toast(err.message));
}
document.fonts && document.fonts.ready.then(moveInd);
setTimeout(moveInd, 300);
