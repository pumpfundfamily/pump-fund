export function Terms() {
  return (
    <div className="page legal">
      <h1>Terms</h1>
      <p className="muted">Pump Fund launches Pumpfun tokens on Solana when a signed-in X account asks it to. The account that launches a token is responsible for what it launches and how it is promoted.</p>
      <p className="muted">A token being launched for an X account does not mean that account created, approved or endorses it. Pump Fund does not issue, sell, endorse or vouch for any token. Tokens can lose all of their value. Nothing on this site is financial advice.</p>
      <p className="muted">Creator rewards are collected from Pumpfun and paid to the X account a token was launched for, as described in How it works. X Money payouts are made through Peer and depend on a buyer paying; rewards that cannot be delivered wait for their owner. Pump Fund may refuse or delay launches to protect the service, for example from spam, abuse or impersonation.</p>
      <p className="muted">The service is provided as is. Blockchain transactions cannot be reversed: check every address before you use it.</p>
    </div>
  )
}

export function Privacy() {
  return (
    <div className="page legal">
      <h1>Privacy</h1>
      <p className="muted">Signing in with X reads your public profile only (handle, name, picture, follower count, account age). Pump Fund stores your X id, the payout settings you choose and a sign-in cookie. It never posts for you.</p>
      <p className="muted">When a token is launched for an X account, Pump Fund reads that account's public profile to identify it, and shows its handle, name and picture next to the token.</p>
      <p className="muted">Payout addresses and payouts are public on the Solana and Base blockchains. Pump Fund does not sell data.</p>
    </div>
  )
}
