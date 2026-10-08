# Third-party code bundled in /vendor

- `vendor/bsv-sdk.min.js` — a minified subset of **@bsv/sdk v3.2.0** (Open BSV License v6 — copy in `vendor/BSV-SDK-LICENSE.txt`; it permits use only with the BSV blockchain, which is what this tool does; includes MIT/Apache-2.0/BSD/ISC components — see the legal comments at the end of the file and https://github.com/bsv-blockchain/ts-sdk). Built with: `esbuild entry.js --bundle --format=iife --global-name=bsv --minify` where entry.js re-exports `PrivateKey, PublicKey, P2PKH, Transaction, Script, LockingScript, OP, SatoshisPerKilobyte, ARC, WhatsOnChainBroadcaster, WalletClient, Utils, Hash, Spend`.
- `vendor/qrcode.js` — **qrcode-generator** by Kazuhiko Arase, MIT licence.
