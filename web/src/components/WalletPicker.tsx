import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { IClose, IX } from './Icons'
import { signInUrl } from '../lib/api'
import { useModal } from '../lib/useModal'
import type { WalletState } from '../lib/wallet'

/**
 * Picks one of the Solana wallets installed in this browser (header Connect button and the launch page).
 * ⛔ Rendered into <body>: the header's backdrop-filter makes it the containing block of any position:fixed child, so
 * an overlay inside it covered only the 76 px header strip (operator 16 Nov: "looks bugged").
 */
/** `withX`: the header's popup also offers "Sign in with X" (operator 16 Nov), for recipients; the launch page's does not. */
export function WalletPicker({ w, onClose, withX = false }: { w: WalletState; onClose: () => void; withX?: boolean }) {
  const [err, setErr] = useState<string | null>(null)
  const close = useCallback(() => onClose(), [onClose])
  const box = useModal<HTMLDivElement>(true, close)
  return createPortal(
    <div className="overlay" onClick={close}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-label="Connect" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head pf-wallet-head"><h3>Connect</h3><button type="button" className="icon-btn" aria-label="Close" onClick={close}><IClose /></button></div>
        {w.wallets.length ? (
          <div className="wallet-list">
            {w.wallets.map((x) => (
              <button type="button" key={x.name} className="wallet-row" onClick={() => w.connect(x).then(close).catch((e: Error) => setErr(/reject|denied|cancel|declin/i.test(e.message) ? 'You declined in your wallet.' : e.message))}>
                <img src={x.icon} alt="" width={28} height={28} /> <span>{x.name}</span>
              </button>
            ))}
          </div>
        ) : <p className="muted small" style={{ margin: 0 }}>No Solana wallet was found in this browser. Install Phantom, Solflare or Backpack to launch.</p>}
        {withX && (
          <>
            <div className="pf-or"><span>or</span></div>
            <a href={signInUrl('/account')} className="wallet-row pf-x-row"><span className="pf-x-mark"><IX size={14} /></span> <span>Sign in with X</span></a>
          </>
        )}
        {err && <div className="note error">{err}</div>}
      </div>
    </div>,
    document.body,
  )
}
