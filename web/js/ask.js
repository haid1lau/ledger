/* =========================================================
   Ask: the spending agent (agent.py) inside Ledger. See AGENT.md.
   POST /api/ask streams one JSON event per line while the agent works:
     step · thinking · tool_call · tool_result · answer  (or error)
   Each one is drawn the moment it arrives, so you watch it work.
   ========================================================= */
const Ask = (() => {
  const SUGGEST = [
    'How much did I spend on food last month?',
    "What's my biggest category this month vs last month?",
    'List my 5 most expensive purchases',
    'Am I over budget anywhere this month?',
  ];
  let history = [];   // earlier {q, a} pairs, sent back so follow-ups like "and in May?" work
  let ctrl = null;    // aborts the request in flight (on logout)

  // Answers arrive as light Markdown. Escape everything first, then allow only **bold**,
  // `code` and simple lists, so nothing the model writes can turn into HTML on the page.
  function md(text) {
    const inline = s => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    let html = '', list = null;
    for (const line of esc(text).split('\n')) {
      const m = line.match(/^\s*(?:[-*•]|(\d+)\.)\s+(.*)$/);
      if (m) {
        const kind = m[1] ? 'ol' : 'ul';
        if (list !== kind) { if (list) html += `</${list}>`; html += `<${kind}>`; list = kind; }
        html += `<li>${inline(m[2])}</li>`;
        continue;
      }
      if (list) { html += `</${list}>`; list = null; }
      if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    return html + (list ? `</${list}>` : '');
  }

  function resultHTML(r) {
    if (r.error) return `<div class="ask-res ask-err">✗ ${esc(r.error)}</div>`;
    if (r.rows) {
      const n = r.rows.length;
      const head = `${n} row${n === 1 ? '' : 's'}${r.truncated ? ' (cut off at 50; there were more)' : ''}`;
      if (!n) return `<div class="ask-res">← no rows</div>`;
      const rows = r.rows.slice(0, 5).map(row => `<tr>${row.map(v => `<td>${esc(v ?? 'NULL')}</td>`).join('')}</tr>`).join('');
      return `<div class="ask-res">← ${head}<div class="ask-table"><table>
        <tr>${r.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr>${rows}</table></div>${n > 5 ? `… ${n - 5} more` : ''}</div>`;
    }
    if (r.tables) return `<div class="ask-res">← ${r.tables.map(t => esc(t.name)).join(', ')}</div>`;
    if (r.columns) return `<div class="ask-res">← ${r.columns.map(c => `${esc(c.name)} <i>${esc(c.type)}</i>`).join(', ')}</div>`;
    return '';
  }

  function callHTML(e) {
    const a = e.args;
    if (e.name === 'run_query' && a && typeof a === 'object' && 'sql' in a)
      return `<span class="ask-tool">→ run_query</span><pre class="ask-sql">${esc(String(a.sql).trim())}</pre>`;
    const shown = a && typeof a === 'object' ? Object.entries(a).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ') : String(a ?? '');
    return `<span class="ask-tool">→ ${esc(e.name)}(${esc(shown)})</span>`;
  }

  function newTurn(q) {
    const el = document.createElement('div');
    el.className = 'ask-turn';
    el.innerHTML = `<div class="ask-q">${esc(q)}</div>
      <details class="ask-steps live"><summary><span class="ask-status">Thinking…</span><span class="ask-time"></span></summary>
      <ol class="ask-log"></ol></details><div class="ask-a"></div>`;
    $('askThread').append(el);
    return { el, status: el.querySelector('.ask-status'), time: el.querySelector('.ask-time'), log: el.querySelector('.ask-log'),
             steps: el.querySelector('.ask-steps'), ans: el.querySelector('.ask-a'),
             started: Date.now(), step: 0, queries: 0, lastCall: null };
  }

  function draw(t, e) {
    if (e.type === 'step') { t.step = e.n; tick(t); }
    else if (e.type === 'thinking') {
      const text = e.text.replace(/\s+/g, ' ').trim();
      const li = document.createElement('li'); li.className = 'ask-think';
      li.textContent = 'thinking: ' + (text.length > 280 ? text.slice(0, 280) + '…' : text);
      li.title = text;
      t.log.append(li);
    } else if (e.type === 'tool_call') {
      if (e.name === 'run_query') t.queries++;
      t.lastCall = document.createElement('li'); t.lastCall.innerHTML = callHTML(e);
      t.log.append(t.lastCall);
    } else if (e.type === 'tool_result') {
      (t.lastCall || t.log).insertAdjacentHTML('beforeend', resultHTML(e.result));
    } else if (e.type === 'answer') {
      t.ans.innerHTML = md(e.text);
      finish(t, `Show how · ${e.steps} step${e.steps === 1 ? '' : 's'} · ${t.queries} quer${t.queries === 1 ? 'y' : 'ies'} · ${secs(t)}`);
      history = [...history, { q: t.el.querySelector('.ask-q').textContent, a: e.text }].slice(-6);
      $('askNew').hidden = false;
      return true;
    } else if (e.type === 'error') {
      fail(t, e.message);
      return true;
    }
    if (t.steps.open) t.log.lastElementChild?.scrollIntoView?.({ block: 'nearest', behavior: RM ? 'auto' : 'smooth' });
    return false;
  }

  // While it works, only "Thinking…" and a timer show; the steps are still recorded, folded away,
  // and can be opened with the toggle (during or after) to see the SQL.
  const secs = t => `${Math.round((Date.now() - t.started) / 1000)}s`;
  function tick(t) { t.time.textContent = secs(t); }
  function finish(t, label) { clearInterval(t.timer); t.steps.classList.remove('live'); t.steps.open = false; t.status.textContent = label; t.time.textContent = ''; }
  function fail(t, msg) { t.ans.innerHTML = `<p class="ask-fail">${esc(msg)}</p>`; finish(t, `Stopped · ${secs(t)} · show what happened`); }

  async function send(q) {
    q = q.trim();
    if (!q || ctrl) return;
    $('askQ').value = '';
    $('askSugg').hidden = true;
    const t = newTurn(q);
    t.timer = setInterval(() => tick(t), 1000);
    setBusy(true);
    ctrl = new AbortController();
    let ended = false;
    try {
      const res = await fetch('/api/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history }), signal: ctrl.signal,
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null))?.detail;
        if (res.status === 401) onAuthLost();
        throw new Error(typeof d === 'string' ? d : Array.isArray(d) ? d.map(x => x.msg.replace(/^Value error, /, '')).join(' ') : `Something went wrong (${res.status}).`);
      }
      // Read the stream as it arrives and split it into lines; each line is one event.
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (line.trim()) ended = draw(t, JSON.parse(line)) || ended;
        }
      }
      if (!ended) fail(t, 'The answer stopped part-way. Try asking again.');
    } catch (err) {
      if (err.name === 'AbortError') return;
      fail(t, err instanceof TypeError ? 'Can\'t reach the Ledger server. Is it running?' : err.message);
    } finally {
      ctrl = null; setBusy(false);
    }
  }

  function setBusy(on) {
    $('askGo').disabled = on;
    $('askGo').textContent = on ? 'Working…' : 'Ask';
    $('askQ').disabled = on;
    if (!on && FINE && view === 'ask') $('askQ').focus();
  }

  function reset() {   // on logout: forget everything, so the next person sees nothing
    if (ctrl) ctrl.abort();
    ctrl = null; history = [];
    $('askThread').innerHTML = '';
    $('askQ').value = ''; $('askNew').hidden = true; $('askSugg').hidden = false;
    setBusy(false);
  }

  $('askSugg').innerHTML = SUGGEST.map(s => `<button type="button" class="ask-chip">${esc(s)}</button>`).join('');
  $('askSugg').addEventListener('click', ev => { const b = ev.target.closest('.ask-chip'); if (b) send(b.textContent); });
  $('askForm').addEventListener('submit', ev => { ev.preventDefault(); send($('askQ').value); });
  $('askNew').addEventListener('click', () => { reset(); if (FINE) $('askQ').focus(); });

  return { reset, shown: () => { if (FINE && !ctrl) $('askQ').focus(); } };
})();
