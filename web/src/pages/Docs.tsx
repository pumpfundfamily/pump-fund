import type { ReactNode } from 'react'
import { Link, PageHead } from '../components/ui'

/**
 * How it works. ⛔ The wording is the operator's own (15 Nov 2026): change the layout freely, never the text. Four statements were
 * corrected on the operator's say ("fix text if necessary"): the launcher CAN be a recipient, no per-wallet limit, the cost
 * beyond two GitHub accounts / charities, PayPal connects once.
 * The page's sections, in order: the contents list and each section's number come from here.
 */
const SECTIONS: [string, string][] = [['what', 'Pump Fund'], ['launch', 'Launching a token'], ['for', 'Who can receive funding?'], ['splits', 'Splitting creator rewards'], ['github', 'GitHub accounts'], ['charity', 'Charities'], ['apps', 'Venmo, Cash App, Zelle, Chime and PayPal'], ['rewards', 'Creator rewards'], ['xmoney', 'X Money payouts'], ['other', 'Other ways to receive rewards'], ['devbuy', 'Dev buy'], ['limits', 'Launch limits'], ['risk', 'Risks and disclaimers']]
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
      <Q id="what" title="Pump Fund">
        <p>Creator rewards go to the people or organizations selected when the token is launched. This could be someone who needs financial help, a creator you want to support, an open-source developer or a charity.</p>
        <p>Recipients can receive their share through X Money, GitHub, a supported payment app or a charity donation.</p>
        <p>Anyone can launch a token for someone else. The recipient does not need to participate, sign up or approve the launch.</p>
      </Q>
      <Q id="launch" title="Launching a token">
        <p>To launch a token, connect your Solana wallet on the Launch page and enter its ticker, name, image, description and links. You will also select who receives the creator rewards.</p>
        <p>Each token must have a ticker between 1 and 10 letters or numbers. Names can contain up to 32 characters. If no name is provided, the ticker is used instead.</p>
        <p>An image is optional. Tokens launched without one will use the Pump Fund heart as their image.</p>
        <p>The launch costs:</p>
        <ul>
          <li>0.01 SOL for standard launches.</li>
          <li>0.025 SOL when a GitHub account or charity is included among the recipients, plus 0.003 SOL for each one beyond two.</li>
        </ul>
        <p>If a paid launch fails, the SOL is returned to your wallet.</p>
        <p>Every token launched through Pump Fund is a standard Pumpfun token paired with SOL. Its contract address ends in <span className="mono">fund</span>.</p>
        <p>Once a token is live, its ticker, name, image and links cannot be changed.</p>
        <p><Link to="/launch" className="btn white sm">Launch a token</Link></p>
      </Q>
      <Q id="for" title="Who can receive funding?">
        <p>Pump Fund allows you to direct creator rewards to different types of recipients:</p>
        <ul>
          <li><strong>X accounts:</strong> Send rewards to someone's X Money account or let them withdraw to a Solana wallet.</li>
          <li><strong>GitHub accounts:</strong> Direct creator rewards to an open-source developer or project through Pumpfun's fee-sharing system.</li>
          <li><strong>Charities:</strong> Support registered charities through the Donate.gg directory.</li>
          <li><strong>Payment accounts:</strong> Send rewards in US dollars through Venmo, Cash App, Zelle, Chime or PayPal.</li>
        </ul>
        <p>When adding an X account, enter its handle. Pump Fund looks up the account on X and displays its name and profile picture so you can verify the recipient.</p>
        <p>Recipients are linked to their permanent X or GitHub ID rather than their username. Changing a handle or username will not affect their rewards.</p>
        <p>Recipients do not need to sign up or take any action to be included in a launch.</p>
      </Q>
      <Q id="splits" title="Splitting creator rewards">
        <p>A single token can fund up to five recipients at the same time.</p>
        <p>You can combine any supported recipient types and assign each one a percentage of the creator rewards.</p>
        <p>Each recipient must receive at least 5%, and all percentages must add up to exactly 100%.</p>
        <p>For example, you could distribute rewards as follows:</p>
        <ul>
          <li>50% to an X account.</li>
          <li>25% to a charity.</li>
          <li>15% to a GitHub account.</li>
          <li>10% to a PayPal account.</li>
        </ul>
        <p>The split is permanently fixed when the token launches. Neither the launcher nor the recipients can change it afterwards.</p>
        <p>Every time creator rewards are collected, they are distributed according to the original split.</p>
        <p>The token page publicly displays every recipient, their percentage and the amounts they have earned and received.</p>
      </Q>
      <Q id="github" title="GitHub accounts">
        <p>You can direct a share of creator rewards to any GitHub account by entering its username during the launch process.</p>
        <p>Pump Fund verifies the account and links it to its permanent GitHub ID, so changes to the username will not affect its allocation.</p>
        <p>Unlike other recipient types, GitHub rewards are paid directly by Pumpfun.</p>
        <p>The recipient's share is configured in Pumpfun's fee-sharing system during launch and locked in place. The account owner can then sign in to Pumpfun using GitHub to claim their rewards.</p>
        <p>Only the owner of the selected GitHub account can claim this allocation.</p>
      </Q>
      <Q id="charity" title="Charities">
        <p>Pump Fund allows you to direct creator rewards to registered charities through Donate.gg.</p>
        <p>Simply select Charity when adding a recipient and find the organization in the available directory.</p>
        <p>Only charities listed in the Donate.gg directory can be selected.</p>
        <p>As with GitHub accounts, charity allocations are configured directly through Pumpfun's fee-sharing system and locked at launch.</p>
        <p>The rewards collect in an account assigned to that charity for the token and are forwarded through Donate.gg, which handles delivery of the donation.</p>
        <p>Tokens launched with a GitHub account or charity as a recipient do not include a dev buy.</p>
      </Q>
      <Q id="apps" title="Venmo, Cash App, Zelle, Chime and PayPal">
        <p>Pump Fund supports direct funding through several popular payment apps.</p>
        <p>Select Payment App when adding a recipient and enter the relevant account information:</p>
        <ul>
          <li>Venmo username</li>
          <li>Cash App cashtag</li>
          <li>Zelle email address or US phone number</li>
          <li>ChimeSign</li>
          <li>PayPal.Me username</li>
        </ul>
        <p>Payments are made in US dollars through Peer, using the same payment process as X Money.</p>
        <p>Because these platforms do not allow Pump Fund to verify accounts through a public directory, the account details are displayed back to you for confirmation.</p>
        <p>Make sure the information is correct. Payment details are permanently locked when the token launches, and payments sent to an incorrect account cannot be reversed.</p>
        <p>A recipient does not need to sign up or connect their account beforehand.</p>
        <p>Once their accumulated share reaches 0.1 SOL, Pump Fund can initiate a payout. Finding a buyer for the payment can take one or two days.</p>
        <p>If a payment has not been completed within 14 days, the unpaid amount returns to the recipient's balance and Pump Fund will try again later.</p>
        <p>Zelle email addresses and phone numbers are never displayed in full on the website.</p>
        <h3>PayPal verification</h3>
        <p>PayPal requires one additional step. Peer only processes payments to PayPal accounts that have been connected and verified by their owner.</p>
        <p>The token page provides a link where the recipient can connect their PayPal account through Peer. This only needs to be completed once.</p>
        <p>Until verification is complete, their rewards remain safely in their Pump Fund balance.</p>
      </Q>
      <Q id="rewards" title="Creator rewards">
        <p>Pumpfun generates creator rewards on every trade, both before and after a token graduates.</p>
        <p>Pump Fund automatically collects the rewards allocated to X accounts every few minutes and credits them to the respective recipients' balances.</p>
        <p>GitHub and charity allocations are handled separately and paid directly by Pumpfun through its fee-sharing system. These rewards never pass through Pump Fund.</p>
        <p>Every recipient receives 100% of their allocated share.</p>
        <p>Pump Fund takes no cut.</p>
      </Q>
      <Q id="xmoney" title="X Money payouts">
        <p>X accounts receiving creator rewards can automatically receive their share through X Money.</p>
        <p>Once a recipient's balance reaches 0.1 SOL, Pump Fund converts the rewards into USDC and lists them on Peer, a marketplace where buyers can purchase USDC using X Money.</p>
        <p>The process works as follows:</p>
        <ol>
          <li>Pump Fund converts the recipient's accumulated rewards into USDC.</li>
          <li>The USDC is listed on Peer.</li>
          <li>A buyer sends US dollars to the recipient's X Money account.</li>
          <li>Peer verifies that the payment has been received.</li>
          <li>Once verified, Peer releases the USDC to the buyer.</li>
        </ol>
        <p>The recipient receives dollars directly in their X Money account without needing to sign up or connect anything to Pump Fund.</p>
        <p>Payments typically complete within a day.</p>
        <p>If nobody purchases the listed USDC within 14 days, for example because the recipient has not activated X Money, the unpaid amount is returned to their Pump Fund balance.</p>
        <p>The rewards are never lost. Recipients can always sign in with X and withdraw their balance to a Solana wallet instead.</p>
        <p>All completed payouts and their corresponding transactions are publicly visible on the Pump Fund homepage and individual token pages.</p>
      </Q>
      <Q id="other" title="Other ways to receive rewards">
        <p>Recipients can manage their earnings through the Your Rewards page by signing in with X.</p>
        <p>From there, they can choose how they want to receive their rewards:</p>
        <ul>
          <li><strong>X Money:</strong> Automatically receive payouts in US dollars.</li>
          <li><strong>Manual withdrawal:</strong> Withdraw accumulated rewards to any Solana wallet whenever you want. The minimum withdrawal is 0.01 SOL.</li>
          <li><strong>Automatic wallet withdrawals:</strong> Set a SOL wallet address and choose a balance threshold at which rewards are automatically withdrawn.</li>
        </ul>
        <p>Your own payout preferences always take priority over automatic X Money payouts.</p>
        <p>Signing in with X only accesses your public profile information.</p>
        <p><Link to="/account" className="btn white sm">Manage your rewards</Link></p>
      </Q>
      <Q id="devbuy" title="Dev buy">
        <p>When a token only funds X accounts or payment app accounts, the launcher has the option to include a dev buy.</p>
        <p>You can specify an amount of SOL to purchase the token directly in the launch transaction.</p>
        <p>The purchase happens before the token becomes available for public trading, and the launch cost is included in the same transaction.</p>
        <p>Tokens that include a GitHub account or charity among their recipients cannot have a dev buy.</p>
      </Q>
      <Q id="limits" title="Launch limits">
        <p>Each ticker can only be launched once every 24 hours.</p>
        <p>This limit applies to all launches on the platform.</p>
      </Q>
      <Q id="risk" title="Risks and disclaimers">
        <p>Tokens launched through Pump Fund are created by the individuals launching them.</p>
        <p>Launching a token for an X account, GitHub account, individual or charity does not mean that the recipient has approved, endorsed or participated in the launch.</p>
        <p>Pump Fund does not endorse any token launched through the platform.</p>
        <p>Cryptocurrency tokens are highly speculative assets. Trading them involves significant risk, including the possibility of losing your entire investment.</p>
        <p>Always do your own research before buying or trading a token.</p>
      </Q>
      </div>
      </div>
    </div>
  )
}
