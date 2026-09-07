// Stockyard portfolio demo — stand-in for firebase-firestore.js.
// A tiny in-memory Firestore lookalike, seeded with made-up sample data
// (fictional business, fictional customers/suppliers). Nothing here is
// real, and nothing written here ever leaves this browser tab — refreshing
// the page resets everything back to the seed state below.

function daysAgo(n, hour, minute){
  var d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour != null ? hour : 9, minute != null ? minute : 0, 0, 0);
  return d.toISOString();
}

var items = [
  { id: "1", name: "GI Sheet 4x8 Gauge 26", sku: "ROOF-101", category: "Roofing", warehouse: "Warehouse 1", qty: 85, unit: "sheet", reorder: 20, price: 450 },
  { id: "2", name: "Ridge Roll 10ft", sku: "ROOF-102", category: "Roofing", warehouse: "Warehouse 1", qty: 12, unit: "pc", reorder: 15, price: 320 },
  { id: "3", name: "Roofing Nails 1kg", sku: "ROOF-103", category: "Roofing", warehouse: "Warehouse 1", qty: 0, unit: "pack", reorder: 10, price: 85 },
  { id: "4", name: "Steel Angle Bar 1x1x6m", sku: "MTL-201", category: "Metal Products", warehouse: "Warehouse 1", qty: 60, unit: "pc", reorder: 15, price: 210 },
  { id: "5", name: "Tie Wire #16", sku: "MTL-202", category: "Metal Products", warehouse: "Warehouse 1", qty: 25, unit: "roll", reorder: 10, price: 95 },
  { id: "6", name: "Portland Cement 40kg", sku: "CEM-301", category: "Cement & Aggregates", warehouse: "Warehouse 1", qty: 140, unit: "bag", reorder: 50, price: 265 },
  { id: "7", name: "Washed Sand", sku: "CEM-302", category: "Cement & Aggregates", warehouse: "Warehouse 1", qty: 18, unit: "cu.m", reorder: 20, price: 950 },
  { id: "8", name: "Coco Lumber 2x3x10", sku: "LUM-401", category: "Eco Lumber", warehouse: "Warehouse 2", qty: 55, unit: "pc", reorder: 30, price: 145 },
  { id: "9", name: "Marine Plywood 1/2\"", sku: "LUM-402", category: "Eco Lumber", warehouse: "Warehouse 2", qty: 40, unit: "sheet", reorder: 15, price: 780 },
  { id: "10", name: "Wheelbarrow Heavy Duty", sku: "EQP-501", category: "Equipment", warehouse: "Warehouse 2", qty: 3, unit: "pc", reorder: 2, price: 2450 },
  { id: "11", name: "Circular Saw 7\"", sku: "EQP-502", category: "Equipment", warehouse: "Warehouse 2", qty: 1, unit: "pc", reorder: 1, price: 3200 },
  { id: "12", name: "PVC Pipe 4\" x 10ft", sku: "PLB-601", category: "Plumbing", warehouse: "Warehouse 2", qty: 45, unit: "pc", reorder: 20, price: 310 },
  { id: "13", name: "Gate Valve 1\"", sku: "PLB-602", category: "Plumbing", warehouse: "Warehouse 2", qty: 8, unit: "pc", reorder: 10, price: 175 }
];

