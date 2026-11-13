/**
 * Pumpfun's own fee sharing (the pump_fees program), as Pump Fund uses it for GitHub accounts and charities.
 *
 * A coin's `SharingConfig` names up to 10 shareholders (address + bps, 10000 together). It can be set ONCE: after
 * `update_fee_shares` the config's admin is revoked and nobody, us included, can change it. From then on the coin's
 * creator rewards collect in the config's creator vault and `distribute_creator_fees` (permissionless) pays every
 * shareholder its share. A shareholder is just an address:
 *
 *   a wallet                 Pump Fund's own reward wallet of the coin (the X accounts' combined share, split by our ledger)
 *   a SocialFeePda           ["social-fee-pda", user id, [platform]]: platform 2 = GitHub, the id is GitHub's numeric user id.
 *                            The person claims on Pumpfun (signed by Pumpfun's social claim authority); nobody else can.
 *   a DonationFeePda         ["donation-fee-pda", mint, config id]: config id = a Donate.gg charity id (32 bytes).
 *                            `crank_donation_fee_pda` forwards its balance to the donation relay.
 *
 * ⛔ The relay does not validate charity ids: one that belongs to nobody still "works" and the money is gone. Ids come from
 * Donate.gg's directory (api/charities.mjs), never from free text.
 * Facts proven on a mainnet clone 13 Nov 2026: memory pumpfun-social-and-donation-fee-pdas, scripts/probe-native-split.mjs.
 */
import anchor from '@coral-xyz/anchor'
import { Keypair, PublicKey } from '@solana/web3.js'
import { readFileSync } from 'node:fs'
import { TOKEN_PROGRAM_ID, WSOL, ammCreatorVaultAuthority, ata, bondingCurveAddress, creatorVaultAddress, poolAddress } from './pump.mjs'

export const PFEE = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
export const PLATFORM_GITHUB = 2
export const MAX_SHAREHOLDERS = 10
const idl = JSON.parse(readFileSync(new URL('./pump_fees.idl.json', import.meta.url)))
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PFEE)[0]

const programs = new WeakMap()
export function feesProgram(conn) {
  let p = programs.get(conn)
  if (!p) { p = new anchor.Program(idl, new anchor.AnchorProvider(conn, { publicKey: Keypair.generate().publicKey }, {})); programs.set(conn, p) }
  return p
}

export const sharingConfigAddress = (mint) => pda([Buffer.from('sharing-config'), new PublicKey(mint).toBuffer()])
/** A GitHub account's fee account. `githubId` is the NUMERIC user id (a login can be renamed and re-registered). */
export function socialFeeAddress(githubId, platform = PLATFORM_GITHUB) {
  const id = String(githubId)
  if (!/^[0-9]{1,20}$/.test(id)) throw new Error('a social fee account needs a numeric user id')
  return pda([Buffer.from('social-fee-pda'), Buffer.from(id), Buffer.from([platform])])
}
/** 0x + 64 hex (Donate.gg's form) → the 32 bytes as a public key (Pumpfun's form). */
export function charityKey(configId) {
  const hex = String(configId).replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('a charity id is 32 bytes of hex')
  return new PublicKey(Buffer.from(hex, 'hex'))
}
export const donationFeeAddress = (mint, configId) => pda([Buffer.from('donation-fee-pda'), new PublicKey(mint).toBuffer(), charityKey(configId).toBuffer()])

/** Where a recipient's share is paid on chain: { kind: 'wallet' | 'github' | 'charity', id } → address. */
export function shareholderAddress(mint, r) {
  if (r.kind === 'wallet') return new PublicKey(r.id)
  if (r.kind === 'github') return socialFeeAddress(r.id)
  if (r.kind === 'charity') return donationFeeAddress(mint, r.id)
  throw new Error(`unknown shareholder kind ${r.kind}`)
}

/** Turns fee sharing on for a coin still on its curve. `creator` (the coin's creator) signs and pays the config's rent. */
export function createSharingConfigIx(conn, { mint, creator }) {
  return feesProgram(conn).methods.createFeeSharingConfig()
    .accountsPartial({ payer: creator, mint, sharingConfig: sharingConfigAddress(mint), bondingCurve: bondingCurveAddress(mint), pool: null, pumpAmmProgram: null, pumpAmmEventAuthority: null })
    .instruction()
}

/**
 * Sets the shareholders: [{ address, bps }]. ⛔ ONCE per coin, for ever. `current` = the shareholders before this call
 * (right after creation: the creator alone); they are paid whatever is pending first.
 */
