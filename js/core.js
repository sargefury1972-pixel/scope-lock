/*
 * Scope Lock — on-chain core (no DOM). Adapted from Proof of Design v1.
 * Works in the browser (window.SLCore) and in Node (module.exports) so the
 * exact same code is unit-tested offline.
 *
 * On-chain record format (one output, 0 satoshis, unspendable):
 *   OP_FALSE OP_RETURN
 *     "SCOPELOCK"          protocol prefix (UTF-8)
 *     "1"                  format version (UTF-8)
 *     <32 bytes>           SHA-256 of the exact agreement text (UTF-8, normalised)
 *     "<title>"            short public title, UTF-8 (empty push if none)
 *     "<ISO-8601 time>"    time the stamp was created, as claimed by the stamper
 * The authoritative time is the BLOCK time of the transaction; the ISO time
 * inside the record is informational.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory
  else root.SLCore = factory(root.bsv)
})(typeof self !== 'undefined' ? self : this, function (bsv) {
  'use strict'
  const PREFIX = 'SCOPELOCK'
  const VERSION = '1'
  const MAX_TITLE_BYTES = 200

  const enc = new TextEncoder()
  const dec = new TextDecoder('utf-8', { fatal: false })

  function hexToBytes (hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('Invalid hex')
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
    return out
  }
  function bytesToHex (bytes) {
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  }
  function truncateUtf8 (s, maxBytes) {
    let b = enc.encode(s || '')
    if (b.length <= maxBytes) return s || ''
    // cut on a character boundary
    let str = s
    while (enc.encode(str).length > maxBytes) str = str.slice(0, -1)
    return str
  }

  /** Build the OP_FALSE OP_RETURN locking script for a stamp. */
  function buildStampScript ({ hashHex, title = '', isoTime }) {
    if (!/^[0-9a-f]{64}$/i.test(hashHex || '')) throw new Error('hashHex must be a 64-char SHA-256 hex string')
    if (!isoTime) throw new Error('isoTime required')
    const s = new bsv.LockingScript()
    s.writeOpCode(bsv.OP.OP_FALSE)
    s.writeOpCode(bsv.OP.OP_RETURN)
    s.writeBin(Array.from(enc.encode(PREFIX)))
    s.writeBin(Array.from(enc.encode(VERSION)))
    s.writeBin(Array.from(hexToBytes(hashHex.toLowerCase())))
    s.writeBin(Array.from(enc.encode(truncateUtf8(title.trim(), MAX_TITLE_BYTES))))
    s.writeBin(Array.from(enc.encode(isoTime)))
    return s
  }

  /**
   * Minimal, dependency-free script push parser.
   * Returns { isOpReturn, pushes: Uint8Array[] } where pushes are the data
   * pushes that follow OP_RETURN (OP_FALSE OP_RETURN or bare OP_RETURN).
   */
  function parseOpReturn (scriptHex) {
    const b = hexToBytes(scriptHex)
    let i = 0
    if (b[0] === 0x00 && b[1] === 0x6a) i = 2
    else if (b[0] === 0x6a) i = 1
    else return { isOpReturn: false, pushes: [] }
    const pushes = []
    while (i < b.length) {
      const op = b[i++]
      let len
      if (op === 0x00) { pushes.push(new Uint8Array(0)); continue }
      if (op >= 0x01 && op <= 0x4b) len = op
      else if (op === 0x4c) { len = b[i]; i += 1 }
      else if (op === 0x4d) { len = b[i] | (b[i + 1] << 8); i += 2 }
      else if (op === 0x4e) { len = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0; i += 4 }
      else if (op >= 0x51 && op <= 0x60) { pushes.push(new Uint8Array([op - 0x50])); continue }
      else if (op === 0x4f) { pushes.push(new Uint8Array([0x81])); continue }
      else continue // non-push opcode inside data; skip (e.g. '|' separators are pushes anyway)
      if (i + len > b.length) { pushes.push(b.slice(i)); break }
      pushes.push(b.slice(i, i + len))
      i += len
    }
    return { isOpReturn: true, pushes }
  }

  /** Decode a Scope Lock record from a script hex, or null. */
  function decodeStamp (scriptHex) {
    const { isOpReturn, pushes } = parseOpReturn(scriptHex)
    if (!isOpReturn || pushes.length < 3) return null
    if (dec.decode(pushes[0]) !== PREFIX) return null
    const version = dec.decode(pushes[1])
    const hash = pushes[2]
    if (hash.length !== 32) return null
    return {
      protocol: PREFIX,
      version,
      hashHex: bytesToHex(hash),
      title: pushes[3] ? dec.decode(pushes[3]) : '',
      isoTime: pushes[4] ? dec.decode(pushes[4]) : ''
    }
  }

  /**
   * Examine all outputs of a transaction (as returned by WhatsOnChain /tx/{txid})
   * and decide whether `fileHashHex` is recorded in it.
   * Accepts a Scope Lock record, or (generic fallback) any OP_RETURN push
   * that equals the hash as 32 raw bytes or as 64-char hex text.
   */
  function findHashInTx (wocTx, fileHashHex) {
    const want = (fileHashHex || '').toLowerCase()
    const result = { match: false, kind: null, stamp: null, opReturns: [] }
    for (const v of (wocTx.vout || [])) {
      const hex = v.scriptPubKey && v.scriptPubKey.hex
      if (!hex) continue
      const parsed = parseOpReturn(hex)
      if (!parsed.isOpReturn) continue
      const stamp = decodeStamp(hex)
      result.opReturns.push({ n: v.n, hex, pushes: parsed.pushes.map(p => ({ hex: bytesToHex(p), text: printable(p) })), stamp })
      if (stamp) {
        result.stamp = result.stamp || stamp
        if (stamp.hashHex === want) { result.match = true; result.kind = 'scopelock'; result.stamp = stamp; return result }
      }
      for (const p of parsed.pushes) {
        if (p.length === 32 && bytesToHex(p) === want) { result.match = true; result.kind = 'generic-raw'; return result }
        if (p.length === 64 && dec.decode(p).toLowerCase() === want) { result.match = true; result.kind = 'generic-hex'; return result }
      }
    }
    return result
  }

  function printable (bytes) {
    const s = dec.decode(bytes)
    // treat as text if mostly printable
    const bad = (s.match(/[\u0000-\u0008\u000e-\u001f\ufffd]/g) || []).length
    return bad === 0 ? s : null
  }

  /** Rough size estimate (bytes) for a P2PKH-input stamp tx. */
  function estimateSize ({ inputs = 1, scriptLen, extraOutputs = 0 }) {
    return 10 + inputs * 148 + (9 + scriptLen + (scriptLen > 252 ? 2 : 0)) + 34 * (1 + extraOutputs)
  }
  function estimateFee ({ inputs = 1, scriptLen, extraOutputs = 0, satsPerKb }) {
    return Math.max(1, Math.ceil(estimateSize({ inputs, scriptLen, extraOutputs }) * satsPerKb / 1000))
  }

  /**
   * Build + sign a stamp transaction from the stamping key's UTXOs.
   * utxos: [{ txid, vout, satoshis, sourceHex }]
   * serviceFee: optional { address, satoshis } — pays the tool operator.
   */
  async function buildStampTx ({ privateKey, utxos, hashHex, title, isoTime, satsPerKb = 100, serviceFee = null, network = 'main' }) {
    const script = buildStampScript({ hashHex, title, isoTime })
    const scriptLen = script.toBinary().length
    const address = privateKey.toPublicKey().toAddress(network === 'main' ? [0x00] : [0x6f])
    const svc = serviceFee && serviceFee.address && serviceFee.satoshis > 0 ? serviceFee : null

    const sorted = [...utxos].sort((a, b) => b.satoshis - a.satoshis)
    const chosen = []
    let total = 0
    for (const u of sorted) {
      chosen.push(u); total += u.satoshis
      const need = estimateFee({ inputs: chosen.length, scriptLen, extraOutputs: svc ? 1 : 0, satsPerKb }) + (svc ? svc.satoshis : 0) + 1
      if (total >= need) break
    }
    const need = estimateFee({ inputs: chosen.length, scriptLen, extraOutputs: svc ? 1 : 0, satsPerKb }) + (svc ? svc.satoshis : 0) + 1
    if (total < need) {
      const err = new Error(`Not enough funds on the stamping key: have ${total} sats, need about ${need} sats.`)
      err.code = 'INSUFFICIENT_FUNDS'; throw err
    }

    const tx = new bsv.Transaction()
    for (const u of chosen) {
      const src = bsv.Transaction.fromHex(u.sourceHex)
      if (src.id('hex') !== u.txid) throw new Error('Source transaction does not match UTXO txid ' + u.txid)
      tx.addInput({ sourceTransaction: src, sourceOutputIndex: u.vout, unlockingScriptTemplate: new bsv.P2PKH().unlock(privateKey) })
    }
    tx.addOutput({ lockingScript: script, satoshis: 0 })
    if (svc) tx.addOutput({ lockingScript: new bsv.P2PKH().lock(svc.address), satoshis: svc.satoshis })
    tx.addOutput({ lockingScript: new bsv.P2PKH().lock(address), change: true })
    await tx.fee(new bsv.SatoshisPerKilobyte(satsPerKb))
    await tx.sign()
    const fee = total - tx.outputs.reduce((s, o) => s + (o.satoshis || 0), 0)
    return { tx, txid: tx.id('hex'), hex: tx.toHex(), fee, size: tx.toBinary().length, inputsUsed: chosen, address }
  }

  /** Build a sweep transaction sending everything on the key to `toAddress`. */
  async function buildSweepTx ({ privateKey, utxos, toAddress, satsPerKb = 100 }) {
    if (!utxos.length) throw new Error('Nothing to withdraw')
    const tx = new bsv.Transaction()
    for (const u of utxos) {
      tx.addInput({ sourceTransaction: bsv.Transaction.fromHex(u.sourceHex), sourceOutputIndex: u.vout, unlockingScriptTemplate: new bsv.P2PKH().unlock(privateKey) })
    }
    tx.addOutput({ lockingScript: new bsv.P2PKH().lock(toAddress), change: true })
    await tx.fee(new bsv.SatoshisPerKilobyte(satsPerKb))
    if (!tx.outputs[0] || !tx.outputs[0].satoshis) throw new Error('Balance too small to cover the network fee')
    await tx.sign()
    return { tx, txid: tx.id('hex'), hex: tx.toHex(), amount: tx.outputs[0].satoshis }
  }

  return { PREFIX, VERSION, MAX_TITLE_BYTES, hexToBytes, bytesToHex, buildStampScript, parseOpReturn, decodeStamp, findHashInTx, estimateSize, estimateFee, buildStampTx, buildSweepTx }
})
