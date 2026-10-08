/*
 * Scope Lock — settings you can edit.
 */
window.SL_CONFIG = {
  // 'main' for real locks, 'test' for BSV testnet (free faucet coins, nothing of value).
  defaultNetwork: 'main',

  // OPTIONAL: charge a tiny fee per lock, paid to YOUR OWN BSV address.
  // Leave address empty ('') to charge nothing. Example: { address: '1YourAddress...', satoshis: 1000 }
  serviceFee: { address: '', satoshis: 0 },

  // Fallback network fee if the live miner policy can't be fetched (satoshis per 1,000 bytes).
  fallbackSatsPerKb: 100,

  // Public infrastructure (no API keys needed).
  arc: { main: 'https://arc.gorillapool.io', test: 'https://testnet.arc.gorillapool.io' },
  woc: { main: 'https://api.whatsonchain.com/v1/bsv/main', test: 'https://api.whatsonchain.com/v1/bsv/test' },
  explorer: { main: 'https://whatsonchain.com/tx/', test: 'https://test.whatsonchain.com/tx/' },
  priceUrl: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=gbp,usd',

  // Safety: warn if the stamping key holds more than this many satoshis.
  maxRecommendedBalanceSats: 1000000,

  // localStorage prefix. Proof of Design uses 'pod.' on the same github.io origin,
  // so Scope Lock keeps its own, separate key and data under 'sl.'.
  storagePrefix: 'sl.'
}