export function updateSharesIx(conn, { mint, authority, shareholders, current }) {
  const cfg = sharingConfigAddress(mint), amm = ammCreatorVaultAuthority(cfg)
  return feesProgram(conn).methods.updateFeeShares(shareholders.map((s) => ({ address: s.address, shareBps: s.bps })))
    .accountsPartial({ authority, mint, sharingConfig: cfg, pumpCreatorVault: creatorVaultAddress(cfg), coinCreatorVaultAuthority: amm, coinCreatorVaultAta: ata(amm, WSOL, TOKEN_PROGRAM_ID) })
    .remainingAccounts(current.map((k) => ({ pubkey: k, isSigner: false, isWritable: true })))
    .instruction()
}

/** Opens a GitHub account's fee account. Permissionless: `payer` pays its rent. */
export function createSocialIx(conn, { payer, githubId }) {
  return feesProgram(conn).methods.createSocialFeePda(String(githubId), PLATFORM_GITHUB).accountsPartial({ payer, socialFeePda: socialFeeAddress(githubId) }).instruction()
}

/** Opens a coin's donation account for one charity. Permissionless; the coin's sharing config must exist. */
export function createDonationIx(conn, { payer, mint, configId }) {
  return feesProgram(conn).methods.createDonationFeePda()
    .accountsPartial({ payer, donationFeePda: donationFeeAddress(mint, configId), configId: charityKey(configId), baseMint: mint, bondingCurve: bondingCurveAddress(mint), pool: poolAddress(mint), sharingConfig: sharingConfigAddress(mint) })
    .instruction()
}

export const DONATION_RELAY = new PublicKey('RLAYHr9TRFcKB2ubYQhspcnXiaGpaVzNQvHytt47RZu')
const relayPda = (seeds) => PublicKey.findProgramAddressSync(seeds, DONATION_RELAY)[0]
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

/**
 * Forwards a coin's donation account to the charity through the donation relay (Donate.gg). Permissionless: `payer` pays
 * the fee and the rent of a temporary wrapped-SOL account, which comes back in the same transaction. The relay's accounts
 * are per charity (epoch tracker, debouncer), derived here as its own program derives them; proven against mainnet by
 * simulation and on the local clone (tests/chain.test.mjs).
 */
export function crankDonationIx(conn, { payer, mint, configId }) {
  const cfg = charityKey(configId), donation = donationFeeAddress(mint, configId)
  const debouncer = relayPda([Buffer.from('debouncer_v1'), cfg.toBuffer(), WSOL.toBuffer()])
  return feesProgram(conn).methods.crankDonationFeePda().accountsPartial({
    payer, donationFeePda: donation, quoteMint: WSOL, donationFeePdaAta: ata(donation, WSOL, TOKEN_PROGRAM_ID), donationRelayProgram: DONATION_RELAY,
    donationRelayEventAuthority: relayPda([Buffer.from('__event_authority')]), mintWhitelist: relayPda([Buffer.from('mint_whitelist_v1')]),
    epochTracker: relayPda([Buffer.from('epoch_tracker_v1'), cfg.toBuffer(), WSOL.toBuffer()]), debouncer, debouncerAta: ata(debouncer, WSOL, TOKEN_PROGRAM_ID),
  }).instruction()
}
void ATA_PROGRAM

/** Pays the config's creator vault out to its shareholders, in the config's order. Permissionless. */
export function distributeIx(pump, { mint, shareholders }) {
  const cfg = sharingConfigAddress(mint)
  return pump.methods.distributeCreatorFees().accountsPartial({ mint, bondingCurve: bondingCurveAddress(mint), sharingConfig: cfg, creatorVault: creatorVaultAddress(cfg) })
    .remainingAccounts(shareholders.map((k) => ({ pubkey: k, isSigner: false, isWritable: true }))).instruction()
}

/** A coin's sharing config as it is on chain, or null: { address, locked, shareholders: [{ address, bps }] }. */
export async function readSharingConfig(conn, mint) {
  const address = sharingConfigAddress(mint)
  const info = await conn.getAccountInfo(address, 'confirmed')
  if (!info) return null
  const c = feesProgram(conn).coder.accounts.decode('sharingConfig', info.data)
  return { address, locked: !!c.adminRevoked, active: Object.keys(c.status)[0].toLowerCase() === 'active', shareholders: c.shareholders.map((s) => ({ address: s.address.toBase58(), bps: s.shareBps })) }
}

/** True when the chain holds exactly these shareholders, in this order, locked. */
export function sameShareholders(config, want) {
  return !!config && config.locked && config.shareholders.length === want.length && config.shareholders.every((s, i) => s.address === want[i].address.toBase58() && s.bps === want[i].bps)
}
