/* Scope Lock — UI + network glue. Stamping approach shared with Proof of Design v1. */
(function () {
  'use strict'
  const cfg = window.SL_CONFIG
  const Core = window.SLCore
  const A = window.SLAgreement
  const Doc = window.SLDoc
  const P = cfg.storagePrefix || 'sl.'
  const $ = id => document.getElementById(id)
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const ROLES = ['freelancer', 'client']
  const partyEl = role => $(role === 'freelancer' ? 'partyFreelancer' : 'partyClient')

  const state = {
    network: localStorage.getItem(P + 'network') || cfg.defaultNetwork || 'main',
    a: null,
    hashHex: null,
    price: null,
    satsPerKb: cfg.fallbackSatsPerKb,
    balance: null,
    pubTitleTouched: false
  }

  // ---------- formatting ----------
  const fmtSats = n => Number(n).toLocaleString('en-GB') + ' sats'
  function fiat (sats) {
    if (!state.price || !state.price.gbp) return ''
    const gbp = sats / 1e8 * state.price.gbp
    if (gbp < 0.01) return `≈ ${(gbp * 100).toPrecision(2)}p`
    return `≈ £${gbp.toFixed(2)}`
  }
  const explorerUrl = (txid, net = state.network) => cfg.explorer[net] + txid
  const wocBase = (net = state.network) => cfg.woc[net]
  const addrPrefix = net => net === 'test' ? [0x6f] : [0x00]
  const siteUrl = () => location.href.split('#')[0]
  const sameName = (x, y) => A.normalise(x).replace(/\s+/g, ' ').toLowerCase() === A.normalise(y).replace(/\s+/g, ' ').toLowerCase()

  // ---------- small UI helpers ----------
  function notice (el, msg, kind = '') {
    el.className = 'notice' + (kind ? ' ' + kind : '')
    el.innerHTML = '<div>' + msg + '</div>'
    el.classList.remove('hidden')
  }
  function hide (el) { el.classList.add('hidden') }
  function modal ({ title, body, ok = 'OK', cancel = 'Cancel', input = null }) {
    return new Promise(resolve => {
      $('modalTitle').textContent = title
      $('modalBody').innerHTML = body + (input ? `<input id="modalInput" placeholder="${esc(input)}" spellcheck="false" autocomplete="off">` : '')
      $('modalOk').textContent = ok
      $('modalCancel').textContent = cancel
      $('modalCancel').classList.toggle('hidden', cancel === null)
      $('modal').classList.remove('hidden')
      const inp = $('modalInput'); if (inp) setTimeout(() => inp.focus(), 30)
      const done = v => { $('modal').classList.add('hidden'); $('modalOk').onclick = $('modalCancel').onclick = null; resolve(v) }
      $('modalOk').onclick = () => done(input ? (inp.value || '').trim() : true)
      $('modalCancel').onclick = () => done(input ? null : false)
    })
  }
  function busy (btn, on, label) {
    if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span><span>${label}</span>`; btn.disabled = true } else { btn.innerHTML = btn.dataset.label || btn.innerHTML; btn.disabled = false }
  }
  async function fetchJSON (url, opts = {}, timeoutMs = 15000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const r = await fetch(url, { ...opts, signal: ctl.signal })
      if (!r.ok) { const e = new Error(`HTTP ${r.status} from ${new URL(url).host}`); e.status = r.status; throw e }
      const ct = r.headers.get('content-type') || ''
      return ct.includes('json') ? r.json() : r.text()
    } finally { clearTimeout(t) }
  }
  async function copyText (text, btn, label) {
    try { await navigator.clipboard.writeText(text) } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select()
      try { document.execCommand('copy') } catch (e2) {} ta.remove()
    }
    if (btn) { const old = label || btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = old }, 1500) }
  }
  function downloadFile (name, text, type = 'text/plain;charset=utf-8') {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type }))
    a.download = name; document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }

  // ---------- agreement storage ----------
  function shape (a) {
    a.conf = a.conf || {}; a.conf.freelancer = a.conf.freelancer || null; a.conf.client = a.conf.client || null
    a.locks = Array.isArray(a.locks) ? a.locks : []; a.included = a.included || []; a.excluded = a.excluded || []
    return a
  }
  function loadDraft () {
    try { const a = JSON.parse(localStorage.getItem(P + 'draft')); if (a && A.validRef(a.ref)) return shape(a) } catch (e) {}
    return A.blank()
  }
  function saveDraft () { localStorage.setItem(P + 'draft', JSON.stringify(state.a)) }
  const hasContent = a => !!(a.job || a.client || a.price || a.included.length || a.excluded.length)
  const parties = () => A.partiesOf(state.a)
  /** The lock (if any) that covers exactly the current text. */
  function currentLock () {
    if (!state.hashHex) return null
    return [...state.a.locks].reverse().find(l => l.hash && state.hashHex.startsWith(l.hash)) || null
  }

  // ---------- form <-> agreement ----------
  const FIELDS = ['job', 'client', 'freelancer', 'price', 'start']
  function fillForm () {
    for (const f of FIELDS) $(f).value = state.a[f] || ''
    $('included').value = state.a.included.join('\n')
    $('excluded').value = state.a.excluded.join('\n')
    $('pubTitle').value = state.a.pubTitle || ''
    state.pubTitleTouched = !!state.a.pubTitle
    for (const r of ROLES) { const el = partyEl(r); el.querySelector('.party-name').value = ''; el.querySelector('.party-tick').checked = false }
  }
  function readForm () {
    if (parties() !== 'none') return // terms are frozen once someone agreed
    for (const f of FIELDS) state.a[f] = $(f).value
    state.a.job = state.a.job.replace(/[\r\n]+/g, ' ')
    state.a.included = A.parseList($('included').value)
    state.a.excluded = A.parseList($('excluded').value)
  }

  // ---------- render ----------
  let hashSeq = 0
  async function render () {
    const a = state.a
    const p = parties()
    // summary + fingerprint
    $('summary').innerHTML = Doc.render(a, { explorer: cfg.explorer })
    const seq = ++hashSeq
    const h = await A.sha256Hex(A.canonicalText(a))
    if (seq !== hashSeq) return
    state.hashHex = h
    $('fingerprint').textContent = h

    // terms editable?
    const frozen = p !== 'none'
    for (const id of [...FIELDS, 'included', 'excluded']) $(id).disabled = frozen
    $('termsLocked').classList.toggle('hidden', !frozen)
    $('termsCard').classList.toggle('frozen', frozen)
    document.querySelector('#tab-agree .grid').classList.toggle('frozen', frozen)
    const miss = A.missing(a)
    $('missingLine').className = miss.length ? 'muted small-text' : 'small-text ok'
    $('missingLine').textContent = miss.length ? 'Still needed before anyone can agree: ' + miss.join(', ') + '.' : '✓ Ready for both of you to agree.'

    // parties
    for (const r of ROLES) {
      const el = partyEl(r); const c = a.conf[r]
      el.classList.toggle('done', !!c)
      el.querySelector('.party-pending').classList.toggle('hidden', !!c)
      el.querySelector('.party-done').classList.toggle('hidden', !c)
      const formName = r === 'freelancer' ? a.freelancer : a.client
      el.querySelector('.party-name').placeholder = formName ? `Type your full name (${A.normalise(formName)})` : 'Type your full name'
      if (c) {
        el.querySelector('.signed-name').textContent = c.name
        el.querySelector('.party-time').textContent = 'Agreed ' + Doc.ukTime(c.at)
      }
      updatePartyButton(r)
    }

    // share box wording
    const who = p === 'freelancer' ? 'client' : p === 'client' ? 'freelancer' : null
    $('shareTitle').textContent = p === 'both' ? 'Send the agreed scope to the other person' : who ? `${who === 'client' ? 'Client' : 'Freelancer'} not with you?` : 'Other person not with you?'
    $('shareSub').textContent = p === 'both'
      ? 'The link carries the full agreement, both confirmations and any locks, so they keep their own copy and can verify it.'
      : who === 'client'
        ? 'Send them a link to read the scope and add their confirmation. You can lock it now with just your confirmation, or wait and lock it once they agree. The whole agreement travels inside the link, so nothing is stored on a server.'
        : who === 'freelancer'
          ? 'Send the freelancer a link back so they can add their confirmation and lock it. The whole agreement travels inside the link, so nothing is stored on a server.'
          : 'Send them a link to read the scope. The whole agreement travels inside the link, so nothing is stored on a server.'
    if (!$('shareLinkRow').classList.contains('hidden')) fillShareLink()

    // lock card
    const lock = currentLock()
    const pill = $('lockWho')
    if (lock) { pill.className = 'pill locked'; pill.textContent = 'Locked' } else if (p === 'both') { pill.className = 'pill ready'; pill.textContent = 'Both agreed · ready' } else if (p !== 'none') { pill.className = 'pill partial'; pill.textContent = 'One confirmation' } else { pill.className = 'pill'; pill.textContent = 'Not ready' }
    $('lockExplain').innerHTML = lock
      ? 'This exact agreement is locked. If anything changes, both of you will need to agree again and lock the new version.'
      : p === 'freelancer' || p === 'client'
        ? `Only the <b>${p}</b> has agreed so far. You can lock it now and send the ${p === 'freelancer' ? 'client' : 'freelancer'} a link. When they confirm, lock it again so the record includes both names.`
        : 'Locking writes a fingerprint of the full agreement, including both names and confirmation times, to the BSV blockchain. The agreement itself stays private. Only the fingerprint and the short title below are public.'
    $('lockBtn').disabled = !!lock || p === 'none' || miss.length > 0
    if (!state.pubTitleTouched) $('pubTitle').value = 'Scope agreed · ' + A.shortRef(a.ref)
    if (lock) showLockResult(lock); else hide($('lockResult'))
    if (!lock) hide($('lockStatus'))
  }
  function updatePartyButton (r) {
    const el = partyEl(r); const btn = el.querySelector('.party-btn')
    const name = A.normalise(el.querySelector('.party-name').value)
    const miss = A.missing(state.a)
    btn.disabled = !name || !el.querySelector('.party-tick').checked || miss.length > 0
    btn.title = miss.length ? 'Fill in the ' + miss.join(', ') + ' first' : (!name ? 'Type your name first' : '')
    let note = el.querySelector('.note'); const formName = r === 'freelancer' ? state.a.freelancer : state.a.client
    const mismatch = name && formName && !sameName(name, formName)
    if (mismatch && !note) { note = document.createElement('div'); note.className = 'note'; el.querySelector('.party-pending').appendChild(note) }
    if (note) { if (mismatch) note.textContent = `This doesn't match the ${r} name in the agreement (${A.normalise(formName)}). That's allowed, but a match is clearer.`; else note.remove() }
  }

  // ---------- confirm / undo / edit ----------
  function confirmRole (r) {
    readForm()
    if (A.missing(state.a).length) return
    const el = partyEl(r)
    const name = A.normalise(el.querySelector('.party-name').value).replace(/\s+/g, ' ')
    if (!name || !el.querySelector('.party-tick').checked) return
    state.a.price = A.cleanPrice(state.a.price)
    state.a.conf[r] = { name, at: A.isoSeconds(new Date()) }
    el.querySelector('.party-name').value = ''; el.querySelector('.party-tick').checked = false
    $('price').value = state.a.price
    saveDraft(); render()
  }
  async function undoRole (r) {
    const inLock = state.a.locks.some(l => l.parties === 'both' || l.parties === r)
    const ok = await modal({ title: `Undo the ${r}'s confirmation?`, body: inLock ? 'This confirmation is already in a lock on the blockchain. Undoing it here does <b>not</b> remove that record, it only changes this page.' : 'They will need to confirm again before the agreement can be locked with their name.', ok: 'Undo' })
    if (!ok) return
    state.a.conf[r] = null; saveDraft(); render()
  }
  async function editTerms () {
    const ok = await modal({ title: 'Change the terms?', body: 'Both confirmations will be cleared and each person will need to agree again. The changed agreement gets a new reference number. Any earlier lock stays on the blockchain (and in <b>Your locks</b>), but it won\'t match the new terms.', ok: 'Change the terms' })
    if (!ok) return
    state.a.conf = { freelancer: null, client: null }; state.a.locks = []; state.a.ref = A.makeRef()
    if (!state.pubTitleTouched) state.a.pubTitle = ''
    saveDraft(); hide($('shareLinkRow')); render(); $('job').focus()
  }
  async function newAgreement () {
    if (hasContent(state.a) && !currentLock()) {
      const ok = await modal({ title: 'Start a new agreement?', body: 'This clears the form on this page. Locked agreements are kept in <b>Your locks</b> under Key &amp; funds.', ok: 'Start new' })
      if (!ok) return
    }
    const name = state.a.freelancer
    state.a = A.blank(); state.a.freelancer = name
    saveDraft(); fillForm(); hide($('shareLinkRow')); hide($('linkBanner')); render()
    window.scrollTo({ top: 0, behavior: 'smooth' }); $('job').focus()
  }

  // ---------- share links ----------
  const shareUrl = (a = state.a) => siteUrl() + '#' + A.encodeShare(a)
  function fillShareLink () {
    const a = state.a; const url = shareUrl()
    $('shareLink').value = url
    const p = parties()
    const toClient = p !== 'client'
    const to = toClient ? A.normalise(a.client) : A.normalise(a.freelancer)
    const from = toClient ? A.normalise(a.freelancer) : A.normalise(a.client)
    const job = A.normalise(a.job) || 'the job'
    const ask = p === 'both' ? 'Here is the scope we both agreed, so you have your own copy:' : 'Here is the scope for us both to agree before work starts. Please open the link, check what is and isn\'t included, and add your confirmation:'
    const body = `Hi${to ? ' ' + to.split(' ')[0] : ''},\n\n${ask}\n\n${url}\n\nThanks,\n${from}`
    $('emailLink').href = 'mailto:?subject=' + encodeURIComponent('Scope of work: ' + job) + '&body=' + encodeURIComponent(body)
    $('waLink').href = 'https://wa.me/?text=' + encodeURIComponent(body)
    $('nativeShare').classList.toggle('hidden', !navigator.share)
    $('nativeShare').onclick = () => navigator.share({ title: 'Scope of work: ' + job, text: body.replace(url, '').trim(), url }).catch(() => {})
  }
  function makeLink () {
    readForm(); saveDraft()
    $('shareLinkRow').classList.remove('hidden'); fillShareLink()
    $('shareLink').select()
  }

  /** Open an agreement from the URL #hash. */
  function openFromHash () {
    if (!/(^#|&)a=/.test(location.hash)) return false
    let incoming
    try { incoming = shape(A.decodeShare(location.hash)) } catch (e) {
      notice($('linkBanner'), '<b>Couldn\'t open that link.</b>&nbsp;' + esc(e.message), 'error')
      history.replaceState(null, '', siteUrl()); return false
    }
    const cur = state.a; let stashed = false
    if (cur.ref === incoming.ref && A.termsText(cur) === A.termsText(incoming)) {
      // same agreement: merge confirmations and locks
      for (const r of ROLES) cur.conf[r] = cur.conf[r] || incoming.conf[r]
      for (const l of incoming.locks) if (!cur.locks.some(x => x.txid === l.txid)) cur.locks.push(l)
      cur.locks.sort((x, y) => String(x.at).localeCompare(String(y.at)))
    } else {
      if (hasContent(cur)) { localStorage.setItem(P + 'stash', JSON.stringify(cur)); stashed = true }
      state.a = incoming
    }
    saveDraft(); fillForm()
    history.replaceState(null, '', siteUrl())
    const a = state.a; const p = A.partiesOf(a)
    const fn = esc(A.normalise(a.freelancer) || 'The freelancer'); const cn = esc(A.normalise(a.client) || 'The client')
    let msg
    if (p === 'freelancer') msg = `<b>${fn} has sent you this scope to agree.</b> Read the summary, then confirm below as the client.`
    else if (p === 'client') msg = `<b>${cn} has agreed to this scope.</b> Add your confirmation as the freelancer, then lock it.`
    else if (p === 'both') msg = a.locks.length ? '<b>Both of you have agreed and it has been locked on BSV.</b> <button class="linkish" id="bannerVerify">Check it in Verify →</button>' : '<b>Both of you have agreed.</b> Lock it below to make the record permanent.'
    else msg = '<b>Opened a shared scope.</b> Nobody has confirmed it yet.'
    if (stashed) msg += ' Your previous draft was set aside. <button class="linkish" id="restoreStash">Restore it</button>'
    notice($('linkBanner'), msg, 'ok')
    const rs = $('restoreStash'); if (rs) rs.onclick = restoreStash
    const bv = $('bannerVerify'); if (bv) bv.onclick = () => prefillVerify(a.locks[a.locks.length - 1])
    return true
  }
  function restoreStash () {
    try { const s = shape(JSON.parse(localStorage.getItem(P + 'stash'))); localStorage.removeItem(P + 'stash'); state.a = s; saveDraft(); fillForm(); hide($('linkBanner')); render() } catch (e) {}
  }

  // ---------- price & fees ----------
  async function loadPrice () {
    try {
      const d = await fetchJSON(cfg.priceUrl)
      const p = d['bitcoin-cash-sv']; if (p && p.gbp) state.price = { gbp: p.gbp, usd: p.usd }
    } catch (e) {}
    renderCosts()
  }
  async function loadFeeRate () {
    try {
      const d = await fetchJSON(cfg.arc[state.network] + '/v1/policy')
      const f = d.policy && d.policy.miningFee
      if (f && f.bytes > 0 && f.satoshis >= 0) state.satsPerKb = Math.max(1, Math.ceil(f.satoshis / f.bytes * 1000))
    } catch (e) { state.satsPerKb = cfg.fallbackSatsPerKb }
    renderCosts()
  }
  function svcFee () { return cfg.serviceFee && cfg.serviceFee.address && cfg.serviceFee.satoshis > 0 ? cfg.serviceFee : null }
  function typicalFee () {
    const scriptLen = Core.buildStampScript({ hashHex: '00'.repeat(32), title: $('pubTitle').value.trim() || 'Scope agreed · SL-XXXX', isoTime: new Date().toISOString() }).toBinary().length
    return Core.estimateFee({ inputs: 1, scriptLen, extraOutputs: svcFee() ? 1 : 0, satsPerKb: state.satsPerKb })
  }
  function renderCosts () {
    const fee = typicalFee(); const svc = svcFee()
    const total = fee + (svc ? svc.satoshis : 0)
    const f = fiat(total) || '≈ 0.0004p'
    $('costLine').textContent = `Cost ${f.replace('≈ ', 'about ')} (${fmtSats(total)}${svc ? ' incl. ' + fmtSats(svc.satoshis) + ' service fee' : ' network fee'}) · ${state.network === 'test' ? 'TESTNET' : 'mainnet'}`
    $('feeSats').textContent = fee
    $('feeFiat').textContent = fiat(fee) ? ` (${fiat(fee)})` : ''
    $('fund100k').textContent = fiat(100000) ? fiat(100000).replace('≈ ', '') : '1–2p'
    renderBalance()
  }

  // ---------- network ----------
  function setNetwork (net) {
    state.network = net; localStorage.setItem(P + 'network', net)
    document.querySelectorAll('.segbtn').forEach(b => b.classList.toggle('active', b.dataset.net === net))
    $('netBadge').textContent = net === 'test' ? 'TEST' : 'MAIN'
    $('netBadge').classList.toggle('test', net === 'test')
    $('verifyTestnet').checked = net === 'test'
    state.balance = null
    renderKey(); loadFeeRate(); renderCosts()
  }

  // ---------- locking key (separate from Proof of Design: 'sl.key.*') ----------
  const keySlot = () => P + 'key.' + state.network
  function getKey () {
    const wif = localStorage.getItem(keySlot())
    if (!wif) return null
    try { return bsv.PrivateKey.fromWif(wif) } catch (e) { return null }
  }
  const keyAddress = key => key.toPublicKey().toAddress(addrPrefix(state.network))
  function renderKey () {
    const key = getKey()
    $('noKey').classList.toggle('hidden', !!key)
    $('hasKey').classList.toggle('hidden', !key)
    if (!key) return
    const addr = keyAddress(key)
    $('address').textContent = addr
    try { const q = qrcode(0, 'M'); q.addData(addr); q.make(); $('qr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }) } catch (e) { $('qr').innerHTML = '' }
    renderBalance()
  }
  function renderBalance () {
    if (!$('balSats')) return
    if (state.balance == null) { $('balSats').textContent = '—'; $('balFiat').textContent = ''; $('balLocks').textContent = ''; return }
    $('balSats').textContent = fmtSats(state.balance)
    $('balFiat').textContent = fiat(state.balance)
    const per = typicalFee() + (svcFee() ? svcFee().satoshis : 0)
    $('balLocks').textContent = state.balance > 0 ? `Enough for roughly ${Math.floor(state.balance / per).toLocaleString('en-GB')} locks.` : 'Empty. Send a small amount of BSV to the address above.'
    if (state.balance > cfg.maxRecommendedBalanceSats) $('balLocks').textContent += ' This is more than you need, so consider withdrawing some.'
  }
  function createKey () {
    const key = bsv.PrivateKey.fromRandom()
    localStorage.setItem(keySlot(), key.toWif(state.network === 'test' ? [0xef] : [0x80]))
    renderKey(); state.balance = 0; renderBalance()
    notice($('keyStatus'), '<b>Key created.</b> Download a backup now, then send a few pence of BSV to the address.', 'ok')
  }
  async function importKey () {
    const wif = await modal({ title: 'Import locking key', body: 'Paste the WIF private key from a Scope Lock (or Proof of Design) backup file. <b>Do not paste your main wallet\'s seed phrase or keys here.</b>', input: 'WIF, e.g. L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ', ok: 'Import' })
    if (!wif) return
    if (wif.trim().split(/\s+/).length >= 12) { notice($('keyStatus'), 'That looks like a seed phrase. Never paste a seed phrase into a web page. Import cancelled.', 'error'); return }
    try {
      const k = bsv.PrivateKey.fromWif(wif.trim())
      if (getKey() && !(await modal({ title: 'Replace existing key?', body: 'This browser already has a locking key on this network. Make sure it is backed up or empty before replacing it.', ok: 'Replace' }))) return
      localStorage.setItem(keySlot(), k.toWif(state.network === 'test' ? [0xef] : [0x80]))
      renderKey(); refreshBalance()
      notice($('keyStatus'), 'Key imported.', 'ok')
    } catch (e) { notice($('keyStatus'), 'That is not a valid WIF private key.', 'error') }
  }
  function backupKey () {
    const key = getKey(); if (!key) return
    const addr = keyAddress(key)
    const txt = [
      'SCOPE LOCK — LOCKING KEY BACKUP',
      '===============================',
      '',
      `Network:  ${state.network === 'test' ? 'BSV TESTNET' : 'BSV MAINNET'}`,
      `Address:  ${addr}`,
      `Private key (WIF):  ${localStorage.getItem(keySlot())}`,
      '',
      'KEEP THIS FILE PRIVATE. Anyone who has it can spend the BSV on this address.',
      'To restore: open Scope Lock → Key & funds → Import a backup (WIF).',
      'The WIF can also be swept/imported into most BSV wallets.',
      '',
      `Created: ${new Date().toISOString()}`
    ].join('\n')
    downloadFile(`scope-lock-key-${state.network}-${addr.slice(0, 8)}.txt`, txt)
    localStorage.setItem(keySlot() + '.backedUp', '1')
  }
  async function deleteKey () {
    const bal = state.balance || 0
    const ok = await modal({ title: 'Remove locking key?', body: (bal > 0 ? `<b>This key still holds ${fmtSats(bal)}.</b> Withdraw it first or make sure you have the backup file. ` : '') + 'Removing the key deletes it from this browser. Without a backup, any BSV on it is lost for good.', ok: 'Remove key' })
    if (!ok) return
    localStorage.removeItem(keySlot()); localStorage.removeItem(keySlot() + '.backedUp'); localStorage.removeItem(P + 'pending.' + state.network)
    state.balance = null; renderKey(); hide($('keyStatus'))
  }

  // ---------- UTXOs (WhatsOnChain + local pending view) ----------
  const pendingSlot = () => P + 'pending.' + state.network
  function getPending () {
    try {
      const p = JSON.parse(localStorage.getItem(pendingSlot()) || '{"spent":[],"created":[]}')
      const cutoff = Date.now() - 6 * 3600e3
      p.spent = p.spent.filter(x => x.ts > cutoff); p.created = p.created.filter(x => x.ts > cutoff)
      return p
    } catch (e) { return { spent: [], created: [] } }
  }
  function savePending (p) { localStorage.setItem(pendingSlot(), JSON.stringify(p)) }
  function cacheTx (txid, hex) {
    try {
      const c = JSON.parse(sessionStorage.getItem(P + 'txcache') || '{}'); c[txid] = hex
      const keys = Object.keys(c); if (keys.length > 40) delete c[keys[0]]
      sessionStorage.setItem(P + 'txcache', JSON.stringify(c))
    } catch (e) {}
  }
  function cachedTx (txid) { try { return JSON.parse(sessionStorage.getItem(P + 'txcache') || '{}')[txid] } catch (e) { return null } }
  async function getUtxos (address) {
    const d = await fetchJSON(`${wocBase()}/address/${address}/unspent/all`)
    let list = (d.result || []).filter(u => !u.isSpentInMempoolTx).map(u => ({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value }))
    const p = getPending()
    const spent = new Set(p.spent.map(x => x.op))
    list = list.filter(u => !spent.has(u.txid + ':' + u.vout))
    for (const c of p.created) {
      if (c.address === address && !spent.has(c.txid + ':' + c.vout) && !list.some(u => u.txid === c.txid && u.vout === c.vout)) list.push({ txid: c.txid, vout: c.vout, satoshis: c.satoshis })
    }
    return list
  }
  async function withSources (utxos) {
    const out = []
    for (const u of utxos) {
      let hex = cachedTx(u.txid)
      if (!hex) { hex = String(await fetchJSON(`${wocBase()}/tx/${u.txid}/hex`)).trim(); cacheTx(u.txid, hex) }
      out.push({ ...u, sourceHex: hex })
    }
    return out
  }
  async function refreshBalance () {
    const key = getKey(); if (!key) return
    $('balSats').textContent = 'Checking…'
    try {
      const u = await getUtxos(keyAddress(key))
      state.balance = u.reduce((s, x) => s + x.satoshis, 0)
      renderBalance()
    } catch (e) { $('balSats').textContent = 'Could not load balance'; $('balLocks').textContent = e.message }
  }

  // ---------- broadcast ----------
  async function broadcast (tx) {
    const errors = []
    try {
      const r = await tx.broadcast(new bsv.ARC(cfg.arc[state.network]))
      if (r.status === 'success') return { txid: r.txid || tx.id('hex'), via: 'GorillaPool ARC' }
      if (/already|known|mined/i.test((r.description || '') + (r.code || ''))) return { txid: tx.id('hex'), via: 'GorillaPool ARC (already known)' }
      errors.push('ARC: ' + (r.description || r.code))
    } catch (e) { errors.push('ARC: ' + e.message) }
    try {
      const r = await tx.broadcast(new bsv.WhatsOnChainBroadcaster(state.network))
      if (r.status === 'success') return { txid: r.txid || tx.id('hex'), via: 'WhatsOnChain' }
      errors.push('WhatsOnChain: ' + (r.description || r.code))
    } catch (e) { errors.push('WhatsOnChain: ' + e.message) }
    throw new Error('The network did not accept the transaction. ' + errors.join(' · '))
  }
  function recordPending (built, address) {
    const p = getPending(); const ts = Date.now()
    for (const u of built.inputsUsed || []) p.spent.push({ op: u.txid + ':' + u.vout, ts })
    built.tx.outputs.forEach((o, i) => {
      if (o.satoshis > 0 && o.lockingScript.toHex() === new bsv.P2PKH().lock(address).toHex()) p.created.push({ txid: built.txid, vout: i, satoshis: o.satoshis, address, ts })
    })
    savePending(p); cacheTx(built.txid, built.hex)
  }

  // ---------- LOCK ----------
  async function lock () {
    const a = state.a; const status = $('lockStatus'); const btn = $('lockBtn')
    const p = parties()
    if (p === 'none' || A.missing(a).length) return
    const key = getKey()
    if (!key) { notice(status, 'You need a funded locking key first. <button class="linkish" data-goto="key">Set one up →</button>', 'error'); return }
    const text = A.canonicalText(a)
    const hashHex = await A.sha256Hex(text)
    const title = $('pubTitle').value.trim()
    const ok = await modal({
      title: p === 'both' ? 'Lock this agreement?' : `Lock with the ${p}'s confirmation only?`,
      body: `This writes the agreement's fingerprint to the BSV ${state.network === 'test' ? '<b>testnet</b>' : 'blockchain'}. It can't be undone.<br><br>Public title: <b>${esc(title || '(none)')}</b><br>Cost: ${esc($('costLine').textContent.split(' · ')[0])}`,
      ok: 'Lock it'
    })
    if (!ok) return
    const isoTime = new Date().toISOString()
    try {
      busy(btn, true, 'Finding funds…')
      const address = keyAddress(key)
      const utxos = await getUtxos(address)
      if (!utxos.length) { const e = new Error('Your locking key is empty. Send a few pence of BSV to it first.'); e.code = 'INSUFFICIENT_FUNDS'; throw e }
      utxos.sort((x, y) => y.satoshis - x.satoshis)
      const picked = []; let tot = 0
      for (const u of utxos) { picked.push(u); tot += u.satoshis; if (tot > 5000) break }
      busy(btn, false); busy(btn, true, 'Signing…')
      const built = await Core.buildStampTx({ privateKey: key, utxos: await withSources(picked), hashHex, title, isoTime, satsPerKb: state.satsPerKb, serviceFee: svcFee(), network: state.network })
      busy(btn, false); busy(btn, true, 'Broadcasting…')
      const b = await broadcast(built.tx)
      recordPending(built, address)
      state.balance = Math.max(0, (state.balance == null ? tot : state.balance) - built.fee - (svcFee() ? svcFee().satoshis : 0))
      const entry = { txid: b.txid, network: state.network, parties: p, hash: hashHex, at: A.isoSeconds(isoTime), fee: built.fee, size: built.size, via: b.via, title }
      a.locks.push(entry); a.pubTitle = title; saveDraft()
      addHistory({ ...entry, ref: a.ref, job: a.job, text, agreement: JSON.parse(JSON.stringify(a)) })
      hide(status)
      await render()
      $('lockResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } catch (e) {
      console.error(e)
      const msg = e.code === 'INSUFFICIENT_FUNDS' ? `${esc(e.message)} <button class="linkish" data-goto="key">Fund your key →</button>` : esc(e.message || String(e))
      notice(status, '<b>Not locked.</b>&nbsp;' + msg, 'error')
    } finally { busy(btn, false); render() }
  }
  function showLockResult (l) {
    const rows = [
      ['Reference', esc(state.a.ref)],
      ['Records', l.parties === 'both' ? 'Freelancer and client confirmations' : `The ${esc(l.parties)}'s confirmation only`],
      ['Fingerprint', `<span class="mono">${esc(state.hashHex)}</span>`],
      ['Transaction ID', `<a class="mono" href="${explorerUrl(l.txid, l.network)}" target="_blank" rel="noopener">${esc(l.txid)}</a>`],
      ['Locked at', esc(Doc.ukTime(l.at))],
      ['Cost', l.fee != null ? `${fmtSats(l.fee)} ${fiat(l.fee)} network fee · ${l.size} bytes` : '—'],
      ['Network', l.network === 'test' ? 'BSV testnet' : 'BSV mainnet']
    ]
    $('lockKv').innerHTML = rows.map(r => `<dt>${r[0]}</dt><dd>${r[1]}</dd>`).join('')
    $('explorerLink').href = explorerUrl(l.txid, l.network)
    $('lockResult').classList.remove('hidden')
  }

  // ---------- history (device only) ----------
  function getHistory () { try { return JSON.parse(localStorage.getItem(P + 'history') || '[]') } catch (e) { return [] } }
  function addHistory (e) { const h = getHistory(); h.unshift(e); localStorage.setItem(P + 'history', JSON.stringify(h.slice(0, 200))); renderHistory() }
  function renderHistory () {
    const h = getHistory(); const el = $('history')
    if (!h.length) { el.innerHTML = '<li class="muted">No locks yet.</li>'; return }
    el.innerHTML = h.map((e, i) => `<li>
      <div class="h-title">${esc(e.job || e.ref)}</div>
      <div class="h-meta">${esc(Doc.ukTime(e.at))} · ${e.parties === 'both' ? 'both agreed' : esc(e.parties) + ' only'}${e.network === 'test' ? ' · testnet' : ''}</div>
      <div class="h-links"><button class="linkish" data-open="${i}">Open</button><button class="linkish" data-verify="${i}">Verify</button><a href="${explorerUrl(e.txid, e.network)}" target="_blank" rel="noopener">Explorer ↗</a></div>
    </li>`).join('')
  }

  // ---------- print / text ----------
  function printSummary () {
    readForm()
    const lock = currentLock()
    Doc.open({ a: state.a, text: A.canonicalText(state.a), hashHex: state.hashHex, lock, explorerUrl: lock ? explorerUrl(lock.txid, lock.network) : '', explorer: cfg.explorer, siteUrl: siteUrl() })
  }
  const txtName = () => `scope-${state.a.ref}.txt`

  // ---------- VERIFY ----------
  let vSeq = 0
  async function updateVerifyHash () {
    const t = $('vText').value; const seq = ++vSeq
    if (!A.normalise(t)) { $('vHash').textContent = '—'; updateVerifyBtn(); return }
    const h = await A.sha256Hex(t); if (seq !== vSeq) return
    $('vHash').textContent = h; updateVerifyBtn()
  }
  function updateVerifyBtn () { $('verifyBtn').disabled = !(/^[0-9a-f]{64}$/i.test($('vHash').textContent) && /^[0-9a-f]{64}$/i.test($('txid').value.trim())) }
  function prefillVerify (l, a = state.a) {
    $('vText').value = A.canonicalText(a, { parties: l ? l.parties : 'both' })
    if (l) { $('txid').value = l.txid; $('verifyTestnet').checked = l.network === 'test' }
    hide($('verdict')); showTab('verify'); updateVerifyHash()
  }
  async function verify () {
    const txid = $('txid').value.trim().toLowerCase()
    const text = $('vText').value
    const hashHex = await A.sha256Hex(text)
    const net = $('verifyTestnet').checked ? 'test' : 'main'
    const btn = $('verifyBtn'); const out = $('verdict')
    busy(btn, true, 'Checking the blockchain…')
    try {
      let tx
      try { tx = await fetchJSON(`${wocBase(net)}/tx/${txid}`) } catch (e) {
        if (e.status === 404) throw new Error(`Transaction not found on ${net === 'test' ? 'testnet' : 'mainnet'}. Check the ID${net === 'main' ? ', or tick "testnet transaction"' : ''}. Very new transactions can take a few seconds to appear.`)
        throw e
      }
      const r = Core.findHashInTx(tx, hashHex)
      const info = A.readText(text)
      const confirmed = !!tx.blocktime && (tx.confirmations || 0) > 0
      const when = confirmed ? new Date(tx.blocktime * 1000) : null
      const whenStr = when ? `${when.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'long', timeZone: 'Europe/London' })} (UK)` : 'Not in a block yet (still in the mempool). Check again in about 10 minutes for the final block time.'
      const icon = r.match
        ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M7 12.5l3.2 3.2L17 9" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M8 8l8 8M16 8l-8 8" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>'
      let html = `<div class="verdict-big">${icon}${r.match ? 'Match. This exact agreement was locked.' : 'No match.'}</div>`
      if (r.match) html += `<p>The fingerprint of this text (<span class="mono">${hashHex.slice(0, 16)}…</span>) is recorded in this transaction${r.kind === 'scopelock' ? ' as a Scope Lock record' : ' (generic OP_RETURN hash record)'}.</p>`
      else if (r.stamp) html += `<p>This transaction holds a Scope Lock record for a <b>different</b> text (<span class="mono">${r.stamp.hashHex.slice(0, 16)}…</span>). Even a one-character change produces a different fingerprint. If one person confirmed after this lock was made, the earlier lock covers the text without their confirmation.</p>`
      else if (r.opReturns.length) html += '<p>This transaction has OP_RETURN data, but none of it matches this text\'s fingerprint.</p>'
      else html += '<p>This transaction contains no OP_RETURN data at all.</p>'
      const rows = [['Block time', esc(whenStr)], ['Block', confirmed ? `#${Number(tx.blockheight).toLocaleString('en-GB')} · ${Number(tx.confirmations).toLocaleString('en-GB')} confirmations` : '—']]
      if (r.stamp) { if (r.stamp.title) rows.push(['Public title', esc(r.stamp.title)]); rows.push(['Locker\'s clock', esc(r.stamp.isoTime)]) }
      if (r.match && info.isScopeLock) {
        rows.push(['Job', esc(info.job)], ['Reference', esc(info.ref)], ['Price', esc(info.price)], ['Freelancer', esc(info.freelancerConf)], ['Client', esc(info.clientConf)])
      }
      rows.push(['Transaction', `<a href="${explorerUrl(txid, net)}" target="_blank" rel="noopener" class="mono">${txid}</a>`])
      html += `<dl class="kv">${rows.map(x => `<dt>${x[0]}</dt><dd>${x[1]}</dd>`).join('')}</dl>`
      out.className = 'verdict ' + (r.match ? 'match' : 'nomatch'); out.innerHTML = html
    } catch (e) {
      out.className = 'verdict nomatch'; out.innerHTML = `<div class="verdict-big" style="font-size:19px">Couldn't verify</div><p>${esc(e.message)}</p>`
    } finally { busy(btn, false); updateVerifyBtn() }
  }

  // ---------- withdraw ----------
  async function withdraw () {
    const key = getKey(); if (!key) return
    const to = await modal({ title: 'Withdraw all funds', body: `Send everything on the locking key (minus a tiny network fee) to one of your own ${state.network === 'test' ? 'testnet ' : ''}BSV addresses.`, input: 'Your BSV address (starts with 1…)', ok: 'Withdraw' })
    if (!to) return
    try { new bsv.P2PKH().lock(to) } catch (e) { notice($('keyStatus'), 'That address doesn\'t look valid.', 'error'); return }
    const btn = $('withdrawBtn'); busy(btn, true, 'Withdrawing…')
    try {
      const utxos = await withSources(await getUtxos(keyAddress(key)))
      const s = await Core.buildSweepTx({ privateKey: key, utxos, toAddress: to, satsPerKb: state.satsPerKb })
      if (!(await modal({ title: 'Confirm withdrawal', body: `Send <b>${fmtSats(s.amount)}</b> ${fiat(s.amount)} to<br><code class="addr">${esc(to)}</code>`, ok: 'Send' }))) return
      const b = await broadcast(s.tx)
      const p = getPending(); utxos.forEach(u => p.spent.push({ op: u.txid + ':' + u.vout, ts: Date.now() })); savePending(p)
      state.balance = 0; renderBalance()
      notice($('keyStatus'), `Sent. <a href="${explorerUrl(b.txid)}" target="_blank" rel="noopener">View transaction ↗</a>`, 'ok')
    } catch (e) { notice($('keyStatus'), esc(e.message), 'error') } finally { busy(btn, false) }
  }

  // ---------- tabs ----------
  function showTab (name) {
    document.querySelectorAll('.tab').forEach(t => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on) })
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name))
    if (name === 'key') refreshBalance()
    window.scrollTo({ top: 0 })
  }

  // ---------- wire up ----------
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)))
  document.querySelectorAll('.segbtn').forEach(b => b.addEventListener('click', () => setNetwork(b.dataset.net)))
  document.addEventListener('click', ev => {
    const g = ev.target.closest('[data-goto]'); if (g) { ev.preventDefault(); showTab(g.dataset.goto) }
    const o = ev.target.closest('[data-open]'); if (o) {
      const e = getHistory()[+o.dataset.open]
      if (e && e.agreement) { state.a = shape(JSON.parse(JSON.stringify(e.agreement))); saveDraft(); fillForm(); render(); showTab('agree') }
    }
    const v = ev.target.closest('[data-verify]'); if (v) {
      const e = getHistory()[+v.dataset.verify]
      if (e) { $('vText').value = e.text; $('txid').value = e.txid; $('verifyTestnet').checked = e.network === 'test'; hide($('verdict')); showTab('verify'); updateVerifyHash() }
    }
  })
  for (const id of [...FIELDS, 'included', 'excluded']) $(id).addEventListener('input', () => { readForm(); saveDraft(); render() })
  $('pubTitle').addEventListener('input', () => { state.pubTitleTouched = true; state.a.pubTitle = $('pubTitle').value; saveDraft(); renderCosts() })
  for (const r of ROLES) {
    const el = partyEl(r)
    el.querySelector('.party-name').addEventListener('input', () => updatePartyButton(r))
    el.querySelector('.party-tick').addEventListener('change', () => updatePartyButton(r))
    el.querySelector('.party-btn').addEventListener('click', () => confirmRole(r))
    el.querySelector('.party-undo').addEventListener('click', () => undoRole(r))
  }
  $('editTerms').addEventListener('click', editTerms)
  $('newAgreement').addEventListener('click', newAgreement)
  $('makeLink').addEventListener('click', makeLink)
  $('copyLink').addEventListener('click', () => copyText($('shareLink').value, $('copyLink'), 'Copy link'))
  $('copyLockedLink').addEventListener('click', () => copyText(shareUrl(), $('copyLockedLink'), 'Copy link to the locked agreement'))
  $('lockBtn').addEventListener('click', lock)
  $('printBtn').addEventListener('click', printSummary)
  $('downloadTxt').addEventListener('click', () => { readForm(); downloadFile(txtName(), A.canonicalText(state.a)) })
  $('copyTxt').addEventListener('click', () => { readForm(); copyText(A.canonicalText(state.a), $('copyTxt'), 'Copy agreement text') })
  $('vText').addEventListener('input', () => {
    // pasting a share link into the text box opens the agreement it carries
    const t = $('vText').value.trim()
    if (/^https?:\S+#a=[A-Za-z0-9_-]+$/.test(t)) {
      try { const a = shape(A.decodeShare(t)); const l = a.locks[a.locks.length - 1]; prefillVerify(l, a); return } catch (e) {}
    }
    updateVerifyHash()
  })
  $('vFile').addEventListener('change', async () => { const f = $('vFile').files[0]; if (f) { $('vText').value = await f.text(); updateVerifyHash() } $('vFile').value = '' })
  $('txid').addEventListener('input', updateVerifyBtn)
  $('verifyBtn').addEventListener('click', verify)
  $('createKey').addEventListener('click', createKey)
  $('importKey').addEventListener('click', importKey)
  $('backupKey').addEventListener('click', backupKey)
  $('deleteKey').addEventListener('click', deleteKey)
  $('withdrawBtn').addEventListener('click', withdraw)
  $('refreshBal').addEventListener('click', refreshBalance)
  $('copyAddr').addEventListener('click', () => copyText($('address').textContent, $('copyAddr'), 'Copy address'))
  window.addEventListener('hashchange', () => { if (openFromHash()) render() })

  state.a = loadDraft()
  fillForm()
  openFromHash()
  setNetwork(state.network)
  renderHistory(); render(); loadPrice()
  if (getKey()) refreshBalance()
  // test hook (used by the automated browser test only)
  window.__sl = { state, A, Core, render }
})()
