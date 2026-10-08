/*
 * Scope Lock — the agreement itself (no DOM, no network, no blockchain).
 * Works in the browser (window.SLAgreement) and in Node (module.exports) so
 * the exact same code is unit-tested offline.
 *
 * The fingerprint that goes on-chain is SHA-256 of canonicalText(agreement),
 * encoded as UTF-8 after normalise(). canonicalText is deliberately plain,
 * readable and deterministic: no locale-dependent formatting, so the same
 * agreement always produces the same text on any device.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.SLAgreement = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'
  const FORMAT = 'scope-lock/1'
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32: no I, L, O, U
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  /* ---------- cleaning ---------- */
  const oneLine = s => String(s == null ? '' : s).normalize('NFC').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  /** Turn a textarea (one item per line, bullets optional) into a clean list. */
  function parseList (text) {
    return String(text == null ? '' : text).split(/\r\n|\r|\n/)
      .map(l => oneLine(l.replace(/^\s*(?:[-–—*•·▪◦]|\d+[.)])\s+/, '').replace(/^\s*[-–—*•·▪◦]\s*/, '')))
      .filter(Boolean)
  }
  /** Normalise any agreement text before hashing (line endings, trailing spaces, Unicode form). */
  function normalise (text) {
    return String(text == null ? '' : text).normalize('NFC').replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+$/gm, '').replace(/^\n+|\s+$/g, '')
  }

  /* ---------- formatting (deterministic, locale-free) ---------- */
  /** '1250' | '1,250.5' | '£1250' -> '1250.50' (string, pounds.pence) or '' if invalid. */
  function cleanPrice (p) {
    const s = String(p == null ? '' : p).replace(/[£,\s]/g, '').replace(/gbp/i, '')
    if (!/^\d{1,9}(\.\d{0,2})?$/.test(s)) return ''
    const [w, f = ''] = s.split('.')
    return String(parseInt(w, 10)) + '.' + (f + '00').slice(0, 2)
  }
  function formatPrice (p) {
    const c = cleanPrice(p); if (!c) return ''
    const [w, f] = c.split('.')
    return '£' + w.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + f
  }
  function validDate (iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return false
    const [y, m, d] = iso.split('-').map(Number)
    const t = new Date(Date.UTC(y, m - 1, d))
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
  }
  /** '2026-10-19' -> 'Monday 19 October 2026' */
  function formatDate (iso) {
    if (!validDate(iso)) return ''
    const [y, m, d] = iso.split('-').map(Number)
    const t = new Date(Date.UTC(y, m - 1, d))
    return `${DAYS[t.getUTCDay()]} ${d} ${MONTHS[m - 1]} ${y}`
  }
  /** Any Date/ISO -> 'YYYY-MM-DDTHH:MM:SSZ' (UTC, whole seconds). */
  function isoSeconds (d) {
    const t = d instanceof Date ? d : new Date(d)
    return t.toISOString().replace(/\.\d{3}Z$/, 'Z')
  }

  /* ---------- reference (random, makes the fingerprint unguessable) ---------- */
  function makeRef () {
    const bytes = new Uint8Array(15) // 120 bits
    ;(typeof crypto !== 'undefined' ? crypto : require('crypto').webcrypto).getRandomValues(bytes)
    let bits = 0; let val = 0; let out = ''
    for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5 } }
    return 'SL-' + out.match(/.{4}/g).join('-') // SL-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
  }
  const validRef = r => /^SL-[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/.test(r || '')
  const shortRef = r => (r || '').split('-').slice(0, 2).join('-')

  /* ---------- the agreement ---------- */
  function blank () {
    return { v: 1, ref: makeRef(), job: '', client: '', freelancer: '', price: '', start: '', included: [], excluded: [], conf: { freelancer: null, client: null }, locks: [] }
  }
  /** Which required bits are missing (plain-English labels). */
  function missing (a) {
    const m = []
    if (!oneLine(a.job)) m.push('job title')
    if (!oneLine(a.client)) m.push('client name')
    if (!oneLine(a.freelancer)) m.push('your name')
    if (!cleanPrice(a.price)) m.push('price')
    if (!validDate(a.start)) m.push('start date')
    if (!(a.included || []).length) m.push('at least one thing that is included')
    return m
  }
  /**
   * The exact text that is fingerprinted.
   * opts.parties: which confirmations to include — 'both' (default: whatever is
   * confirmed), 'freelancer', 'client'. Used to re-create the text of an earlier lock.
   */
  function canonicalText (a, opts = {}) {
    const want = opts.parties || 'both'
    const fc = a.conf && a.conf.freelancer && (want === 'both' || want === 'freelancer') ? a.conf.freelancer : null
    const cc = a.conf && a.conf.client && (want === 'both' || want === 'client') ? a.conf.client : null
    const L = []
    L.push('SCOPE LOCK - AGREED SCOPE OF WORK')
    L.push('Format: ' + FORMAT)
    L.push('Reference: ' + a.ref)
    L.push('')
    L.push('Job: ' + oneLine(a.job))
    L.push('Client: ' + oneLine(a.client))
    L.push('Freelancer: ' + oneLine(a.freelancer))
    L.push('Price: ' + formatPrice(a.price) + ' (GBP)')
    L.push('Work starts: ' + formatDate(a.start) + ' (' + a.start + ')')
    L.push('')
    L.push('INCLUDED')
    for (const i of a.included || []) L.push('- ' + oneLine(i))
    L.push('')
    L.push('NOT INCLUDED')
    if ((a.excluded || []).length) for (const x of a.excluded) L.push('- ' + oneLine(x))
    else L.push('- (nothing listed)')
    L.push('')
    L.push('Only the work listed under INCLUDED is part of this job. Anything else, including')
    L.push('everything under NOT INCLUDED, needs a new agreement or quote.')
    L.push('')
    L.push('CONFIRMATIONS')
    L.push('Freelancer: ' + (fc ? `${oneLine(fc.name)} agreed at ${fc.at}` : 'not yet confirmed'))
    L.push('Client: ' + (cc ? `${oneLine(cc.name)} agreed at ${cc.at}` : 'not yet confirmed'))
    return normalise(L.join('\n'))
  }
  /** Text of the terms only (no confirmations): used to spot edits after someone agreed. */
  function termsText (a) { return canonicalText({ ...a, conf: {} }).split('\nCONFIRMATIONS')[0] }
  function partiesOf (a) {
    const f = !!(a.conf && a.conf.freelancer); const c = !!(a.conf && a.conf.client)
    return f && c ? 'both' : f ? 'freelancer' : c ? 'client' : 'none'
  }

  /** Read the key facts back out of a pasted agreement text (for the Verify view). */
  function readText (text) {
    const t = normalise(text); const get = k => { const m = t.match(new RegExp('^' + k + ': (.*)$', 'm')); return m ? m[1] : '' }
    return {
      isScopeLock: t.startsWith('SCOPE LOCK - AGREED SCOPE OF WORK'),
      ref: get('Reference'), job: get('Job'), client: get('Client'), freelancer: (t.split('\nCONFIRMATIONS')[0].match(/^Freelancer: (.*)$/m) || [])[1] || '',
      price: get('Price'), start: get('Work starts'),
      freelancerConf: ((t.split('\nCONFIRMATIONS')[1] || '').match(/^Freelancer: (.*)$/m) || [])[1] || '',
      clientConf: ((t.split('\nCONFIRMATIONS')[1] || '').match(/^Client: (.*)$/m) || [])[1] || ''
    }
  }

  /* ---------- hashing ---------- */
  function bytesToHex (b) { return Array.from(b, x => x.toString(16).padStart(2, '0')).join('') }
  async function sha256Hex (text) {
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null
    const data = enc.encode(normalise(text))
    if (subtle) return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', data)))
    if (typeof bsv !== 'undefined') return bytesToHex(bsv.Hash.sha256(Array.from(data))) // non-secure context fallback
    throw new Error('No SHA-256 available')
  }

  /* ---------- share link (agreement travels in the URL #hash, never to a server) ---------- */
  function b64urlEncode (bytes) {
    let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  function b64urlDecode (s) {
    const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
    const out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
    return out
  }
  const packConf = c => c ? [c.name, c.at] : 0
  const unpackConf = c => Array.isArray(c) && typeof c[0] === 'string' && typeof c[1] === 'string' ? { name: c[0], at: c[1] } : null
  /** Agreement -> 'a=…' fragment (no leading #). */
  function encodeShare (a) {
    const o = {
      v: 1, r: a.ref, j: a.job, c: a.client, f: a.freelancer, p: a.price, s: a.start,
      i: a.included || [], x: a.excluded || [],
      fc: packConf(a.conf && a.conf.freelancer), cc: packConf(a.conf && a.conf.client),
      l: (a.locks || []).map(k => [k.txid, k.network === 'test' ? 't' : 'm', k.parties[0], k.hash.slice(0, 16), k.at])
    }
    return 'a=' + b64urlEncode(enc.encode(JSON.stringify(o)))
  }
  /** '#a=…' or 'a=…' or a full URL -> agreement, or throws a plain-English error. */
  function decodeShare (str) {
    let s = String(str || '').trim()
    const hashAt = s.indexOf('#'); if (hashAt >= 0) s = s.slice(hashAt + 1)
    const m = s.match(/(?:^|&)a=([A-Za-z0-9_-]+)/)
    if (!m) throw new Error('This link does not contain an agreement.')
    let o
    try { o = JSON.parse(dec.decode(b64urlDecode(m[1]))) } catch (e) { throw new Error('This link is damaged or incomplete. Ask for it to be sent again.') }
    if (!o || o.v !== 1 || !validRef(o.r)) throw new Error('This link is not a Scope Lock agreement.')
    const str2 = v => typeof v === 'string' ? v : ''
    const list = v => Array.isArray(v) ? v.filter(x => typeof x === 'string') : []
    const pm = { f: 'freelancer', c: 'client', b: 'both' }
    return {
      v: 1, ref: o.r, job: str2(o.j), client: str2(o.c), freelancer: str2(o.f), price: str2(o.p), start: str2(o.s),
      included: list(o.i), excluded: list(o.x),
      conf: { freelancer: unpackConf(o.fc), client: unpackConf(o.cc) },
      locks: (Array.isArray(o.l) ? o.l : []).filter(k => Array.isArray(k) && /^[0-9a-f]{64}$/.test(k[0]) && pm[k[2]])
        .map(k => ({ txid: k[0], network: k[1] === 't' ? 'test' : 'main', parties: pm[k[2]], hash: str2(k[3]), at: str2(k[4]) }))
    }
  }

  return { FORMAT, parseList, normalise, cleanPrice, formatPrice, validDate, formatDate, isoSeconds, makeRef, validRef, shortRef, blank, missing, canonicalText, termsText, partiesOf, readText, sha256Hex, encodeShare, decodeShare }
})