// Log entries, oldest first here — pushed into state newest-first below,
// same as addDoc does in the real app.
var logSeed = [
  { ts: daysAgo(9, 8, 40), itemId: "6", itemName: "Portland Cement 40kg", sku: "CEM-301", category: "Cement & Aggregates", warehouse: "Warehouse 1", oldQty: 0, newQty: 140, delta: 140, unitPrice: 265, value: 140 * 265, reason: "Stock in", party: "Pacific Cement Supply", docNumber: "3312", note: "" },
  { ts: daysAgo(7, 10, 15), itemId: "1", itemName: "GI Sheet 4x8 Gauge 26", sku: "ROOF-101", category: "Roofing", warehouse: "Warehouse 1", oldQty: 0, newQty: 85, delta: 85, unitPrice: 450, value: 85 * 450, reason: "Stock in", party: "Metro Steel Supply", docNumber: "3315", note: "" },
  { ts: daysAgo(6, 13, 5), itemId: "2", itemName: "Ridge Roll 10ft", sku: "ROOF-102", category: "Roofing", warehouse: "Warehouse 1", oldQty: 20, newQty: 12, delta: -8, unitPrice: 320, value: -8 * 320, reason: "Stock out", party: "Dela Cruz Construction", docNumber: "2201", note: "" },
  { ts: daysAgo(4, 9, 30), itemId: "8", itemName: "Coco Lumber 2x3x10", sku: "LUM-401", category: "Eco Lumber", warehouse: "Warehouse 2", oldQty: 95, newQty: 55, delta: -40, unitPrice: 145, value: -40 * 145, reason: "Stock out", party: "Santos Builders", docNumber: "2210", note: "" },
  { ts: daysAgo(2, 15, 50), itemId: "8", itemName: "Coco Lumber 2x3x10", sku: "LUM-401", category: "Eco Lumber", warehouse: "Warehouse 2", oldQty: 75, newQty: 55, delta: -20, unitPrice: 145, value: -20 * 145, reason: "Stock out", party: "Santos Builders", docNumber: "2210", note: "" },
  { ts: daysAgo(1, 11, 0), itemId: "11", itemName: "Circular Saw 7\"", sku: "EQP-502", category: "Equipment", warehouse: "Warehouse 2", oldQty: 3, newQty: 1, delta: -2, unitPrice: 3200, value: -2 * 3200, reason: "Stock out", party: "Reyes Hardware Depot", docNumber: "2225", note: "" },
  { ts: daysAgo(0, 9, 45), itemId: "12", itemName: "PVC Pipe 4\" x 10ft", sku: "PLB-601", category: "Plumbing", warehouse: "Warehouse 2", oldQty: 55, newQty: 45, delta: -10, unitPrice: 310, value: -10 * 310, reason: "Stock out", party: "Walk-in Customer", docNumber: "", note: "" },
  { ts: daysAgo(0, 14, 10), itemId: "4", itemName: "Steel Angle Bar 1x1x6m", sku: "MTL-201", category: "Metal Products", warehouse: "Warehouse 1", oldQty: 80, newQty: 60, delta: -20, unitPrice: 210, value: -20 * 210, reason: "Stock out", party: "Dela Cruz Construction", docNumber: "2240", note: "" },
  { ts: daysAgo(0, 14, 12), itemId: "5", itemName: "Tie Wire #16", sku: "MTL-202", category: "Metal Products", warehouse: "Warehouse 1", oldQty: 30, newQty: 25, delta: -5, unitPrice: 95, value: -5 * 95, reason: "Stock out", party: "Dela Cruz Construction", docNumber: "2240", note: "" }
];
var log = logSeed.slice().reverse().map(function(e, i){ return Object.assign({ id: "l" + (logSeed.length - i) }, e); });

var unclaimed = [
  {
    id: "u1", kind: "customer", customer: "Santos Builders", docNumber: "2210",
    itemId: "8", itemName: "Coco Lumber 2x3x10", sku: "LUM-401", unit: "pc",
    ordered: 60, taken: 60, remaining: 0, status: "claimed",
    createdAt: daysAgo(4, 9, 30), updatedAt: daysAgo(2, 15, 50), claimedAt: daysAgo(2, 15, 50)
  },
  {
    id: "u2", kind: "customer", customer: "Reyes Hardware Depot", docNumber: "2225",
    itemId: "11", itemName: "Circular Saw 7\"", sku: "EQP-502", unit: "pc",
    ordered: 3, taken: 2, remaining: 1, status: "open",
    createdAt: daysAgo(1, 11, 0), updatedAt: daysAgo(1, 11, 0)
  }
];

