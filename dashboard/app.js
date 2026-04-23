/* Indexing Monitor — vanilla-JS SPA.
   Talks to /api/*. Hash-routed (#/list, #/client/<id>, #/add).
   Polls /api/run-status while any run is active; stops on view change. */

(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    view: 'list',                // 'list' | 'detail' | 'add'
    clientId: null,
    tab: 'overview',
    clients: [],                 // last list payload
    detail: null,                // last detail payload
    history: null,               // last history payload
    runStatus: null,             // last run-status payload
    search: '',
    theme: localStorage.getItem('im-theme') || 'dark',
    pollHandle: null,
  };

  const API = {
    listClients:  ()                 => fetchJSON('/api/clients'),
    createClient: (payload)          => fetchJSON('/api/clients', { method: 'POST', body: payload }),
    getClient:    (id)               => fetchJSON(`/api/client?id=${encodeURIComponent(id)}`),
    getHistory:   (id)               => fetchJSON(`/api/history?client_id=${encodeURIComponent(id)}`),
    getRunStatus: (id)               => fetchJSON(`/api/run-status?client_id=${encodeURIComponent(id)}`),
    triggerRun:   (id)               => fetchJSON('/api/run', { method: 'POST', body: { client_id: id } }),
  };

  // ---------------------------------------------------------------------
  // Fetch helper
  // ---------------------------------------------------------------------
  async function fetchJSON(url, opts = {}) {
    const init = {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const resp = await fetch(url, init);
    const text = await resp.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!resp.ok) {
      const err = new Error(data.error || `HTTP ${resp.status}`);
      err.status = resp.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------------
  // Escape helpers — trust nothing from the API when building HTML
  // ---------------------------------------------------------------------
  const escHTML = (v) => String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const escAttr = escHTML;

  // ---------------------------------------------------------------------
  // Formatters
  // ---------------------------------------------------------------------
  const fmtInt = (n) => (n ?? 0).toLocaleString('en-US');
  const fmtPct = (n) => `${Math.round(Number(n) || 0)}%`;

  function fmtRelativeDate(iso) {
    if (!iso) return 'never';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    } catch { return iso; }
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${y}-${m}-${day} ${hh}:${mm}`;
    } catch { return iso; }
  }

  // ---------------------------------------------------------------------
  // Polling — one shared interval, tied to current view
  // ---------------------------------------------------------------------
  function stopPolling() {
    if (state.pollHandle) {
      clearInterval(state.pollHandle);
      state.pollHandle = null;
    }
  }
  function startPolling(tick, intervalMs = 2000) {
    stopPolling();
    state.pollHandle = setInterval(() => {
      tick().catch((e) => console.warn('[poll]', e.message));
    }, intervalMs);
  }

  // ---------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('im-theme', theme);
    document.querySelectorAll('.theme-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.themeChoice === theme);
    });
  }

  // ---------------------------------------------------------------------
  // Router (hash-based)
  // ---------------------------------------------------------------------
  function navigate(view, opts = {}) {
    stopPolling();
    state.view = view;
    state.clientId = opts.clientId || null;
    state.tab = opts.tab || 'overview';

    let hash = '#/list';
    if (view === 'detail' && state.clientId) hash = `#/client/${encodeURIComponent(state.clientId)}`;
    else if (view === 'add') hash = '#/add';
    if (location.hash !== hash) location.hash = hash;

    // Sidebar nav active state
    document.querySelectorAll('.nav-btn').forEach((b) => {
      const on = (view === 'list' && b.dataset.view === 'list')
              || (view === 'add'  && b.dataset.view === 'add');
      b.classList.toggle('active', on);
      b.disabled = on;
    });

    render();
  }

  function readHash() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    if (!h || h === 'list') return { view: 'list' };
    if (h === 'add') return { view: 'add' };
    const match = h.match(/^client\/(.+)$/);
    if (match) return { view: 'detail', clientId: decodeURIComponent(match[1]) };
    return { view: 'list' };
  }

  // ---------------------------------------------------------------------
  // Render entry point
  // ---------------------------------------------------------------------
  async function render() {
    const root = document.getElementById('content');
    try {
      if (state.view === 'list') await renderList(root);
      else if (state.view === 'detail') await renderDetail(root);
      else if (state.view === 'add') await renderAdd(root);
    } catch (e) {
      root.innerHTML = `<div class="alert alert-error"><strong>Couldn't load:</strong> ${escHTML(e.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------------
  // List view
  // ---------------------------------------------------------------------
  async function renderList(root) {
    // Clone template
    const tpl = document.getElementById('tpl-list').content.cloneNode(true);
    root.innerHTML = '';
    root.appendChild(tpl);

    const data = await API.listClients();
    state.clients = data.clients || [];

    renderStatsStrip(data.dashboard || {});
    renderClientList();

    document.getElementById('search-input').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderClientList();
    });
    document.getElementById('search-input').value = state.search;

    // Poll if any client is running
    const hasRunning = state.clients.some((c) => c.current_run && c.current_run.status === 'running');
    if (hasRunning) {
      startPolling(async () => {
        const fresh = await API.listClients();
        state.clients = fresh.clients || [];
        renderStatsStrip(fresh.dashboard || {});
        renderClientList();
        const stillRunning = state.clients.some((c) => c.current_run && c.current_run.status === 'running');
        if (!stillRunning) stopPolling();
      });
    }
  }

  function renderStatsStrip(d) {
    const active = d.active_runs || 0;
    const total = d.urls_tracked || 0;
    const indexed = d.indexed || 0;
    const coverage = total
      ? `${fmtInt(indexed)} of ${fmtInt(total)} · ${fmtPct((indexed / total) * 100)}`
      : 'No runs yet';
    const withData = state.clients.filter((c) => c.stats).length;

    document.getElementById('stats-strip').innerHTML = `
      <div class="stats-tile">
        <div class="label">Total clients</div>
        <div class="value">${fmtInt(d.total_clients)}</div>
        <div class="sub">${withData} with run data</div>
      </div>
      <div class="stats-tile">
        <div class="label">URLs tracked</div>
        <div class="value">${fmtInt(total)}</div>
        <div class="sub">Across all sitemaps</div>
      </div>
      <div class="stats-tile">
        <div class="label">Indexed</div>
        <div class="value">${fmtInt(indexed)}</div>
        <div class="sub">${escHTML(coverage)}</div>
      </div>
      <div class="stats-tile ${active ? 'accent' : ''}">
        <div class="label">Active runs</div>
        <div class="value">${fmtInt(active)}</div>
        <div class="sub">${active ? 'Live now' : 'Idle'}</div>
      </div>
    `;
  }

  function filteredClients() {
    const q = state.search.trim().toLowerCase();
    if (!q) return state.clients;
    return state.clients.filter(
      (c) => c.name.toLowerCase().includes(q) || c.domain.toLowerCase().includes(q)
    );
  }

  function renderClientList() {
    const total = state.clients.length;
    document.getElementById('list-count').textContent = `${total} client${total === 1 ? '' : 's'}`;

    const list = document.getElementById('client-list');
    const filtered = filteredClients();
    if (!total) {
      list.innerHTML = `<div class="empty">No clients yet. Click <strong>+ Add new client</strong> to get started.</div>`;
      return;
    }
    if (!filtered.length) {
      list.innerHTML = `<div class="empty">No clients match "${escHTML(state.search)}".</div>`;
      return;
    }

    list.innerHTML = filtered.map(clientCardHTML).join('');
  }

  function clientCardHTML(c) {
    const running = c.current_run && c.current_run.status === 'running';
    const stats = c.stats;
    let dotHTML;
    if (running) {
      dotHTML = '<span class="live-dot"></span>';
    } else if (!stats) {
      dotHTML = '<span class="status-dot gray"></span>';
    } else {
      const pct = stats.total ? (stats.indexed / stats.total) * 100 : 0;
      dotHTML = `<span class="status-dot ${pct >= 90 ? 'green' : 'amber'}"></span>`;
    }

    let metricsRow;
    let summary;
    if (!stats) {
      metricsRow = `
        <div class="status-row">
          <span><strong>—</strong> indexed</span>
          <span><strong>—</strong> not indexed</span>
          <span><strong>—</strong> submitted</span>
        </div>`;
      summary = 'No runs yet';
    } else {
      const pct = stats.total ? Math.round((stats.indexed / stats.total) * 100) : 0;
      metricsRow = `
        <div class="status-row">
          <span><strong>${fmtInt(stats.indexed)}</strong> indexed</span>
          <span><strong>${fmtInt(stats.not_indexed)}</strong> not indexed</span>
          <span><strong>${fmtInt(stats.submitted)}</strong> submitted</span>
        </div>`;
      summary = `${fmtInt(stats.indexed)}/${fmtInt(stats.total)} indexed (${pct}%)`;
    }

    let progressHTML = '';
    if (running) {
      const cur = c.current_run.current || 0;
      const tot = c.current_run.total || 0;
      const pct = c.current_run.pct || 0;
      const counter = tot ? `${fmtInt(cur)} / ${fmtInt(tot)} URLs` : 'starting…';
      progressHTML = `
        <div class="run-progress">
          <div class="run-progress-label">
            <span>Running · ${escHTML(counter)}</span>
            <span>${fmtPct(pct)}</span>
          </div>
          <div class="run-progress-bar-bg">
            <div class="run-progress-bar" style="width:${Math.min(100, pct).toFixed(1)}%"></div>
          </div>
        </div>`;
    }

    const last = c.last_run_at ? fmtRelativeDate(c.last_run_at) : 'never';

    return `
      <div class="client-row">
        <div class="client-card">
          <h4>${dotHTML}${escHTML(c.name)}</h4>
          <div class="domain">${escHTML(c.domain)}</div>
          ${metricsRow}
          ${progressHTML}
          <div class="last-run">Last run: ${escHTML(last)} · ${escHTML(summary)}</div>
        </div>
        <div class="client-actions">
          <button class="btn btn-sm" data-action="open" data-client="${escAttr(c.id)}" type="button">Open</button>
          <button class="btn btn-primary btn-sm" data-action="run" data-client="${escAttr(c.id)}" type="button"
            ${running ? 'disabled' : ''}>
            ${running ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>`;
  }

  // Delegated click handler for list view actions
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const action = t.dataset.action;
    const clientId = t.dataset.client;
    if (action === 'open') navigate('detail', { clientId });
    else if (action === 'run') {
      t.disabled = true;
      const oldText = t.textContent;
      t.textContent = 'Queuing…';
      try {
        await API.triggerRun(clientId);
        navigate('detail', { clientId, tab: 'run' });
      } catch (err) {
        alert(`Couldn't start run: ${err.message}`);
        t.disabled = false;
        t.textContent = oldText;
      }
    } else if (action === 'download-csv') {
      // Browser handles this via the <a> tag; nothing to do here.
    }
  });

  // ---------------------------------------------------------------------
  // Detail view
  // ---------------------------------------------------------------------
  async function renderDetail(root) {
    const tpl = document.getElementById('tpl-detail').content.cloneNode(true);
    root.innerHTML = '';
    root.appendChild(tpl);

    // Wire tab buttons
    root.querySelectorAll('.tab').forEach((b) => {
      b.addEventListener('click', () => {
        state.tab = b.dataset.tab;
        activateTab();
      });
    });

    const detail = await API.getClient(state.clientId);
    state.detail = detail;

    const c = detail.client;
    root.querySelector('#detail-name').textContent = c.name;
    root.querySelector('#detail-sub').textContent = `${c.domain} · sitemap: ${c.sitemap_url}`;

    // Render the three panels
    renderOverviewTab(root.querySelector('[data-tab-panel="overview"]'), detail);
    renderRunTab(root.querySelector('[data-tab-panel="run"]'), c);
    const historyPanel = root.querySelector('[data-tab-panel="history"]');
    historyPanel.innerHTML = '<div class="empty">Loading history…</div>';

    activateTab();

    // Render live-run area and start polling if running
    renderRunOutputArea();
    if (detail.current_run) {
      startPolling(pollRunStatus);
    }
  }

  function activateTab() {
    document.querySelectorAll('.tab').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.hidden = p.dataset.tabPanel !== state.tab;
    });
    if (state.tab === 'history' && state.clientId) {
      const panel = document.querySelector('[data-tab-panel="history"]');
      if (!state.history || state.history.clientId !== state.clientId) {
        loadHistory(panel);
      }
    }
  }

  function renderOverviewTab(panel, detail) {
    const c = detail.client;
    const stats = detail.stats;
    const lastRun = detail.last_run_at;
    if (!stats) {
      panel.innerHTML = `<div class="alert alert-info">No runs for <strong>${escHTML(c.name)}</strong> yet. Go to the <strong>Run</strong> tab to kick off the first check.</div>`;
      return;
    }

    const coverage = stats.total ? Math.round((stats.indexed / stats.total) * 100) : 0;
    const reasons = detail.reason_breakdown || [];

    panel.innerHTML = `
      <div class="caption" style="color:var(--text-muted);font-size:12px;">Last run: ${escHTML(fmtRelativeDate(lastRun))}</div>
      ${metricsCards4([
        { label: 'Total URLs',        value: fmtInt(stats.total) },
        { label: 'Indexed',           value: fmtInt(stats.indexed), delta: `${coverage}% of sitemap` },
        { label: 'Not indexed',       value: fmtInt(stats.not_indexed) },
        { label: 'Submitted last run',value: fmtInt(stats.submitted) },
      ])}
      ${
        reasons.length
          ? `<h4 style="margin-top:8px;margin-bottom:10px;">Why URLs are not indexed</h4>
             <table class="data-table">
               <thead><tr><th>Reason</th><th class="num">Count</th></tr></thead>
               <tbody>
                 ${reasons.map((r) => `
                   <tr><td>${escHTML(r.reason)}</td><td class="num">${fmtInt(r.count)}</td></tr>
                 `).join('')}
               </tbody>
             </table>`
          : `<div class="alert alert-success">Every URL in the sitemap is indexed.</div>`
      }`;
  }

  function renderRunTab(panel, client) {
    const running = state.detail && state.detail.current_run;
    panel.innerHTML = `
      <h3>Run check for ${escHTML(client.name)}</h3>
      <div style="color:var(--text-muted);font-size:12px;margin-top:4px;margin-bottom:16px;">
        Clicking Run executes the indexing check on GitHub Actions. A typical run takes 1–5 minutes.
        Progress streams back here — leave the tab open or come back later.
      </div>
      <button class="btn btn-primary" data-action="run" data-client="${escAttr(client.id)}" type="button"
        ${running ? 'disabled' : ''}>
        ${running ? 'Running…' : 'Run now'}
      </button>`;
  }

  async function loadHistory(panel) {
    panel.innerHTML = '<div class="empty">Loading history…</div>';
    try {
      const data = await API.getHistory(state.clientId);
      state.history = { clientId: state.clientId, ...data };
      const runs = data.runs || [];
      if (!runs.length) {
        panel.innerHTML = '<div class="empty">No runs recorded yet.</div>';
        return;
      }
      panel.innerHTML = `<h3 style="margin-bottom:12px;">Past runs</h3>` + runs.map(historyItemHTML).join('');
    } catch (e) {
      panel.innerHTML = `<div class="alert alert-error">Couldn't load history: ${escHTML(e.message)}</div>`;
    }
  }

  function historyItemHTML(r) {
    const s = r.stats || {};
    const total = s.total || 0;
    const coverage = total ? Math.round((s.indexed / total) * 100) : 0;
    const title = `${escHTML(fmtDateTime(r.started_at))} · ${escHTML(r.status)}`;
    const summary = total
      ? `${fmtInt(s.indexed)}/${fmtInt(total)} indexed (${coverage}%)`
      : (r.error ? `failed: ${escHTML(r.error)}` : 'no data');
    return `
      <details class="expander">
        <summary>${title} — ${summary}</summary>
        <div class="expander-body">
          ${metricsCards4([
            { label: 'Total URLs',        value: fmtInt(total) },
            { label: 'Indexed',           value: fmtInt(s.indexed) },
            { label: 'Not indexed',       value: fmtInt(s.not_indexed) },
            { label: 'Submitted this run',value: fmtInt(s.submitted) },
          ])}
          <a class="btn btn-sm" href="/api/run-csv?run_id=${encodeURIComponent(r.id)}" download>Download CSV</a>
        </div>
      </details>`;
  }

  function metricsCards4(items) {
    return `<div class="metrics metrics-4">${items.map((m) => `
      <div class="metric-card">
        <div class="label">${escHTML(m.label)}</div>
        <div class="value">${escHTML(m.value)}</div>
        ${m.delta ? `<div class="delta">${escHTML(m.delta)}</div>` : ''}
      </div>`).join('')}</div>`;
  }

  function metricsCards3(items) {
    return `<div class="metrics metrics-3">${items.map((m) => `
      <div class="metric-card">
        <div class="label">${escHTML(m.label)}</div>
        <div class="value">${escHTML(m.value)}</div>
      </div>`).join('')}</div>`;
  }

  // ---------------------------------------------------------------------
  // Live run status — banner, progress bar, metrics, log tail
  // ---------------------------------------------------------------------
  function renderRunOutputArea() {
    const area = document.getElementById('run-output-area');
    if (!area) return;
    const run = state.runStatus && state.runStatus.run;
    const detail = state.detail;

    // Seed from detail payload on first render
    const cur = run || (detail && detail.current_run) || null;
    const client = detail && detail.client;
    if (!client || (!cur && !(state.runStatus && state.runStatus.run))) {
      area.innerHTML = '';
      return;
    }

    // Use `cur` when present; fall back to state.runStatus for final metrics after finish
    const s = (state.runStatus && state.runStatus.run) || cur;
    if (!s) { area.innerHTML = ''; return; }

    const running = s.status === 'running';
    let banner = '';
    if (running) {
      banner = `
        <div class="run-banner">
          <div class="run-banner-title">
            <span class="live-dot"></span>Running indexing check for ${escHTML(client.name)}
          </div>
          <div class="run-banner-sub">${escHTML(client.domain)} · started ${escHTML(fmtDateTime(s.started_at))}</div>
        </div>`;
    }

    const pct = Math.min(100, Math.max(0, Number(s.pct) || 0));
    let progressText;
    if (running && !s.total) progressText = 'Starting run…';
    else if (running) progressText = `Inspecting URL ${fmtInt(s.current)} of ${fmtInt(s.total)} · ${fmtPct(pct)}`;
    else if (s.status === 'failed') progressText = `Failed · ${escHTML(s.error || 'unknown error')}`;
    else progressText = `Done · ${fmtInt(s.total || s.current)} URLs inspected · 100%`;

    const finalPct = running ? pct : (s.status === 'done' ? 100 : pct);

    const logLines = (s.log_tail || []).slice(-40);
    const logBlock = logLines.length
      ? `<div class="log-block">${logLines.map(escHTML).join('\n')}</div>`
      : '';

    let finished = '';
    if (!running && s.status === 'done') {
      const stats = s.stats || {};
      finished = `
        <div class="alert alert-success">Run completed for ${escHTML(client.name)}.</div>
        ${metricsCards4([
          { label: 'Total URLs',   value: fmtInt(stats.total) },
          { label: 'Indexed',      value: fmtInt(stats.indexed) },
          { label: 'Not indexed',  value: fmtInt(stats.not_indexed) },
          { label: 'Submitted',    value: fmtInt(stats.submitted) },
        ])}
        <a class="btn btn-primary btn-sm" href="/api/run-csv?run_id=${encodeURIComponent(s.id)}" download>Download CSV</a>`;
    } else if (!running && s.status === 'failed') {
      finished = `<div class="alert alert-error"><strong>Run failed:</strong> ${escHTML(s.error || 'unknown error')}</div>`;
    }

    area.innerHTML = `
      ${banner}
      <div class="progress-text">${progressText}</div>
      <div class="progress"><div class="progress-fill" style="width:${finalPct.toFixed(1)}%"></div></div>
      ${metricsCards3([
        { label: 'URLs inspected',  value: fmtInt(s.current) },
        { label: 'Total in sitemap',value: s.total ? fmtInt(s.total) : '—' },
        { label: 'Progress',        value: fmtPct(pct) },
      ])}
      ${logBlock}
      ${finished}
      <hr />`;
  }

  async function pollRunStatus() {
    if (!state.clientId || state.view !== 'detail') return;
    try {
      const data = await API.getRunStatus(state.clientId);
      state.runStatus = data;
      renderRunOutputArea();

      // Also refresh the Run tab button's disabled state by re-rendering it
      const detail = state.detail;
      if (detail) {
        const running = data.run && data.run.status === 'running';
        detail.current_run = running ? data.run : null;
        const runPanel = document.querySelector('[data-tab-panel="run"]');
        if (runPanel) renderRunTab(runPanel, detail.client);
      }

      if (!data.run || data.run.status !== 'running') {
        stopPolling();
        // Reload the Overview tab when a run finishes so stats + reasons refresh
        if (data.run && data.run.status === 'done' && state.detail) {
          const fresh = await API.getClient(state.clientId);
          state.detail = fresh;
          const panel = document.querySelector('[data-tab-panel="overview"]');
          if (panel) renderOverviewTab(panel, fresh);
        }
      }
    } catch (e) {
      console.warn('[run-status]', e.message);
    }
  }

  // ---------------------------------------------------------------------
  // Add client
  // ---------------------------------------------------------------------
  async function renderAdd(root) {
    const tpl = document.getElementById('tpl-add').content.cloneNode(true);
    root.innerHTML = '';
    root.appendChild(tpl);

    const form = root.querySelector('#add-form');
    const errBox = root.querySelector('#add-error');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errBox.hidden = true;
      const fd = new FormData(form);
      const payload = {
        name:         fd.get('name'),
        website:      fd.get('website'),
        sitemap_url:  fd.get('sitemap_url'),
        gsc_site_url: fd.get('gsc_site_url'),
      };
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      const original = submitBtn.textContent;
      submitBtn.textContent = 'Saving…';
      try {
        const resp = await API.createClient(payload);
        navigate('detail', { clientId: resp.client.id });
      } catch (err) {
        errBox.hidden = false;
        errBox.textContent = err.message;
        submitBtn.disabled = false;
        submitBtn.textContent = original;
      }
    });
  }

  // ---------------------------------------------------------------------
  // Wire up global listeners and boot
  // ---------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const navBtn = e.target.closest('[data-view]');
    if (navBtn) {
      navigate(navBtn.dataset.view);
      return;
    }
    const navLink = e.target.closest('[data-nav]');
    if (navLink) {
      navigate(navLink.dataset.nav);
      return;
    }
    const tc = e.target.closest('[data-theme-choice]');
    if (tc) {
      applyTheme(tc.dataset.themeChoice);
      return;
    }
  });

  window.addEventListener('hashchange', () => {
    const parsed = readHash();
    if (parsed.view === state.view && parsed.clientId === state.clientId) return;
    navigate(parsed.view, { clientId: parsed.clientId });
  });

  // Stop polling when the tab is hidden (saves bandwidth + quota)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else if (state.view === 'list' || state.view === 'detail') render();
  });

  // Boot
  applyTheme(state.theme);
  const initial = readHash();
  navigate(initial.view, { clientId: initial.clientId });
})();
