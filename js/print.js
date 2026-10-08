/* Scope Lock — the agreement "document" (on-screen summary + printable one-page A4). */
(function () {
  'use strict'
  const A = window.SLAgreement
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="currentColor" opacity=".14"/><path d="M4.6 8.3l2.2 2.2 4.6-4.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  const CROSS = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="currentColor" opacity=".12"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'

  function ukTime (iso) {
    if (!iso) return ''
    const d = new Date(iso); if (isNaN(d)) return esc(iso)
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) + ' UK'
  }
  function statusPill (a) {
    const p = A.partiesOf(a)
    const lockedNow = (a.locks || []).some(l => l.parties === p && p !== 'none')
    if (lockedNow) return '<span class="pill locked">Locked on BSV</span>'
    if (p === 'both') return '<span class="pill ready">Both agreed</span>'
    if (p === 'freelancer') return '<span class="pill partial">Freelancer agreed</span>'
    if (p === 'client') return '<span class="pill partial">Client agreed</span>'
    return '<span class="pill">Draft</span>'
  }

  /** Inner HTML of the summary document. opts: { explorer: {main,test} } */
  function render (a, opts = {}) {
    const v = (x, ph) => x ? esc(x) : `<span class="empty">${ph}</span>`
    const fact = (k, val, cls = '') => `<div><div class="k">${k}</div><div class="v ${cls} ${val ? '' : 'empty'}">${val || '—'}</div></div>`
    const inc = (a.included || []).length ? a.included.map(i => `<li class="in">${TICK}<span>${esc(i)}</span></li>`).join('') : '<li class="empty">Add what\'s included…</li>'
    const exc = (a.excluded || []).length ? a.excluded.map(i => `<li class="out">${CROSS}<span>${esc(i)}</span></li>`).join('') : '<li class="empty">Nothing listed yet. Adding exclusions is what prevents arguments later.</li>'
    const sig = (who, c, name) => c
      ? `<div class="sig"><div class="who">${who}</div><div class="name">${esc(c.name)}</div><div class="when">agreed ${ukTime(c.at)}</div></div>`
      : `<div class="sig pending"><div class="who">${who}</div><div class="name">${name ? esc(name) + ' has not confirmed yet' : 'Not confirmed yet'}</div></div>`
    const exp = opts.explorer || {}
    const locks = (a.locks || []).length
      ? `<div class="locks">${a.locks.map(l => `Locked (${l.parties === 'both' ? 'both parties' : l.parties + ' only'}) ${ukTime(l.at)} · <a href="${esc((exp[l.network] || '') + l.txid)}" target="_blank" rel="noopener">${l.txid.slice(0, 12)}…</a>${l.network === 'test' ? ' (testnet)' : ''}`).join('<br>')}</div>`
      : ''
    return `<div class="doc-top"><div class="doc-eyebrow">Agreed scope of work</div><div class="doc-status">${statusPill(a)}</div></div>
      <div class="doc-title ${a.job ? '' : 'empty'}">${a.job ? esc(a.job) : 'Job title'}</div>
      <div class="doc-ref">${esc(a.ref)}</div>
      <div class="doc-facts">
        ${fact('Client', a.client ? esc(a.client) : '')}
        ${fact('Freelancer', a.freelancer ? esc(a.freelancer) : '')}
        ${fact('Price', A.formatPrice(a.price) ? esc(A.formatPrice(a.price)) + ' <span style="font-size:12px;font-weight:600;color:#8A877F">GBP</span>' : '', 'price')}
        ${fact('Work starts', A.formatDate(a.start) ? esc(A.formatDate(a.start)) : '')}
      </div>
      <h4 class="in">Included</h4><ul>${inc}</ul>
      <h4 class="out">Not included</h4><ul>${exc}</ul>
      <div class="rule">Only the work listed under <b>Included</b> is part of this job. Anything else, including everything under <b>Not included</b>, needs a new agreement or quote.</div>
      <div class="doc-sigs">${sig('Freelancer', a.conf && a.conf.freelancer, a.freelancer)}${sig('Client', a.conf && a.conf.client, a.client)}</div>
      ${locks}`
  }

  function qrSvg (text) {
    try { const q = qrcode(0, 'L'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 3, margin: 0, scalable: true }) } catch (e) { return '' }
  }

  /**
   * Full printable page. d: { a, text, hashHex, lock (or null), explorerUrl, shareUrl, explorer }
   */
  function page (d) {
    const lock = d.lock
    const verifyBlock = lock
      ? `<table>
          <tr><td>Fingerprint</td><td class="mono">${esc(d.hashHex)}</td></tr>
          <tr><td>Transaction</td><td class="mono"><a href="${esc(d.explorerUrl)}">${esc(lock.txid)}</a>${lock.network === 'test' ? ' (testnet)' : ''}</td></tr>
          <tr><td>Locked</td><td>${esc(ukTime(lock.at))} by the locker's clock · the block time on the explorer is the authoritative time</td></tr>
        </table>`
      : `<table><tr><td>Fingerprint</td><td class="mono">${esc(d.hashHex)}</td></tr><tr><td>Status</td><td><b>Not locked on the blockchain yet.</b> This page is a summary only.</td></tr></table>`
    const qrTarget = lock ? d.explorerUrl : ''
    return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Scope agreement · ${esc(d.a.job || d.a.ref)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
@page{size:A4;margin:12mm}
*{box-sizing:border-box}body{margin:0;background:#EDEAE3;font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#141414;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{max-width:794px;margin:24px auto;background:#fff;padding:40px 46px;border-radius:4px;box-shadow:0 20px 60px -30px rgba(0,0,0,.35)}
.brand{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#8A877F;margin-bottom:18px}
.brand b{color:#2D4BD8;letter-spacing:.14em;text-transform:uppercase;font-size:10.5px}
.doc{position:relative}
.doc-eyebrow{font-size:10.5px;font-weight:750;letter-spacing:.16em;text-transform:uppercase;color:#2D4BD8}
.doc-title{font-size:26px;font-weight:750;letter-spacing:-.02em;line-height:1.15;margin:6px 0 2px}
.doc-ref{font:11.5px ui-monospace,Menlo,Consolas,monospace;color:#8A877F}
.doc-top{display:flex;justify-content:space-between;align-items:center;gap:12px}
.pill{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;background:#E9EDFD;color:#2D4BD8;padding:4px 9px;border-radius:999px}
.pill.ready{background:#E3F4EC;color:#1F8A5B}.pill.partial{background:#FFF5DB;color:#8A6A12}.pill.locked{background:#141414;color:#fff}
.doc-facts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px 18px;margin:16px 0 4px;padding:12px 0;border-top:1px solid #E4E0D6;border-bottom:1px solid #E4E0D6}
.k{font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8A877F}
.v{font-weight:600}.v.price{font-size:18px;font-weight:780}
h4{margin:14px 0 6px;font-size:10.5px;font-weight:750;letter-spacing:.1em;text-transform:uppercase}
h4.in{color:#1F8A5B}h4.out{color:#C3332B}
ul{list-style:none;margin:0;padding:0;columns:2;column-gap:28px}
li{display:flex;gap:8px;padding:2px 0;break-inside:avoid}
li svg{width:14px;height:14px;flex:none;margin-top:2px}
li.in svg{color:#1F8A5B}li.out svg{color:#C3332B}li.empty{color:#8A877F;font-style:italic}
.rule{font-size:11.5px;color:#55534E;background:#F7F5F0;border-radius:6px;padding:8px 11px;margin-top:12px}
.doc-sigs{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:20px}
.sig{border-top:1.5px solid #141414;padding-top:6px}
.who{font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8A877F}
.name{font:italic 600 19px/1.25 Georgia,"Times New Roman",serif;margin-top:2px}
.sig.pending .name{color:#8A877F;font:500 12px system-ui;font-style:normal}
.when{font-size:11px;color:#8A877F}
.locks{display:none}
.record{margin-top:22px;border:1.5px solid #141414;border-radius:8px;padding:14px 16px;display:flex;gap:16px;align-items:flex-start}
.record h5{margin:0 0 4px;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase}
.record .body{flex:1;min-width:0}
table{width:100%;border-collapse:collapse}
td{padding:5px 0;border-top:1px solid #EFEBE2;vertical-align:top;font-size:11.5px}
td:first-child{width:92px;color:#8A877F;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding-top:7px}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:10.5px;word-break:break-all}
a{color:#141414}
.qr{width:92px;height:92px;flex:none}.qr svg{width:100%;height:100%}
.how{font-size:10.5px;color:#55534E;margin-top:12px}
.btn{position:fixed;right:20px;top:20px;background:#141414;color:#fff;border:0;border-radius:10px;padding:10px 16px;font:600 14px system-ui;cursor:pointer}
@media print{body{background:#fff}.sheet{box-shadow:none;margin:0;max-width:none;padding:0}.btn{display:none}}
</style></head><body>
<button class="btn" onclick="window.print()">Print / Save as PDF</button>
<div class="sheet">
  <div class="brand"><b>Scope Lock</b><span>Printed ${esc(ukTime(new Date().toISOString()))}</span></div>
  <div class="doc">${render(d.a, { explorer: d.explorer })}</div>
  <div class="record">
    <div class="body">
      <h5>Blockchain record</h5>
      ${verifyBlock}
      <div class="how">To check it: open the Verify tab at ${esc(d.siteUrl || 'the Scope Lock site')}, paste the exact agreement text (keep the .txt file or the share link) and the transaction ID. If even one character differs, it will not match. A lock proves this text existed by the block time. It is not a signed contract and not legal advice.</div>
    </div>
    ${qrTarget ? `<div class="qr">${qrSvg(qrTarget)}</div>` : ''}
  </div>
</div></body></html>`
  }

  function open (d) {
    const w = window.open('', '_blank')
    if (!w) { download(d); return }
    w.document.open(); w.document.write(page(d)); w.document.close()
    setTimeout(() => { try { w.focus(); w.print() } catch (e) {} }, 400)
  }
  function download (d) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([page(d)], { type: 'text/html' }))
    a.download = `scope-${A.shortRef(d.a.ref).toLowerCase()}.html`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }
  window.SLDoc = { render, page, open, download, ukTime }
})()
