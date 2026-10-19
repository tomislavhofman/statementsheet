/* StatementSheet parser: turns bank statements into plain objects.
 * - ISO 20022 camt.053 (statement), camt.052 (intraday report), camt.054 (debit/credit
 *   notification), any version from .001.01 to .001.13;
 * - SWIFT MT940 / MT942 text statements, including the German ?-structured field 86 and the
 *   Dutch /KEY/value style.
 * No dependencies; XML needs a DOMParser-compatible implementation. Matching is by local name
 * so namespace prefixes and versions never matter. */
(function (root) {
  'use strict';

  class NotAStatementError extends Error {}

  /* ---------------- XML helpers ---------------- */

  const local = (n) => n.localName || n.nodeName.split(':').pop();

  function kids(el, name) {
    const out = [];
    if (!el) return out;
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && local(c) === name) out.push(c);
    }
    return out;
  }

  function all(el, path) {
    let cur = el ? [el] : [];
    for (const step of path.split('/')) {
      const next = [];
      for (const e of cur) next.push(...kids(e, step));
      cur = next;
    }
    return cur;
  }

  function at(el, paths) {
    for (const p of [].concat(paths)) {
      const hit = all(el, p)[0];
      if (hit) return hit;
    }
    return null;
  }

  const txt = (el, paths) => {
    const n = paths ? at(el, paths) : el;
    return n ? n.textContent.replace(/\s+/g, ' ').trim() : '';
  };
  const toNum = (s) => {
    if (s === '' || s == null) return null;
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  };
  const attr = (el, name) => (el && el.getAttribute(name)) || '';
  const r2 = (v) => Math.round(v * 100) / 100;

  // ISO dates come as Dt (date) or DtTm (date-time); keep the calendar date.
  const date = (el, path) => txt(el, [`${path}/Dt`, `${path}/DtTm`, path]).slice(0, 10);

  // Signed amount: debits are negative.
  function signed(amountEl, indicator) {
    const v = toNum(amountEl ? amountEl.textContent.trim() : '');
    if (v == null) return null;
    return /^DBIT$/i.test(indicator) ? -v : v;
  }

  /* ---------------- ISO 20022 camt.052 / .053 / .054 ---------------- */

  const NOT_PROVIDED = /^NOTPROVIDED$/i;
  const clean = (s) => (NOT_PROVIDED.test(s) ? '' : s);

  // Parties moved one level down in version .08 (Dbtr/Pty/Nm instead of Dbtr/Nm).
  const partyName = (rp, who) => txt(rp, [`${who}/Nm`, `${who}/Pty/Nm`, `${who}/Agt/FinInstnId/Nm`]);
  const accountId = (rp, who) => txt(rp, [`${who}Acct/Id/IBAN`, `${who}Acct/Id/Othr/Id`]);

  function bankCode(el) {
    const b = at(el, 'BkTxCd');
    if (!b) return '';
    const iso = [txt(b, 'Domn/Cd'), txt(b, 'Domn/Fmly/Cd'), txt(b, 'Domn/Fmly/SubFmlyCd')].filter(Boolean).join('-');
    return [iso, txt(b, 'Prtry/Cd')].filter(Boolean).join(' / ');
  }

  function balanceOf(stmt, codes) {
    for (const code of codes) {
      const b = kids(stmt, 'Bal').find((x) => txt(x, ['Tp/CdOrPrtry/Cd', 'Tp/CdOrPrtry/Prtry']) === code);
      if (b) {
        const amt = at(b, 'Amt');
        return { type: code, amount: signed(amt, txt(b, 'CdtDbtInd')), currency: attr(amt, 'Ccy'), date: date(b, 'Dt') };
      }
    }
    return null;
  }

  function camtRow(entry, tx, amount, currency, defaults) {
    const indicator = txt(tx, 'CdtDbtInd') || txt(entry, 'CdtDbtInd');
    const credit = !/^DBIT$/i.test(indicator);
    const rp = at(tx, 'RltdPties');
    const ra = at(tx, 'RltdAgts');
    // The counterparty is whoever is on the other side: the payer for money in, the payee for money out.
    const other = credit ? 'Dbtr' : 'Cdtr';
    const ultimate = credit ? 'UltmtDbtr' : 'UltmtCdtr';
    const ustrd = all(tx, 'RmtInf/Ustrd').map((u) => u.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const credId = all(rp, 'Cdtr/Id/PrvtId/Othr').concat(all(rp, 'Cdtr/Pty/Id/PrvtId/Othr'))
      .find((o) => /SEPA/i.test(txt(o, 'SchmeNm/Prtry')));
    return {
      bookingDate: date(entry, 'BookgDt') || date(entry, 'ValDt'),
      valueDate: date(entry, 'ValDt'),
      amount,
      currency,
      status: txt(entry, ['Sts/Cd', 'Sts/Prtry', 'Sts']) || defaults.status,
      reversal: txt(entry, 'RvslInd') === 'true',
      counterparty: partyName(rp, other) || partyName(rp, ultimate),
      counterpartyAccount: accountId(rp, other),
      counterpartyBic: txt(ra, [`${other}Agt/FinInstnId/BICFI`, `${other}Agt/FinInstnId/BIC`]),
      ultimateParty: partyName(rp, ultimate),
      remittance: ustrd.join(' '),
      reference: txt(tx, ['RmtInf/Strd/CdtrRefInf/Ref', 'RmtInf/Strd/RfrdDocInf/Nb']),
      endToEndId: clean(txt(tx, 'Refs/EndToEndId')),
      mandateId: txt(tx, 'Refs/MndtId'),
      creditorId: credId ? txt(credId, 'Id') : '',
      bankCode: bankCode(tx) || bankCode(entry),
      info: [txt(entry, 'AddtlNtryInf'), tx !== entry ? txt(tx, 'AddtlTxInf') : ''].filter(Boolean).join(' · '),
      bankRef: txt(tx, 'Refs/AcctSvcrRef') || txt(entry, 'AcctSvcrRef') || txt(entry, 'NtryRef'),
    };
  }

  function camtEntries(stmt, defaultCcy) {
    const rows = [];
    for (const entry of kids(stmt, 'Ntry')) {
      const amtEl = at(entry, 'Amt');
      const currency = attr(amtEl, 'Ccy') || defaultCcy;
      const total = signed(amtEl, txt(entry, 'CdtDbtInd'));
      const txs = all(entry, 'NtryDtls/TxDtls');
      // A batch booking holds several transactions; split it only when each one has its own amount.
      const txAmount = (tx) => {
        const a = at(tx, ['Amt', 'AmtDtls/TxAmt/Amt', 'AmtDtls/InstdAmt/Amt']);
        if (!a || (attr(a, 'Ccy') && attr(a, 'Ccy') !== currency)) return null;
        return signed(a, txt(tx, 'CdtDbtInd') || txt(entry, 'CdtDbtInd'));
      };
      if (txs.length > 1 && txs.every((tx) => txAmount(tx) != null)) {
        for (const tx of txs) rows.push(camtRow(entry, tx, txAmount(tx), currency, { status: '' }));
      } else {
        const row = camtRow(entry, txs[0] || entry, total, currency, { status: '' });
        if (txs.length > 1) {
          const more = txs.slice(1).map((tx) => camtRow(entry, tx, null, currency, { status: '' }));
          row.remittance = [row.remittance, ...more.map((m) => m.remittance)].filter(Boolean).join(' | ');
          row.counterparty = [row.counterparty, ...more.map((m) => m.counterparty)].filter(Boolean).join(' | ');
        }
        rows.push(row);
      }
    }
    return rows;
  }

  function parseCamt(rootEl) {
    let msg = rootEl;
    if (local(rootEl) === 'Document') {
      msg = null;
      for (let c = rootEl.firstChild; c && !msg; c = c.nextSibling) if (c.nodeType === 1) msg = c;
      if (!msg) throw new NotAStatementError('empty');
    }
    const kindByMsg = { BkToCstmrStmt: 'camt.053', BkToCstmrAcctRpt: 'camt.052', BkToCstmrDbtCdtNtfctn: 'camt.054' };
    // Version .001.01 wrapped the message in a versioned element name (BkToCstmrAcctRptV01).
    const msgName = local(msg).replace(/V\d\d$/, '');
    const kind = kindByMsg[msgName];
    if (!kind) throw new NotAStatementError('root:' + msgName);
    const ns = rootEl.namespaceURI || msg.namespaceURI || '';
    const version = (ns.match(/camt\.05[234]\.001\.\d+/) || [kind])[0];
    const stmtTag = { 'camt.053': 'Stmt', 'camt.052': 'Rpt', 'camt.054': 'Ntfctn' }[kind];
    const created = txt(msg, 'GrpHdr/CreDtTm');

    return kids(msg, stmtTag).map((stmt) => {
      const acct = at(stmt, 'Acct');
      const currency = txt(acct, 'Ccy');
      const opening = balanceOf(stmt, ['OPBD', 'PRCD']);
      // Intraday reports (camt.052) often only carry an interim booked balance.
      const closing = balanceOf(stmt, ['CLBD', 'ITBD']);
      const entries = camtEntries(stmt, currency || (opening && opening.currency) || '');
      const s = {
        format: version,
        kind,
        id: txt(stmt, 'Id'),
        seq: txt(stmt, ['ElctrncSeqNb', 'LglSeqNb']),
        created: txt(stmt, 'CreDtTm') || created,
        from: txt(stmt, 'FrToDt/FrDtTm').slice(0, 10),
        to: txt(stmt, 'FrToDt/ToDtTm').slice(0, 10),
        account: {
          id: txt(acct, ['Id/IBAN', 'Id/Othr/Id']),
          currency: currency || (opening && opening.currency) || (entries[0] && entries[0].currency) || '',
          name: txt(acct, 'Nm'),
          owner: txt(acct, ['Ownr/Nm', 'Ownr/Pty/Nm']),
          bic: txt(acct, ['Svcr/FinInstnId/BICFI', 'Svcr/FinInstnId/BIC']),
          bank: txt(acct, 'Svcr/FinInstnId/Nm'),
        },
        opening,
        closing,
        entries,
      };
      finish(s);
      return s;
    });
  }

  /* ---------------- SWIFT MT940 / MT942 ---------------- */

  const yymmdd = (s) => {
    if (!/^\d{6}$/.test(s)) return '';
    const yy = +s.slice(0, 2);
    return `${yy < 80 ? 2000 + yy : 1900 + yy}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
  };
  const swiftNum = (s) => toNum((s || '').replace(/\s/g, '').replace(',', '.').replace(/\.$/, ''));

  function mtBalance(v) {
    const m = /^([CD])(\d{6})([A-Z]{3})([\d,.]+)/.exec((v || '').replace(/\s+/g, ''));
    if (!m) return null;
    const n = swiftNum(m[4]);
    return { amount: m[1] === 'D' ? -n : n, currency: m[3], date: yymmdd(m[2]) };
  }

  // Field 86 has three common shapes: German "GVC?20...?32..." subfields, "/KEY/value" (NL),
  // or free text.
  function details86(lines) {
    const raw = lines.join('\n');
    const g = /^\s*(\d{3})\s*([?@#|^~])/.exec(raw);
    if (g) {
      const sep = g[2];
      const flat = lines.join('');
      const sub = {};
      const parts = flat.slice(flat.indexOf(sep)).split(sep).filter(Boolean);
      for (const p of parts) {
        const k = p.slice(0, 2);
        if (/^\d\d$/.test(k)) (sub[k] ||= []).push(p.slice(2));
      }
      const pick = (...ks) => ks.flatMap((k) => sub[k] || []).join('');
      const purpose = pick('20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '60', '61', '62', '63');
      const sepa = {};
      const keyed = purpose.split(/(EREF|KREF|MREF|CRED|DEBT|COAM|OAMT|SVWZ|ABWA|ABWE|IBAN|BIC)\+/);
      for (let i = 1; i < keyed.length; i += 2) sepa[keyed[i]] = keyed[i + 1].trim();
      return {
        bankCode: [g[1], pick('00')].filter(Boolean).join(' '),
        remittance: (keyed.length > 1 ? sepa.SVWZ || keyed[0].trim() : purpose).replace(/\s+/g, ' ').trim(),
        counterparty: pick('32', '33').replace(/\s+/g, ' ').trim(),
        counterpartyAccount: pick('31').trim(),
        counterpartyBic: pick('30').trim(),
        endToEndId: clean(sepa.EREF || ''),
        mandateId: sepa.MREF || '',
        creditorId: sepa.CRED || '',
        ultimateParty: sepa.ABWA || sepa.ABWE || '',
        info: pick('34'),
      };
    }
    const flat = lines.join('');
    if (/^\s*\/(?:[A-Z]{2,4})\//.test(flat) && /\/(NAME|REMI|IBAN|CNTP|EREF|TRTP)\//.test(flat)) {
      const KEYS = 'EREF|BENM|ORDP|NAME|IBAN|BIC|REMI|MARF|CSID|TRTP|ADDR|ISDT|CNTP|SVCL|ULTC|ULTD|ULTB|PURP|RTRN|PREF|ATOS|ACCW|BUSP|FX|CITY|IDNR';
      const toks = flat.split(new RegExp(`/(${KEYS})/`));
      const kv = {};
      for (let i = 1; i < toks.length; i += 2) if (!(toks[i] in kv)) kv[toks[i]] = toks[i + 1].replace(/\/+$/, '').trim();
      let name = kv.NAME || '';
      let account = kv.IBAN || '';
      let bic = kv.BIC || '';
      if (kv.CNTP != null) {
        // ING style: /CNTP/IBAN/BIC/NAME/CITY/
        const c = kv.CNTP.split('/');
        account ||= c[0] || '';
        bic ||= c[1] || '';
        name ||= c[2] || '';
      }
      return {
        bankCode: kv.TRTP || '',
        remittance: (kv.REMI || '').replace(/^(USTD|STRD)\/\/?/, '').replace(/\/+$/, '').trim(),
        counterparty: name,
        counterpartyAccount: account,
        counterpartyBic: bic,
        endToEndId: clean((kv.EREF || '').split('/')[0]),
        mandateId: kv.MARF || '',
        creditorId: kv.CSID || '',
        ultimateParty: '',
        info: '',
      };
    }
    return {
      bankCode: '', remittance: lines.map((l) => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' '), counterparty: '', counterpartyAccount: '',
      counterpartyBic: '', endToEndId: '', mandateId: '', creditorId: '', ultimateParty: '', info: '',
    };
  }

  // :61: value date YYMMDD, optional entry date MMDD, mark (C, D, RC, RD, EC, ED), optional funds
  // code, amount, type (N/F/S + 3), customer reference, //bank reference, supplementary details.
  const IBAN_LIKE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;
  const LINE61 = /^(\d{6})(\d{4})?(RC|RD|EC|ED|C|D)([A-Z])?(\d[\d,]*)([NFS][A-Z0-9]{3})(.*)$/;

  function mtLine(v, currency) {
    const text = v.join('\n');
    const head = v.length > 1 && !LINE61.test(v[0].replace(/\s/g, '')) ? v.join('') : v[0];
    const m = LINE61.exec(head.replace(/\s+$/, '').replace(/^\s+/, ''));
    if (!m) return null;
    const valueDate = yymmdd(m[1]);
    let bookingDate = valueDate;
    if (m[2]) {
      let y = +valueDate.slice(0, 4);
      const vm = +valueDate.slice(5, 7);
      const em = +m[2].slice(0, 2);
      if (em === 12 && vm === 1) y -= 1;
      if (em === 1 && vm === 12) y += 1;
      bookingDate = `${y}-${m[2].slice(0, 2)}-${m[2].slice(2, 4)}`;
    }
    const mark = m[3];
    const n = swiftNum(m[5]);
    const negative = mark === 'D' || mark === 'RC' || mark === 'ED';
    const rest = m[7];
    const [customerRef, bankRef = ''] = rest.split('//');
    const supplementary = head === v[0] ? v.slice(1).join(' ').trim() : '';
    return {
      bookingDate, valueDate, amount: n == null ? null : negative ? -n : n, currency,
      status: mark.startsWith('E') ? 'PDNG' : 'BOOK',
      reversal: mark.startsWith('R'),
      type: m[6], customerRef: clean(customerRef.trim().replace(/^NONREF$/i, '')), bankRef: bankRef.trim(), supplementary, text,
    };
  }

  function parseMt940(text) {
    const body = text.replace(/\r\n?/g, '\n');
    // Split into tagged fields; lines that do not start a new tag continue the previous one.
    const fields = [];
    for (const line of body.split('\n')) {
      const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
      if (m) fields.push({ tag: m[1], lines: [m[2]] });
      else if (fields.length && !/^-\}?\s*$/.test(line) && !/^\{/.test(line)) fields[fields.length - 1].lines.push(line);
    }
    if (!fields.some((f) => f.tag === '61') && !fields.some((f) => /^6[02]/.test(f.tag))) throw new NotAStatementError('mt940');

    const stmts = [];
    let cur = null;
    let last = null;
    const start = () => {
      cur = { format: 'MT940', kind: 'mt940', id: '', seq: '', created: '', from: '', to: '', account: { id: '', currency: '', name: '', owner: '', bic: '', bank: '' }, opening: null, closing: null, entries: [] };
      stmts.push(cur);
      last = null;
    };
    for (const f of fields) {
      const v = f.lines.join('\n').trim();
      if (f.tag === '20') { start(); cur.id = v; continue; }
      if (!cur) start();
      switch (f.tag) {
        case '25': {
          const a = v.replace(/\s+/g, '');
          const ccy = /([A-Z]{3})$/.exec(a);
          cur.account.id = ccy && /\d/.test(a.slice(0, -3)) && a.length > 3 && !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(a) ? a.slice(0, -3) : a;
          if (ccy && cur.account.id !== a) cur.account.currency = ccy[1];
          break;
        }
        case '28': case '28C': cur.seq = v; break;
        case '13D': cur.created = v; break;
        case '60F': case '60M': {
          // A new 60F after entries means a second statement in the same file without :20:.
          if (cur.opening && cur.entries.length) { const id = cur.id; const acc = { ...cur.account }; start(); cur.id = id; cur.account = acc; }
          cur.opening = mtBalance(v);
          if (cur.opening) { cur.account.currency ||= cur.opening.currency; cur.from = cur.opening.date; }
          break;
        }
        case '62F': case '62M':
          cur.closing = mtBalance(v);
          if (cur.closing) { cur.account.currency ||= cur.closing.currency; cur.to = cur.closing.date; }
          break;
        case '61': {
          const l = mtLine(f.lines, cur.account.currency || (cur.opening && cur.opening.currency) || '');
          if (l) { cur.entries.push(l); last = l; }
          break;
        }
        case '86':
          if (last && !last.details) last.details = details86(f.lines);
          else if (cur) cur.info = [cur.info, v].filter(Boolean).join(' ');
          break;
        default:
      }
    }
    return stmts.filter((s) => s.entries.length || s.opening || s.closing).map((s) => {
      s.entries = s.entries.map((l) => {
        const d = l.details || details86([]);
        return {
          bookingDate: l.bookingDate, valueDate: l.valueDate, amount: l.amount, currency: l.currency || s.account.currency,
          status: l.status, reversal: l.reversal,
          // Some banks (Rabobank) put the counterparty IBAN in the :61: supplementary details.
          counterparty: d.counterparty, counterpartyBic: d.counterpartyBic, ultimateParty: d.ultimateParty,
          counterpartyAccount: d.counterpartyAccount || (IBAN_LIKE.test(l.supplementary) ? l.supplementary : ''),
          remittance: d.remittance, reference: l.customerRef, endToEndId: d.endToEndId, mandateId: d.mandateId,
          creditorId: d.creditorId, bankCode: [l.type, d.bankCode].filter(Boolean).join(' '), bankRef: l.bankRef,
          info: [d.info, IBAN_LIKE.test(l.supplementary) ? '' : l.supplementary].filter(Boolean).join(' '),
        };
      });
      if (s.entries.length && !s.from) s.from = s.entries[0].bookingDate;
      finish(s);
      return s;
    });
  }

  /* ---------------- shared ---------------- */

  // Opening balance + booked entries should equal the closing balance.
  function finish(s) {
    s.credits = r2(s.entries.reduce((a, e) => a + (e.amount > 0 ? e.amount : 0), 0));
    s.debits = r2(s.entries.reduce((a, e) => a + (e.amount < 0 ? e.amount : 0), 0));
    s.warnings = [];
    const booked = s.entries.filter((e) => !/^(PDNG|INFO)$/i.test(e.status) && e.amount != null);
    if (s.opening && s.closing && s.opening.amount != null && s.closing.amount != null && s.kind !== 'camt.052') {
      const sum = booked.reduce((a, e) => a + e.amount, 0);
      if (Math.abs(s.opening.amount + sum - s.closing.amount) > 0.005) s.warnings.push('balance');
    }
    const dates = s.entries.map((e) => e.bookingDate).filter(Boolean).sort();
    s.from ||= dates[0] || (s.opening && s.opening.date) || (s.closing && s.closing.date) || '';
    s.to ||= dates[dates.length - 1] || (s.closing && s.closing.date) || s.from;
  }

  function parseText(text, DOMParserImpl) {
    const t = text.replace(/^﻿/, '');
    if (/^\s*</.test(t)) {
      const P = DOMParserImpl || root.DOMParser;
      const doc = new P().parseFromString(t, 'application/xml');
      if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) throw new NotAStatementError('xml');
      let el = doc.documentElement;
      // Some banks wrap the Document in an envelope.
      if (local(el) !== 'Document' && !/^BkToCstmr/.test(local(el))) {
        const inner = doc.getElementsByTagNameNS('*', 'Document')[0];
        if (!inner) throw new NotAStatementError('root:' + local(el));
        el = inner;
      }
      return parseCamt(el);
    }
    if (/:(20|25|60F|61):/.test(t)) return parseMt940(t);
    throw new NotAStatementError('unknown');
  }

  root.StatementParser = { parseText, NotAStatementError };
})(typeof globalThis !== 'undefined' ? globalThis : this);
