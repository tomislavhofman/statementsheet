/* StatementSheet app: everything runs in the browser; files are never uploaded. */
(function () {
  'use strict';

  const CFG = window.SS_CONFIG;
  const T = window.SS_I18N;
  const LANG = document.documentElement.lang || 'en';
  const LIB = {
    zip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    xlsx: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  };
  const LICENSE_KEY = 'statementsheet.license';
  const REVALIDATE_MS = 30 * 24 * 3600 * 1000;
  const MAX_ROWS = 500;
  const STATEMENT_FILE = /\.(xml|camt|053|052|054|sta|mt940|940|942|txt|dat)$/i;

  const $ = (sel) => document.querySelector(sel);
  const state = { statements: [], errors: [], files: 0, query: '' };

  /* ---------- helpers ---------- */

  const track = (name, data) => {
    try { window.umami && window.umami.track(name, data); } catch (_) { /* analytics is optional */ }
  };

  const loaded = {};
  function loadScript(src) {
    loaded[src] = loaded[src] || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('load ' + src));
      document.head.appendChild(s);
    });
    return loaded[src];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const nf = new Intl.NumberFormat(LANG, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (v) => (v == null ? '' : nf.format(v));

  // camt is UTF-8; MT940 files from German banks are often ISO-8859-1 / Windows-1252.
  function decode(buf) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (_) {
      return new TextDecoder('windows-1252').decode(buf);
    }
  }

  /* ---------- reading files ---------- */

  async function* expand(file) {
    if (/\.zip$/i.test(file.name)) {
      await loadScript(LIB.zip);
      const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || /(^|\/)(__MACOSX|\.)/.test(entry.name)) continue;
        if (STATEMENT_FILE.test(entry.name)) yield { name: entry.name, data: () => entry.async('arraybuffer') };
      }
      return;
    }
    yield { name: file.name, data: () => file.arrayBuffer() };
  }

  async function handleFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    setBusy(true);
    let added = 0;
    for (const f of files) {
      try {
        for await (const item of expand(f)) {
          try {
            const stmts = window.StatementParser.parseText(decode(await item.data()));
            stmts.forEach((s) => { s.file = item.name; });
            state.statements.push(...stmts);
            state.files++;
            added += stmts.length;
          } catch (e) {
            state.errors.push({ file: item.name, msg: e instanceof window.StatementParser.NotAStatementError ? T.err_not_statement : (e.message || T.err_read) });
          }
        }
      } catch (e) {
        state.errors.push({ file: f.name, msg: e.message || T.err_read });
      }
    }
    setBusy(false);
    track('parse', { added, errors: state.errors.length, files: state.files, tx: transactions().length });
    render();
  }

  /* ---------- data ---------- */

  function transactions() {
    const out = [];
    state.statements.forEach((s, si) => {
      for (const e of s.entries) out.push({ ...e, account: s.account.id, file: s.file, si });
    });
    return out.sort((a, b) => (a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : 0));
  }

  const description = (t) => t.remittance || t.info || t.bankCode;
  const matches = (t, q) => !q || [t.counterparty, t.counterpartyAccount, t.remittance, t.info, t.reference, t.endToEndId, t.mandateId, t.bookingDate, money(t.amount), String(t.amount), t.account]
    .some((v) => v && String(v).toLowerCase().includes(q));

  /* ---------- rendering ---------- */

  function setBusy(on) {
    $('#ss-drop').classList.toggle('busy', on);
    $('#ss-drop-status').textContent = on ? T.parsing : '';
  }

  function render() {
    const stmts = state.statements;
    const txs = transactions();
    $('#ss-results').hidden = stmts.length === 0 && state.errors.length === 0;
    $('#ss-count').textContent = T.n_summary.replace('{s}', stmts.length).replace('{n}', txs.length);

    $('#ss-stmt-body').innerHTML = stmts.map((s) => `
      <tr>
        <td>${esc(s.account.id || '—')}${s.account.owner ? `<div class="muted small">${esc(s.account.owner)}</div>` : ''}</td>
        <td class="nowrap">${esc(s.from)}${s.to && s.to !== s.from ? ` – ${esc(s.to)}` : ''}</td>
        <td class="num">${s.opening ? money(s.opening.amount) : ''}</td>
        <td class="num pos">${money(s.credits)}</td>
        <td class="num neg">${money(s.debits)}</td>
        <td class="num">${s.closing ? money(s.closing.amount) : ''}</td>
        <td class="num">${s.entries.length}</td>
        <td class="muted small">${esc(s.account.currency)} · ${esc(s.format)}${s.warnings.length ? ` <span class="warn" title="${esc(T.warn_balance)}">⚠</span>` : ''}</td>
      </tr>`).join('');

    const q = state.query.trim().toLowerCase();
    const shown = txs.filter((t) => matches(t, q));
    const accounts = new Set(stmts.map((s) => s.account.id));
    $('#ss-tx').classList.toggle('one-account', accounts.size < 2);
    $('#ss-tx-body').innerHTML = shown.slice(0, MAX_ROWS).map((t) => `
      <tr>
        <td class="nowrap">${esc(t.bookingDate)}${/^PDNG$/i.test(t.status) ? `<div class="muted small">${esc(T.pending)}</div>` : ''}</td>
        <td class="num ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)} <span class="muted small">${esc(t.currency)}</span></td>
        <td>${esc(t.counterparty)}${t.counterpartyAccount ? `<div class="muted small mono">${esc(t.counterpartyAccount)}</div>` : ''}</td>
        <td class="desc">${esc(description(t))}${t.reversal ? ` <span class="tag">${esc(T.reversal)}</span>` : ''}${t.reference ? `<div class="muted small mono">${esc(t.reference)}</div>` : ''}</td>
        <td class="muted small mono acct">${esc(t.account)}</td>
      </tr>`).join('');
    $('#ss-showing').textContent = shown.length > MAX_ROWS ? T.showing.replace('{shown}', MAX_ROWS).replace('{n}', shown.length) : '';

    // Money in / out per currency over the filtered rows.
    const sums = {};
    for (const t of shown) {
      const s = (sums[t.currency || '?'] ||= { in: 0, out: 0 });
      if (t.amount > 0) s.in += t.amount; else s.out += t.amount || 0;
    }
    $('#ss-tx-foot').innerHTML = Object.entries(sums).map(([cur, s]) => `
      <tr><td>${esc(T.totals)}</td><td class="num">${money(s.in + s.out)} <span class="muted small">${esc(cur)}</span></td>
      <td colspan="3" class="muted small">${esc(T.col_credits)}: ${money(s.in)} · ${esc(T.col_debits)}: ${money(s.out)}</td></tr>`).join('');

    $('#ss-errors').innerHTML = state.errors.map((e) => `<li><strong>${esc(e.file)}</strong>: ${esc(e.msg)}</li>`).join('');
    $('#ss-errors').hidden = !state.errors.length;
    renderGateNote();
  }

  /* ---------- export ---------- */

  function sheets() {
    const tx = [[T.col_file, T.col_account, T.col_booking, T.col_value, T.col_amount, T.col_currency, T.col_dc, T.col_counterparty, T.col_cp_account,
      T.col_cp_bic, T.col_ultimate, T.col_remittance, T.col_reference, T.col_e2e, T.col_mandate, T.col_creditor, T.col_bankcode, T.col_info,
      T.col_bankref, T.col_status]];
    for (const t of transactions()) {
      tx.push([t.file, t.account, t.bookingDate, t.valueDate, t.amount, t.currency, t.amount < 0 ? T.debit : T.credit, t.counterparty,
        t.counterpartyAccount, t.counterpartyBic, t.ultimateParty, t.remittance, t.reference, t.endToEndId, t.mandateId, t.creditorId, t.bankCode,
        t.info, t.bankRef, [t.status, t.reversal ? T.reversal : ''].filter(Boolean).join(' ')]);
    }
    const st = [[T.col_file, T.col_format, T.col_account, T.col_owner, T.col_currency, T.col_stmt, T.col_from, T.col_to, T.col_opening,
      T.col_credits, T.col_debits, T.col_closing, T.col_count, T.col_check]];
    for (const s of state.statements) {
      st.push([s.file, s.format, s.account.id, s.account.owner, s.account.currency, s.seq || s.id, s.from, s.to, s.opening ? s.opening.amount : null,
        s.credits, s.debits, s.closing ? s.closing.amount : null, s.entries.length, s.warnings.length ? T.warn_balance : 'OK']);
    }
    return { transactions: tx, statements: st };
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function exportXlsx() {
    await loadScript(LIB.xlsx);
    const X = window.XLSX;
    const s = sheets();
    const wb = X.utils.book_new();
    const add = (rows, name) => {
      const ws = X.utils.aoa_to_sheet(rows);
      ws['!cols'] = rows[0].map((h, c) => ({ wch: Math.min(48, Math.max(String(h).length, ...rows.slice(1, 200).map((r) => String(r[c] ?? '').length)) + 2) }));
      ws['!autofilter'] = { ref: X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) };
      X.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    };
    add(s.transactions, T.sheet_tx);
    add(s.statements, T.sheet_stmt);
    X.writeFile(wb, `statements-${stamp()}.xlsx`);
  }

  // Excel outside English locales expects ';' separators and decimal commas in CSV.
  function exportCsv() {
    const semi = LANG !== 'en';
    const sep = semi ? ';' : ',';
    const cell = (v) => {
      if (v == null) return '';
      if (typeof v === 'number') return semi ? String(v).replace('.', ',') : String(v);
      const s = String(v);
      return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = '﻿' + sheets().transactions.map((r) => r.map(cell).join(sep)).join('\r\n');
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `transactions-${stamp()}.csv`);
  }

  /* ---------- Pro licence (Polar) ---------- */

  const paymentsLive = () => Boolean(CFG.checkoutUrl && CFG.polarOrgId);

  function readLicense() {
    try { return JSON.parse(localStorage.getItem(LICENSE_KEY) || 'null'); } catch (_) { return null; }
  }
  function saveLicense(v) {
    try { v ? localStorage.setItem(LICENSE_KEY, JSON.stringify(v)) : localStorage.removeItem(LICENSE_KEY); } catch (_) { /* private mode */ }
  }
  const isPro = () => Boolean(readLicense());

  // Returns true/false for a definite answer, null when Polar could not be reached.
  async function validateKey(key) {
    try {
      const r = await fetch('https://api.polar.sh/v1/customer-portal/license-keys/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, organization_id: CFG.polarOrgId }),
      });
      if (r.ok) return (await r.json()).status === 'granted';
      return r.status === 404 || r.status === 422 ? false : null;
    } catch (_) {
      return null;
    }
  }

  async function revalidateQuietly() {
    const lic = readLicense();
    if (!lic || !paymentsLive() || Date.now() - lic.checked < REVALIDATE_MS) return;
    const ok = await validateKey(lic.key);
    if (ok === false) saveLicense(null);
    else if (ok) saveLicense({ key: lic.key, checked: Date.now() });
    renderGateNote();
  }

  function renderGateNote() {
    const el = $('#ss-gate-note');
    if (!paymentsLive()) el.textContent = T.launch_free;
    else if (isPro()) el.textContent = T.pro_active;
    else el.textContent = T.free_limit.replace('{n}', CFG.freeLimit);
  }

  const needsPro = () => paymentsLive() && !isPro() && state.files > CFG.freeLimit;

  function guarded(fn, label) {
    return async () => {
      if (!state.statements.length) return;
      if (needsPro()) {
        $('#ss-paywall-count').textContent = state.files;
        $('#ss-key-msg').textContent = '';
        $('#ss-paywall').showModal();
        track('paywall_shown', { n: state.files });
        return;
      }
      track('export', { type: label, files: state.files, pro: isPro() });
      await fn();
    };
  }

  /* ---------- wiring ---------- */

  function init() {
    const drop = $('#ss-drop');
    const input = $('#ss-file');
    drop.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') input.click(); });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

    $('#ss-search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
    $('#ss-xlsx').addEventListener('click', guarded(exportXlsx, 'xlsx'));
    $('#ss-csv').addEventListener('click', guarded(exportCsv, 'csv'));
    $('#ss-clear').addEventListener('click', () => { state.statements = []; state.errors = []; state.files = 0; render(); });
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

    $('#ss-buy').href = CFG.checkoutUrl || '#';
    $('#ss-buy').addEventListener('click', () => track('checkout_click', { n: state.files }));
    $('#ss-key-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = $('#ss-key').value.trim();
      if (!key) return;
      $('#ss-key-msg').textContent = '…';
      const ok = await validateKey(key);
      if (ok) {
        saveLicense({ key, checked: Date.now() });
        $('#ss-key-msg').textContent = T.key_ok;
        track('license_ok');
        renderGateNote();
        setTimeout(() => $('#ss-paywall').close(), 900);
      } else {
        $('#ss-key-msg').textContent = ok === false ? T.key_bad : T.key_offline;
      }
    });

    renderGateNote();
    revalidateQuietly();
  }

  init();
})();
