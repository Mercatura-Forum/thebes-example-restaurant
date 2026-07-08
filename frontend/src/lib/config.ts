/** Contract ids — injected at deploy via window globals; fallback to current cids. */
declare global {
  interface Window {
    RESTAURANT_CID?: number
    MEDIA_CID?: number
  }
}

export const RESTAURANT_CID: number =
  (typeof window !== 'undefined' && window.RESTAURANT_CID) || 118949186870210

export const MEDIA_CID: number =
  (typeof window !== 'undefined' && window.MEDIA_CID) || 199651578293719

/** Token has 8 decimals (e8s). Format a base-unit price. */
export function fmtE8s(e8s: bigint | number): string {
  const v = typeof e8s === 'bigint' ? e8s : BigInt(Math.trunc(e8s))
  const whole = (v / 100_000_000n).toString()
  const frac = (v % 100_000_000n).toString().padStart(8, '0').slice(0, 2)
  return `${whole}.${frac}`
}

export function relTime(ns: bigint): string {
  const ms = Number(ns / 1_000_000n)
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