var purchaseOrders = [];

export function getFirestore(app){ return {}; }
export function collection(db, name){ return { name: name }; }
export function doc(colOrDb, colName, id){
  if (id !== undefined) return { id: id, __col: colName };
  return { id: colName || ("gen" + Math.random().toString(36).slice(2)) };
}
export function query(col){ return col; }
export function orderBy(){ return {}; }

var listeners = { items: [], log: [], purchaseOrders: [], unclaimed: [] };

function stripId(x){ var c = Object.assign({}, x); delete c.id; return c; }
function snapshotFor(name){
  var arr = name === "items" ? items : name === "log" ? log : name === "purchaseOrders" ? purchaseOrders : name === "unclaimed" ? unclaimed : null;
  if (!arr) return null;
  return { docs: arr.map(function(x){ return { id: x.id, data: function(){ return stripId(x); } }; }) };
}
function fireSnapshot(name){
  if (!listeners[name]) return;
  var snap = snapshotFor(name);
  listeners[name].forEach(function(cb){ cb(snap); });
}

export function onSnapshot(colOrQuery, onNext){
  var name = colOrQuery.name;
  if (listeners[name]) listeners[name].push(onNext);
  setTimeout(function(){
    var snap = snapshotFor(name);
    if (snap) onNext(snap);
  }, 10);
  return function(){
    if (listeners[name]) listeners[name] = listeners[name].filter(function(cb){ return cb !== onNext; });
  };
}

function nextId(arr, prefix){ return prefix + (arr.length + 1) + "-" + Math.random().toString(36).slice(2, 6); }

export function addDoc(col, data){
  if (col.name === "items"){ var it = Object.assign({ id: nextId(items, "i") }, data); items.push(it); fireSnapshot("items"); return Promise.resolve({ id: it.id }); }
  if (col.name === "log"){ var e = Object.assign({ id: nextId(log, "l") }, data); log.unshift(e); fireSnapshot("log"); return Promise.resolve({ id: e.id }); }
  if (col.name === "purchaseOrders"){ var p = Object.assign({ id: nextId(purchaseOrders, "po") }, data); purchaseOrders.push(p); fireSnapshot("purchaseOrders"); return Promise.resolve({ id: p.id }); }
  if (col.name === "unclaimed"){ var u = Object.assign({ id: nextId(unclaimed, "u") }, data); unclaimed.push(u); fireSnapshot("unclaimed"); return Promise.resolve({ id: u.id }); }
  return Promise.resolve({ id: "new" + Math.random() });
}

export function updateDoc(ref, data){
  var col = ref.__col;
  var arr = col === "items" ? items : col === "log" ? log : col === "purchaseOrders" ? purchaseOrders : col === "unclaimed" ? unclaimed : null;
  var it = arr ? arr.find(function(x){ return x.id === ref.id; }) : null;
  if (it) Object.assign(it, data);
  fireSnapshot(col);
  return Promise.resolve();
}

export function deleteDoc(ref){
  var col = ref.__col;
  if (col === "log") log = log.filter(function(e){ return e.id !== ref.id; });
  else if (col === "purchaseOrders") purchaseOrders = purchaseOrders.filter(function(p){ return p.id !== ref.id; });
  else if (col === "items") items = items.filter(function(x){ return x.id !== ref.id; });
  else if (col === "unclaimed") unclaimed = unclaimed.filter(function(u){ return u.id !== ref.id; });
  fireSnapshot(col);
  return Promise.resolve();
}

export function writeBatch(db){ return { set: function(){}, commit: function(){ return Promise.resolve(); } }; }
export function getDocs(col){
  var snap = snapshotFor(col.name) || { docs: [] };
  return Promise.resolve({ empty: snap.docs.length === 0, size: snap.docs.length, docs: snap.docs });
}
