import Map "mo:core/Map";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Int "mo:core/Int";
import Text "mo:core/Text";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Array "mo:core/Array";
import Iter "mo:core/Iter";
import Result "mo:core/Result";
import Runtime "mo:core/Runtime";
import Admin "mo:thebes-lib/Admin";
import Invoices "mo:thebes-lib/Invoices";
import Migration "Migration";

// A restaurant that cannot double-book a table.
//
// The property this example proves: SINGLE ALLOCATION under time. A dining
// table is a scarce resource in two dimensions — right now (one active order
// at a time) and across time (no two overlapping reservations). Every booking
// and every seating is validated on-chain against both, and the public
// invariant oracle `invariantReportView` recomputes the whole floor's laws on
// demand:
//     at most one active order per table
//     zero overlapping non-cancelled reservations per table
//     every seating references a real table, party ≤ seats
// An empty report is the proof that the floor can never be double-allocated.
// Tables gain floor-plan positions in this version (see Migration.mo).
(with migration = Migration.run)
persistent actor Restaurant {

  // Standard admin surface (lib/Admin). The restaurant operator claims
  // ownership; kitchen staff are granted the admins tier, so menu and order
  // lifecycle actions are admin-gated while revenue stats stay owner-only.
  var admin = Admin.init();

  public shared(msg) func claimOwner() : async Bool { Admin.claimOwner(admin, msg.caller) };
  public shared(msg) func transferOwner(n : Principal) : async Bool { Admin.transferOwner(admin, msg.caller, n) };
  public shared(msg) func addAdmin(w : Principal) : async Bool { Admin.addAdmin(admin, msg.caller, w) };
  public shared(msg) func removeAdmin(w : Principal) : async Bool { Admin.removeAdmin(admin, msg.caller, w) };
  public shared(msg) func setPaused(v : Bool) : async Bool { Admin.setPaused(admin, msg.caller, v) };
  public query func getOwner() : async ?Principal { Admin.getOwner(admin) };
  public query func getAdmins() : async [Principal] { Admin.getAdmins(admin) };
  public query func isPaused() : async Bool { Admin.isPaused(admin) };
  public shared query(msg) func amKitchen() : async Bool { Admin.isAdmin(admin, msg.caller) };

  type MenuItem = {
    id : Nat;
    name : Text;
    priceE8s : Nat;
    available : Bool;
    // Pointer to the dish photo on the media contract ("/photo/{hash}").
    photoPath : ?Text;
  };

  type OrderItem = {
    menuItemId : Nat;
    quantity : Nat;
  };

  type OrderStatus = {
    #pending;
    #preparing;
    #ready;
    #delivered;
  };

  type Order = {
    id : Nat;
    customerId : Principal;
    items : [OrderItem];
    totalAmount : Nat;
    status : OrderStatus;
    timestamp : Int;
    // Dine-in orders sit at a numbered table; take-away orders sit at none.
    tableNumber : ?Nat;
  };

  // ── The floor ──
  // The floor plan is a fixed grid; a table's footprint depends on its size.
  // posX/posY are 1-based grid cells; 0/0 = unplaced (the shelf — the UI
  // auto-flows those exactly as before the editor existed).
  let GRID_W : Nat = 12;
  let GRID_H : Nat = 8;

  type DiningTable = {
    number : Nat; // the number painted on the table — the identity
    seats : Nat;
    retired : Bool; // retired tables keep history but take no allocations
    posX : Nat;
    posY : Nat;
  };

  // Footprint in grid cells, by table size (matches the drawn shapes).
  func footprint(seats : Nat) : (Nat, Nat) {
    if (seats <= 4) (2, 2) else if (seats <= 6) (3, 2) else (4, 2);
  };
  func rectsOverlap(ax : Nat, ay : Nat, aw : Nat, ah : Nat, bx : Nat, by_ : Nat, bw : Nat, bh : Nat) : Bool {
    ax < bx + bw and bx < ax + aw and ay < by_ + bh and by_ < ay + ah;
  };

  type ReservationStatus = { #booked; #seated; #completed; #cancelled; #noshow };

  type Reservation = {
    id : Nat;
    who : Principal;
    guestName : Text;
    tableNumber : Nat;
    partySize : Nat;
    startNs : Int;
    endNs : Int;
    status : ReservationStatus;
    createdAt : Int;
  };

  type FloorEvent = { at : Int; kind : Text; detail : Text; tableNumber : Nat; orderId : Nat };

  var nextMenuItemId : Nat = 1;
  var nextOrderId : Nat = 1;
  var nextReservationId : Nat = 1;

  // Persistent state
  var menuItems : Map.Map<Nat, MenuItem> = Map.empty<Nat, MenuItem>();
  var orders : Map.Map<Nat, Order> = Map.empty<Nat, Order>();
  let tables = Map.empty<Nat, DiningTable>();
  let reservations = Map.empty<Nat, Reservation>();
  let floorLog = List.empty<FloorEvent>();
  // Each placed order issues an invoice via the shared thebes-lib module.
  let invoices = Invoices.init();

  // Kitchen actions are gated on the admin tier (owner or staff); customers
  // never advance the kitchen-side lifecycle.
  private func isKitchen(caller : Principal) : Bool {
    Admin.isAdmin(admin, caller);
  };

  func logFloor(kind : Text, detail : Text, tableNumber : Nat, orderId : Nat) {
    List.add(floorLog, { at = Time.now(); kind; detail; tableNumber; orderId });
  };

  // ── Allocation law helpers (the heart of this example) ──────────────────

  func activeReservation(r : Reservation) : Bool {
    switch (r.status) { case (#booked or #seated) true; case _ false };
  };

  // Two closed-open intervals [aS,aE) and [bS,bE) overlap iff aS < bE and bS < aE.
  func overlaps(aS : Int, aE : Int, bS : Int, bE : Int) : Bool {
    aS < bE and bS < aE;
  };

  // The order currently occupying a table, if any (pending/preparing/ready).
  func activeOrderAt(tableNumber : Nat) : ?Order {
    for ((_, o) in Map.entries(orders)) {
      switch (o.status, o.tableNumber) {
        case (#delivered, _) {};
        case (_, ?t) { if (t == tableNumber) return ?o };
        case (_, null) {};
      };
    };
    null;
  };

  // A reservation whose window covers `now` (or is seated), on this table.
  func coveringReservation(tableNumber : Nat, now : Int) : ?Reservation {
    for ((_, r) in Map.entries(reservations)) {
      if (r.tableNumber == tableNumber and activeReservation(r)) {
        if (r.status == #seated or (r.startNs <= now and now < r.endNs)) return ?r;
      };
    };
    null;
  };

  func getDiningTable(n : Nat) : DiningTable {
    switch (Map.get(tables, Nat.compare, n)) {
      case (?t) { if (t.retired) Runtime.trap("Table " # Nat.toText(n) # " is retired.") else t };
      case null { Runtime.trap("No table " # Nat.toText(n) # " on the floor.") };
    };
  };

  // ── Floor management (kitchen-gated) ─────────────────────────────────────

  // Add a numbered table. The number is chosen by the operator (it's painted
  // on the table); re-using a retired number revives it with the new size.
  public shared(msg) func addTable(number : Nat, seats : Nat) : async () {
    Admin.requireNotPaused(admin);
    if (not isKitchen(msg.caller)) Runtime.trap("Not authorized");
    if (number == 0) Runtime.trap("Table numbers start at 1.");
    if (seats == 0 or seats > 20) Runtime.trap("Seats must be 1–20.");
    switch (Map.get(tables, Nat.compare, number)) {
      case (?t) { if (not t.retired) Runtime.trap("Table " # Nat.toText(number) # " already exists.") };
      case null {};
    };
    Map.add(tables, Nat.compare, number, { number; seats; retired = false; posX = 0; posY = 0 });
    logFloor("table.add", "table " # Nat.toText(number) # " (" # Nat.toText(seats) # " seats) joins the floor", number, 0);
  };

  public shared(msg) func setTableSeats(number : Nat, seats : Nat) : async () {
    Admin.requireNotPaused(admin);
    if (not isKitchen(msg.caller)) Runtime.trap("Not authorized");
    if (seats == 0 or seats > 20) Runtime.trap("Seats must be 1–20.");
    let t = getDiningTable(number);
    if (t.posX > 0) requirePlacementFree(number, t.posX, t.posY, seats);
    Map.add(tables, Nat.compare, number, { t with seats });
    logFloor("table.resize", "table " # Nat.toText(number) # " now seats " # Nat.toText(seats), number, 0);
  };

  // Retire a table — only when it is FREE (no active order, no live booking).
  public shared(msg) func retireTable(number : Nat) : async () {
    Admin.requireNotPaused(admin);
    if (not isKitchen(msg.caller)) Runtime.trap("Not authorized");
    let t = getDiningTable(number);
    if (activeOrderAt(number) != null) Runtime.trap("Table " # Nat.toText(number) # " has an active order.");
    for ((_, r) in Map.entries(reservations)) {
      if (r.tableNumber == number and activeReservation(r)) {
        Runtime.trap("Table " # Nat.toText(number) # " has live reservations.");
      };
    };
    Map.add(tables, Nat.compare, number, { t with retired = true });
    logFloor("table.retire", "table " # Nat.toText(number) # " leaves the floor", number, 0);
  };

  // Placement guard: the footprint must sit inside the grid and overlap no
  // other placed, unretired table. `skip` is the table being (re)placed.
  func requirePlacementFree(skip : Nat, x : Nat, y : Nat, seats : Nat) {
    let (w, h) = footprint(seats);
    if (x == 0 or y == 0) Runtime.trap("Grid cells start at 1.");
    if (x + w - 1 > GRID_W or y + h - 1 > GRID_H) Runtime.trap("That spot falls off the floor.");
    for ((_, o) in Map.entries(tables)) {
      if (o.number != skip and not o.retired and o.posX > 0) {
        let (ow, oh) = footprint(o.seats);
        if (rectsOverlap(x, y, w, h, o.posX, o.posY, ow, oh)) {
          Runtime.trap("That spot overlaps table " # Nat.toText(o.number) # ".");
        };
      };
    };
  };

  /// Arrange the floor: put a table at a grid cell (kitchen only). x=0,y=0
  /// sends it back to the shelf (auto-flow). The no-overlap guard is the same
  /// law the oracle audits.
  public shared(msg) func setTablePosition(number : Nat, x : Nat, y : Nat) : async () {
    Admin.requireNotPaused(admin);
    if (not isKitchen(msg.caller)) Runtime.trap("Not authorized");
    let t = getDiningTable(number);
    if (x == 0 and y == 0) {
      Map.add(tables, Nat.compare, number, { t with posX = 0; posY = 0 });
      logFloor("table.unplace", "table " # Nat.toText(number) # " goes back to the shelf", number, 0);
      return;
    };
    requirePlacementFree(number, x, y, t.seats);
    Map.add(tables, Nat.compare, number, { t with posX = x; posY = y });
    logFloor("table.place", "table " # Nat.toText(number) # " set at " # Nat.toText(x) # "," # Nat.toText(y), number, 0);
  };

  // ── Reservations (customers book; the guard does the arithmetic) ─────────

  // Book a table for a window. THE GUARD: rejected if any non-cancelled
  // reservation on the same table overlaps the window, or the party exceeds
  // the seats, or the window is in the past / inside-out.
  private func doReserve(caller : Principal, guestName : Text, tableNumber : Nat, partySize : Nat, startNs : Int, endNs : Int) : Result.Result<Nat, Text> {
    Admin.requireNotPaused(admin);
    if (Principal.isAnonymous(caller)) return #err("Sign in to reserve a table.");
    let t = getDiningTable(tableNumber);
    if (partySize == 0) return #err("A party of zero needs no table.");
    if (partySize > t.seats) return #err("Table " # Nat.toText(tableNumber) # " seats " # Nat.toText(t.seats) # " — your party is " # Nat.toText(partySize) # ".");
    if (endNs <= startNs) return #err("The reservation must end after it starts.");
    if (endNs - startNs > 6 * 3_600_000_000_000) return #err("Reservations are limited to 6 hours.");
    if (endNs < Time.now()) return #err("That window is already in the past.");
    // The no-double-booking law, extended to tables:
    for ((_, r) in Map.entries(reservations)) {
      if (r.tableNumber == tableNumber and activeReservation(r) and overlaps(startNs, endNs, r.startNs, r.endNs)) {
        return #err("Table " # Nat.toText(tableNumber) # " is already booked for that window.");
      };
    };
    let id = nextReservationId;
    nextReservationId += 1;
    Map.add(reservations, Nat.compare, id, {
      id; who = caller; guestName; tableNumber; partySize; startNs; endNs;
      status = #booked; createdAt = Time.now();
    });
    logFloor("reserve.book", guestName # " books table " # Nat.toText(tableNumber) # " (party of " # Nat.toText(partySize) # ")", tableNumber, 0);
    #ok(id);
  };

  public shared(msg) func reserveTable(guestName : Text, tableNumber : Nat, partySize : Nat, startNs : Int, endNs : Int) : async Result.Result<Nat, Text> {
    doReserve(msg.caller, guestName, tableNumber, partySize, startNs, endNs);
  };
  public shared(msg) func reserveTableOrTrap(guestName : Text, tableNumber : Nat, partySize : Nat, startNs : Int, endNs : Int) : async Nat {
    switch (doReserve(msg.caller, guestName, tableNumber, partySize, startNs, endNs)) {
      case (#ok(id)) id; case (#err(e)) Runtime.trap(e);
    };
  };

  // The guest (or the kitchen) cancels a booking.
  public shared(msg) func cancelReservation(id : Nat) : async () {
    switch (Map.get(reservations, Nat.compare, id)) {
      case null { Runtime.trap("Reservation not found.") };
      case (?r) {
        if (not Principal.equal(r.who, msg.caller) and not isKitchen(msg.caller)) Runtime.trap("Not your reservation.");
        if (r.status != #booked) Runtime.trap("Only a booked reservation can be cancelled.");
        Map.add(reservations, Nat.compare, id, { r with status = #cancelled });
        logFloor("reserve.cancel", r.guestName # " releases table " # Nat.toText(r.tableNumber), r.tableNumber, 0);
      };
    };
  };

  // The party arrived: the kitchen seats them. The table is now occupied by
  // this reservation until completed/freed.
  public shared(msg) func seatReservation(id : Nat) : async () {
    Admin.requireNotPaused(admin);
    if (not isKitchen(msg.caller)) Runtime.trap("Not authorized");
    switch (Map.get(reservations, Nat.compare, id)) {
      case null { Runtime.trap("Reservation not found.") };
      case (?r) {
        if (r.status != #booked) Runtime.trap("Only a booked reservation can be seated.");
        ignore getDiningTable(r.tableNumber); // still on the floor
        Map.add(reservations, Nat.compare, id, { r with status = #seated });
        logFloor("reserve.seat", r.guestName # "'s party sits at table " # Nat.toText(r.tableNumber), r.tableNumber, 0);
      };
    };
  };

  // The party left / never came: close the reservation out.
  public shared(msg) func completeReservation(id : Nat, showed : Bool) : async () {
    Admin.requireNotPaused(admin);
    if (not isKitchen(msg.caller)) Runtime.trap("Not authorized");
    switch (Map.get(reservations, Nat.compare, id)) {
      case null { Runtime.trap("Reservation not found.") };
      case (?r) {
        if (r.status != #booked and r.status != #seated) Runtime.trap("Reservation already closed.");
        let next : ReservationStatus = if (showed) #completed else #noshow;
        Map.add(reservations, Nat.compare, id, { r with status = next });
        logFloor("reserve.close", r.guestName # (if (showed) " finishes at table " else " no-shows table ") # Nat.toText(r.tableNumber), r.tableNumber, 0);
      };
    };
  };

  // ── Menu (unchanged surface + audit events) ──────────────────────────────

  private func addMenuItemRaw(name : Text, priceE8s : Nat, photoPath : ?Text) : Nat {
    let id = nextMenuItemId;
    nextMenuItemId += 1;
    let item : MenuItem = {
      id = id;
      name = name;
      priceE8s = priceE8s;
      available = true;
      photoPath = photoPath;
    };
    Map.add(menuItems, Nat.compare, id, item);
    id;
  };

  private func doAddMenuItem(caller : Principal, name : Text, priceE8s : Nat, photoPath : ?Text) : Result.Result<Nat, Text> {
    Admin.requireNotPaused(admin);
    if (not isKitchen(caller)) { return #err("Not authorized") };
    #ok(addMenuItemRaw(name, priceE8s, photoPath));
  };

  public shared(msg) func addMenuItem(name : Text, priceE8s : Nat, photoPath : ?Text) : async Result.Result<Nat, Text> {
    doAddMenuItem(msg.caller, name, priceE8s, photoPath);
  };
  public shared(msg) func addMenuItemOrTrap(name : Text, priceE8s : Nat, photoPath : ?Text) : async Nat {
    switch (doAddMenuItem(msg.caller, name, priceE8s, photoPath)) { case (#ok(id)) { id }; case (#err(e)) { Runtime.trap(e) } };
  };

  private func doSetMenuItemPhoto(caller : Principal, id : Nat, photoPath : Text) : Result.Result<(), Text> {
    Admin.requireNotPaused(admin);
    if (not isKitchen(caller)) { return #err("Not authorized") };
    switch (Map.get(menuItems, Nat.compare, id)) {
      case null { #err("Item not found") };
      case (?item) {
        Map.add(menuItems, Nat.compare, id, { item with photoPath = ?photoPath });
        #ok(());
      };
    };
  };

  public shared(msg) func setMenuItemPhoto(id : Nat, photoPath : Text) : async Result.Result<(), Text> {
    doSetMenuItemPhoto(msg.caller, id, photoPath);
  };
  public shared(msg) func setMenuItemPhotoOrTrap(id : Nat, photoPath : Text) : async () {
    switch (doSetMenuItemPhoto(msg.caller, id, photoPath)) { case (#ok(())) {}; case (#err(e)) { Runtime.trap(e) } };
  };

  public query func getMenu() : async [MenuItem] {
    Iter.toArray(Map.values(menuItems));
  };

  private func doSetItemAvailable(caller : Principal, id : Nat, available : Bool) : Result.Result<(), Text> {
    Admin.requireNotPaused(admin);
    if (not isKitchen(caller)) { return #err("Not authorized") };
    switch (Map.get(menuItems, Nat.compare, id)) {
      case null { #err("Item not found") };
      case (?item) {
        let updated = { item with available = available };
        Map.add(menuItems, Nat.compare, id, updated);
        #ok(());
      };
    };
  };

  public shared(msg) func setItemAvailable(id : Nat, available : Bool) : async Result.Result<(), Text> {
    doSetItemAvailable(msg.caller, id, available);
  };
  public shared(msg) func setItemAvailableOrTrap(id : Nat, available : Bool) : async () {
    switch (doSetItemAvailable(msg.caller, id, available)) { case (#ok(())) {}; case (#err(e)) { Runtime.trap(e) } };
  };

  public shared(msg) func updateMenuPrice(id : Nat, newPrice : Nat) : async Result.Result<(), Text> {
    Admin.requireNotPaused(admin);
    if (not isKitchen(msg.caller)) { return #err("Not authorized") };
    switch (Map.get(menuItems, Nat.compare, id)) {
      case null { #err("Item not found") };
      case (?item) {
        let updated = { item with priceE8s = newPrice };
        Map.add(menuItems, Nat.compare, id, updated);
        #ok(());
      };
    };
  };

  public query func getMenuItem(id : Nat) : async ?MenuItem {
    Map.get(menuItems, Nat.compare, id);
  };

  // ── Orders (now table-aware) ─────────────────────────────────────────────

  // Core order placement over an explicit caller (validate-then-create).
  // tableNumber 0 = take-away. A dine-in order claims its table — THE GUARD:
  // one active order per table, and the table must be on the floor.
  private func doPlaceOrder(caller : Principal, items : [OrderItem], tableNumber : Nat) : Result.Result<Nat, Text> {
    Admin.requireNotPaused(admin);
    if (items.size() == 0) return #err("The order is empty.");
    var totalAmount : Nat = 0;

    for (item in items.values()) {
      switch (Map.get(menuItems, Nat.compare, item.menuItemId)) {
        case (?menuItem) {
          if (menuItem.available) {
            totalAmount += menuItem.priceE8s * item.quantity;
          } else {
            return #err("Item " # Nat.toText(item.menuItemId) # " is unavailable");
          };
        };
        case null { return #err("Unknown item " # Nat.toText(item.menuItemId)) };
      };
    };

    let table : ?Nat = if (tableNumber == 0) null else {
      let t = getDiningTable(tableNumber);
      switch (activeOrderAt(tableNumber)) {
        case (?o) { return #err("Table " # Nat.toText(tableNumber) # " already has order #" # Nat.toText(o.id) # " running.") };
        case null {};
      };
      // A table reserved for someone ELSE right now can't take a walk-in order.
      switch (coveringReservation(tableNumber, Time.now())) {
        case (?r) {
          if (not Principal.equal(r.who, caller) and not isKitchen(caller)) {
            return #err("Table " # Nat.toText(tableNumber) # " is reserved for " # r.guestName # " right now.");
          };
        };
        case null {};
      };
      ?t.number;
    };

    let orderId = nextOrderId;
    nextOrderId += 1;

    let order : Order = {
      id = orderId;
      customerId = caller;
      items = items;
      totalAmount = totalAmount;
      status = #pending;
      timestamp = Time.now();
      tableNumber = table;
    };

    Map.add(orders, Nat.compare, orderId, order);
    switch (table) {
      case (?t) { logFloor("order.seated", "order #" # Nat.toText(orderId) # " opens at table " # Nat.toText(t), t, orderId) };
      case null { logFloor("order.takeaway", "take-away order #" # Nat.toText(orderId) # " opens", 0, orderId) };
    };

    // Issue an invoice for the order (owner → customer) from its line items.
    let seller = switch (Admin.getOwner(admin)) { case (?o) o; case null caller };
    let lineItems = Array.map<OrderItem, Invoices.LineItem>(
      items,
      func(it) {
        switch (Map.get(menuItems, Nat.compare, it.menuItemId)) {
          case (?m) { { description = m.name; quantity = it.quantity; unitPriceE8s = m.priceE8s } };
          case null { { description = "item"; quantity = it.quantity; unitPriceE8s = 0 } };
        };
      },
    );
    ignore Invoices.createIssued(invoices, Time.now(), seller, caller, lineItems, 0);

    #ok(orderId);
  };

  public shared(msg) func placeOrder(items : [OrderItem]) : async Result.Result<Nat, Text> { doPlaceOrder(msg.caller, items, 0) };

  // Frontend-friendly: two parallel arrays (the SPA encodes vec<nat> easily) →
  // zipped into order items → returns the order id, or traps with the reason.
  // tableNumber 0 = take-away, else dine-in at that table.
  public shared(msg) func placeOrderFlatOrTrap(menuItemIds : [Nat], quantities : [Nat], tableNumber : Nat) : async Nat {
    let n = Nat.min(menuItemIds.size(), quantities.size());
    let items = Array.tabulate<OrderItem>(n, func(i) { { menuItemId = menuItemIds[i]; quantity = quantities[i] } });
    switch (doPlaceOrder(msg.caller, items, tableNumber)) { case (#ok(id)) { id }; case (#err(e)) { Runtime.trap(e) } };
  };

  // Kitchen moves a running order between tables (or to take-away with 0) —
  // same guard: the destination must be free.
  public shared(msg) func moveOrderToTable(orderId : Nat, tableNumber : Nat) : async () {
    Admin.requireNotPaused(admin);
    if (not isKitchen(msg.caller)) Runtime.trap("Not authorized");
    switch (Map.get(orders, Nat.compare, orderId)) {
      case null { Runtime.trap("Order not found") };
      case (?o) {
        if (o.status == #delivered) Runtime.trap("Order already delivered.");
        let dest : ?Nat = if (tableNumber == 0) null else {
          ignore getDiningTable(tableNumber);
          switch (activeOrderAt(tableNumber)) {
            case (?other) { if (other.id != orderId) Runtime.trap("Table " # Nat.toText(tableNumber) # " already has order #" # Nat.toText(other.id) # ".") };
            case null {};
          };
          ?tableNumber;
        };
        Map.add(orders, Nat.compare, orderId, { o with tableNumber = dest });
        logFloor("order.moved", "order #" # Nat.toText(orderId) # (if (tableNumber == 0) " becomes take-away" else " moves to table " # Nat.toText(tableNumber)), tableNumber, orderId);
      };
    };
  };

  public query func getOrder(id : Nat) : async ?Order {
    Map.get(orders, Nat.compare, id);
  };

  // Shared forward-only transition: kitchen-gated, requires the order to be in
  // `from`, moves it to `to`, else rejects with `wrongMsg`.
  private func doAdvance(caller : Principal, orderId : Nat, from : OrderStatus, to : OrderStatus, wrongMsg : Text) : Result.Result<(), Text> {
    Admin.requireNotPaused(admin);
    if (not isKitchen(caller)) { return #err("Not authorized") };
    switch (Map.get(orders, Nat.compare, orderId)) {
      case null { #err("Order not found") };
      case (?order) {
        if (order.status == from) {
          Map.add(orders, Nat.compare, orderId, { order with status = to });
          if (to == #delivered) {
            switch (order.tableNumber) {
              case (?t) { logFloor("order.closed", "order #" # Nat.toText(orderId) # " delivered — table " # Nat.toText(t) # " frees", t, orderId) };
              case null {};
            };
          };
          #ok(());
        } else { #err(wrongMsg) };
      };
    };
  };

  public shared(msg) func startPreparingOrder(orderId : Nat) : async Result.Result<(), Text> {
    doAdvance(msg.caller, orderId, #pending, #preparing, "Order is not pending");
  };
  public shared(msg) func startPreparingOrderOrTrap(orderId : Nat) : async () {
    switch (doAdvance(msg.caller, orderId, #pending, #preparing, "Order is not pending")) { case (#ok(())) {}; case (#err(e)) { Runtime.trap(e) } };
  };

  public shared(msg) func markOrderReady(orderId : Nat) : async Result.Result<(), Text> {
    doAdvance(msg.caller, orderId, #preparing, #ready, "Order is not preparing");
  };
  public shared(msg) func markOrderReadyOrTrap(orderId : Nat) : async () {
    switch (doAdvance(msg.caller, orderId, #preparing, #ready, "Order is not preparing")) { case (#ok(())) {}; case (#err(e)) { Runtime.trap(e) } };
  };

  public shared(msg) func markDelivered(orderId : Nat) : async Result.Result<(), Text> {
    doAdvance(msg.caller, orderId, #ready, #delivered, "Order is not ready");
  };
  public shared(msg) func markDeliveredOrTrap(orderId : Nat) : async () {
    switch (doAdvance(msg.caller, orderId, #ready, #delivered, "Order is not ready")) { case (#ok(())) {}; case (#err(e)) { Runtime.trap(e) } };
  };

  public query func getOpenOrders() : async [Order] {
    let allOrders = Iter.toArray(Map.values(orders));
    let openOrders = Array.filter(allOrders, func(o) {
      switch (o.status) {
        case (#pending or #preparing) { true };
        case _ { false };
      };
    });
    Array.sort(openOrders, func(a, b) {
      Int.compare(a.timestamp, b.timestamp)
    });
  };

  // Owner-gated. Revenue counts only #delivered orders whose timestamp falls
  // within [dayStartNs, dayEndNs). Returns zeros to non-owners.
  public shared query(msg) func getOwnerStats(dayStartNs : Int, dayEndNs : Int) : async { totalRevenue : Nat; totalOrders : Nat } {
    if (not Admin.isOwner(admin, msg.caller)) {
      return { totalRevenue = 0; totalOrders = 0 };
    };
    var revenue : Nat = 0;
    var count : Nat = 0;

    for ((_, order) in Map.entries(orders)) {
      if (order.status == #delivered and order.timestamp >= dayStartNs and order.timestamp < dayEndNs) {
        revenue += order.totalAmount;
        count += 1;
      };
    };

    { totalRevenue = revenue; totalOrders = count };
  };

  // Seed a demo restaurant on a fresh contract: a menu AND a floor, so a
  // just-deployed room is immediately alive. Fires only while the menu is empty.
  public shared(msg) func seedDemo() : async Bool {
    if (Principal.isAnonymous(msg.caller)) { Runtime.trap("Sign in to load demo data") };
    if (Map.size(menuItems) > 0) { return false };
    ignore addMenuItemRaw("Margherita Pizza", 1250000000, null);
    ignore addMenuItemRaw("Spaghetti Carbonara", 1600000000, null);
    ignore addMenuItemRaw("Caesar Salad", 950000000, null);
    ignore addMenuItemRaw("Grilled Salmon", 2200000000, null);
    ignore addMenuItemRaw("Tiramisu", 700000000, null);
    ignore addMenuItemRaw("Sparkling Water", 350000000, null);
    if (Map.size(tables) == 0) {
      Map.add(tables, Nat.compare, 1, { number = 1; seats = 2; retired = false; posX = 0; posY = 0 });
      Map.add(tables, Nat.compare, 2, { number = 2; seats = 2; retired = false; posX = 0; posY = 0 });
      Map.add(tables, Nat.compare, 3, { number = 3; seats = 4; retired = false; posX = 0; posY = 0 });
      Map.add(tables, Nat.compare, 4, { number = 4; seats = 4; retired = false; posX = 0; posY = 0 });
      Map.add(tables, Nat.compare, 5, { number = 5; seats = 6; retired = false; posX = 0; posY = 0 });
      Map.add(tables, Nat.compare, 6, { number = 6; seats = 8; retired = false; posX = 0; posY = 0 });
      logFloor("seed.floor", "six tables join the floor", 0, 0);
    };
    true;
  };

  // ── The proof: the floor's allocation laws, recomputable by anyone ───────
  public query func invariantReportView() : async [{
    rule : Text; tableNumber : Nat; detail : Text;
  }] {
    let bad = List.empty<{ rule : Text; tableNumber : Nat; detail : Text }>();
    // (a) at most one active order per table
    for ((_, t) in Map.entries(tables)) {
      var count = 0;
      for ((_, o) in Map.entries(orders)) {
        switch (o.status, o.tableNumber) {
          case (#delivered, _) {};
          case (_, ?tn) { if (tn == t.number) count += 1 };
          case (_, null) {};
        };
      };
      if (count > 1) {
        List.add(bad, { rule = "one-order-per-table"; tableNumber = t.number; detail = Nat.toText(count) # " active orders" });
      };
    };
    // (b) zero overlapping non-cancelled reservations per table
    let resArr = Iter.toArray(Map.values(reservations));
    var i = 0;
    while (i < resArr.size()) {
      var j = i + 1;
      while (j < resArr.size()) {
        let a = resArr[i]; let b = resArr[j];
        if (a.tableNumber == b.tableNumber and activeReservation(a) and activeReservation(b)
            and overlaps(a.startNs, a.endNs, b.startNs, b.endNs)) {
          List.add(bad, { rule = "no-overlap"; tableNumber = a.tableNumber; detail = "reservations #" # Nat.toText(a.id) # " and #" # Nat.toText(b.id) # " overlap" });
        };
        j += 1;
      };
      i += 1;
    };
    // (c') no two placed tables overlap on the floor plan
    let tArr = Iter.toArray(Map.values(tables));
    var ti = 0;
    while (ti < tArr.size()) {
      var tj = ti + 1;
      while (tj < tArr.size()) {
        let a = tArr[ti]; let b = tArr[tj];
        if (not a.retired and not b.retired and a.posX > 0 and b.posX > 0) {
          let (aw, ah) = footprint(a.seats);
          let (bw, bh) = footprint(b.seats);
          if (rectsOverlap(a.posX, a.posY, aw, ah, b.posX, b.posY, bw, bh)) {
            List.add(bad, { rule = "floor-overlap"; tableNumber = a.number; detail = "tables " # Nat.toText(a.number) # " and " # Nat.toText(b.number) # " occupy the same cells" });
          };
        };
        tj += 1;
      };
      ti += 1;
    };
    // (c) every live allocation references a real, unretired table; party fits
    for ((_, r) in Map.entries(reservations)) {
      if (activeReservation(r)) {
        switch (Map.get(tables, Nat.compare, r.tableNumber)) {
          case null { List.add(bad, { rule = "table-exists"; tableNumber = r.tableNumber; detail = "reservation #" # Nat.toText(r.id) # " references a missing table" }) };
          case (?t) {
            if (t.retired) List.add(bad, { rule = "table-exists"; tableNumber = r.tableNumber; detail = "reservation #" # Nat.toText(r.id) # " references a retired table" });
            if (r.partySize > t.seats) List.add(bad, { rule = "party-fits"; tableNumber = r.tableNumber; detail = "party " # Nat.toText(r.partySize) # " > " # Nat.toText(t.seats) # " seats" });
          };
        };
      };
    };
    List.toArray(bad);
  };

  // One line for the footer: the whole floor audited in a single query.
  public query func floorSealView() : async [{
    tablesOnFloor : Nat; occupied : Nat; reservedNow : Nat; violations : Nat; checkedAt : Int;
  }] {
    let now = Time.now();
    var onFloor = 0; var occupied = 0; var reservedNow = 0;
    for ((_, t) in Map.entries(tables)) {
      if (not t.retired) {
        onFloor += 1;
        if (activeOrderAt(t.number) != null) { occupied += 1 }
        else if (coveringReservation(t.number, now) != null) { reservedNow += 1 };
      };
    };
    // violations = the full report's size (cheap at example scale)
    var v = 0;
    for ((_, t) in Map.entries(tables)) {
      var count = 0;
      for ((_, o) in Map.entries(orders)) {
        switch (o.status, o.tableNumber) {
          case (#delivered, _) {};
          case (_, ?tn) { if (tn == t.number) count += 1 };
          case (_, null) {};
        };
      };
      if (count > 1) v += 1;
    };
    [{ tablesOnFloor = onFloor; occupied; reservedNow; violations = v; checkedAt = now }];
  };

  // ── Frontend view-models (flat records — easy to decode in the SPA) ──
  func statusText(s : OrderStatus) : Text {
    switch s { case (#pending) "pending"; case (#preparing) "preparing"; case (#ready) "ready"; case (#delivered) "delivered" };
  };
  func resStatusText(s : ReservationStatus) : Text {
    switch s { case (#booked) "booked"; case (#seated) "seated"; case (#completed) "completed"; case (#cancelled) "cancelled"; case (#noshow) "noshow" };
  };

  public query func menuView() : async [{ id : Nat; name : Text; priceE8s : Nat; available : Bool; photoPath : Text }] {
    Array.map<MenuItem, { id : Nat; name : Text; priceE8s : Nat; available : Bool; photoPath : Text }>(
      Iter.toArray(Map.values(menuItems)),
      func(m) { { id = m.id; name = m.name; priceE8s = m.priceE8s; available = m.available; photoPath = (switch (m.photoPath) { case (?p) p; case null "" }) } },
    )
  };

  // THE FLOOR — one row per live table with its derived status, current order,
  // current/next reservation, all joined server-side so the SPA draws it in one
  // call. status: "free" | "reserved" | "occupied" | "ready".
  public shared query(msg) func floorView() : async [{
    number : Nat; seats : Nat; status : Text;
    orderId : Nat; orderStatus : Text; orderTotalE8s : Nat; orderIsMine : Bool;
    guestName : Text; reservationId : Nat; partySize : Nat; resStart : Int; resEnd : Int; resSeated : Bool;
    nextResAt : Int; nowNs : Int; posX : Nat; posY : Nat; gridW : Nat; gridH : Nat;
  }] {
    let now = Time.now();
    let live = Array.filter<(Nat, DiningTable)>(Map.toArray(tables), func((_, t)) { not t.retired });
    Array.map<(Nat, DiningTable), {
      number : Nat; seats : Nat; status : Text;
      orderId : Nat; orderStatus : Text; orderTotalE8s : Nat; orderIsMine : Bool;
      guestName : Text; reservationId : Nat; partySize : Nat; resStart : Int; resEnd : Int; resSeated : Bool;
      nextResAt : Int; nowNs : Int; posX : Nat; posY : Nat; gridW : Nat; gridH : Nat;
    }>(live, func((_, t)) {
      let ord = activeOrderAt(t.number);
      let res = coveringReservation(t.number, now);
      // the next FUTURE booking, for the "reserved at 19:00" hint on free tables
      var nextAt : Int = 0;
      for ((_, r) in Map.entries(reservations)) {
        if (r.tableNumber == t.number and r.status == #booked and r.startNs > now) {
          if (nextAt == 0 or r.startNs < nextAt) nextAt := r.startNs;
        };
      };
      let status = switch (ord, res) {
        case (?o, _) { if (o.status == #ready) "ready" else "occupied" };
        case (null, ?_) "reserved";
        case (null, null) "free";
      };
      {
        number = t.number; seats = t.seats; status;
        orderId = (switch (ord) { case (?o) o.id; case null 0 });
        orderStatus = (switch (ord) { case (?o) statusText(o.status); case null "" });
        orderTotalE8s = (switch (ord) { case (?o) o.totalAmount; case null 0 });
        orderIsMine = (switch (ord) { case (?o) Principal.equal(o.customerId, msg.caller); case null false });
        guestName = (switch (res) { case (?r) r.guestName; case null "" });
        reservationId = (switch (res) { case (?r) r.id; case null 0 });
        partySize = (switch (res) { case (?r) r.partySize; case null 0 });
        resStart = (switch (res) { case (?r) r.startNs; case null 0 });
        resEnd = (switch (res) { case (?r) r.endNs; case null 0 });
        resSeated = (switch (res) { case (?r) r.status == #seated; case null false });
        nextResAt = nextAt; nowNs = now;
        posX = t.posX; posY = t.posY; gridW = GRID_W; gridH = GRID_H;
      };
    });
  };

  // The caller's bookings, newest first.
  public shared query(msg) func myReservationsView() : async [{
    id : Nat; tableNumber : Nat; partySize : Nat; startNs : Int; endNs : Int; status : Text; nowNs : Int;
  }] {
    let mine = Array.filter<Reservation>(Iter.toArray(Map.values(reservations)), func(r) { Principal.equal(r.who, msg.caller) });
    let sorted = Array.sort<Reservation>(mine, func(a, b) { Int.compare(b.startNs, a.startNs) });
    let now = Time.now();
    Array.map<Reservation, { id : Nat; tableNumber : Nat; partySize : Nat; startNs : Int; endNs : Int; status : Text; nowNs : Int }>(
      sorted, func(r) { { id = r.id; tableNumber = r.tableNumber; partySize = r.partySize; startNs = r.startNs; endNs = r.endNs; status = resStatusText(r.status); nowNs = now } },
    );
  };

  // All live bookings for the kitchen's book (booked + seated, soonest first).
  public shared query(msg) func reservationsBookView() : async [{
    id : Nat; guestName : Text; tableNumber : Nat; partySize : Nat; startNs : Int; endNs : Int; status : Text; nowNs : Int;
  }] {
    if (not isKitchen(msg.caller)) return [];
    let live = Array.filter<Reservation>(Iter.toArray(Map.values(reservations)), activeReservation);
    let sorted = Array.sort<Reservation>(live, func(a, b) { Int.compare(a.startNs, b.startNs) });
    let now = Time.now();
    Array.map<Reservation, { id : Nat; guestName : Text; tableNumber : Nat; partySize : Nat; startNs : Int; endNs : Int; status : Text; nowNs : Int }>(
      sorted, func(r) { { id = r.id; guestName = r.guestName; tableNumber = r.tableNumber; partySize = r.partySize; startNs = r.startNs; endNs = r.endNs; status = resStatusText(r.status); nowNs = now } },
    );
  };

  // The floor's story, newest first.
  public query func floorEventsView(offset : Nat, limit : Nat) : async [{
    at : Int; kind : Text; detail : Text; tableNumber : Nat; orderId : Nat;
  }] {
    let n = List.size(floorLog);
    if (offset >= n) return [];
    let take = Nat.min(Nat.min(limit, 50), n - offset);
    let out = List.empty<{ at : Int; kind : Text; detail : Text; tableNumber : Nat; orderId : Nat }>();
    var i = 0;
    for (e in List.reverseValues(floorLog)) {
      if (i >= offset and i < offset + take) { List.add(out, e) };
      i += 1;
    };
    List.toArray(out);
  };

  public shared query(msg) func myOrdersView() : async [{ id : Nat; status : Text; totalAmount : Nat; itemCount : Nat; timestamp : Int; tableNumber : Nat }] {
    let mine = Array.filter(Iter.toArray(Map.values(orders)), func(o : Order) : Bool { Principal.equal(o.customerId, msg.caller) });
    let sorted = Array.sort(mine, func(a : Order, b : Order) : { #less; #equal; #greater } { Int.compare(b.timestamp, a.timestamp) });
    Array.map<Order, { id : Nat; status : Text; totalAmount : Nat; itemCount : Nat; timestamp : Int; tableNumber : Nat }>(
      sorted, func(o) { { id = o.id; status = statusText(o.status); totalAmount = o.totalAmount; itemCount = o.items.size(); timestamp = o.timestamp; tableNumber = (switch (o.tableNumber) { case (?t) t; case null 0 }) } },
    )
  };

  public shared query(msg) func myInvoicesView() : async [{ id : Nat; totalE8s : Nat; status : Text; itemCount : Nat; createdAt : Int }] {
    Array.map<Invoices.Invoice, { id : Nat; totalE8s : Nat; status : Text; itemCount : Nat; createdAt : Int }>(
      Invoices.forPrincipal(invoices, msg.caller),
      func(i) { { id = i.id; totalE8s = i.totalE8s; status = Invoices.statusText(i.status); itemCount = i.lineItems.size(); createdAt = i.createdAt } },
    )
  };

  // Kitchen queue (admin/kitchen only): open orders (pending/preparing/ready),
  // oldest first, with their tables.
  public shared query(msg) func kitchenView() : async [{ id : Nat; status : Text; totalAmount : Nat; itemCount : Nat; timestamp : Int; tableNumber : Nat }] {
    if (not isKitchen(msg.caller)) return [];
    let open = Array.filter(Iter.toArray(Map.values(orders)), func(o : Order) : Bool {
      switch (o.status) { case (#pending or #preparing or #ready) true; case _ false };
    });
    let sorted = Array.sort(open, func(a : Order, b : Order) : { #less; #equal; #greater } { Int.compare(a.timestamp, b.timestamp) });
    Array.map<Order, { id : Nat; status : Text; totalAmount : Nat; itemCount : Nat; timestamp : Int; tableNumber : Nat }>(
      sorted, func(o) { { id = o.id; status = statusText(o.status); totalAmount = o.totalAmount; itemCount = o.items.size(); timestamp = o.timestamp; tableNumber = (switch (o.tableNumber) { case (?t) t; case null 0 }) } },
    )
  };
};
