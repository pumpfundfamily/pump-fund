import type { ReactNode } from 'react'
import { Ext, Link, PageHead } from '../components/ui'

/** The page's sections, in order: the contents list and each section's number come from here. */
const SECTIONS: [string, string][] = [['what', 'What Pump Fund is'], ['launch', 'Launching a token'], ['for', 'Who it funds'], ['splits', 'Splits'], ['github', 'GitHub accounts'], ['charity', 'Charities'], ['apps', 'Venmo, Cash App, Zelle, Chime and PayPal'], ['rewards', 'Creator rewards'], ['xmoney', 'X Money payouts'], ['other', 'Other ways to be paid'], ['devbuy', 'Dev buy'], ['limits', 'Limits'], ['risk', 'Risk']]
const Q = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => {
  const n = SECTIONS.findIndex(([k]) => k === id) + 1
  return (
    <section id={id} className="ct-doc">
      <div className="ct-doc-head"><span className="ct-doc-n">{String(n).padStart(2, '0')}</span><h2>{title}</h2></div>
      <div className="ct-doc-body">{children}</div>
    </section>
  )
}

export function Docs() {
  return (
    <div className="page ct-docs">
      <PageHead eyebrow="How it works" title="How it works" />
      <div className="ct-docs-grid">
      <nav className="ct-docs-toc" aria-label="On this page">
        {SECTIONS.map(([id, title], i) => <a key={id} href={`#${id}`}><span className="ct-doc-n sm">{String(i + 1).padStart(2, '0')}</span>{title}</a>)}
      </nav>
      <div className="ct-docs-main">
      <Q id="what" title="What Pump Fund is">
        <p>Pump Fund is a launchpad for Pumpfun tokens with one difference: a token's creator rewards do not go to whoever launched it. They go to whoever the token was launched <strong>for</strong>: an X account (paid to its X Money in dollars), a GitHub account or a charity.</p>
        <p>That account can be a person who needs help, a creator you want to support or a cause with an X account. It cannot be you: whoever launches a token never receives its rewards.</p>
      </Q>
      <Q id="launch" title="Launching a token">
        <p>Open <Link to="/launch" className="u">Launch</Link>, connect a Solana wallet and fill in the ticker, name, image, description and links, and who the token funds.</p>
        <p>The ticker is 1 to 10 letters or numbers. The name is up to 32 characters, or the ticker if you leave it empty. Without an image the token carries the Pump Fund heart.</p>
        <p>Your wallet pays the launch cost: 0.01 SOL, or 0.025 SOL when a GitHub account or a charity is among the recipients. If a paid launch does not go through, the payment is sent back to your wallet. Every token is a standard Pumpfun token, paired with SOL, with an address ending in <span className="mono">fund</span>.</p>
        <p>A token's name, ticker, image and links are permanent once it is live.</p>
        <p><Link to="/launch" className="btn white sm">Launch a token</Link></p>
      </Q>
      <Q id="for" title="Who it funds">
        <p>On the form you enter an X handle. Pump Fund looks the account up on X and shows its name and picture so you can check it is the right one. If the handle is not found, nothing launches.</p>
        <p>The token is tied to that account's permanent X id, not its handle, so a rename changes nothing.</p>
        <p>The account you name does not have to do anything, and does not have to agree first. Its page here shows every token launched for it and what they have earned.</p>
      </Q>
      <Q id="splits" title="Splits">
        <p>A token can fund up to five recipients at once, in any mix of X accounts, Venmo, Cash App, Zelle, Chime and PayPal accounts, GitHub accounts and charities. Add a recipient on the form and give each one a share in whole percent, at least 5% each and 100% together.</p>
        <p>The split is fixed at launch and cannot be changed afterwards, by anyone. Every time rewards are collected they are divided in those shares, and each recipient is paid on its own.</p>
        <p>The token's page shows the split, and what each account has earned and been sent.</p>
      </Q>
      <Q id="github" title="GitHub accounts">
        <p>Choose GitHub on the form and enter a username. Pump Fund looks it up on GitHub and ties the share to that account's permanent GitHub id, so a renamed account keeps it.</p>
        <p>This share is paid by Pumpfun itself, not by Pump Fund: it is written into the token's fee sharing on Pumpfun at launch and locked there. The account's owner signs in on <Ext href="https://pump.fun" className="u">Pumpfun</Ext> with GitHub and claims it. Nobody else can.</p>
      </Q>
      <Q id="charity" title="Charities">
        <p>Choose Charity on the form and search the directory by name. A charity can only be picked from the list, which comes from <Ext href="https://donate.gg" className="u">Donate.gg</Ext>.</p>
        <p>This share is also paid by Pumpfun and locked at launch. It collects in an account that belongs to that charity for that token, and is forwarded through Donate.gg, which delivers the donation to the charity.</p>
        <p>A token with a GitHub account or a charity among its recipients launches without a dev buy.</p>
      </Q>
      <Q id="apps" title="Venmo, Cash App, Zelle, Chime and PayPal">
        <p>Choose Payment app on the form, pick the app and enter the account: a Venmo username, a Cash App cashtag, a Zelle email or US phone number, a ChimeSign, or a PayPal.Me username. These accounts are paid in US dollars in that app, the same way X Money is: through <Ext href="https://peer.xyz" className="u">Peer</Ext>, where a buyer sends the dollars to the account and receives our USDC only after Peer has verified the payment.</p>
        <p>No app lets anyone look its accounts up, so the form shows the account back to you instead. Check the spelling: the account is fixed at launch and cannot be changed, and dollars sent to a wrong account cannot be brought back.</p>
        <p>The account does not sign in here and does not have to do anything. Its share is sent once it reaches 0.1 SOL; a payout can take a day or two to find a buyer. If nobody pays an account within 14 days, the money comes back to its balance and Pump Fund tries again later. A Zelle email or phone number is never shown in full on this site.</p>
        <p>PayPal has one extra step: Peer only pays a PayPal account once its owner has connected it in Peer's app, to prove it is theirs. The token's page links the owner to a page here where they start that, once, for every token that pays them. Until then the PayPal share waits in its balance.</p>
      </Q>
      <Q id="rewards" title="Creator rewards">
        <p>Pumpfun pays a creator reward on every trade of a token, before and after it graduates. X accounts' shares go to the token's own reward wallet, which Pump Fund collects every few minutes and books to those accounts. Shares of GitHub accounts and charities never pass through Pump Fund: Pumpfun pays them directly.</p>
        <p>All of it is theirs. Pump Fund takes no cut, and the account that launched the token receives nothing from it.</p>
      </Q>
      <Q id="xmoney" title="X Money payouts">
        <p>Once an account's rewards reach 0.1 SOL they are sent to its <span className="hl">X Money</span>, in dollars, with no sign-in needed.</p>
        <p>The payment goes through <Ext href="https://peer.xyz" className="u">Peer</Ext>, a marketplace where people buy USDC with X Money. Pump Fund swaps the rewards to USDC and lists them on Peer. A buyer sends the dollars to the account's X Money, Peer checks that payment, and only then releases the USDC to the buyer. This usually takes under a day.</p>
        <p>If nobody pays within 14 days, for example because X Money is not turned on for that account, the unpaid part comes back to the account's balance here. It is never lost: the owner can sign in with X and withdraw it to a wallet.</p>
        <p>Every payout is listed on the home page and on the token's page with its transactions.</p>
      </Q>
      <Q id="other" title="Other ways to be paid">
        <p>If a token funds your account, sign in with X on <Link to="/account" className="u">Your rewards</Link>. You can keep X Money, withdraw to any Solana wallet whenever you like (minimum 0.01 SOL), or have the rewards sent to a Solana wallet automatically once they pass a threshold you choose.</p>
        <p>Signing in only reads your public profile. Your own choice always wins over the automatic X Money payout.</p>
      </Q>
      <Q id="devbuy" title="Dev buy">
        <p>When no recipient is a GitHub account or a charity, you can enter an amount of SOL when you launch. Your wallet then buys the token in the launch transaction itself, before anyone else can trade it, and pays the launch cost in that same transaction.</p>
      </Q>
      <Q id="limits" title="Limits">
        <p>Each wallet can launch one token every 30 minutes, and each ticker can be launched once every 24 hours.</p>
      </Q>
      <Q id="risk" title="Risk">
        <p>Tokens launched here are created by whoever launches them. A token being launched for an account does not mean that account endorses it. Pump Fund does not endorse any token, and trading them can lose you everything you put in.</p>
      </Q>
      </div>
      </div>
    </div>
  )
}
