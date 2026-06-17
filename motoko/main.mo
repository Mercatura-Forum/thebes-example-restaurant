import Map "mo:core/Map";
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
  };

  var nextMenuItemId : Nat = 1;
  var nextOrderId : Nat = 1;

  // Persistent state
  var menuItems : Map.Map<Nat, MenuItem> = Map.empty<Nat, MenuItem>();
  var orders : Map.Map<Nat, Order> = Map.empty<Nat, Order>();
  // Each placed order issues an invoice via the shared thebes-lib module.
  let invoices = Invoices.init();

  // Kitchen actions are gated on the admin tier (owner or staff); customers
  // never advance the kitchen-side lifecycle.
  private func isKitchen(caller : Principal) : Bool {
    Admin.isAdmin(admin, caller);
  };

  // Order status lifecycle (forward-only, kitchen-driven):
  //   #pending --startPreparingOrder--> #preparing
  //           --markOrderReady--------> #ready
  //           --markDelivered---------> #delivered
  // Each transition is owner-gated and rejects out-of-order requests.

  // No-auth core: append a menu item and return its id. Used by the gated
  // public methods and by seedDemo (which bypasses the owner gate on an empty
  // contract so a fresh deploy is immediately alive).
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

  // Owner-gated: only the restaurant may add menu items.
  public shared(msg) func addMenuItem(name : Text, priceE8s : Nat, photoPath : ?Text) : async Result.Result<Nat, Text> {
    doAddMenuItem(msg.caller, name, priceE8s, photoPath);
  };

  // Trap-on-error twin: returns the id on success and traps the error message
  // (e.g. "Not authorized") so a frontend gets a clean success/failure.
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

  // Owner/kitchen-gated: set/replace a dish photo (uploaded to media first).
  public shared(msg) func setMenuItemPhoto(id : Nat, photoPath : Text) : async Result.Result<(), Text> {
    doSetMenuItemPhoto(msg.caller, id, photoPath);
  };

  public shared(msg) func setMenuItemPhotoOrTrap(id : Nat, photoPath : Text) : async () {
    switch (doSetMenuItemPhoto(msg.caller, id, photoPath)) { case (#ok(())) {}; case (#err(e)) { Runtime.trap(e) } };
  };

  // Full menu listing (public) — items in id order. The single-item getMenuItem
  // alone left a frontend unable to render the menu.
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

  // Owner-gated: toggle whether an item can currently be ordered.
  public shared(msg) func setItemAvailable(id : Nat, available : Bool) : async Result.Result<(), Text> {
    doSetItemAvailable(msg.caller, id, available);
  };

  public shared(msg) func setItemAvailableOrTrap(id : Nat, available : Bool) : async () {
    switch (doSetItemAvailable(msg.caller, id, available)) { case (#ok(())) {}; case (#err(e)) { Runtime.trap(e) } };
  };

  // Owner-gated: change an item's price.
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

  // Distinguishes an unknown item id from a known-but-unavailable item so the
  // caller can react appropriately, instead of an ambiguous 0.
  // Core order placement over an explicit caller (validate-then-create).
  private func doPlaceOrder(caller : Principal, items : [OrderItem]) : Result.Result<Nat, Text> {
    Admin.requireNotPaused(admin);
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

    let orderId = nextOrderId;
    nextOrderId += 1;

    let order : Order = {
      id = orderId;
      customerId = caller;
      items = items;
      totalAmount = totalAmount;
      status = #pending;
      timestamp = Time.now();
    };

    Map.add(orders, Nat.compare, orderId, order);

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

  public shared(msg) func placeOrder(items : [OrderItem]) : async Result.Result<Nat, Text> { doPlaceOrder(msg.caller, items) };

  // Frontend-friendly: two parallel arrays (the SPA encodes vec<nat> easily) →
  // zipped into order items → returns the order id, or traps with the reason.
  public shared(msg) func placeOrderFlatOrTrap(menuItemIds : [Nat], quantities : [Nat]) : async Nat {
    let n = Nat.min(menuItemIds.size(), quantities.size());
    let items = Array.tabulate<OrderItem>(n, func(i) { { menuItemId = menuItemIds[i]; quantity = quantities[i] } });
    switch (doPlaceOrder(msg.caller, items)) { case (#ok(id)) { id }; case (#err(e)) { Runtime.trap(e) } };
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
          #ok(());
        } else { #err(wrongMsg) };
      };
    };
  };

  // Owner-gated (kitchen). Forward-only: #pending -> #preparing.
  public shared(msg) func startPreparingOrder(orderId : Nat) : async Result.Result<(), Text> {
    doAdvance(msg.caller, orderId, #pending, #preparing, "Order is not pending");
  };
  public shared(msg) func startPreparingOrderOrTrap(orderId : Nat) : async () {
    switch (doAdvance(msg.caller, orderId, #pending, #preparing, "Order is not pending")) { case (#ok(())) {}; case (#err(e)) { Runtime.trap(e) } };
  };

  // Owner-gated (kitchen). Forward-only: #preparing -> #ready.
  public shared(msg) func markOrderReady(orderId : Nat) : async Result.Result<(), Text> {
    doAdvance(msg.caller, orderId, #preparing, #ready, "Order is not preparing");
  };
  public shared(msg) func markOrderReadyOrTrap(orderId : Nat) : async () {
    switch (doAdvance(msg.caller, orderId, #preparing, #ready, "Order is not preparing")) { case (#ok(())) {}; case (#err(e)) { Runtime.trap(e) } };
  };

  // Owner-gated (kitchen). Forward-only: #ready -> #delivered. Without this
  // transition no order ever reaches #delivered, so getOwnerStats revenue
  // would always be zero.
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

  // Seed a demo menu on a fresh contract so a just-deployed restaurant is
  // immediately alive. Bypasses the owner gate but only fires when the menu is
  // empty (the first signed-in visitor brings it to life). Prices in e8s.
  public shared(msg) func seedDemo() : async Bool {
    if (Principal.isAnonymous(msg.caller)) { Runtime.trap("Sign in to load demo data") };
    if (Map.size(menuItems) > 0) { return false };
    ignore addMenuItemRaw("Margherita Pizza", 1250000000, null);
    ignore addMenuItemRaw("Spaghetti Carbonara", 1600000000, null);
    ignore addMenuItemRaw("Caesar Salad", 950000000, null);
    ignore addMenuItemRaw("Grilled Salmon", 2200000000, null);
    ignore addMenuItemRaw("Tiramisu", 700000000, null);
    ignore addMenuItemRaw("Sparkling Water", 350000000, null);
    true;
  };

  // ── Frontend view-models (flat records — easy to decode in the SPA) ──
  func statusText(s : OrderStatus) : Text {
    switch s { case (#pending) "pending"; case (#preparing) "preparing"; case (#ready) "ready"; case (#delivered) "delivered" };
  };

  public query func menuView() : async [{ id : Nat; name : Text; priceE8s : Nat; available : Bool; photoPath : Text }] {
    Array.map<MenuItem, { id : Nat; name : Text; priceE8s : Nat; available : Bool; photoPath : Text }>(
      Iter.toArray(Map.values(menuItems)),
      func(m) { { id = m.id; name = m.name; priceE8s = m.priceE8s; available = m.available; photoPath = (switch (m.photoPath) { case (?p) p; case null "" }) } },
    )
  };

  public shared query(msg) func myOrdersView() : async [{ id : Nat; status : Text; totalAmount : Nat; itemCount : Nat; timestamp : Int }] {
    let mine = Array.filter(Iter.toArray(Map.values(orders)), func(o : Order) : Bool { Principal.equal(o.customerId, msg.caller) });
    let sorted = Array.sort(mine, func(a : Order, b : Order) : { #less; #equal; #greater } { Int.compare(b.timestamp, a.timestamp) });
    Array.map<Order, { id : Nat; status : Text; totalAmount : Nat; itemCount : Nat; timestamp : Int }>(
      sorted, func(o) { { id = o.id; status = statusText(o.status); totalAmount = o.totalAmount; itemCount = o.items.size(); timestamp = o.timestamp } },
    )
  };

  // Invoices issued to the caller (one per order), flat view for the frontend.
  public shared query(msg) func myInvoicesView() : async [{ id : Nat; totalE8s : Nat; status : Text; itemCount : Nat; createdAt : Int }] {
    Array.map<Invoices.Invoice, { id : Nat; totalE8s : Nat; status : Text; itemCount : Nat; createdAt : Int }>(
      Invoices.forPrincipal(invoices, msg.caller),
      func(i) { { id = i.id; totalE8s = i.totalE8s; status = Invoices.statusText(i.status); itemCount = i.lineItems.size(); createdAt = i.createdAt } },
    )
  };

  // Kitchen queue (admin/kitchen only): open orders (pending/preparing), oldest first.
  public shared query(msg) func kitchenView() : async [{ id : Nat; status : Text; totalAmount : Nat; itemCount : Nat; timestamp : Int }] {
    if (not isKitchen(msg.caller)) return [];
    let open = Array.filter(Iter.toArray(Map.values(orders)), func(o : Order) : Bool {
      switch (o.status) { case (#pending or #preparing or #ready) true; case _ false };
    });
    let sorted = Array.sort(open, func(a : Order, b : Order) : { #less; #equal; #greater } { Int.compare(a.timestamp, b.timestamp) });
    Array.map<Order, { id : Nat; status : Text; totalAmount : Nat; itemCount : Nat; timestamp : Int }>(
      sorted, func(o) { { id = o.id; status = statusText(o.status); totalAmount = o.totalAmount; itemCount = o.items.size(); timestamp = o.timestamp } },
    )
  };
};
