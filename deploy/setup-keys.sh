#!/usr/bin/env bash
# Creates the mainnet keys ONCE, on this Mac, and prints only public addresses.
#   keys/mainnet/launcher.json   pays every launch (~0.025 SOL each): fund it, top it up
#   keys/mainnet/keeper.json     pays collect / payout / airdrop transaction fees: fund ~0.1 SOL
#   keys/mainnet/fee-seed.hex    derives EVERY coin's fee wallet. ⛔ Never rotate once a coin exists; back it up offline.
# Refuses to overwrite anything that exists.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p keys/mainnet && chmod 700 keys keys/mainnet
umask 077
for k in launcher keeper; do
  if [[ -e keys/mainnet/$k.json ]]; then echo "keys/mainnet/$k.json exists: kept"; else
    node -e "const {Keypair}=require('@solana/web3.js');const k=Keypair.generate();require('fs').writeFileSync('keys/mainnet/$k.json',JSON.stringify([...k.secretKey]),{mode:0o600})"
  fi
done
[[ -e keys/mainnet/fee-seed.hex ]] && echo "keys/mainnet/fee-seed.hex exists: kept" || node -e "require('fs').writeFileSync('keys/mainnet/fee-seed.hex',require('crypto').randomBytes(32).toString('hex'),{mode:0o600})"
node --input-type=module -e "
import { Keypair } from '@solana/web3.js'; import { readFileSync } from 'node:fs'
import { parseSeed, seedFingerprint } from './api/feewallet.mjs'
for (const k of ['launcher', 'keeper']) console.log(k.padEnd(9), Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('keys/mainnet/' + k + '.json')))).publicKey.toBase58())
console.log('fee seed  fingerprint', seedFingerprint(parseSeed(readFileSync('keys/mainnet/fee-seed.hex', 'utf8'))))"
