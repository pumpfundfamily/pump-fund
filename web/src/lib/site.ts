/** Our own X account, linked in the footer when set (VITE_X_HANDLE). */
export const X_HANDLE: string = import.meta.env.VITE_X_HANDLE || ''
export const SITE = 'pumpfund.family'
/** An amount in any asset: SOL, or a paired coin's token (big token amounts drop their decimals). */
export const amt = (n: number, unit: string, digits = 4) => `${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : digits })} ${unit}`
export const sol = (n: number, digits = 4) => `${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: digits })} SOL`
