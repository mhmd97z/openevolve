// Test Results tab — loads evolve_scheduler test_runner summary.json via Flask API

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function combinedScoreColor(cs) {
    if (typeof cs !== 'number' || !isFinite(cs)) return '#888888';
    const t = Math.max(0, Math.min(1, cs));
    const r = Math.round(255 * (1 - t));
    const g = Math.round(40 + 215 * t);
    const b = Math.round(50 + 30 * (1 - t));
    return `rgb(${r},${g},${b})`;
}

function scenarioTooltip(sr) {
    if (!sr || typeof sr !== 'object') return '';
    const parts = [];
    if (sr.failure_reason) parts.push(`failure: ${sr.failure_reason}`);
    if (typeof sr.combined_score === 'number') parts.push(`combined_score: ${sr.combined_score.toFixed(4)}`);
    if (typeof sr.avg_p95_latency_ratio === 'number') parts.push(`avg_p95_lat_r: ${sr.avg_p95_latency_ratio.toFixed(4)}`);
    if (typeof sr.avg_p95_prb_ratio === 'number') parts.push(`avg_p95_prb_r: ${sr.avg_p95_prb_ratio.toFixed(4)}`);
    if (typeof sr.scheduler_exec_us === 'number') parts.push(`exec_us: ${sr.scheduler_exec_us.toFixed(2)}`);
    if (sr.valid === false) parts.push('valid: false');
    if (sr.ue_starvation) parts.push('UE starvation');
    return parts.join('\n');
}

function renderTestTable(data) {
    const inner = document.getElementById('test-results-inner');
    if (!inner) return;

    const programs = Array.isArray(data.programs) ? data.programs : [];
    const order = Array.isArray(data.all_scenario_order) ? data.all_scenario_order : [];
    const trainSet = new Set((data.scenarios && data.scenarios.training) || []);
    const testSet = new Set((data.scenarios && data.scenarios.test) || []);

    let trainCount = 0;
    let testCount = 0;
    order.forEach((name) => {
        if (trainSet.has(name)) trainCount += 1;
        if (testSet.has(name)) testCount += 1;
    });

    const theadRows = [];
    theadRows.push('<tr>');
    theadRows.push('<th rowspan="2">Rank</th>');
    theadRows.push('<th rowspan="2">Program</th>');
    theadRows.push('<th colspan="3">Evolution (checkpoint)</th>');
    if (trainCount > 0) {
        theadRows.push(`<th colspan="${trainCount}">Training scenarios (re-run)</th>`);
    }
    if (testCount > 0) {
        theadRows.push(`<th colspan="${testCount}">Test scenarios</th>`);
    }
    theadRows.push('</tr><tr>');
    theadRows.push('<th>combined</th><th>avg_lat_r</th><th>avg_prb_r</th>');
    order.forEach((name) => {
        if (!trainSet.has(name)) return;
        const shortName = name.replace(/\.json$/i, '');
        theadRows.push(`<th title="${escapeHtml(name)}">${escapeHtml(shortName)}</th>`);
    });
    order.forEach((name) => {
        if (!testSet.has(name)) return;
        const shortName = name.replace(/\.json$/i, '');
        theadRows.push(`<th title="${escapeHtml(name)}">${escapeHtml(shortName)}</th>`);
    });
    theadRows.push('</tr>');

    const bodyRows = [];
    programs.forEach((p) => {
        const tm = p.training_metrics || {};
        const cs = typeof tm.combined_score === 'number' ? tm.combined_score.toFixed(4) : '—';
        const al = typeof tm.avg_p95_latency_ratio === 'number' ? tm.avg_p95_latency_ratio.toFixed(4) : '—';
        const ap = typeof tm.avg_p95_prb_ratio === 'number' ? tm.avg_p95_prb_ratio.toFixed(4) : '—';
        const pid = p.id || '';
        const rank = p.rank != null ? p.rank : '';

        bodyRows.push('<tr>');
        bodyRows.push(`<td>${escapeHtml(String(rank))}</td>`);
        bodyRows.push(
            `<td><a href="/program/${escapeHtml(pid)}" target="_blank" rel="noopener">${escapeHtml(pid)}</a></td>`
        );
        bodyRows.push(`<td>${escapeHtml(cs)}</td><td>${escapeHtml(al)}</td><td>${escapeHtml(ap)}</td>`);

        const srMap = p.scenario_results || {};
        order.forEach((name) => {
            if (!trainSet.has(name)) return;
            const sr = srMap[name];
            const val = sr && typeof sr.combined_score === 'number' ? sr.combined_score.toFixed(3) : '—';
            const bg = sr ? combinedScoreColor(sr.combined_score) : '#444';
            const fg = sr && typeof sr.combined_score === 'number' && sr.combined_score > 0.55 ? '#111' : '#eee';
            const tip = escapeHtml(scenarioTooltip(sr));
            bodyRows.push(
                `<td style="background:${bg};color:${fg};text-align:center;font-weight:600;" title="${tip}">${escapeHtml(val)}</td>`
            );
        });
        order.forEach((name) => {
            if (!testSet.has(name)) return;
            const sr = srMap[name];
            const val = sr && typeof sr.combined_score === 'number' ? sr.combined_score.toFixed(3) : '—';
            const bg = sr ? combinedScoreColor(sr.combined_score) : '#444';
            const fg = sr && typeof sr.combined_score === 'number' && sr.combined_score > 0.55 ? '#111' : '#eee';
            const tip = escapeHtml(scenarioTooltip(sr));
            bodyRows.push(
                `<td style="background:${bg};color:${fg};text-align:center;font-weight:600;" title="${tip}">${escapeHtml(val)}</td>`
            );
        });
        bodyRows.push('</tr>');
    });

    const meta = `
      <div style="margin:0 1em 1em 1em;font-size:0.95em;color:#888;">
        <div><b>Run:</b> ${escapeHtml(data.run || '')}</div>
        <div><b>Test config:</b> ${escapeHtml(data.test_config || '')}</div>
        <div><b>Generated:</b> ${escapeHtml(data.generated_at || '')}</div>
        <div><b>Checkpoint:</b> ${escapeHtml(data.checkpoint_used || '')}</div>
      </div>
    `;

    const table = `
      <div style="margin:0 1em;">
        <table class="metrics-table" style="border-collapse:collapse;width:100%;min-width:720px;">
          <thead>${theadRows.join('')}</thead>
          <tbody>${bodyRows.join('')}</tbody>
        </table>
      </div>
    `;

    inner.innerHTML = meta + table;
}

