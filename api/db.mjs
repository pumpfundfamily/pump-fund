/**
 * PUMP FUND store: node:sqlite, one file.
 *
 * Money model (DESIGN.md): every coin has its own fee wallet (api/feewallet.mjs), the pump.fun `creator` of that coin.
 * Its SOL balance is always   rent floor + creator bucket + holders bucket   once credited:
 *
 *   credits   one row per keeper pass that found new SOL in the wallet, booked to the coin's mode AT THAT MOMENT
 *   outflows  one row per transaction that moves SOL out of a fee wallet (creator payout or holders airdrop),
 *             state 'sending' → 'landed' | 'expired'. A 'sending' row blocks new credits for that wallet until the chain
 *             answers, so an in-flight payout is never mistaken for missing (or new) money.
 *
 * The keeper (and the site's withdraw) only ever moves SOL that was credited to the right bucket.
 *
 * ⭐ PAIRED COINS (11 Nov): a coin paired with token Q (tokens.quote_mint) earns its creator fees IN Q. Its credits and
 * outflows rows hold Q's smallest units in the `lamports` column, and its fee wallet's balance that matters is its Q
 * token account. ⛔ Never add `lamports` across coins without grouping by asset (assetOf): a SOL sum that includes a
 * BONK coin is wrong by orders of magnitude, and a SOL payout sized from it would drain other coins' buckets.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { OUR_KINDS, isOurs } from './rails.mjs'

export const now = () => Math.floor(Date.now() / 1000)

/** An account that never chose: creator fees go to holders (pump.fun holder rewards at launch). Operator, 10 Nov 2026. */
export const DEFAULT_MODE = 'holders'

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    -- An X account. id = X's stable user id, never the handle.
    CREATE TABLE IF NOT EXISTS users (
      x_id TEXT PRIMARY KEY,
      handle TEXT, name TEXT, avatar TEXT, followers INTEGER, x_created_at INTEGER,
      default_mode TEXT NOT NULL DEFAULT 'holders' CHECK (default_mode IN ('creator', 'holders')),
      -- where creator fees go: 'claim' (wait for a withdraw), 'wallet' (auto-pay a Solana address),
      -- 'fomo' (auto-pay the FOMO wallet of fomo_handle), 'xmoney' (dollars to the account's X Money, via Peer: api/xmoney.mjs)
      payout_kind TEXT NOT NULL DEFAULT 'claim' CHECK (payout_kind IN ('claim', 'wallet', 'fomo', 'xmoney')),
      payout_wallet TEXT, fomo_handle TEXT, payout_confirmed INTEGER NOT NULL DEFAULT 0,
      auto_min_lamports INTEGER NOT NULL DEFAULT 50000000,
      seen_at INTEGER NOT NULL, settings_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS users_handle ON users (lower(handle));

    -- Every mention that asked for a launch (and only those: see api/parse.mjs hasLaunchIntent).
    CREATE TABLE IF NOT EXISTS mentions (
      tweet_id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL, author_handle TEXT NOT NULL, text TEXT NOT NULL, url TEXT,
      tweeted_at INTEGER NOT NULL, seen_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'launching', 'launched', 'rejected', 'failed')),
      code TEXT, reason TEXT,
      symbol TEXT, name TEXT, mode TEXT, image_url TEXT, in_reply_to_id TEXT, quoted_image_url TEXT,
      author_followers INTEGER, author_created_at INTEGER,
      platform INTEGER NOT NULL DEFAULT 0, next_try_at INTEGER NOT NULL DEFAULT 0,
      mint TEXT, signature TEXT, last_valid_height INTEGER, attempts INTEGER NOT NULL DEFAULT 0, launched_at INTEGER,
      reply_state TEXT NOT NULL DEFAULT 'none' CHECK (reply_state IN ('none', 'pending', 'sent', 'failed', 'skipped')),
      reply_id TEXT, reply_attempts INTEGER NOT NULL DEFAULT 0, reply_after INTEGER NOT NULL DEFAULT 0,
      payload TEXT, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mentions_state ON mentions (state, seen_at);
    CREATE INDEX IF NOT EXISTS mentions_author ON mentions (author_id, state, updated_at);

    CREATE TABLE IF NOT EXISTS tokens (
      mint TEXT PRIMARY KEY,
      name TEXT NOT NULL, symbol TEXT NOT NULL, image TEXT, metadata_uri TEXT, description TEXT,
      creator_id TEXT NOT NULL, creator_handle TEXT NOT NULL,
      tweet_id TEXT, tweet_url TEXT,
      fee_wallet TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL DEFAULT 'creator' CHECK (mode IN ('creator', 'holders')),
      mode_at INTEGER,
      launch_sig TEXT, created_at INTEGER NOT NULL,
      platform INTEGER NOT NULL DEFAULT 0,
      graduated INTEGER NOT NULL DEFAULT 0, pool TEXT,
      market_cap_usd REAL DEFAULT 0, price_usd REAL, change_24h REAL, volume_24h_usd REAL,
      curve_progress REAL DEFAULT 0, market_at INTEGER DEFAULT 0, trades_24h INTEGER, holders INTEGER,
      -- a payout/airdrop holds this until it has an answer from the chain (conditional UPDATE: a DB lock, not a flag)
      busy_until INTEGER NOT NULL DEFAULT 0,
      last_distribution_at INTEGER NOT NULL DEFAULT 0,
      -- launched with pump.fun's native holder rewards (BondingCurve.is_holder_reward): pump.fun pays holders, locked for life
      native_holders INTEGER NOT NULL DEFAULT 0,
      -- creator = a wallet the operator holds (the platform token): fees are claimed on pump.fun by that wallet, the keeper skips it
      own_creator INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS tokens_creator ON tokens (creator_id);
    CREATE INDEX IF NOT EXISTS tokens_created ON tokens (created_at);

    CREATE TABLE IF NOT EXISTS credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL REFERENCES tokens (mint), bucket TEXT NOT NULL CHECK (bucket IN ('creator', 'holders')),
      lamports INTEGER NOT NULL CHECK (lamports > 0), signature TEXT, time INTEGER NOT NULL, sol_usd REAL
    );
    CREATE INDEX IF NOT EXISTS credits_mint ON credits (mint, bucket);

    CREATE TABLE IF NOT EXISTS outflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL REFERENCES tokens (mint), bucket TEXT NOT NULL CHECK (bucket IN ('creator', 'holders')),
      lamports INTEGER NOT NULL CHECK (lamports > 0),
      kind TEXT NOT NULL CHECK (kind IN ('payout', 'airdrop')),
      -- payout: the destination wallet; airdrop: the batch's recipients are in airdrop_items
      destination TEXT, x_id TEXT, batch TEXT,
      state TEXT NOT NULL CHECK (state IN ('sending', 'landed', 'expired')),
      signature TEXT, last_valid_height INTEGER, time INTEGER NOT NULL, settled_at INTEGER, sol_usd REAL
    );
    CREATE INDEX IF NOT EXISTS outflows_mint ON outflows (mint, bucket, state);
    CREATE INDEX IF NOT EXISTS outflows_sig ON outflows (signature);
    CREATE INDEX IF NOT EXISTS outflows_x ON outflows (x_id, time);
    CREATE TABLE IF NOT EXISTS airdrop_items (
      outflow_id INTEGER NOT NULL REFERENCES outflows (id), owner TEXT NOT NULL, lamports INTEGER NOT NULL, tokens TEXT NOT NULL,
      PRIMARY KEY (outflow_id, owner)
    );

    -- ⛔ A mint key is handed out ONCE (a known mint address can be griefed forever).
    CREATE TABLE IF NOT EXISTS vanity (
      pubkey TEXT PRIMARY KEY, secret TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'fresh' CHECK (state IN ('fresh', 'issued', 'launched', 'burned')),
      created_at INTEGER NOT NULL, issued_at INTEGER, launcher TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, x_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

    -- Tokens a coin can be paired with, by ticker: pump.fun's quote-control list (+ USDC), refreshed daily (api/pairs.mjs).
    CREATE TABLE IF NOT EXISTS pair_tokens (
      mint TEXT PRIMARY KEY, symbol TEXT, name TEXT, decimals INTEGER NOT NULL, program TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pair_tokens_symbol ON pair_tokens (upper(symbol));
    -- Float's pair list (api/floatpairs.mjs): enabled QuoteAsset accounts of the Float program, refreshed daily
    CREATE TABLE IF NOT EXISTS float_pairs (
      mint TEXT PRIMARY KEY, symbol TEXT, name TEXT, decimals INTEGER NOT NULL, program TEXT NOT NULL, global_config TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS float_pairs_symbol ON float_pairs (upper(symbol));

    -- ⭐ X Money payouts (11 Nov, api/xmoney.mjs). One row = one payout run through:
    --   collecting  creator SOL buckets → the keeper (payout outflows, signatures in collect_sigs; their fate settles it)
    --   bridging    keeper SOL → Relay → our Base wallet's USDC (relay_sig on Solana, relay_request at Relay)
    --   listing     a Peer Cash order: sell that USDC to a buyer who pays the handle in X Money (list_started_at = sent)
    --   listed      deposit_id on Peer; a buyer's proven X Money payment releases USDC to them
    --   returning   the unfilled USDC → Relay → keeper SOL (return_request), then
    --   crediting   keeper → refund_mint's fee wallet (credit_sig), booked to that coin's CREATOR bucket
    --   done | failed (failed = needs the operator: the row says why)
    CREATE TABLE IF NOT EXISTS xmoney_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      x_id TEXT NOT NULL, handle TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('collecting', 'bridging', 'listing', 'listed', 'returning', 'crediting', 'done', 'failed')),
      collect_sigs TEXT NOT NULL DEFAULT '[]', lamports INTEGER NOT NULL DEFAULT 0, refund_mint TEXT, sol_usd REAL,
      relay_request TEXT, relay_sig TEXT, relay_lvh INTEGER, relay_attempts INTEGER NOT NULL DEFAULT 0,
      usdc INTEGER NOT NULL DEFAULT 0, deposit_id TEXT, list_started_at INTEGER, listed_at INTEGER, relists INTEGER NOT NULL DEFAULT 0,
      filled_usdc INTEGER NOT NULL DEFAULT 0, paid_usd REAL NOT NULL DEFAULT 0, cur_filled_usdc INTEGER NOT NULL DEFAULT 0, cur_paid_usd REAL NOT NULL DEFAULT 0,
      -- a sub-$1 remainder no buyer can take (Peer's minimum fill is 1 USDC): held on Base, added to the account's next payout
      carry_usdc INTEGER NOT NULL DEFAULT 0, carry_used INTEGER NOT NULL DEFAULT 0,
      return_usdc INTEGER NOT NULL DEFAULT 0, return_request TEXT, return_started_at INTEGER,
      returned_lamports INTEGER NOT NULL DEFAULT 0, credit_sig TEXT, credit_lvh INTEGER,
      error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS xmoney_payouts_x ON xmoney_payouts (x_id, state);
    -- ⛔ one live X Money payout per account: the database refuses a second (a DB lock, not a flag)
    CREATE UNIQUE INDEX IF NOT EXISTS xmoney_payouts_one_live ON xmoney_payouts (x_id) WHERE state NOT IN ('done', 'failed');
  `)
  const mcols = db.prepare('PRAGMA table_info(mentions)').all().map((c) => c.name)
  if (!mcols.includes('quoted_image_url')) db.exec('ALTER TABLE mentions ADD COLUMN quoted_image_url TEXT')
  // the pair as written ('$BONK' or an address), and as resolved (JSON: api/pairs.mjs)
  if (!mcols.includes('pair_input')) db.exec('ALTER TABLE mentions ADD COLUMN pair_input TEXT')
  if (!mcols.includes('pair')) db.exec('ALTER TABLE mentions ADD COLUMN pair TEXT')
  // ⭐ Float (11 Nov): where a request launches ('pump' | 'float'): the post's own "on Float" / "on Pumpfun", else the account setting
  if (!mcols.includes('venue')) db.exec('ALTER TABLE mentions ADD COLUMN venue TEXT')
  // launching FOR an X account (12 Nov): the request's target, as written and then as X's numeric id
  if (!mcols.includes('for_handle')) db.exec('ALTER TABLE mentions ADD COLUMN for_handle TEXT')
  if (!mcols.includes('for_id')) db.exec('ALTER TABLE mentions ADD COLUMN for_id TEXT')
  // the operator let this one post past the 24 h cashtag rule (api/requeue.mjs)
  if (!mcols.includes('ticker_override')) db.exec('ALTER TABLE mentions ADD COLUMN ticker_override INTEGER NOT NULL DEFAULT 0')
  // ⭐ launches made on the site (13 Nov): source 'site', the form's own fields in `opts` (JSON). Their tweet_id is a
  // made-up 'site-…' id: nothing is ever replied to (reply_state 'skipped', and the reply loop reads source 'x' only).
  if (!mcols.includes('source')) db.exec("ALTER TABLE mentions ADD COLUMN source TEXT NOT NULL DEFAULT 'x'")
  if (!mcols.includes('opts')) db.exec('ALTER TABLE mentions ADD COLUMN opts TEXT')
  db.exec(`
    -- A site launch WITH a dev buy waits here for the buyer's wallet signature (api/sitelaunch.mjs): the exact message
    -- that was built, and everything needed to record the coin. 'open' → 'used' (a conditional UPDATE: signed once) | 'expired'.
    CREATE TABLE IF NOT EXISTS site_drafts (
      id TEXT PRIMARY KEY, x_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('open', 'used', 'expired')),
      mint TEXT NOT NULL, wallet TEXT NOT NULL, lamports INTEGER NOT NULL, message TEXT NOT NULL, last_valid_height INTEGER NOT NULL,
      request TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS site_drafts_x ON site_drafts (x_id, state);
    -- Metadata already pinned for exactly these fields + image: a second try (wallet refused, blockhash expired) pins nothing new
    CREATE TABLE IF NOT EXISTS pins (hash TEXT PRIMARY KEY, uri TEXT NOT NULL, image TEXT NOT NULL, at INTEGER NOT NULL);
  `)
  db.exec(`
    -- ⭐ SPLITS (13 Nov): who a coin's creator rewards belong to, fixed at launch (no setter anywhere). One row per recipient,
    -- slot 0 first; bps add up to 10000. kind 'x' = an X account (recipient_id = its numeric X id, paid to its X Money by our
    -- ledger); 'github' = a GitHub account (recipient_id = GitHub's numeric user id) and 'charity' = a Donate.gg charity
    -- (recipient_id = its 0x… config id): those two are paid by Pumpfun's own fee sharing (lib/feeshare.mjs), never by us.
    -- ⛔ ids are unique per kind only (x:42 is not github:42). A coin with no rows (the project token) has a single owner.
    CREATE TABLE IF NOT EXISTS token_shares (
      mint TEXT NOT NULL, slot INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'x', recipient_id TEXT NOT NULL, handle TEXT,
      bps INTEGER NOT NULL CHECK (bps > 0 AND bps <= 10000),
      PRIMARY KEY (mint, slot), UNIQUE (mint, kind, recipient_id)
    );
    CREATE INDEX IF NOT EXISTS token_shares_recipient ON token_shares (kind, recipient_id);
  `)
  // whose money a creator credit is (a split coin books one row per recipient); NULL on a row = the coin's single owner
  if (!db.prepare('PRAGMA table_info(credits)').all().some((c) => c.name === 'x_id')) db.exec('ALTER TABLE credits ADD COLUMN x_id TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS credits_x ON credits (x_id, mint)')
  const tcols = db.prepare('PRAGMA table_info(tokens)').all().map((c) => c.name)
  // ⭐ a coin whose rewards are split by Pumpfun's own fee sharing: the address of its sharing config (its Pumpfun creator)
  if (!tcols.includes('share_config')) db.exec('ALTER TABLE tokens ADD COLUMN share_config TEXT')
  if (!tcols.includes('venue')) db.exec("ALTER TABLE tokens ADD COLUMN venue TEXT NOT NULL DEFAULT 'pump'")
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
  // payout_auto = 1: X Money was set up FOR this account by a launch made for it (it never chose); its own choice clears it
  if (!ucols.includes('payout_auto')) db.exec('ALTER TABLE users ADD COLUMN payout_auto INTEGER NOT NULL DEFAULT 0')
  if (!ucols.includes('launch_venue')) db.exec("ALTER TABLE users ADD COLUMN launch_venue TEXT NOT NULL DEFAULT 'pump'")
  // a coin launched FOR its creator by someone else: who asked (creator_id/handle = whose coin it is)
  if (!tcols.includes('launched_by_id')) db.exec('ALTER TABLE tokens ADD COLUMN launched_by_id TEXT')
  if (!tcols.includes('launched_by_handle')) db.exec('ALTER TABLE tokens ADD COLUMN launched_by_handle TEXT')
  if (!tcols.includes('native_holders')) db.exec('ALTER TABLE tokens ADD COLUMN native_holders INTEGER NOT NULL DEFAULT 0')
  if (!tcols.includes('own_creator')) db.exec('ALTER TABLE tokens ADD COLUMN own_creator INTEGER NOT NULL DEFAULT 0')
  // paired coins: NULL quote_mint = SOL-paired. Creator fees accrue in the quote token.
  for (const [c, def] of [['quote_mint', 'TEXT'], ['quote_symbol', 'TEXT'], ['quote_decimals', 'INTEGER'], ['quote_program', 'TEXT'],
    ['fees_usd', 'REAL NOT NULL DEFAULT 0'], ['last_collect_at', 'INTEGER NOT NULL DEFAULT 0'],
    // fees pump.fun handles itself (native holder coins, the platform coin), read from the chain: api/feetrack.mjs
    ['ext_in', 'INTEGER NOT NULL DEFAULT 0'], ['ext_out', 'INTEGER NOT NULL DEFAULT 0'], ['ext_waiting', 'INTEGER NOT NULL DEFAULT 0'],
    ['ext_sig', 'TEXT'], ['ext_at', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!tcols.includes(c)) db.exec(`ALTER TABLE tokens ADD COLUMN ${c} ${def}`)
  }
  // ⛔ xmoney_payouts existed on the box before these columns: CREATE TABLE IF NOT EXISTS never adds a column, so every
  // column after the first deploy is migrated here (11 Nov: the missing carry_usdc crashed every keeper run)
  const xcols = db.prepare('PRAGMA table_info(xmoney_payouts)').all().map((c) => c.name)
  for (const [c, def] of [['cur_filled_usdc', 'INTEGER NOT NULL DEFAULT 0'], ['cur_paid_usd', 'REAL NOT NULL DEFAULT 0'],
    ['carry_usdc', 'INTEGER NOT NULL DEFAULT 0'], ['carry_used', 'INTEGER NOT NULL DEFAULT 0'],
    // ⭐ 13 Nov: the Peer corridor a payout pays out on: 'xmoney' (an X account), or a payment app (api/rails.mjs)
    ['platform', "TEXT NOT NULL DEFAULT 'xmoney'"],
    // ⭐ 13 Nov (operator: "everything tracked and verifiable on chain"): every step's transaction, kept for the proof pages
    ['bridge_dest_tx', 'TEXT'], ['deposit_tx', 'TEXT'], ['withdraw_tx', 'TEXT'], ['return_txs', "TEXT NOT NULL DEFAULT '[]'"], ['return_dest_tx', 'TEXT'],
    // ⭐ 15 Nov (review): how often Peer refused to list this payout, and how many Base transactions its bridge back needs
    ['list_attempts', 'INTEGER NOT NULL DEFAULT 0'], ['return_steps', 'INTEGER']]) {
    if (!xcols.includes(c)) db.exec(`ALTER TABLE xmoney_payouts ADD COLUMN ${c} ${def}`)
  }
  db.exec(`
    -- ⭐ Each buyer who paid a payout on Peer (13 Nov): their intent (an on-chain order on Peer's Base escrow), what they
    -- paid in fiat (from Peer's verified receipt) and the USDC released to them. One row per intent, written once FULFILLED.
    CREATE TABLE IF NOT EXISTS xmoney_fills (
      intent_hash TEXT PRIMARY KEY, payout_id INTEGER NOT NULL, buyer TEXT, usdc INTEGER NOT NULL DEFAULT 0,
      fiat_paid REAL, currency TEXT, paid_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS xmoney_fills_payout ON xmoney_fills (payout_id);
    -- ⭐ Payments Pumpfun makes itself on a natively split coin (13 Nov): 'distribute' = the collect transaction in which
    -- Pumpfun split the swept rewards between the coin's shareholders (lamports = all of it); 'donation' = a charity's
    -- account forwarded through Donate.gg's relay (recipient = the charity id).
    CREATE TABLE IF NOT EXISTS native_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('distribute', 'donation')),
      signature TEXT NOT NULL, lamports INTEGER NOT NULL, recipient TEXT, time INTEGER NOT NULL, UNIQUE (signature, kind, recipient)
    );
    CREATE INDEX IF NOT EXISTS native_events_mint ON native_events (mint, time);
  `)
  // 11 Nov: feetrack v1 subtracted a rent pump.fun does not keep and could skip older transactions: count again from 0
  if (!db.prepare("SELECT 1 FROM kv WHERE k = 'feetrack_v2'").get()) {
    db.prepare('UPDATE tokens SET ext_in = 0, ext_out = 0, ext_waiting = 0, ext_sig = NULL, ext_at = 0').run()
    db.prepare("INSERT INTO kv (k, v) VALUES ('feetrack_v2', '1')").run()
  }
  // 10 Nov: the default became holders. Accounts that never saved a setting follow the new default (once).
  if (!db.prepare("SELECT 1 FROM kv WHERE k = 'default_mode_holders_v1'").get()) {
    db.prepare("UPDATE users SET default_mode = 'holders' WHERE settings_at IS NULL").run()
    db.prepare("INSERT INTO kv (k, v) VALUES ('default_mode_holders_v1', '1')").run()
  }
  return db
}

export const kvGet = (db, k) => db.prepare('SELECT v FROM kv WHERE k = ?').get(k)?.v ?? null
export const kvSet = (db, k, v) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, String(v))
export const kvDel = (db, k) => db.prepare('DELETE FROM kv WHERE k = ?').run(k)

/** Launching is CLOSED while this row exists (absence = open). Seeded closed on a fresh store: see openLaunching. */
export const LAUNCHING_CLOSED = 'launching_closed'
export function launchingOpen(db) { return kvGet(db, LAUNCHING_CLOSED) === null }

export function upsertUser(db, u) {
  db.prepare(`
    INSERT INTO users (x_id, handle, name, avatar, followers, x_created_at, seen_at, default_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (x_id) DO UPDATE SET
      handle = COALESCE(excluded.handle, users.handle), name = COALESCE(excluded.name, users.name),
      avatar = COALESCE(excluded.avatar, users.avatar), followers = COALESCE(excluded.followers, users.followers),
      x_created_at = COALESCE(excluded.x_created_at, users.x_created_at), seen_at = excluded.seen_at
  `).run(String(u.id), u.handle ?? null, u.name ?? null, u.avatar ?? null, u.followers ?? null, u.createdAt ?? null, now(), DEFAULT_MODE)
  return db.prepare('SELECT * FROM users WHERE x_id = ?').get(String(u.id))
}

/**
 * The two buckets of one coin, in lamports. `sending` outflows count as spent: their SOL is reserved the moment the
 * row is written, and comes back only if the chain positively says the transaction expired.
 */
export function buckets(db, mint) {
  const c = db.prepare(`SELECT bucket, COALESCE(SUM(lamports), 0) AS l FROM credits WHERE mint = ? GROUP BY bucket`).all(mint)
  const o = db.prepare(`SELECT bucket, COALESCE(SUM(lamports), 0) AS l FROM outflows WHERE mint = ? AND state != 'expired' GROUP BY bucket`).all(mint)
  const get = (rows, b) => Number(rows.find((r) => r.bucket === b)?.l ?? 0)
  const creatorIn = get(c, 'creator'), holdersIn = get(c, 'holders'), creatorOut = get(o, 'creator'), holdersOut = get(o, 'holders')
  return { creatorIn, holdersIn, creatorOut, holdersOut, creator: creatorIn - creatorOut, holders: holdersIn - holdersOut }
}

/** A coin's fee asset: 'SOL', or its quote token's mint (a paired coin). */
export const assetOf = (t) => t.quote_mint ?? 'SOL'

/** A coin's recipients, slot 0 first: [{ slot, kind, id, handle, bps }]. A coin without share rows has one: its creator. */
export function sharesOf(db, mint) {
  const rows = db.prepare('SELECT slot, kind, recipient_id AS id, handle, bps FROM token_shares WHERE mint = ? ORDER BY slot').all(mint)
  if (rows.length) return rows
  const t = db.prepare('SELECT creator_id, creator_handle FROM tokens WHERE mint = ?').get(mint)
  return t ? [{ slot: 0, kind: 'x', id: t.creator_id, handle: t.creator_handle, bps: 10000 }] : []
}

/**
 * The recipients OUR ledger pays (X accounts), slot order kept. On a coin that also funds GitHub accounts or charities,
 * Pumpfun pays those itself and only the X accounts' combined share ever reaches the coin's reward wallet: what arrives
 * there is divided between the X accounts in proportion to their bps.
 */
export const ledgerShares = (db, mint) => sharesOf(db, mint).filter((s) => isOurs(s.kind))
// ⭐ payment-app recipients (api/rails.mjs) are ours too: their recipient_id IS their ledger key ('venmo:jane'), so the
// rows above carry the key every credit / outflow / payout is booked under, exactly like an X id

/**
 * Splits `amount` between recipients in proportion to their bps, in whole units. Every share is rounded DOWN and what is
 * left over (under one unit per recipient) goes to the first, so the parts always add up to exactly `amount`. Pure.
 */
export function splitAmount(amount, shares) {
  const total = shares.reduce((t, s) => t + s.bps, 0)
  const parts = shares.map((s) => ({ ...s, amount: total > 0 ? Math.floor((amount * s.bps) / total) : 0 }))
  if (parts.length) parts[0].amount += amount - parts.reduce((t, p) => t + p.amount, 0)
  return parts
}

/** The mints an X account (or a payment-app account, by its ledger key) has a share of, or owns outright. */
const OURS_SQL = OUR_KINDS.map((k) => `'${k}'`).join(', ')
export function mintsOf(db, xId) {
  return db.prepare(`SELECT mint FROM token_shares WHERE kind IN (${OURS_SQL}) AND recipient_id = ?
    UNION SELECT mint FROM tokens WHERE creator_id = ? AND mint NOT IN (SELECT mint FROM token_shares)`).all(String(xId), String(xId)).map((r) => r.mint)
}

/**
 * One X account's part of ONE coin's creator bucket: { earned, out, owed } in the coin's units. Credits carry the account
 * they were booked to (credits.x_id; a row without one belongs to the coin's creator); payouts carry who they paid.
 * ⛔ Across a coin's recipients these add up to buckets(mint).creator exactly: nothing is owed twice or to nobody.
 */
export function shareOf(db, mint, xId) {
  const id = String(xId)
  const earned = Number(db.prepare(`SELECT COALESCE(SUM(c.lamports), 0) l FROM credits c JOIN tokens t ON t.mint = c.mint
    WHERE c.mint = ? AND c.bucket = 'creator' AND COALESCE(c.x_id, t.creator_id) = ?`).get(mint, id).l)
  const out = Number(db.prepare(`SELECT COALESCE(SUM(o.lamports), 0) l FROM outflows o JOIN tokens t ON t.mint = o.mint
    WHERE o.mint = ? AND o.bucket = 'creator' AND o.state != 'expired' AND COALESCE(o.x_id, t.creator_id) = ?`).get(mint, id).l)
  const paid = Number(db.prepare(`SELECT COALESCE(SUM(o.lamports), 0) l FROM outflows o JOIN tokens t ON t.mint = o.mint
    WHERE o.mint = ? AND o.bucket = 'creator' AND o.state = 'landed' AND COALESCE(o.x_id, t.creator_id) = ?`).get(mint, id).l)
  return { earned, out, paid, owed: earned - out }
}

/** Everything one X account is owed in SOL across the SOL-paired coins it has a share of. Paired coins: owedAssets. */
export function owedTo(db, xId) {
  const sol = new Set(db.prepare('SELECT mint FROM tokens WHERE quote_mint IS NULL').all().map((r) => r.mint))
  let total = 0
  const perCoin = []
  for (const mint of mintsOf(db, xId)) {
    if (!sol.has(mint)) continue
    const owed = shareOf(db, mint, xId).owed
    if (owed > 0) perCoin.push({ mint, lamports: owed })
    total += owed
  }
  return { total, perCoin: perCoin.sort((a, b) => b.lamports - a.lamports) }
}

/**
 * Takes the coin's fee-wallet lock for `seconds`. Returns true when this caller holds it. A conditional UPDATE, so the
 * API (withdraw) and the keeper (auto-pay, airdrops) can never both sign for one wallet at once.
 */
export function lockCoin(db, mint, seconds = 120) {
  const t = now()
  return db.prepare('UPDATE tokens SET busy_until = ? WHERE mint = ? AND busy_until < ?').run(t + seconds, mint, t).changes === 1
}
export const unlockCoin = (db, mint) => db.prepare('UPDATE tokens SET busy_until = 0 WHERE mint = ?').run(mint)

/**
 * What one X account is owed, per asset: [{ asset: 'SOL' | mint, symbol, decimals, units, coins: [{ mint, units }] }],
 * SOL first. `units` are the asset's smallest units (lamports for SOL).
 */
export function owedAssets(db, xId) {
  const out = new Map()
  for (const mint of mintsOf(db, xId)) {
    const t = db.prepare('SELECT mint, quote_mint, quote_symbol, quote_decimals FROM tokens WHERE mint = ?').get(mint)
    const units = shareOf(db, t.mint, xId).owed
    if (units <= 0) continue
    const k = assetOf(t)
    const a = out.get(k) ?? { asset: k, symbol: t.quote_mint ? (t.quote_symbol ?? 'tokens') : 'SOL', decimals: t.quote_mint ? (t.quote_decimals ?? 0) : 9, units: 0, coins: [] }
    a.units += units; a.coins.push({ mint: t.mint, units })
    out.set(k, a)
  }
  return [...out.values()].sort((a, b) => (a.asset === 'SOL' ? -1 : b.asset === 'SOL' ? 1 : a.symbol.localeCompare(b.symbol)))
}
