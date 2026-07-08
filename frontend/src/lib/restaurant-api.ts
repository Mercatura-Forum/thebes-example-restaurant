/**
 * restaurant-api.ts — typed reads/writes for the restaurant backend. Reads use
 * flat `*View`; ordering uses the flat trap-wrapper (two parallel vec<nat>).
 */
import { query, update, encodeArg, encodeArgs, decodeVecRecord, decodeNat, decodeBool } from '@thebes/sdk'
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
  tableNumber: bigint // 0 = take-away
}
export interface FloorTable {
  number: bigint
  seats: bigint
  status: string // free | reserved | occupied | ready
  orderId: bigint
  orderStatus: string
  orderTotalE8s: bigint
  orderIsMine: boolean
  guestName: string
  reservationId: bigint
  partySize: bigint
  resStart: bigint
  resEnd: bigint
  resSeated: boolean
  nextResAt: bigint // 0 = none
  nowNs: bigint
}
export interface ReservationRow {
  id: bigint
  tableNumber: bigint
  partySize: bigint
  startNs: bigint
  endNs: bigint
  status: string // booked | seated | completed | cancelled | noshow
  nowNs: bigint
  guestName?: string
}
export interface FloorSeal {
  tablesOnFloor: bigint
  occupied: bigint
  reservedNow: bigint
  violations: bigint
  checkedAt: bigint
}
export interface FloorEvent { at: bigint; kind: string; detail: string; tableNumber: bigint; orderId: bigint }

const nat = (name: string) => ({ name, type: 'nat' as const })
const int = (name: string) => ({ name, type: 'int' as const })
const text = (name: string) => ({ name, type: 'text' as const })
const bool = (name: string) => ({ name, type: 'bool' as const })

const MENU_FIELDS = [nat('id'), text('name'), nat('priceE8s'), bool('available'), text('photoPath')]
const ORDER_FIELDS = [nat('id'), text('status'), nat('totalAmount'), nat('itemCount'), int('timestamp'), nat('tableNumber')]
const FLOOR_FIELDS = [
  nat('number'), nat('seats'), text('status'),
  nat('orderId'), text('orderStatus'), nat('orderTotalE8s'), bool('orderIsMine'),
  text('guestName'), nat('reservationId'), nat('partySize'), int('resStart'), int('resEnd'), bool('resSeated'),
  int('nextResAt'), int('nowNs'),
]
const MY_RES_FIELDS = [nat('id'), nat('tableNumber'), nat('partySize'), int('startNs'), int('endNs'), text('status'), int('nowNs')]
const BOOK_FIELDS = [nat('id'), text('guestName'), nat('tableNumber'), nat('partySize'), int('startNs'), int('endNs'), text('status'), int('nowNs')]
const SEAL_FIELDS = [nat('tablesOnFloor'), nat('occupied'), nat('reservedNow'), nat('violations'), int('checkedAt')]
const EVENT_FIELDS = [int('at'), text('kind'), text('detail'), nat('tableNumber'), nat('orderId')]
const VIOLATION_FIELDS = [text('rule'), nat('tableNumber'), text('detail')]

export const decodeMenu = (h: string) => decodeVecRecord(h, MENU_FIELDS) as unknown as MenuItem[]
export const decodeOrders = (h: string) => decodeVecRecord(h, ORDER_FIELDS) as unknown as OrderRow[]
export const decodeFloor = (h: string) => decodeVecRecord(h, FLOOR_FIELDS) as unknown as FloorTable[]
export const decodeMyReservations = (h: string) => decodeVecRecord(h, MY_RES_FIELDS) as unknown as ReservationRow[]
export const decodeBookRows = (h: string) => decodeVecRecord(h, BOOK_FIELDS) as unknown as ReservationRow[]
export const decodeSeal = (h: string) => decodeVecRecord(h, SEAL_FIELDS) as unknown as FloorSeal[]
export const decodeEvents = (h: string) => decodeVecRecord(h, EVENT_FIELDS) as unknown as FloorEvent[]
export const decodeViolations = (h: string) => decodeVecRecord(h, VIOLATION_FIELDS) as unknown as { rule: string; tableNumber: bigint; detail: string }[]
export const decodeAmKitchen = (h: string) => decodeBool(h)

export const M = {
  menu: 'menuView', myOrders: 'myOrdersView', kitchen: 'kitchenView',
  floor: 'floorView', myReservations: 'myReservationsView', book: 'reservationsBookView',
  seal: 'floorSealView', events: 'floorEventsView', invariants: 'invariantReportView',
  amKitchen: 'amKitchen',
} as const
export const pageArg = (offset: number, limit: number) =>
  encodeArgs([{ type: 'nat', value: BigInt(offset) }, { type: 'nat', value: BigInt(limit) }])

// ── Writes ──
/** Place an order (tableNumber 0 = take-away) → order id, or throws the reason. */
export async function placeOrder(lines: { id: bigint; qty: number }[], tableNumber: number): Promise<bigint> {
  const ids = lines.map((l) => ({ type: 'nat' as const, value: l.id }))
  const qtys = lines.map((l) => ({ type: 'nat' as const, value: BigInt(l.qty) }))
  const r = await update(RESTAURANT_CID, 'placeOrderFlatOrTrap', encodeArgs([
    { type: 'vec', inner: { type: 'nat' }, value: ids },
    { type: 'vec', inner: { type: 'nat' }, value: qtys },
    { type: 'nat', value: BigInt(tableNumber) },
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

// ── The floor ──
export const addTable = (number: number, seats: number) =>
  update(RESTAURANT_CID, 'addTable', encodeArgs([{ type: 'nat', value: BigInt(number) }, { type: 'nat', value: BigInt(seats) }]))
export const setTableSeats = (number: bigint, seats: number) =>
  update(RESTAURANT_CID, 'setTableSeats', encodeArgs([{ type: 'nat', value: number }, { type: 'nat', value: BigInt(seats) }]))
export const retireTable = (number: bigint) =>
  update(RESTAURANT_CID, 'retireTable', encodeArg({ type: 'nat', value: number }))
export const moveOrderToTable = (orderId: bigint, tableNumber: number) =>
  update(RESTAURANT_CID, 'moveOrderToTable', encodeArgs([{ type: 'nat', value: orderId }, { type: 'nat', value: BigInt(tableNumber) }]))

/** Book a table for a window → reservation id, or throws the guard's reason. */
export async function reserveTable(guestName: string, tableNumber: bigint, partySize: number, startNs: bigint, endNs: bigint): Promise<bigint> {
  const r = await update(RESTAURANT_CID, 'reserveTableOrTrap', encodeArgs([
    { type: 'text', value: guestName },
    { type: 'nat', value: tableNumber },
    { type: 'nat', value: BigInt(partySize) },
    { type: 'int', value: startNs },
    { type: 'int', value: endNs },
  ]))
  return decodeNat(r.reply_hex ?? r.reply ?? '')
}
export const cancelReservation = (id: bigint) =>
  update(RESTAURANT_CID, 'cancelReservation', encodeArg({ type: 'nat', value: id }))
export const seatReservation = (id: bigint) =>
  update(RESTAURANT_CID, 'seatReservation', encodeArg({ type: 'nat', value: id }))
export const completeReservation = (id: bigint, showed: boolean) =>
  update(RESTAURANT_CID, 'completeReservation', encodeArgs([{ type: 'nat', value: id }, { type: 'bool', value: showed }]))

/** Seed a demo menu + floor on a fresh contract (no-op if the menu has items). */
export async function seedDemo(): Promise<void> {
  await update(RESTAURANT_CID, 'seedDemo')
}

export { query, RESTAURANT_CID }
