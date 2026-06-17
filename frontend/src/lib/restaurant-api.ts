/**
 * restaurant-api.ts — typed reads/writes for the restaurant backend. Reads use
 * flat `*View`; ordering uses the flat trap-wrapper (two parallel vec<nat>).
 */
import { query, update, encodeArg, encodeArgs, decodeVecRecord, decodeNat } from '@thebes/sdk'
import { RESTAURANT_CID } from './config'

export interface MenuItem {
  id: bigint
  name: string
  priceE8s: bigint
  available: boolean
  photoPath: string
}
export interface OrderRow {
  id: bigint
  status: string // pending | preparing | ready | delivered
  totalAmount: bigint
  itemCount: bigint
  timestamp: bigint
}

const MENU_FIELDS = [
  { name: 'id', type: 'nat' as const },
  { name: 'name', type: 'text' as const },
  { name: 'priceE8s', type: 'nat' as const },
  { name: 'available', type: 'bool' as const },
  { name: 'photoPath', type: 'text' as const },
]
const ORDER_FIELDS = [
  { name: 'id', type: 'nat' as const },
  { name: 'status', type: 'text' as const },
  { name: 'totalAmount', type: 'nat' as const },
  { name: 'itemCount', type: 'nat' as const },
  { name: 'timestamp', type: 'int' as const },
]

export const decodeMenu = (h: string) => decodeVecRecord(h, MENU_FIELDS) as unknown as MenuItem[]
export const decodeOrders = (h: string) => decodeVecRecord(h, ORDER_FIELDS) as unknown as OrderRow[]

export const M = { menu: 'menuView', myOrders: 'myOrdersView', kitchen: 'kitchenView' } as const

// ── Writes ──
/** Place an order from {menuItemId → quantity} → order id, or throws the reason. */
export async function placeOrder(lines: { id: bigint; qty: number }[]): Promise<bigint> {
  const ids = lines.map((l) => ({ type: 'nat' as const, value: l.id }))
  const qtys = lines.map((l) => ({ type: 'nat' as const, value: BigInt(l.qty) }))
  const r = await update(RESTAURANT_CID, 'placeOrderFlatOrTrap', encodeArgs([
    { type: 'vec', inner: { type: 'nat' }, value: ids },
    { type: 'vec', inner: { type: 'nat' }, value: qtys },
  ]))
  return decodeNat(r.reply_hex ?? r.reply ?? '')
}
export async function claimOwner(): Promise<void> { await update(RESTAURANT_CID, 'claimOwner') }
/** Add a dish → returns the new menu-item id, or throws "Not authorized". */
export async function addMenuItem(name: string, priceE8s: bigint, photoPath: string | null): Promise<bigint> {
  const r = await update(RESTAURANT_CID, 'addMenuItemOrTrap', encodeArgs([
    { type: 'text', value: name },
    { type: 'nat', value: priceE8s },
    { type: 'opt', inner: { type: 'text' }, value: photoPath },
  ]))
  return decodeNat(r.reply_hex ?? r.reply ?? '')
}
export async function setItemAvailable(id: bigint, available: boolean): Promise<void> {
  await update(RESTAURANT_CID, 'setItemAvailableOrTrap', encodeArgs([
    { type: 'nat', value: id },
    { type: 'bool', value: available },
  ]))
}
/** Re-set a dish photo after creation (uploaded to media first). Throws on error. */
export async function setMenuItemPhoto(id: bigint, photoPath: string): Promise<void> {
  await update(RESTAURANT_CID, 'setMenuItemPhotoOrTrap', encodeArgs([
    { type: 'nat', value: id },
    { type: 'text', value: photoPath },
  ]))
}
// Kitchen lifecycle (forward-only); trap-wrappers so a rejected transition
// surfaces as a failed call the UI can catch.
export const advanceOrder = (method: 'startPreparingOrderOrTrap' | 'markOrderReadyOrTrap' | 'markDeliveredOrTrap', orderId: bigint) =>
  update(RESTAURANT_CID, method, encodeArg({ type: 'nat', value: orderId }))

/** Seed a demo menu on a fresh contract (no-op if the menu already has items). */
export async function seedDemo(): Promise<void> {
  await update(RESTAURANT_CID, 'seedDemo')
}

export { query, RESTAURANT_CID }