function showTestError(msg) {
    const inner = document.getElementById('test-results-inner');
    if (inner) inner.innerHTML = `<p style="margin:1em;color:#c62828;">${escapeHtml(msg)}</p>`;
}

async function loadTestConfigsIntoSelect(selectEl) {
    const r = await fetch('/api/test_results');
    if (!r.ok) {
        showTestError(`Failed to list test results (${r.status})`);
        return null;
    }
    const data = await r.json();
    const configs = data.configs || [];
    selectEl.innerHTML = '';
    configs.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        selectEl.appendChild(opt);
    });
    return configs;
}

async function loadTestDetail(configStem) {
    if (!configStem) {
        showTestError('No test_results bundle selected.');
        return;
    }
    const r = await fetch(`/api/test_results/${encodeURIComponent(configStem)}`);
    if (!r.ok) {
        showTestError(`Failed to load summary (${r.status})`);
        return;
    }
    const data = await r.json();
    if (data.error) {
        showTestError(data.error);
        return;
    }
    renderTestTable(data);
}

function ensureTestToolbar() {
    const container = document.getElementById('view-test');
    if (!container) return null;
    let tb = document.getElementById('test-results-toolbar');
    if (!tb) {
        container.innerHTML =
            '<div id="test-results-toolbar" style="margin:0 1em 1em 1em;display:flex;flex-wrap:wrap;gap:12px;align-items:center;"></div>' +
            '<div id="test-results-inner"></div>';
        tb = document.getElementById('test-results-toolbar');
    }
    if (tb && tb.childElementCount === 0) {
        const label = document.createElement('label');
        label.className = 'toolbar-label';
        label.htmlFor = 'test-results-select';
        label.textContent = 'Result bundle: ';
        const select = document.createElement('select');
        select.id = 'test-results-select';
        select.style.maxWidth = '320px';
        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.textContent = 'Refresh';
        refresh.style.padding = '0.35em 0.9em';
        const hint = document.createElement('span');
        hint.style.color = '#888';
        hint.style.fontSize = '0.92em';
        hint.innerHTML =
            'Generate with: <code style="background:#f0f0f0;padding:2px 6px;border-radius:4px;">python3 evolve_scheduler/test_runner.py --config evolve_scheduler/test_configs/&lt;name&gt;.yaml</code>';
        tb.appendChild(label);
        tb.appendChild(select);
        tb.appendChild(refresh);
        tb.appendChild(hint);

        select.addEventListener('change', () => {
            loadTestDetail(select.value);
        });
        refresh.addEventListener('click', async () => {
            const configs = await loadTestConfigsIntoSelect(select);
            if (configs && configs.length) {
                if (!configs.includes(select.value)) select.selectedIndex = 0;
                await loadTestDetail(select.value);
            } else {
                showTestError('No test_results/*/summary.json found for this run. Run test_runner.py first.');
            }
        });
    }
    return document.getElementById('test-results-select');
}

async function loadTestTab() {
    ensureTestToolbar();
    const select = document.getElementById('test-results-select');
    if (!select) return;
    const configs = await loadTestConfigsIntoSelect(select);
    if (!configs || !configs.length) {
        showTestError('No test_results/*/summary.json found for this run. Run test_runner.py first.');
        return;
    }
    if (!select.value) select.selectedIndex = 0;
    await loadTestDetail(select.value);
}

const tabTest = document.getElementById('tab-test');
if (tabTest) {
    tabTest.addEventListener('click', () => {
        loadTestTab();
    });
}
