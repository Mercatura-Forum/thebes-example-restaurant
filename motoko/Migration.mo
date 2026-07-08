import Map "mo:core/Map";
import Nat "mo:core/Nat";

/// v2 → v2.1 state migration: dining tables gain a floor-plan position
/// (posX/posY grid cells; 0/0 = unplaced, which renders exactly as the old
/// auto-flow layout). Every other stable field passes through untouched.
module {
  type TableV2 = { number : Nat; seats : Nat; retired : Bool };
  type TableV21 = { number : Nat; seats : Nat; retired : Bool; posX : Nat; posY : Nat };

  public func run(old : { tables : Map.Map<Nat, TableV2> }) : { tables : Map.Map<Nat, TableV21> } {
    let tables = Map.empty<Nat, TableV21>();
    for ((k, t) in Map.entries(old.tables)) {
      Map.add(tables, Nat.compare, k, { number = t.number; seats = t.seats; retired = t.retired; posX = 0; posY = 0 });
    };
    { tables };
  };
}
