import { useCallback, useState } from 'react'
import { IClose } from './Icons'
import { useModal } from '../lib/useModal'
import type { WalletState } from '../lib/wallet'

/** Picks one of the Solana wallets installed in this browser (header Connect button and the launch page). */
export function WalletPicker({ w, onClose }: { w: WalletState; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null)
  const close = useCallback(() => onClose(), [onClose])
  const box = useModal<HTMLDivElement>(true, close)
  return (
    <div className="overlay" onClick={close}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head"><h3 style={{ margin: 0 }}>Connect a wallet</h3><button type="button" className="icon-btn" aria-label="Close" onClick={close}><IClose /></button></div>
        {w.wallets.length ? (
          <div className="wallet-list">
            {w.wallets.map((x) => (
              <button type="button" key={x.name} className="wallet-row" onClick={() => w.connect(x).then(close).catch((e: Error) => setErr(/reject|denied|cancel|declin/i.test(e.message) ? 'You declined in your wallet.' : e.message))}>
                <img src={x.icon} alt="" width={28} height={28} /> <span>{x.name}</span>
              </button>
            ))}
          </div>
        ) : <p className="muted small" style={{ margin: 0 }}>No Solana wallet was found in this browser. Install Phantom, Solflare or Backpack to launch.</p>}
        <div className="muted tiny">The wallet you connect pays for the launch and signs it.</div>
        {err && <div className="note error">{err}</div>}
      </div>
    </div>
  )
}
