export type Mode = 'creator' | 'holders'
export type User = { id: string; handle: string; name: string; avatar: string }
export type Token = {
  mint: string; name: string; symbol: string; image: string; description: string
  creator: User; tweetUrl: string; launchTx: string; createdAt: number; platform: boolean; launchedBy: { id: string; handle: string } | null
  /** who the creator rewards belong to, in what shares (fixed at launch), with each account's own figures */
  shares: { kind: 'x' | 'github' | 'charity' | 'venmo' | 'cashapp' | 'zelle' | 'chime' | 'paypal'; app?: string; connected?: boolean | null; connectPath?: string; id: string; handle: string; name: string; avatar: string; url: string; pct: number; earned: number | null; paid: number | null; owed: number | null }[]
  /** set when Pumpfun's own fee sharing pays part of the rewards (GitHub accounts, charities): its locked config */
  shareConfig: string | null
  mode: Mode; nativeHolders: boolean; ownCreator?: boolean; feeWallet: string; venue?: 'pump' | 'float'
  // a paired coin: fees are in `quote`; `unit` names the asset of creatorEarned/Paid/Owed (the *Sol fields are SOL coins only)
  quote: { mint: string; symbol: string; decimals: number } | null; unit: string
  creatorEarned: number; creatorPaid: number; creatorOwed: number
  marketCapUsd: number; graduated: boolean; curveProgress: number; volume24hUsd: number; change24h: number | null
  feesUsd: number; feesSol: number
  creatorEarnedSol: number; creatorPaidSol: number; creatorOwedSol: number
  holdersEarnedSol: number; holdersPaidSol: number; holdersPendingSol: number; airdrops: number
  links: { pump: string; float?: string; fomo: string; dexscreener: string; x: string; solscan: string }
}
export type Outflow = { signature: string; time: number; unit: string; amount: number; sol: number; usd: number | null; kind: 'payout' | 'airdrop'; destination: string | null; mint: string; state: string; recipients?: number }
export type Stats = {
  launches: number; creators: number; feesSol: number; feesUsd: number; solUsd: number
  paidToCreatorsSol: number; airdroppedSol: number; queued: number; launchingOpen: boolean; handle: string; platformMint: string | null; ticker: string
  xmoney: { enabled: boolean; paidUsd: number; listedUsd: number; people: number; payouts: number }
}
export type FeedItem = { tweetId: string; handle: string; symbol: string; name: string; state: 'queued' | 'launched'; mint: string | null; url: string; at: number }
export type PayoutKind = 'claim' | 'wallet' | 'fomo' | 'xmoney'
export type Me = {
  user: User
  settings: { defaultMode: Mode; payoutKind: PayoutKind; payoutWallet: string; fomoHandle: string; payoutConfirmed: boolean; autoMinSol: number; launchVenue?: 'pump' | 'float' }
  options: { fomo: boolean; float?: boolean; xmoney: boolean; xmoneyNote: string; xmoneyMinSol?: number }
  owedSol: number; owedUsd: number; minWithdrawSol: number
  owed: { asset: string; symbol: string; decimals: number; amount: number; coins: number }[]
  tokens: Token[]; payouts: Outflow[]
  xmoney?: XMoneyPayout[]
}
export type XMoneyPayout = { id: number; time: number; handle: string; sol: number; usd: number; paidUsd: number; status: string; done: boolean }
