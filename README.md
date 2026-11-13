# Pump Fund

Launch a [Pumpfun](https://pump.fun) token whose creator rewards fund people and good causes.
Live at **[pumpfund.family](https://pumpfund.family)** · [@pumpfundfamily](https://x.com/pumpfundfamily)

Every token launched here sends its creator rewards (the fee Pumpfun pays on every trade) to the recipients it was
launched for, in fixed shares for the life of the token. The launcher never gets a cut, and Pump Fund takes none.
Every token address ends in `fund`.

## Who a token can fund

Up to five recipients per token, at least 5% each, fixed at launch:

| Recipient | How it is paid |
|---|---|
| An X account | US dollars to its **X Money**, through [Peer](https://peer.xyz) |
| A Venmo, Cash App, Zelle or Chime account | US dollars in that app, through Peer |
| A PayPal account | US dollars on PayPal through Peer, once its owner has connected it with Peer |
| A GitHub account | By Pumpfun's own fee sharing; the owner claims on Pumpfun |
| A charity | By Pumpfun's own fee sharing, delivered through Donate.gg |

Nobody has to sign up or agree first. An X account can sign in to see its rewards or have them sent to a Solana wallet
instead.

## How the money moves

1. Each token's creator is its own **reward wallet**, derived from a seed only the server holds. Trading fees collect
   there; a keeper sweeps them every few minutes and books each recipient's share in a ledger, to the lamport.
2. A dollar payout bridges that recipient's SOL to USDC on Base with [Relay](https://relay.link), then lists it on
   **Peer Cash**: a buyer pays the recipient in the app (X Money, Venmo, ...), Peer verifies the payment, and only then
   releases our USDC to the buyer. If nobody pays within 14 days the USDC comes back and is credited to the recipient's
   balance again.
3. GitHub and charity shares are written into Pumpfun's own fee sharing at launch and locked there; Pumpfun pays them
   directly.

Every payment, with each step's transaction on Solana or Base, is listed at
[pumpfund.family/payouts](https://pumpfund.family/payouts), and each token's page lists the payments its rewards made.

## Code

```
api/       Node API, launch worker, keeper (reward collection), payouts (xmoney.mjs), proof records (proof.mjs)
lib/       Solana helpers: transactions, Pumpfun / PumpSwap instructions, fee sharing
web/       Vite + React site
tests/     unit tests and end-to-end tests on a local validator with Pumpfun cloned from mainnet
tools/     Rust vanity grinder for mint addresses ending in `fund`
deploy/    systemd units and deploy scripts (server address in deploy/local.env, not committed)
scripts/   local dev server and one-off utilities
```

## Running locally

Requires Node 22+, the Solana CLI (`solana-test-validator`) and Rust for the grinder.

```sh
npm ci && (cd web && npm ci)
./run-tests.sh                          # unit tests, then end-to-end on a local validator (port 8931)

./validator.sh                          # local validator with Pumpfun cloned from mainnet
node scripts/dev-site.mjs               # API on :5590 with a stub X sign-in
(cd web && npm run dev -- --port 5595)  # site on :5595
```

Configuration for a real deployment lives in a secrets file that is never committed; see
`deploy/secrets.env.example` for the variables.

## Status

Launching opens when the $FUND token is live. Payment rails other than X Money have run only in tests so far.
