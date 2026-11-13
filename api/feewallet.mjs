/**
 * Each coin's fee wallet: the pump.fun `creator` of that coin, so its creator fees are collected there.
 *
 *   seed(mint) = HMAC-SHA256(FEE_SEED, "pumpfund-fee-wallet:v1:" + mint)      → ed25519 keypair
 *
 * Derived, never stored: FEE_SEED + the mint recover every wallet, so a lost database loses no money.
 * ⛔ FEE_SEED is the key to every coin's fees. It lives only in the box's secrets file (0600), is never logged, and is
 * never rotated while any coin exists (a new seed would derive different wallets: the old coins' fees stay where they are).
 */
import { createHmac } from 'node:crypto'
import { Keypair } from '@solana/web3.js'

export function parseSeed(hex) {
  const s = String(hex ?? '').trim()
  if (!/^[0-9a-f]{64}$/i.test(s)) throw new Error('FEE_SEED must be 64 hex characters (32 random bytes)')
  return Buffer.from(s, 'hex')
}

export function feeWallet(seed, mint) {
  const m = typeof mint === 'string' ? mint : mint.toBase58()
  return Keypair.fromSeed(createHmac('sha256', seed).update(`pumpfund-fee-wallet:v1:${m}`).digest())
}

/** A short, non-reversible fingerprint to compare seeds across machines without printing them. */
export const seedFingerprint = (seed) => createHmac('sha256', seed).update('fingerprint').digest('hex').slice(0, 16)
