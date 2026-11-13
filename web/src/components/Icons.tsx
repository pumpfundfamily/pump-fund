import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }
const line = ({ size = 18, ...p }: P) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p })

export const IHome = (p: P) => <svg {...line(p)}><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" /></svg>
export const ICompass = (p: P) => <svg {...line(p)}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></svg>
export const IDollar = (p: P) => <svg {...line(p)}><path d="M12 2v20M17 6.5c0-1.9-2.2-3-5-3s-5 1.3-5 3.5 2.2 3 5 3.5 5 1.4 5 3.6-2.2 3.4-5 3.4-5-1.2-5-3" /></svg>
export const IChart = (p: P) => <svg {...line(p)}><path d="M3 3v18h18M8 17v-5M12 17V8M16 17v-8M20 17V5" /></svg>
export const IRocket = (p: P) => <svg {...line(p)}><path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9s-2.1-.8-2.9-.1zM12 15l-3-3a22 22 0 0 1 2-4A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2z" /><path d="M9 12H4s.5-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.5 4-2c1.1-1.6 0-5 0-5" /></svg>
export const ICash = (p: P) => <svg {...line(p)}><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 12h.01M18 12h.01" /></svg>
export const IFlow = (p: P) => <svg {...line(p)}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><path d="M6.5 10v4a3 3 0 0 0 3 3H14" /></svg>
export const IDoc = (p: P) => <svg {...line(p)}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h6" /></svg>
export const ISearch = (p: P) => <svg {...line(p)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
export const IWallet = (p: P) => <svg {...line(p)}><path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3" /><path d="M21 12h-4a2 2 0 0 0 0 4h4V10h-4" /></svg>
export const IArrow = (p: P) => <svg {...line({ size: 14, ...p })}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
export const IExternal = (p: P) => <svg {...line({ size: 12, ...p })}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
export const IChevron = ({ dir = 'right', ...p }: P & { dir?: 'left' | 'right' | 'down' }) => (
  <svg {...line({ size: 14, ...p })}><path d={dir === 'left' ? 'm15 6-6 6 6 6' : dir === 'down' ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'} /></svg>
)
export const ISwap = (p: P) => <svg {...line({ size: 14, ...p })}><path d="M4 8h14l-3-3M20 16H6l3 3" /></svg>
export const IClose = (p: P) => <svg {...line(p)}><path d="M6 6l12 12M18 6 6 18" /></svg>
export const IVerified = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-label="verified"><path fill="#3b9ef5" d="M12 1.5 14.6 4l3.5-.4.7 3.5 3 1.9-1.5 3.2 1.5 3.2-3 1.9-.7 3.5-3.5-.4L12 22.5 9.4 20l-3.5.4-.7-3.5-3-1.9L3.7 12 2.2 8.8l3-1.9.7-3.5 3.5.4z" /><path d="m8 12.2 2.7 2.6L16.3 9" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
)

export const IX = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-label="X" role="img"><path d="M17.8 2.5h3.3l-7.2 8.2 8.5 11.3h-6.7l-5.2-6.8-6 6.8H1.2l7.7-8.8L.8 2.5h6.8l4.7 6.2zm-1.2 17.5h1.8L6.6 4.4H4.6z" /></svg>
)
export const IUser = (p: P) => <svg {...line(p)}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></svg>
export const ICopy = (p: P) => <svg {...line({ size: 14, ...p })}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>
export const IUsers = (p: P) => <svg {...line(p)}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.5 2.9-6 6.5-6s6.5 2.5 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2.2.6 3.5 2.6 3.5 6" /></svg>

export const IGithub = ({ size = 16 }: { size?: number }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.55v-2.1c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.66.8.55A11.5 11.5 0 0 0 12 .5Z" /></svg>
