"use strict";

import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "./demo-firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, writeBatch
} from "./demo-firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "./demo-firebase-auth.js";

/* ============================= firebase ============================= */
var fbApp = initializeApp(firebaseConfig);
var db = getFirestore(fbApp);
var auth = getAuth(fbApp);
var itemsCol = collection(db, "items");
var logCol = collection(db, "log");
var unclaimedCol = collection(db, "unclaimed");

var currentUser = null;
var readOnly = true;
var itemsLoaded = false, logLoaded = false;
var syncState = "loading"; // loading | synced | error

/* ============================= constants ============================= */
var CATEGORY_PREFIX = {
  "Roofing":"ROOF","Deformed Bar":"DBAR","Plywood":"PLY","Boards":"BRD",
  "Tiling Equipment Products":"TILE","GI Plain":"GI","Metal Products":"MTL",
  "Tubular Steel Bar":"TUBE","C-Purlins":"CPUR","GI Pipe":"PIPE","Angle Bars":"ANGL","Wire Nails":"WIRE",
  "Eco Lumber":"ECOL","Liston":"LIST","Orange PVC Pipe":"OPVC","Black PVC Pipe":"BPVC",
  "Ordinary Electrical Pipe":"EPIP","Toilet Products":"TOIL","Door Products":"DOOR",
  "Hardi Sanepa":"HARD","Insulation Foam":"INSF","Equipment":"EQP"
};
var CATEGORY_ORDER_DEFAULT = [
  "Roofing","Deformed Bar","Plywood","Boards","Tiling Equipment Products","GI Plain","Metal Products","Tubular Steel Bar","C-Purlins","GI Pipe","Angle Bars","Wire Nails",
  "Eco Lumber","Liston","Orange PVC Pipe","Black PVC Pipe","Ordinary Electrical Pipe","Toilet Products","Door Products","Hardi Sanepa","Insulation Foam","Equipment"
];
var WAREHOUSE_ORDER_DEFAULT = ["Warehouse 1","Warehouse 2"];
var DEAD_STOCK_DAYS = 90;

/* ============================= state ============================= */
var state = { items: [], categoryOrder: CATEGORY_ORDER_DEFAULT.slice(), log: [], unclaimed: [] };
var ui = { search:"", filter:"all", collapsed:{}, view:"inventory", logFilter:"all", exportOpen:false, bulkMenuOpen:false, warehouse:"all", qtySort:"none", skuSort:"none", confirmDeleteLogId:null, unclaimedStatusFilter:"open" };

function uid(){
  return "it-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2,8);
}

function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}

function num(v, fallback){
  var n = parseFloat(v);
  return isFinite(n) && n >= 0 ? n : fallback;
}

function fmtMoney(n){
  return "₱" + (Math.round(n*100)/100).toLocaleString("en-PH", {minimumFractionDigits:2, maximumFractionDigits:2});
}

function fmtSignedMoney(n){
  n = n || 0;
  return (n > 0 ? "+" : n < 0 ? "-" : "") + fmtMoney(Math.abs(n));
}

function fmtDateTime(iso){
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString("en-PH", {year:"numeric", month:"short", day:"numeric", hour:"numeric", minute:"2-digit"});
  } catch(e){ return String(iso); }
}

function statusOf(item){
  if (item.qty <= 0) return "bad";
  if (item.qty <= item.reorder) return "warn";
  return "good";
}
function statusLabel(s){
  return s === "bad" ? "Out of stock" : s === "warn" ? "Low stock" : "In stock";
}

function itemWarehouse(it){
  return (it && it.warehouse) || "Warehouse 1";
}

function getWarehouses(){
  var counts = {};
  state.items.forEach(function(it){ var w = itemWarehouse(it); counts[w] = (counts[w]||0) + 1; });
  var order = WAREHOUSE_ORDER_DEFAULT.slice();
  Object.keys(counts).sort().forEach(function(w){ if (order.indexOf(w) === -1) order.push(w); });
  return order.filter(function(w){ return counts[w] > 0; });
}

function scopedItems(){
  if (ui.warehouse === "all") return state.items;
  return state.items.filter(function(it){ return itemWarehouse(it) === ui.warehouse; });
}

function scopedLog(){
  if (ui.warehouse === "all") return state.log;
  return state.log.filter(function(e){ return itemWarehouse(e) === ui.warehouse; });
}

function getCategories(){
  var counts = {};
  scopedItems().forEach(function(it){ counts[it.category] = (counts[it.category]||0) + 1; });
  var order = state.categoryOrder.slice();
  Object.keys(counts).sort().forEach(function(c){ if (order.indexOf(c) === -1) order.push(c); });
  return order.filter(function(c){ return counts[c] > 0; });
}

function categoryWorstStatus(cat){
  var items = scopedItems().filter(function(it){ return it.category === cat; });
  if (items.some(function(it){ return statusOf(it) === "bad"; })) return "bad";
  if (items.some(function(it){ return statusOf(it) === "warn"; })) return "warn";
  return "good";
}

function computeStats(){
  var items = scopedItems();
  var totalSkus = items.length;
  var totalUnits = 0, lowCount = 0, outCount = 0, totalValue = 0;
  items.forEach(function(it){
    totalUnits += it.qty;
    totalValue += it.qty * it.price;
    var s = statusOf(it);
    if (s === "warn") lowCount++;
    if (s === "bad") outCount++;
  });
  return { totalSkus:totalSkus, totalUnits:totalUnits, lowCount:lowCount, outCount:outCount, totalValue:totalValue };
}

function computeReorderList(){
  return scopedItems().filter(function(it){ return it.qty <= it.reorder; }).map(function(it){
    return Object.assign({}, it, { suggestedOrder: Math.max(it.reorder - it.qty, 0) });
  }).sort(function(a, b){ return a.qty - a.reorder - (b.qty - b.reorder); });
}

function computeDeadStockList(days){
  var cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  var lastMovement = {};
  state.log.forEach(function(e){
    if (!e.itemId) return;
    var t = new Date(e.ts).getTime();
    if (isNaN(t)) return;
    if (!lastMovement.hasOwnProperty(e.itemId) || t > lastMovement[e.itemId]) lastMovement[e.itemId] = t;
  });
  return scopedItems().filter(function(it){ return it.qty > 0; }).map(function(it){
    var last = lastMovement.hasOwnProperty(it.id) ? lastMovement[it.id] : null;
    return Object.assign({}, it, { lastMovementTs: last });
  }).filter(function(it){
    return it.lastMovementTs === null || it.lastMovementTs < cutoff;
  }).sort(function(a, b){
    return (a.lastMovementTs||0) - (b.lastMovementTs||0);
  });
}

function nextSku(category){
  var prefix = CATEGORY_PREFIX[category];
  if (!prefix){
    prefix = category.toUpperCase().replace(/[^A-Z]/g,"").slice(0,4) || "ITEM";
  }
  var max = 0;
  state.items.forEach(function(it){
    if (it.category === category){
      var m = /-(\d+)$/.exec(it.sku || "");
      if (m) max = Math.max(max, parseInt(m[1],10));
    }
  });
  return prefix + "-" + String(max+1).padStart(3,"0");
}

function matchesSearch(it, q){
  if (!q) return true;
  q = q.toLowerCase();
  return (it.name||"").toLowerCase().indexOf(q) > -1 ||
         (it.sku||"").toLowerCase().indexOf(q) > -1 ||
         (it.category||"").toLowerCase().indexOf(q) > -1 ||
         itemWarehouse(it).toLowerCase().indexOf(q) > -1;
}

function matchesFilter(it){
  if (ui.filter === "low") return statusOf(it) === "warn";
  if (ui.filter === "out") return statusOf(it) === "bad";
  return true;
}

/* ============================= stock movement log ============================= */
async function addLogEntry(item, oldQty, newQty, reason, party, docNumber, note){
  if (oldQty === newQty) return;
  var unitPrice = num(item && item.price, 0);
  var delta = newQty - oldQty;
  await addDoc(logCol, {
    ts: new Date().toISOString(),
    itemId: item.id,
    itemName: item.name,
    sku: item.sku,
    category: item.category,
    unit: item.unit,
    warehouse: itemWarehouse(item),
    oldQty: oldQty,
    newQty: newQty,
    delta: delta,
    unitPrice: unitPrice,
    value: delta * unitPrice,
    reason: reason || "",
    party: party || "",
    docNumber: docNumber || "",
    note: note || ""
  });
}

function computeLogStats(){
  var log = scopedLog();
  var inCount=0, outCount=0, inUnits=0, outUnits=0;
  log.forEach(function(e){
    if (e.delta > 0){ inCount++; inUnits += e.delta; }
    else if (e.delta < 0){ outCount++; outUnits += (-e.delta); }
  });
  return {
    total: log.length, inCount:inCount, outCount:outCount,
    inUnits:inUnits, outUnits:outUnits, net: inUnits - outUnits,
    last: log.length ? log[0].ts : null
  };
}

function matchesLogFilter(e){
  if (ui.logFilter === "in") return e.delta > 0;
  if (ui.logFilter === "out") return e.delta < 0;
  return true;
}

function matchesLogSearch(e, q){
  if (!q) return true;
  q = q.toLowerCase();
  return (e.itemName||"").toLowerCase().indexOf(q) > -1 ||
         (e.sku||"").toLowerCase().indexOf(q) > -1 ||
         (e.category||"").toLowerCase().indexOf(q) > -1 ||
         (e.reason||"").toLowerCase().indexOf(q) > -1 ||
         (e.party||"").toLowerCase().indexOf(q) > -1 ||
         (e.docNumber||"").toLowerCase().indexOf(q) > -1 ||
         itemWarehouse(e).toLowerCase().indexOf(q) > -1;
}

// status: "open" (default — still owed), "claimed" (fully claimed, with a
// claimedAt date), or "all". Records written before this field existed have
// no status at all, which is treated as "open" for backward compatibility.
function computeUnclaimedList(kind, status){
  kind = kind || "customer";
  status = status || "open";
  return state.unclaimed.slice()
    .filter(function(r){ return (r.kind || "customer") === kind; })
    .filter(function(r){ return status === "all" ? true : (r.status || "open") === status; })
    .sort(function(a,b){
      var aKey = a.claimedAt || a.updatedAt || a.createdAt || "";
      var bKey = b.claimedAt || b.updatedAt || b.createdAt || "";
      return bKey.localeCompare(aKey);
    });
}

function computeUnclaimedStats(kind){
  var list = computeUnclaimedList(kind);
  var units = 0;
  var parties = {};
  list.forEach(function(r){ units += r.remaining || 0; parties[(r.customer||"").toLowerCase()] = true; });
  return { lines: list.length, units: units, parties: Object.keys(parties).length };
}

function matchesUnclaimedSearch(r, q){
  if (!q) return true;
  q = q.toLowerCase();
  return (r.customer||"").toLowerCase().indexOf(q) > -1 ||
         (r.docNumber||"").toLowerCase().indexOf(q) > -1 ||
         (r.itemName||"").toLowerCase().indexOf(q) > -1 ||
         (r.sku||"").toLowerCase().indexOf(q) > -1;
}

var RETURN_REASONS = ["Customer return", "Return to supplier"];

function computeReturnsList(){
  return state.log.filter(function(e){ return RETURN_REASONS.indexOf(e.reason) > -1; });
}

function computeReturnsStats(){
  var list = computeReturnsList();
  var fromCustomers=0, toSuppliers=0, fromCustomerUnits=0, toSupplierUnits=0;
  list.forEach(function(e){
    if (e.reason === "Customer return"){ fromCustomers++; fromCustomerUnits += Math.abs(e.delta||0); }
    else { toSuppliers++; toSupplierUnits += Math.abs(e.delta||0); }
  });
  return { total: list.length, fromCustomers:fromCustomers, toSuppliers:toSuppliers, fromCustomerUnits:fromCustomerUnits, toSupplierUnits:toSupplierUnits };
}

function matchesReturnsSearch(e, q){
  if (!q) return true;
  q = q.toLowerCase();
  return (e.itemName||"").toLowerCase().indexOf(q) > -1 ||
         (e.sku||"").toLowerCase().indexOf(q) > -1 ||
         (e.party||"").toLowerCase().indexOf(q) > -1 ||
         (e.docNumber||"").toLowerCase().indexOf(q) > -1 ||
         (e.note||"").toLowerCase().indexOf(q) > -1;
}

/* ============================= render ============================= */
function render(){
  var app = document.getElementById("app");
  var cats = getCategories();

  var focusInfo = captureFocus();

  var html = "";
  html += renderTopbar();
  if (!itemsLoaded || !logLoaded) html += '<div class="banner">Loading your inventory…</div>';
  else if (syncState === "error") html += '<div class="banner readonly">Connection trouble — changes may not save until it reconnects.</div>';
  else if (readOnly) html += '<div class="banner readonly">Viewing only — <a href="#" data-action="open-signin">sign in</a> to add or edit stock.</div>';
  html += renderStats();
  html += '<div class="layout">';
  html += renderSidebar(cats);
  html += (ui.view === "log" ? renderLogMain() : ui.view === "returns" ? renderReturnsMain() :
    ui.view === "unclaimed" ? renderUnclaimedMain("customer") : ui.view === "unclaimed-supplier" ? renderUnclaimedMain("supplier") :
    renderMain(cats));
  html += '</div>';
  html += renderModal();
  html += renderStockMoveModal();
  html += renderCountModal();
  html += renderDamageModal();
  html += renderBulkMoveModal();
  html += renderReturnModal();
  html += renderSignInModal();
  html += renderToasts();

  app.innerHTML = html;
  attachDynamicHandlers();
  restoreFocus(focusInfo);
}

function captureFocus(){
  var el = document.activeElement;
  if (!el) return null;
  if (el.id === "search-input"){
    return { selector: "#search-input", selStart: el.selectionStart, selEnd: el.selectionEnd };
  }
  if (el.matches && el.matches("input[data-field]")){
    return {
      selector: 'input[data-field="' + el.getAttribute("data-field") + '"][data-id="' + el.getAttribute("data-id") + '"]',
      selStart: el.selectionStart, selEnd: el.selectionEnd
    };
  }
  if (el.matches && el.matches("input[data-mfield]")){
    return { selector: 'input[data-mfield="' + el.getAttribute("data-mfield") + '"]', selStart: el.selectionStart, selEnd: el.selectionEnd };
  }
  if (el.matches && el.matches("input[data-logfield]")){
    return {
      selector: 'input[data-logfield="' + el.getAttribute("data-logfield") + '"][data-logid="' + el.getAttribute("data-logid") + '"]',
      selStart: el.selectionStart, selEnd: el.selectionEnd
    };
  }
  if (el.matches && el.matches("input[data-smfield]")){
    return { selector: 'input[data-smfield="' + el.getAttribute("data-smfield") + '"]', selStart: el.selectionStart, selEnd: el.selectionEnd };
  }
  if (el.matches && el.matches("input[data-countfield]")){
    return { selector: 'input[data-countfield="' + el.getAttribute("data-countfield") + '"]', selStart: el.selectionStart, selEnd: el.selectionEnd };
  }
  if (el.matches && el.matches("input[data-damagefield]")){
    return { selector: 'input[data-damagefield="' + el.getAttribute("data-damagefield") + '"]', selStart: el.selectionStart, selEnd: el.selectionEnd };
  }
  if (el.matches && el.matches("input[data-returnfield]")){
    return { selector: 'input[data-returnfield="' + el.getAttribute("data-returnfield") + '"]', selStart: el.selectionStart, selEnd: el.selectionEnd };
  }
  if (el.matches && el.matches("input[data-bulkfield]")){
    return {
      selector: 'input[data-bulkfield="' + el.getAttribute("data-bulkfield") + '"]' + (el.hasAttribute("data-bulkrow") ? '[data-bulkrow="' + el.getAttribute("data-bulkrow") + '"]' : ""),
      selStart: el.selectionStart, selEnd: el.selectionEnd
    };
  }
  if (el.matches && el.matches("input[data-authfield]")){
    return { selector: 'input[data-authfield="' + el.getAttribute("data-authfield") + '"]', selStart: el.selectionStart, selEnd: el.selectionEnd };
  }
  return null;
}

function restoreFocus(info){
  if (!info) return;
  var el = document.querySelector(info.selector);
  if (!el) return;
  el.focus();
  if (typeof info.selStart === "number" && el.setSelectionRange){
    try { el.setSelectionRange(info.selStart, info.selEnd); } catch(e){}
  }
}

function renderTopbar(){
  var searchPlaceholder = ui.view === "log" ? "Search log by item, SKU, or customer…" :
    ui.view === "returns" ? "Search returns by item, SKU, party, or reason…" :
    (ui.view === "unclaimed" || ui.view === "unclaimed-supplier") ? "Search by customer/supplier, PO/DR #, or item…" :
    "Search items, SKU, category…";

  var custUnclaimedCount = computeUnclaimedList("customer").length;
  var suppUnclaimedCount = computeUnclaimedList("supplier").length;
  var returnsCount = computeReturnsList().length;

  var viewToggle = (
    '<div class="view-toggle">' +
      '<button class="view-btn' + (ui.view==="inventory"?" active":"") + '" data-action="set-view" data-view="inventory">Inventory</button>' +
      '<button class="view-btn' + (ui.view==="log"?" active":"") + '" data-action="set-view" data-view="log">Log' + (scopedLog().length ? '<span class="count">' + scopedLog().length + '</span>' : '') + '</button>' +
      '<button class="view-btn' + (ui.view==="unclaimed"?" active":"") + '" data-action="set-view" data-view="unclaimed">Unclaimed' + (custUnclaimedCount ? '<span class="count">' + custUnclaimedCount + '</span>' : '') + '</button>' +
      '<button class="view-btn' + (ui.view==="unclaimed-supplier"?" active":"") + '" data-action="set-view" data-view="unclaimed-supplier">Unclaimed (Supplier)' + (suppUnclaimedCount ? '<span class="count">' + suppUnclaimedCount + '</span>' : '') + '</button>' +
      '<button class="view-btn' + (ui.view==="returns"?" active":"") + '" data-action="set-view" data-view="returns">Returns' + (returnsCount ? '<span class="count">' + returnsCount + '</span>' : '') + '</button>' +
    '</div>'
  );

  var exportMenu = (
    '<div class="export-wrap">' +
      '<button class="btn btn-ghost" data-action="toggle-export-menu">' +
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>' +
        'Export' +
      '</button>' +
      (ui.exportOpen ? (
        '<div class="export-menu">' +
          '<div class="export-group-label">Inventory</div>' +
          '<button data-action="export-inventory-pdf"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3v5a2 2 0 0 0 2 2h5"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/></svg>Download PDF</button>' +
          '<button data-action="export-inventory-csv"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>Download CSV (Excel)</button>' +
          '<div class="export-divider"></div>' +
          '<div class="export-group-label">Stock Log</div>' +
          '<button data-action="export-log-pdf"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3v5a2 2 0 0 0 2 2h5"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/></svg>Download PDF</button>' +
          '<button data-action="export-log-csv"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>Download CSV (Excel)</button>' +
          '<div class="export-divider"></div>' +
          '<div class="export-group-label">Reorder Report</div>' +
          '<button data-action="export-reorder-pdf"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3v5a2 2 0 0 0 2 2h5"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/></svg>Download PDF</button>' +
          '<button data-action="export-reorder-csv"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>Download CSV (Excel)</button>' +
          '<div class="export-divider"></div>' +
          '<div class="export-group-label">Dead Stock (' + DEAD_STOCK_DAYS + '+ days idle)</div>' +
          '<button data-action="export-deadstock-pdf"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3v5a2 2 0 0 0 2 2h5"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/></svg>Download PDF</button>' +
          '<button data-action="export-deadstock-csv"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>Download CSV (Excel)</button>' +
          '<div class="export-divider"></div>' +
          '<div class="export-group-label">Unclaimed (Customer)</div>' +
          '<button data-action="export-unclaimed-csv"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>Download CSV (Excel)</button>' +
          '<div class="export-divider"></div>' +
          '<div class="export-group-label">Unclaimed (Supplier)</div>' +
          '<button data-action="export-unclaimed-supplier-csv"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>Download CSV (Excel)</button>' +
          '<div class="export-divider"></div>' +
          '<div class="export-group-label">Returns</div>' +
          '<button data-action="export-returns-csv"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>Download CSV (Excel)</button>' +
        '</div>'
      ) : "") +
    '</div>'
  );

  var bulkMenu = readOnly ? "" : (
    '<div class="export-wrap bulk-wrap">' +
      '<button class="btn btn-ghost" data-action="toggle-bulk-menu">' +
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' +
        'Bulk entry' +
      '</button>' +
      (ui.bulkMenuOpen ? (
        '<div class="export-menu">' +
          '<button data-action="open-bulk-in"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>Bulk stock in</button>' +
          '<button data-action="open-bulk-out"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>Bulk stock out</button>' +
        '</div>'
      ) : "") +
    '</div>'
  );

  var authControl = currentUser
    ? ('<div class="auth-chip"><span class="auth-email">' + esc(currentUser.email) + '</span><button class="btn btn-ghost" data-action="sign-out">Sign out</button></div>')
    : ('<button class="btn btn-ghost" data-action="open-signin">Sign in</button>');

  return (
    '<div class="topbar">' +
      '<div class="brand"><span class="brand-mark">Stockyard<span class="dot">.</span></span><span class="brand-sub">' + esc(ui.warehouse === "all" ? "All warehouses" : ui.warehouse) + '</span><span class="demo-badge" title="Sample data — not a real business">Demo · sample data</span></div>' +
      '<div class="search-wrap">' +
        '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>' +
        '<input type="text" id="search-input" placeholder="' + esc(searchPlaceholder) + '" value="' + esc(ui.search) + '" autocomplete="off">' +
      '</div>' +
      viewToggle +
      exportMenu +
      bulkMenu +
      authControl +
      (readOnly || ui.view === "unclaimed" || ui.view === "unclaimed-supplier" || ui.view === "returns" ? "" : '<button class="btn btn-primary" data-action="open-add"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg><span>Add item</span></button>') +
    '</div>'
  );
}

function renderStats(){
  if (ui.view === "unclaimed" || ui.view === "unclaimed-supplier"){
    var isSupplier = ui.view === "unclaimed-supplier";
    var us = computeUnclaimedStats(isSupplier ? "supplier" : "customer");
    return (
      '<div class="stats">' +
        '<div class="stat"><div class="stat-label">Items still owed</div><div class="stat-value mono warn">' + us.lines + '</div></div>' +
        '<div class="stat"><div class="stat-label">Units still owed</div><div class="stat-value mono warn">' + us.units.toLocaleString("en-PH") + '</div></div>' +
        '<div class="stat"><div class="stat-label">' + (isSupplier ? "Suppliers owing" : "Customers waiting") + '</div><div class="stat-value mono">' + us.parties + '</div></div>' +
      '</div>'
    );
  }
  if (ui.view === "returns"){
    var rs = computeReturnsStats();
    return (
      '<div class="stats">' +
        '<div class="stat"><div class="stat-label">Total returns</div><div class="stat-value mono">' + rs.total + '</div></div>' +
        '<div class="stat"><div class="stat-label">From customers</div><div class="stat-value mono good">' + rs.fromCustomers + ' <span style="font-size:12px; font-weight:400;">(' + rs.fromCustomerUnits.toLocaleString("en-PH") + ' units)</span></div></div>' +
        '<div class="stat"><div class="stat-label">To suppliers</div><div class="stat-value mono warn">' + rs.toSuppliers + ' <span style="font-size:12px; font-weight:400;">(' + rs.toSupplierUnits.toLocaleString("en-PH") + ' units)</span></div></div>' +
      '</div>'
    );
  }
  if (ui.view === "log"){
    var ls = computeLogStats();
    return (
      '<div class="stats">' +
        '<div class="stat"><div class="stat-label">Movements</div><div class="stat-value mono">' + ls.total + '</div></div>' +
        '<div class="stat"><div class="stat-label">Stock in</div><div class="stat-value mono good">+' + ls.inUnits.toLocaleString("en-PH") + '</div></div>' +
        '<div class="stat"><div class="stat-label">Stock out</div><div class="stat-value mono bad">&minus;' + ls.outUnits.toLocaleString("en-PH") + '</div></div>' +
        '<div class="stat"><div class="stat-label">Net change</div><div class="stat-value mono">' + (ls.net>0?'+':'') + ls.net.toLocaleString("en-PH") + '</div></div>' +
        '<div class="stat"><div class="stat-label">Last movement</div><div class="stat-value" style="font-size:14px;">' + (ls.last ? esc(fmtDateTime(ls.last)) : '—') + '</div></div>' +
      '</div>'
    );
  }
  var stats = computeStats();
  function statBtn(filterKey, label, valueHtml, extraCls){
    var active = ui.filter === filterKey ? " active" : "";
    return '<button class="stat stat-clickable' + active + '" data-action="set-filter" data-filter="' + filterKey + '">' +
      '<div class="stat-label">' + label + '</div><div class="stat-value mono' + (extraCls?" "+extraCls:"") + '">' + valueHtml + '</div>' +
    '</button>';
  }
  return (
    '<div class="stats">' +
      statBtn("all", "SKUs tracked", String(stats.totalSkus)) +
      '<div class="stat"><div class="stat-label">Units on hand</div><div class="stat-value mono">' + stats.totalUnits.toLocaleString("en-PH") + '</div></div>' +
      statBtn("low", "Low stock", String(stats.lowCount), "warn") +
      statBtn("out", "Out of stock", String(stats.outCount), "bad") +
      '<div class="stat"><div class="stat-label">Inventory value</div><div class="stat-value mono">' + fmtMoney(stats.totalValue) + '</div></div>' +
    '</div>'
  );
}

function renderWarehouseChips(){
  var whs = getWarehouses();
  if (whs.length < 2) return "";
  var counts = {};
  state.items.forEach(function(it){ var w = itemWarehouse(it); counts[w] = (counts[w]||0) + 1; });
  var chips = [{key:"all", label:"All warehouses", count: state.items.length}].concat(
    whs.map(function(w){ return {key:w, label:w, count: counts[w]||0}; })
  );
  var html = chips.map(function(c){
    return '<button class="filter-chip' + (ui.warehouse===c.key?" active":"") + '" data-action="set-warehouse" data-warehouse="' + esc(c.key) + '">' + esc(c.label) + '<span class="count">' + c.count + '</span></button>';
  }).join("");
  return '<div class="cat-nav-title">Location</div><div class="filter-group">' + html + '</div>';
}

function renderSidebar(cats){
  var warehouseHtml = renderWarehouseChips();

  if (ui.view === "log"){
    var ls = computeLogStats();
    var logChips = [
      {key:"all", label:"All movements", count: ls.total},
      {key:"in", label:"Stock in", count: ls.inCount},
      {key:"out", label:"Stock out", count: ls.outCount}
    ];
    var logChipHtml = logChips.map(function(c){
      return '<button class="filter-chip' + (ui.logFilter===c.key?" active":"") + '" data-action="set-log-filter" data-filter="' + c.key + '">' + c.label + '<span class="count">' + c.count + '</span></button>';
    }).join("");
    return '<aside class="sidebar">' + warehouseHtml + '<div class="filter-group">' + logChipHtml + '</div></aside>';
  }

  var stats = computeStats();
  var chips = [
    {key:"all", label:"All items", count:stats.totalSkus},
    {key:"low", label:"Low stock", count:stats.lowCount},
    {key:"out", label:"Out of stock", count:stats.outCount}
  ];
  var chipHtml = chips.map(function(c){
    return '<button class="filter-chip' + (ui.filter===c.key?" active":"") + '" data-action="set-filter" data-filter="' + c.key + '">' + c.label + '<span class="count">' + c.count + '</span></button>';
  }).join("");

  var navHtml = cats.map(function(c){
    var n = scopedItems().filter(function(it){ return it.category===c; }).length;
    var worst = categoryWorstStatus(c);
    return '<a href="#cat-' + slug(c) + '"><span class="cat-dot ' + (worst==="good"?"":worst) + '"></span><span class="cat-nav-name">' + esc(c) + '</span><span class="cat-nav-count">' + n + '</span></a>';
  }).join("");

  var qtySortLabel = ui.qtySort === "asc" ? "Qty: low to high" : ui.qtySort === "desc" ? "Qty: high to low" : "Sort by quantity";
  var skuSortLabel = ui.skuSort === "asc" ? "Code: A to Z" : ui.skuSort === "desc" ? "Code: Z to A" : "Sort by code";
  var sortHtml = (
    '<div class="filter-group">' +
      '<button class="filter-chip' + (ui.qtySort!=="none"?" active":"") + '" data-action="toggle-qty-sort">' + qtySortLabel + sortArrow(ui.qtySort) + '</button>' +
      '<button class="filter-chip' + (ui.skuSort!=="none"?" active":"") + '" data-action="toggle-sku-sort">' + skuSortLabel + sortArrow(ui.skuSort) + '</button>' +
    '</div>'
  );

  return (
    '<aside class="sidebar">' +
      warehouseHtml +
      '<div class="filter-group">' + chipHtml + '</div>' +
      sortHtml +
      '<div class="cat-nav-title">Categories</div>' +
      '<nav class="cat-nav">' + navHtml + '</nav>' +
    '</aside>'
  );
}

function slug(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,""); }

function sortArrow(sortState){
  if (sortState === "asc") return ' <span class="sort-arrow">&uarr;</span>';
  if (sortState === "desc") return ' <span class="sort-arrow">&darr;</span>';
  return ' <span class="sort-arrow dim">&uarr;&darr;</span>';
}

function sortByQty(list){
  if (ui.qtySort === "none") return list;
  var dir = ui.qtySort === "asc" ? 1 : -1;
  return list.slice().sort(function(a, b){ return (a.qty - b.qty) * dir; });
}

function sortBySku(list){
  if (ui.skuSort === "none") return list;
  var dir = ui.skuSort === "asc" ? 1 : -1;
  return list.slice().sort(function(a, b){
    return (a.sku || "").localeCompare(b.sku || "", undefined, {numeric:true, sensitivity:"base"}) * dir;
  });
}

function applySort(list){
  if (ui.skuSort !== "none") return sortBySku(list);
  return sortByQty(list);
}

function renderMain(cats){
  var q = ui.search.trim();
  var sectionsHtml = "";
  var anyVisible = false;
  var showWarehouseCol = ui.warehouse === "all" && getWarehouses().length > 1;

  cats.forEach(function(cat){
    var items = scopedItems().filter(function(it){ return it.category === cat; });
    var visible = applySort(items.filter(function(it){ return matchesSearch(it,q) && matchesFilter(it); }));
    if (visible.length === 0 && (q || ui.filter !== "all")) return;
    anyVisible = true;
    var collapsed = !!ui.collapsed[cat];
    sectionsHtml += renderCategorySection(cat, items, visible, collapsed, q, showWarehouseCol);
  });

  if (!anyVisible){
    var hasScoped = scopedItems().length > 0;
    sectionsHtml = (
      '<div class="empty-state">' +
        '<h3>' + (hasScoped ? "No items match" : "No items yet") + '</h3>' +
        '<p>' + (hasScoped ? "Try a different search term or clear the filter." : (readOnly ? "Sign in to start adding inventory." : "Click “Add item” to get started.")) + '</p>' +
      '</div>'
    );
  }

  return '<main class="main">' + sectionsHtml + '</main>';
}

function renderCategorySection(cat, items, visible, collapsed, q, showWarehouseCol){
  var rows = visible.map(function(it){ return renderRow(it, q, showWarehouseCol); }).join("");
  return (
    '<section class="cat-section' + (collapsed?" collapsed":"") + '" id="cat-' + slug(cat) + '">' +
      '<div class="cat-head" data-action="toggle-cat" data-cat="' + esc(cat) + '">' +
        '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>' +
        '<h2>' + esc(cat) + '</h2>' +
        '<span class="cat-count">' + visible.length + (visible.length!==items.length ? " of " + items.length : "") + '</span>' +
        '<span class="cat-head-line"></span>' +
      '</div>' +
      '<div class="table-wrap">' +
        '<table>' +
          '<thead><tr>' +
            '<th>Item</th>' +
            '<th class="th-sortable' + (ui.skuSort!=="none"?" active":"") + '" data-action="toggle-sku-sort" title="Sort by code">SKU' + sortArrow(ui.skuSort) + '</th>' +
            (showWarehouseCol ? '<th>Warehouse</th>' : '') +
            '<th class="num th-sortable' + (ui.qtySort!=="none"?" active":"") + '" data-action="toggle-qty-sort" title="Sort by quantity">Qty' + sortArrow(ui.qtySort) + '</th>' +
            '<th>Unit</th>' +
            '<th class="num">Reorder pt.</th><th class="num">Unit price</th><th>Status</th><th></th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
    '</section>'
  );
}

function renderRow(it, q, showWarehouseCol){
  var s = statusOf(it);
  var dis = readOnly ? " disabled" : "";
  return (
    '<tr data-id="' + it.id + '">' +
      '<td class="item-name" data-label="Item">' + esc(it.name) + '</td>' +
      '<td class="sku mono" data-label="SKU">' + esc(it.sku) + '</td>' +
      (showWarehouseCol ? '<td data-label="Warehouse">' + esc(itemWarehouse(it)) + '</td>' : '') +
      '<td class="num" data-label="Qty"><input class="cell-input" type="number" min="0" step="1" value="' + it.qty + '" data-field="qty" data-id="' + it.id + '"' + dis + '></td>' +
      '<td data-label="Unit"><input class="cell-input text" type="text" value="' + esc(it.unit) + '" data-field="unit" data-id="' + it.id + '"' + dis + '></td>' +
      '<td class="num" data-label="Reorder pt."><input class="cell-input" type="number" min="0" step="1" value="' + it.reorder + '" data-field="reorder" data-id="' + it.id + '"' + dis + '></td>' +
      '<td class="num" data-label="Unit price"><input class="cell-input price" type="number" min="0" step="0.01" value="' + it.price + '" data-field="price" data-id="' + it.id + '"' + dis + '></td>' +
      '<td data-label="Status"><span class="pill ' + s + '">' + statusLabel(s) + '</span></td>' +
      '<td data-label=""><div class="row-actions">' +
        (readOnly ? "" :
          '<button class="icon-btn good" data-action="stock-in" data-id="' + it.id + '" title="Stock in"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg></button>' +
          '<button class="icon-btn bad" data-action="stock-out" data-id="' + it.id + '" title="Stock out"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg></button>' +
          '<button class="icon-btn count" data-action="count" data-id="' + it.id + '" title="Physical count"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3"/><path d="m9 14 2 2 4-4"/></svg></button>' +
          '<button class="icon-btn damage" data-action="damage" data-id="' + it.id + '" title="Write off damaged stock"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></button>' +
          '<button class="icon-btn" data-action="return" data-id="' + it.id + '" title="Record a return"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg></button>' +
          '<button class="icon-btn" data-action="edit-item" data-id="' + it.id + '" title="Edit item"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>' +
          '<button class="icon-btn danger" data-action="quick-delete" data-id="' + it.id + '" title="Delete item"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg></button>'
        ) +
      '</div></td>' +
    '</tr>'
  );
}

function renderLogMain(){
  var q = ui.search.trim();
  var log = scopedLog();
  var entries = log.filter(function(e){ return matchesLogFilter(e) && matchesLogSearch(e, q); });
  var showWarehouseCol = ui.warehouse === "all" && getWarehouses().length > 1;

  if (!entries.length){
    var msg = log.length ? "No movements match" : "No movements yet";
    var sub = log.length ? "Try a different search term or filter." : "Change an item's quantity and it'll show up here.";
    return '<main class="main"><div class="empty-state"><h3>' + msg + '</h3><p>' + sub + '</p></div></main>';
  }

  var rows = entries.map(function(e){ return renderLogRow(e, showWarehouseCol); }).join("");
  return (
    '<main class="main"><div class="table-wrap"><table><thead><tr>' +
      '<th>Date</th><th>Item</th><th>SKU</th>' + (showWarehouseCol ? '<th>Warehouse</th>' : '') + '<th class="num">Change</th><th class="num">Qty</th><th class="num">Value</th><th>Delivered by / Customer</th><th>PO/DR #</th><th></th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div></main>'
  );
}

function renderLogRow(e, showWarehouseCol){
  var deltaCls = e.delta > 0 ? "good" : "bad";
  var deltaText = (e.delta > 0 ? "+" : "") + e.delta + (e.unit ? " " + esc(e.unit) : "");
  var dis = readOnly ? " disabled" : "";
  var partyPlaceholder = e.delta > 0 ? "Delivered by…" : e.delta < 0 ? "Customer…" : "—";
  var printBtn = printPoBtnHtml(e);
  var actionsCell = readOnly
    ? (printBtn ? '<div class="row-actions">' + printBtn + '</div>' : "")
    : renderDeleteLogCell(e.id, printBtn);
  return (
    '<tr>' +
      '<td class="mono" data-label="Date" style="white-space:nowrap; color:var(--text-muted); font-size:12.5px;">' + esc(fmtDateTime(e.ts)) + '</td>' +
      '<td class="item-name" data-label="Item">' + esc(e.itemName) + '</td>' +
      '<td class="sku mono" data-label="SKU">' + esc(e.sku) + '</td>' +
      (showWarehouseCol ? '<td data-label="Warehouse">' + esc(itemWarehouse(e)) + '</td>' : '') +
      '<td class="num" data-label="Change"><span class="pill ' + deltaCls + '">' + deltaText + '</span></td>' +
      '<td class="num mono" data-label="Qty">' + e.oldQty + ' → ' + e.newQty + '</td>' +
      '<td class="num mono" data-label="Value"><span class="' + (e.value>0?"value-text good":e.value<0?"value-text bad":"") + '">' + fmtSignedMoney(e.value) + '</span></td>' +
      '<td data-label="Delivered by / Customer"><input class="cell-input text" type="text" style="width:118px;" placeholder="' + esc(partyPlaceholder) + '" value="' + esc(e.party||"") + '" data-logfield="party" data-logid="' + e.id + '"' + dis + '></td>' +
      '<td data-label="PO/DR #"><input class="cell-input text" type="text" style="width:74px;" placeholder="PO/DR #" value="' + esc(e.docNumber||"") + '" data-logfield="docNumber" data-logid="' + e.id + '"' + dis + '></td>' +
      '<td data-label="">' + actionsCell + '</td>' +
    '</tr>'
  );
}

// A Print icon for Stock Out entries that carry a PO number — pulls in every
// row from the same PO (a bulk Stock Out shares one PO across several rows)
// and produces one printable summary PDF.
function printPoBtnHtml(e){
  if (e.reason !== "Stock out") return "";
  return '<button class="icon-btn" data-action="print-po" data-logid="' + e.id + '" title="Print PO summary"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/></svg></button>';
}

function renderDeleteLogCell(logId, extraBtnHtml){
  extraBtnHtml = extraBtnHtml || "";
  if (ui.confirmDeleteLogId === logId){
    return '<div class="row-actions">' + extraBtnHtml +
      '<span style="font-size:12px; color:var(--text-muted); margin-right:4px;">Delete?</span>' +
      '<button class="icon-btn danger" data-action="confirm-delete-log" data-logid="' + logId + '" title="Yes, delete"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg></button>' +
      '<button class="icon-btn" data-action="cancel-delete-log" data-logid="' + logId + '" title="Cancel"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>' +
    '</div>';
  }
  return '<div class="row-actions">' + extraBtnHtml + '<button class="icon-btn danger" data-action="delete-log" data-logid="' + logId + '" title="Delete entry"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg></button></div>';
}

/* ============================= unclaimed ============================= */
function renderUnclaimedMain(kind){
  kind = kind || "customer";
  var isSupplier = kind === "supplier";
  var partyLabel = isSupplier ? "Supplier" : "Customer";
  var statusFilter = ui.unclaimedStatusFilter || "open";
  var isClaimedView = statusFilter === "claimed";
  var q = ui.search.trim().toLowerCase();
  var list = computeUnclaimedList(kind, statusFilter).filter(function(r){ return matchesUnclaimedSearch(r, q); });

  var toggle = (
    '<div class="view-toggle" style="margin-bottom:14px;">' +
      '<button type="button" class="view-btn' + (!isClaimedView ? " active" : "") + '" data-action="set-unclaimed-status" data-status="open">Still owed</button>' +
      '<button type="button" class="view-btn' + (isClaimedView ? " active" : "") + '" data-action="set-unclaimed-status" data-status="claimed">Claimed</button>' +
    '</div>'
  );

  if (!list.length){
    var msg = q ? "No " + (isClaimedView ? "claimed" : "unclaimed") + " items match" : (isClaimedView ? "Nothing claimed yet" : "Nothing unclaimed right now");
    var sub = q ? "Try a different search term." : isClaimedView
      ? "Once a " + (isSupplier ? "supplier" : "customer") + " shortfall is fully claimed, it'll show up here with the date it was cleared."
      : isSupplier
        ? "When you Stock In and a supplier delivers less than ordered, fill in the Ordered qty field and what's still owed will show up here automatically."
        : "When you Stock Out and the customer doesn't take everything, fill in the Ordered qty field and what's left will show up here automatically.";
    return '<main class="main">' + toggle + '<div class="empty-state"><h3>' + msg + '</h3><p>' + sub + '</p></div></main>';
  }
  var rows = list.map(function(r){
    var it = state.items.find(function(x){ return x.id === r.itemId; });
    var lastCell = isClaimedView
      ? '<td class="mono" data-label="Claimed on">' + esc(fmtDateTime(r.claimedAt || r.updatedAt)) + '</td>'
      : '<td data-label="">' + (readOnly || !it ? "" : '<button class="btn btn-ghost" data-action="claim-unclaimed" data-kind="' + kind + '" data-id="' + it.id + '" data-customer="' + esc(r.customer||"") + '" data-docnumber="' + esc(r.docNumber) + '">' + (isSupplier ? "Stock In" : "Stock Out") + '</button>') + '</td>';
    return (
      '<tr>' +
        '<td data-label="' + partyLabel + '">' + esc(r.customer || "—") + '</td>' +
        '<td class="mono" data-label="PO/DR #">' + esc(r.docNumber) + '</td>' +
        '<td class="item-name" data-label="Item">' + esc(r.itemName) + '</td>' +
        '<td class="sku mono" data-label="SKU">' + esc(r.sku) + '</td>' +
        '<td class="num mono" data-label="Ordered">' + r.ordered + '</td>' +
        '<td class="num mono" data-label="' + (isSupplier ? "Received" : "Taken") + '">' + r.taken + '</td>' +
        '<td class="num mono" data-label="Still owed"><span class="value-text ' + (r.remaining > 0 ? "bad" : "good") + '">' + r.remaining + (r.unit ? " " + esc(r.unit) : "") + '</span></td>' +
        lastCell +
      '</tr>'
    );
  }).join("");
  return (
    '<main class="main">' + toggle + '<div class="table-wrap"><table><thead><tr>' +
      '<th>' + partyLabel + '</th><th>PO/DR #</th><th>Item</th><th>SKU</th><th class="num">Ordered</th><th class="num">' + (isSupplier ? "Received" : "Taken") + '</th><th class="num">Still owed</th><th>' + (isClaimedView ? "Claimed on" : "") + '</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div></main>'
  );
}

/* ============================= returns ============================= */
var returnState = null; // { direction:"in"|"out", itemId, itemName, sku, unit, currentQty, qty:"", party:"", docNumber:"", reason:"", error:"" }

function openReturnModal(id, direction){
  var it = state.items.find(function(x){ return x.id === id; });
  if (!it) return;
  returnState = {
    direction: direction || "in", itemId: it.id, itemName: it.name, sku: it.sku,
    unit: it.unit, currentQty: it.qty, qty: "", party: "", docNumber: "", reason: "", error: ""
  };
  render();
  setTimeout(function(){
    var f = document.getElementById("ret-field-qty");
    if (f) f.focus();
  }, 10);
}
function closeReturnModal(){ returnState = null; render(); }

function renderReturnModal(){
  if (!returnState) return "";
  var rs = returnState;
  var isCustomerReturn = rs.direction === "in";
  var partyLabel = isCustomerReturn ? "Customer" : "Supplier";
  var title = "Record return — " + esc(rs.itemName);
  return (
    '<div class="modal-backdrop" data-action="backdrop-return">' +
      '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-item-preview"><div><h3>' + title + '</h3>' +
        '<p class="modal-sub">' + esc(rs.sku) + ' &middot; currently ' + rs.currentQty + ' ' + esc(rs.unit) + ' on hand</p></div></div>' +
        '<div class="view-toggle" style="margin-bottom:16px;">' +
          '<button type="button" class="view-btn' + (isCustomerReturn?" active":"") + '" data-action="set-return-direction" data-direction="in">Customer return</button>' +
          '<button type="button" class="view-btn' + (!isCustomerReturn?" active":"") + '" data-action="set-return-direction" data-direction="out">Return to supplier</button>' +
        '</div>' +
        '<div class="field"><label for="ret-field-qty">Quantity</label>' +
          '<input id="ret-field-qty" type="number" min="1" step="1" value="' + esc(rs.qty) + '" data-returnfield="qty" placeholder="e.g. 5"></div>' +
        '<div class="field"><label for="ret-field-party">' + partyLabel + '</label>' +
          '<input id="ret-field-party" type="text" value="' + esc(rs.party) + '" data-returnfield="party" placeholder="' + partyLabel + ' name"></div>' +
        '<div class="field"><label for="ret-field-docnumber">PO/DR Number</label>' +
          '<input id="ret-field-docnumber" type="text" inputmode="numeric" pattern="[0-9]*" value="' + esc(rs.docNumber) + '" data-returnfield="docNumber" placeholder="e.g. 1042"></div>' +
        '<div class="field"><label for="ret-field-reason">Reason</label>' +
          '<input id="ret-field-reason" type="text" value="' + esc(rs.reason) + '" data-returnfield="reason" placeholder="e.g. wrong item, defective, overstock"></div>' +
        '<p class="field-hint">' + (isCustomerReturn ? "Quantity goes back into stock." : "Quantity is removed from stock — sent back to the supplier.") + '</p>' +
        (rs.error ? '<p style="color:var(--bad); font-size:13px; margin:8px 0 0;">' + esc(rs.error) + '</p>' : "") +
        '<div class="modal-actions">' +
          '<span></span>' +
          '<div class="right">' +
            '<button class="btn btn-ghost" data-action="close-return">Cancel</button>' +
            '<button class="btn btn-primary" data-action="submit-return">Record return</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

async function submitReturn(){
  var rs = returnState;
  var it = state.items.find(function(x){ return x.id === rs.itemId; });
  if (!it){ returnState = null; render(); return; }
  var amt = Math.round(num(rs.qty, 0));
  if (!amt || amt <= 0){ rs.error = "Enter a quantity greater than 0."; render(); return; }
  var isCustomerReturn = rs.direction === "in";
  var partyLabel = isCustomerReturn ? "customer" : "supplier";
  var party = (rs.party || "").trim();
  if (!party){ rs.error = "Enter the " + partyLabel + " name."; render(); return; }
  if (!(rs.docNumber || "").trim()){ rs.error = "Enter the PO/DR number."; render(); return; }
  var reason = (rs.reason || "").trim();
  if (!reason){ rs.error = "Enter a reason for the return."; render(); return; }
  var oldQty = it.qty;
  var newQty;
  if (isCustomerReturn){
    newQty = oldQty + amt;
  } else {
    if (amt > oldQty){ rs.error = "Only " + oldQty + " " + (it.unit||"") + " on hand — can't return " + amt + "."; render(); return; }
    newQty = oldQty - amt;
  }
  var docNumber = (rs.docNumber || "").trim();
  returnState = null;
  render();
  await updateDoc(doc(db, "items", it.id), { qty: newQty });
  await addLogEntry(it, oldQty, newQty, isCustomerReturn ? "Customer return" : "Return to supplier", party, docNumber, reason);
  pushToast((isCustomerReturn ? "Returned " : "Sent back ") + amt + " " + (it.unit||"") + " — " + it.name);
}

function renderReturnsMain(){
  var q = ui.search.trim();
  var allReturns = computeReturnsList();
  var entries = allReturns.filter(function(e){ return matchesReturnsSearch(e, q); });
  if (!entries.length){
    var msg = allReturns.length ? "No returns match" : "No returns yet";
    var sub = allReturns.length ? "Try a different search term." : "Use the return icon on an item to record a customer return or a return to a supplier.";
    return '<main class="main"><div class="empty-state"><h3>' + msg + '</h3><p>' + sub + '</p></div></main>';
  }
  var rows = entries.map(renderReturnRow).join("");
  return (
    '<main class="main"><div class="table-wrap"><table><thead><tr>' +
      '<th>Date</th><th>Type</th><th>Item</th><th>SKU</th><th class="num">Qty</th><th>Party</th><th>PO/DR #</th><th>Reason</th><th></th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div></main>'
  );
}

function renderReturnRow(e){
  var isCustomerReturn = e.reason === "Customer return";
  return (
    '<tr>' +
      '<td class="mono" data-label="Date" style="white-space:nowrap; color:var(--text-muted); font-size:12.5px;">' + esc(fmtDateTime(e.ts)) + '</td>' +
      '<td data-label="Type"><span class="pill ' + (isCustomerReturn ? "good" : "warn") + '">' + esc(e.reason) + '</span></td>' +
      '<td class="item-name" data-label="Item">' + esc(e.itemName) + '</td>' +
      '<td class="sku mono" data-label="SKU">' + esc(e.sku) + '</td>' +
      '<td class="num mono" data-label="Qty">' + Math.abs(e.delta||0) + (e.unit ? " " + esc(e.unit) : "") + '</td>' +
      '<td data-label="Party">' + esc(e.party||"—") + '</td>' +
      '<td class="mono" data-label="PO/DR #">' + esc(e.docNumber||"—") + '</td>' +
      '<td data-label="Reason">' + esc(e.note||"—") + '</td>' +
      '<td data-label="">' + (readOnly ? "" : renderDeleteLogCell(e.id)) + '</td>' +
    '</tr>'
  );
}

/* ============================= modal ============================= */
var modalState = null; // { mode:"add"|"edit", item:{...}, confirmDelete:bool, error:string }

function openAddModal(){
  var defaultWarehouse = ui.warehouse !== "all" ? ui.warehouse : (getWarehouses()[0] || "Warehouse 1");
  modalState = { mode:"add", item:{ id:uid(), name:"", category: getCategories()[0] || "", sku:"", unit:"pc", qty:0, reorder:10, price:0, warehouse:defaultWarehouse }, confirmDelete:false, error:"" };
  modalState.item.sku = modalState.item.category ? nextSku(modalState.item.category) : "";
  render();
  focusFirstField();
}
function openEditModal(id){
  var it = state.items.find(function(x){ return x.id === id; });
  if (!it) return;
  modalState = { mode:"edit", item:Object.assign({ warehouse: itemWarehouse(it) }, it), confirmDelete:false, error:"" };
  render();
  focusFirstField();
}
function closeModal(){ modalState = null; render(); }
function focusFirstField(){
  setTimeout(function(){
    var f = document.getElementById("field-name");
    if (f) f.focus();
  }, 10);
}

/* ============================= stock move modal ============================= */
var stockMoveState = null; // { direction:"in"|"out", itemId, itemName, sku, unit, currentQty, qty:"", party:"", orderedQty:"", error:"" }

function openStockMoveModal(id, direction, prefill){
  var it = state.items.find(function(x){ return x.id === id; });
  if (!it) return;
  prefill = prefill || {};
  stockMoveState = {
    direction: direction, itemId: it.id, itemName: it.name, sku: it.sku,
    unit: it.unit, currentQty: it.qty, qty: "", party: prefill.party || "", docNumber: prefill.docNumber || "", orderedQty: "", noDoc: false, error: ""
  };
  render();
  setTimeout(function(){
    var f = document.getElementById("sm-field-qty");
    if (f) f.focus();
  }, 10);
}
function closeStockMoveModal(){ stockMoveState = null; render(); }

/* ============================= damaged/write-off modal ============================= */
var damageState = null; // { itemId, itemName, sku, unit, currentQty, qty:"", note:"", error:"" }

function openDamageModal(id){
  var it = state.items.find(function(x){ return x.id === id; });
  if (!it) return;
  damageState = {
    itemId: it.id, itemName: it.name, sku: it.sku,
    unit: it.unit, currentQty: it.qty, qty: "", note: "", error: ""
  };
  render();
  setTimeout(function(){
    var f = document.getElementById("damage-field-qty");
    if (f) f.focus();
  }, 10);
}
function closeDamageModal(){ damageState = null; render(); }

function renderDamageModal(){
  if (!damageState) return "";
  var ds = damageState;
  var title = "Write off damaged stock — " + esc(ds.itemName);
  return (
    '<div class="modal-backdrop" data-action="backdrop-damage">' +
      '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-item-preview"><div><h3>' + title + '</h3>' +
        '<p class="modal-sub">' + esc(ds.sku) + ' &middot; currently ' + ds.currentQty + ' ' + esc(ds.unit) + ' on hand</p></div></div>' +
        '<div class="field"><label for="damage-field-qty">Quantity damaged</label>' +
          '<input id="damage-field-qty" type="number" min="1" step="1" value="' + esc(ds.qty) + '" data-damagefield="qty" placeholder="e.g. 5"></div>' +
        '<div class="field"><label for="damage-field-note">Reason</label>' +
          '<input id="damage-field-note" type="text" value="' + esc(ds.note) + '" data-damagefield="note" placeholder="e.g. water damage, broken in transit"></div>' +
        (ds.error ? '<p style="color:var(--bad); font-size:13px; margin:0 0 8px;">' + esc(ds.error) + '</p>' : "") +
        '<div class="modal-actions">' +
          '<span></span>' +
          '<div class="right">' +
            '<button class="btn btn-ghost" data-action="close-damage">Cancel</button>' +
            '<button class="btn btn-danger" data-action="submit-damage">Write off stock</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

async function submitDamage(){
  var ds = damageState;
  var it = state.items.find(function(x){ return x.id === ds.itemId; });
  if (!it){ damageState = null; render(); return; }
  var qty = Math.round(num(ds.qty, 0));
  if (!qty || qty <= 0){ ds.error = "Enter a quantity greater than 0."; render(); return; }
  if (qty > it.qty){ ds.error = "Only " + it.qty + " " + (it.unit||"") + " on hand — can't write off " + qty + "."; render(); return; }
  var note = (ds.note || "").trim();
  if (!note){ ds.error = "Enter a reason (e.g. water damage, broken in transit)."; render(); return; }
  var oldQty = it.qty;
  var newQty = oldQty - qty;
  damageState = null;
  render();
  await updateDoc(doc(db, "items", it.id), { qty: newQty });
  await addLogEntry(it, oldQty, newQty, "Damaged stock", note, "");
  pushToast("Written off " + qty + " " + (it.unit||"") + " — " + it.name + " (now " + newQty + ").");
}

/* ============================= bulk stock move modal ============================= */
var bulkMoveState = null; // { direction, docNumber, party, rows:[{sku,qty}], error }

function openBulkMoveModal(direction){
  bulkMoveState = { direction: direction, docNumber: "", party: "", noDoc: false, rows: [{ sku: "", qty: "", orderedQty: "" }], error: "" };
  ui.bulkMenuOpen = false;
  render();
}
function closeBulkMoveModal(){ bulkMoveState = null; render(); }

function findItemBySkuOrName(text){
  var q = (text || "").trim().toLowerCase();
  if (!q) return null;
  var bySku = state.items.find(function(x){ return (x.sku||"").toLowerCase() === q; });
  if (bySku) return bySku;
  var byName = state.items.find(function(x){ return (x.name||"").toLowerCase() === q; });
  if (byName) return byName;
  // fall back to a unique partial name match, so a few typed letters still resolve
  var partial = state.items.filter(function(x){ return (x.name||"").toLowerCase().indexOf(q) > -1; });
  return partial.length === 1 ? partial[0] : null;
}

function itemRowHintInfo(skuRaw){
  var skuText = (skuRaw || "").trim();
  if (!skuText) return { text: "", cls: "bulk-row-hint" };
  var matched = findItemBySkuOrName(skuText);
  if (matched) return { text: matched.name + " (" + matched.sku + ") · " + matched.qty + " " + (matched.unit||"") + " on hand", cls: "bulk-row-hint" };
  return { text: "No item matches that — try the item name or its SKU", cls: "bulk-row-hint warn" };
}

function updateRowHint(idPrefix, rowIndex, skuText){
  var el = document.getElementById(idPrefix + "-" + rowIndex);
  if (!el) return;
  var info = itemRowHintInfo(skuText);
  el.textContent = info.text;
  el.className = info.cls;
}

function updateBulkRowHint(rowIndex){
  var row = bulkMoveState && bulkMoveState.rows[rowIndex];
  if (!row) return;
  updateRowHint("bulk-hint", rowIndex, row.sku);
}

// Live item-search suggestions for the bulk-entry SKU/name field. Built as a
// small custom dropdown (rather than relying on the native <datalist> this
// used to use) because datalist suggestions don't reliably show up on
// mobile Safari/Chrome-iOS, which is where this was reported broken.
function bulkItemMatches(query, limit){
  var q = (query || "").trim().toLowerCase();
  if (!q) return [];
  var starts = [], contains = [];
  scopedItems().forEach(function(it){
    var name = (it.name || "").toLowerCase();
    var sku = (it.sku || "").toLowerCase();
    if (name.indexOf(q) === 0 || sku.indexOf(q) === 0) starts.push(it);
    else if (name.indexOf(q) > -1 || sku.indexOf(q) > -1) contains.push(it);
  });
  return starts.concat(contains).slice(0, limit || 6);
}

function renderBulkSuggestItemsHtml(matches, rowIndex){
  return matches.map(function(it){
    return '<button type="button" class="bulk-suggest-item" data-action="pick-bulk-suggestion" data-rowindex="' + rowIndex + '" data-sku="' + esc(it.sku) + '">' +
      '<span class="bs-name">' + esc(it.name) + '</span>' +
      '<span class="bs-meta">' + esc(it.sku) + ' · ' + it.qty + ' ' + esc(it.unit || "") + ' on hand</span>' +
    '</button>';
  }).join("");
}

function updateBulkSuggestions(rowIndex, queryText){
  var el = document.getElementById("bulk-suggest-" + rowIndex);
  if (!el) return;
  var matches = bulkItemMatches(queryText, 6);
  if (!matches.length){ el.hidden = true; el.innerHTML = ""; return; }
  el.innerHTML = renderBulkSuggestItemsHtml(matches, rowIndex);
  el.hidden = false;
}

function hideBulkSuggestions(rowIndex){
  var el = document.getElementById("bulk-suggest-" + rowIndex);
  if (el){ el.hidden = true; el.innerHTML = ""; }
}

function renderBulkMoveModal(){
  if (!bulkMoveState) return "";
  var bm = bulkMoveState;
  var isIn = bm.direction === "in";
  var docLabel = isIn ? "DR Number" : "PO Number";
  var partyLabel = isIn ? "Delivered by" : "Customer";
  var rowsHtml = bm.rows.map(function(row, i){
    var hintInfo = itemRowHintInfo(row.sku);
    return (
      '<div class="bulk-row">' +
        '<div class="bulk-row-inputs">' +
          '<div class="bulk-sku-wrap">' +
            '<input type="text" autocomplete="off" placeholder="Item SKU or name" value="' + esc(row.sku) + '" data-bulkfield="sku" data-bulkrow="' + i + '">' +
            '<div class="bulk-suggest" id="bulk-suggest-' + i + '" hidden></div>' +
          '</div>' +
          '<input type="number" min="1" step="1" placeholder="Qty" value="' + esc(row.qty) + '" data-bulkfield="qty" data-bulkrow="' + i + '">' +
          '<input type="number" min="1" step="1" placeholder="Ordered" title="' + (isIn ? "Only if the supplier isn\'t delivering everything — leave blank otherwise" : "Only if the customer isn\'t taking everything — leave blank otherwise") + '" value="' + esc(row.orderedQty||"") + '" data-bulkfield="orderedQty" data-bulkrow="' + i + '">' +
          (bm.rows.length > 1 ? '<button type="button" class="icon-btn danger" data-action="remove-bulk-row" data-rowindex="' + i + '" title="Remove row"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>' : '') +
        '</div>' +
        '<div class="' + hintInfo.cls + '" id="bulk-hint-' + i + '">' + esc(hintInfo.text) + '</div>' +
      '</div>'
    );
  }).join("");

  return (
    '<div class="modal-backdrop" data-action="backdrop-bulk">' +
      '<div class="modal modal-lg" role="dialog" aria-modal="true">' +
        '<h3>Bulk ' + (isIn ? "stock in" : "stock out") + '</h3>' +
        '<p class="modal-sub">' + (isIn ? "Receive several items under one delivery." : "Remove several items under one order.") + '</p>' +
        '<div class="view-toggle" style="margin-bottom:16px;">' +
          '<button type="button" class="view-btn' + (isIn?" active":"") + '" data-action="set-bulk-direction" data-direction="in">Stock in</button>' +
          '<button type="button" class="view-btn' + (!isIn?" active":"") + '" data-action="set-bulk-direction" data-direction="out">Stock out</button>' +
        '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="bulk-field-party">' + partyLabel + '</label><input id="bulk-field-party" type="text" value="' + esc(bm.party) + '" data-bulkfield="party" placeholder="' + (isIn?"Supplier or driver name":"Customer name") + '"></div>' +
          '<div class="field"><label for="bulk-field-docnumber">' + docLabel + '</label>' +
            '<input id="bulk-field-docnumber" type="text" inputmode="numeric" pattern="[0-9]*" value="' + esc(bm.docNumber) + '" data-bulkfield="docNumber" placeholder="' + (isIn?"e.g. 2208":"e.g. 1042") + '"' + (bm.noDoc ? " disabled" : "") + '>' +
            '<label class="checkbox-row"><input type="checkbox" data-bulkfield="noDoc"' + (bm.noDoc ? " checked" : "") + '> No ' + (isIn ? "DR" : "PO") + ' for this ' + (isIn ? "delivery" : "customer") + '</label>' +
          '</div>' +
        '</div>' +
        '<label class="bulk-items-label">Items <span style="font-weight:400; text-transform:none; letter-spacing:0;">— fill in Ordered only if the ' + (isIn ? "supplier isn't delivering" : "customer isn't taking") + ' everything; the rest is tracked as Unclaimed automatically</span></label>' +
        '<div class="bulk-rows">' + rowsHtml + '</div>' +
        '<button type="button" class="btn btn-ghost" data-action="add-bulk-row" style="margin:10px 0 4px;">+ Add another item</button>' +
        (bm.error ? '<p style="color:var(--bad); font-size:13px; margin:10px 0 0;">' + esc(bm.error) + '</p>' : "") +
        '<div class="modal-actions">' +
          '<span></span>' +
          '<div class="right">' +
            '<button class="btn btn-ghost" data-action="close-bulk">Cancel</button>' +
            '<button class="btn ' + (isIn?"btn-primary":"btn-danger") + '" data-action="submit-bulk">' + (isIn?"Receive items":"Remove items") + '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

async function submitBulkMove(){
  var bm = bulkMoveState;
  var isIn = bm.direction === "in";
  var docNumber = bm.noDoc ? "" : (bm.docNumber || "").trim();
  if (!bm.noDoc && !docNumber){ bm.error = "Enter the " + (isIn ? "DR" : "PO") + " number, or check \"No " + (isIn ? "DR" : "PO") + "\"."; render(); return; }
  var party = (bm.party || "").trim();
  if (!party){ bm.error = "Enter the " + (isIn ? "supplier or driver" : "customer") + " name."; render(); return; }

  var runningQty = {};
  var resolved = [];
  for (var i = 0; i < bm.rows.length; i++){
    var row = bm.rows[i];
    var skuText = (row.sku || "").trim();
    var qtyText = (row.qty === undefined || row.qty === null) ? "" : String(row.qty).trim();
    if (!skuText && !qtyText) continue;
    if (!skuText){ bm.error = "Row " + (i+1) + ": choose an item."; render(); return; }
    var it = findItemBySkuOrName(skuText);
    if (!it){ bm.error = "Row " + (i+1) + ": no item matches \"" + skuText + "\" — try the exact item name or its SKU."; render(); return; }
    var qty = Math.round(num(qtyText, 0));
    if (!qty || qty <= 0){ bm.error = "Row " + (i+1) + ": enter a quantity greater than 0."; render(); return; }
    if (row.orderedQty !== "" && row.orderedQty != null){
      var orderedCheckRow = Math.round(num(row.orderedQty, 0));
      if (orderedCheckRow > 0 && orderedCheckRow < qty){
        bm.error = "Row " + (i+1) + ": Ordered qty can't be less than the quantity being " + (isIn ? "received" : "taken out") + "."; render(); return;
      }
    }
    var baseQty = runningQty.hasOwnProperty(it.id) ? runningQty[it.id] : it.qty;
    if (!isIn && qty > baseQty){ bm.error = "Row " + (i+1) + ": only " + baseQty + " " + (it.unit||"") + " on hand for " + it.name + "."; render(); return; }
    var afterQty = isIn ? baseQty + qty : baseQty - qty;
    runningQty[it.id] = afterQty;
    resolved.push({ item: it, oldQty: baseQty, newQty: afterQty, orderedQty: row.orderedQty });
  }
  if (!resolved.length){ bm.error = "Add at least one item."; render(); return; }

  bulkMoveState = null;
  render();
  var localUnclaimedCache = {};
  for (var j = 0; j < resolved.length; j++){
    var r = resolved[j];
    await updateDoc(doc(db, "items", r.item.id), { qty: r.newQty });
    await addLogEntry(r.item, r.oldQty, r.newQty, isIn ? "Stock in" : "Stock out", party, docNumber);
    await applyUnclaimedTracking(isIn ? "supplier" : "customer", docNumber, party, r.item, Math.abs(r.newQty - r.oldQty), r.orderedQty, localUnclaimedCache);
  }
  var docSuffix = docNumber ? (" under " + (isIn?"DR":"PO") + " " + docNumber) : "";
  pushToast((isIn ? "Received " : "Removed ") + resolved.length + " item" + (resolved.length>1?"s":"") + docSuffix + ".");
}

/* ============================= unclaimed tracking ============================= */
// Called after every Stock Out (kind="customer") or Stock In (kind="supplier"),
// single or bulk. If this item is already owed against the same PO/DR # (an
// earlier partial pickup/delivery), this movement counts as a claim against
// that balance. Otherwise, if an "Ordered qty" was given and it's more than
// what's moving now, a new unclaimed record is created automatically — no
// separate PO step required.
// localCache carries forward edits made earlier in the SAME bulk submission
// so two rows in one batch hitting the same item+PO don't clobber each other
// (Firestore's reactive listener hasn't echoed the first write back yet).
async function applyUnclaimedTracking(kind, docNumber, party, item, movedQty, orderedRaw, localCache){
  docNumber = (docNumber || "").trim();
  if (!docNumber || !movedQty || movedQty <= 0) return;
  var key = kind + "|" + item.id + "|" + docNumber;
  var existing = (localCache && localCache[key]) ||
    state.unclaimed.find(function(u){ return (u.kind||"customer") === kind && u.itemId === item.id && (u.docNumber||"") === docNumber && (u.status||"open") !== "claimed"; });
  if (existing){
    var newTaken = (existing.taken || 0) + movedQty;
    var newRemaining = existing.ordered - newTaken;
    if (newRemaining <= 0){
      // Fully claimed — keep the record (instead of deleting it) so there's
      // a record of when it was cleared, just mark it claimed.
      if (localCache) delete localCache[key];
      var claimedAt = new Date().toISOString();
      await updateDoc(doc(db, "unclaimed", existing.id), { taken: newTaken, remaining: 0, status: "claimed", claimedAt: claimedAt, updatedAt: claimedAt });
    } else {
      if (localCache) localCache[key] = Object.assign({}, existing, { taken: newTaken, remaining: newRemaining });
      await updateDoc(doc(db, "unclaimed", existing.id), { taken: newTaken, remaining: newRemaining, updatedAt: new Date().toISOString() });
    }
    return;
  }
  var orderedNum = Math.round(num(orderedRaw, 0));
  if (orderedNum > movedQty){
    var newRecord = {
      kind: kind, customer: (party || "").trim(), docNumber: docNumber,
      itemId: item.id, itemName: item.name, sku: item.sku, unit: item.unit,
      ordered: orderedNum, taken: movedQty, remaining: orderedNum - movedQty,
      status: "open",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    var ref = await addDoc(unclaimedCol, newRecord);
    if (localCache) localCache[key] = Object.assign({ id: ref.id }, newRecord);
  }
}

/* ============================= physical count modal ============================= */
var countState = null; // { itemId, itemName, sku, unit, currentQty, counted:"", note:"", error:"" }

function openCountModal(id){
  var it = state.items.find(function(x){ return x.id === id; });
  if (!it) return;
  countState = {
    itemId: it.id, itemName: it.name, sku: it.sku,
    unit: it.unit, currentQty: it.qty, counted: "", note: "", error: ""
  };
  render();
  setTimeout(function(){
    var f = document.getElementById("count-field-counted");
    if (f) f.focus();
  }, 10);
}
function closeCountModal(){ countState = null; render(); }

function renderCountModal(){
  if (!countState) return "";
  var cs = countState;
  var title = "Physical count — " + esc(cs.itemName);
  return (
    '<div class="modal-backdrop" data-action="backdrop-count">' +
      '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-item-preview"><div><h3>' + title + '</h3>' +
        '<p class="modal-sub">' + esc(cs.sku) + ' &middot; system shows ' + cs.currentQty + ' ' + esc(cs.unit) + ' on hand</p></div></div>' +
        '<div class="field"><label for="count-field-counted">Counted quantity</label>' +
          '<input id="count-field-counted" type="number" min="0" step="1" value="' + esc(cs.counted) + '" data-countfield="counted" placeholder="e.g. ' + cs.currentQty + '"></div>' +
        '<div class="field"><label for="count-field-note">Note <span style="font-weight:400; color:var(--text-muted);">(optional)</span></label>' +
          '<input id="count-field-note" type="text" value="' + esc(cs.note) + '" data-countfield="note" placeholder="e.g. damaged stock found"></div>' +
        (cs.error ? '<p style="color:var(--bad); font-size:13px; margin:0 0 8px;">' + esc(cs.error) + '</p>' : "") +
        '<div class="modal-actions">' +
          '<span></span>' +
          '<div class="right">' +
            '<button class="btn btn-ghost" data-action="close-count">Cancel</button>' +
            '<button class="btn btn-primary" data-action="submit-count">Save count</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

async function submitCount(){
  var cs = countState;
  var it = state.items.find(function(x){ return x.id === cs.itemId; });
  if (!it){ countState = null; render(); return; }
  if (cs.counted === "" || cs.counted == null){ cs.error = "Enter the counted quantity."; render(); return; }
  var counted = Math.round(num(cs.counted, -1));
  if (counted < 0){ cs.error = "Enter a valid quantity (0 or more)."; render(); return; }
  var oldQty = it.qty;
  var note = (cs.note || "").trim();
  countState = null;
  render();
  if (counted === oldQty){
    pushToast("Count matches system — no adjustment needed for " + it.name + ".");
    return;
  }
  await updateDoc(doc(db, "items", it.id), { qty: counted });
  await addLogEntry(it, oldQty, counted, "Physical count", note, "");
  var diff = counted - oldQty;
  pushToast("Count saved — " + it.name + " " + (diff>0?"+":"") + diff + " " + (it.unit||"") + " (now " + counted + ").");
}

function renderStockMoveModal(){
  if (!stockMoveState) return "";
  var sm = stockMoveState;
  var isIn = sm.direction === "in";
  var partyLabel = isIn ? "Delivered by" : "Customer";
  var docLabel = isIn ? "DR Number" : "PO Number";
  var title = (isIn ? "Stock in — " : "Stock out — ") + esc(sm.itemName);
  return (
    '<div class="modal-backdrop" data-action="backdrop-sm">' +
      '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-item-preview"><div><h3>' + title + '</h3>' +
        '<p class="modal-sub">' + esc(sm.sku) + ' &middot; currently ' + sm.currentQty + ' ' + esc(sm.unit) + ' on hand</p></div></div>' +
        '<div class="field"><label for="sm-field-qty">' + (isIn ? "Quantity received" : "Quantity taken out") + '</label>' +
          '<input id="sm-field-qty" type="number" min="1" step="1" value="' + esc(sm.qty) + '" data-smfield="qty" placeholder="e.g. 10"></div>' +
        '<div class="field"><label for="sm-field-party">' + partyLabel + '</label>' +
          '<input id="sm-field-party" type="text" value="' + esc(sm.party) + '" data-smfield="party" placeholder="' + (isIn ? "Supplier or driver name" : "Customer name") + '"></div>' +
        '<div class="field"><label for="sm-field-docnumber">' + docLabel + '</label>' +
          '<input id="sm-field-docnumber" type="text" inputmode="numeric" pattern="[0-9]*" value="' + esc(sm.docNumber) + '" data-smfield="docNumber" placeholder="' + (isIn ? "e.g. 2208" : "e.g. 1042") + '"' + (sm.noDoc ? " disabled" : "") + '>' +
          '<label class="checkbox-row"><input type="checkbox" data-smfield="noDoc"' + (sm.noDoc ? " checked" : "") + '> No ' + (isIn ? "DR" : "PO") + ' for this ' + (isIn ? "delivery" : "customer") + '</label>' +
        '</div>' +
        (sm.noDoc ? "" :
        '<div class="field"><label for="sm-field-ordered">Ordered qty <span style="font-weight:400; color:var(--text-muted);">(optional)</span></label>' +
          '<input id="sm-field-ordered" type="number" min="1" step="1" value="' + esc(sm.orderedQty) + '" data-smfield="orderedQty" placeholder="' + (isIn ? "Leave blank if receiving everything" : "Leave blank if taking everything") + '">' +
          '<p class="field-hint">Only fill this in if the ' + (isIn ? "supplier isn't delivering" : "customer isn't taking") + ' the full order — we\'ll track what\'s left as Unclaimed automatically.</p>' +
        '</div>') +
        (sm.error ? '<p style="color:var(--bad); font-size:13px; margin:0 0 8px;">' + esc(sm.error) + '</p>' : "") +
        '<div class="modal-actions">' +
          '<span></span>' +
          '<div class="right">' +
            '<button class="btn btn-ghost" data-action="close-stockmove">Cancel</button>' +
            '<button class="btn ' + (isIn ? "btn-primary" : "btn-danger") + '" data-action="submit-stockmove">' + (isIn ? "Add stock" : "Remove stock") + '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

async function submitStockMove(){
  var sm = stockMoveState;
  var it = state.items.find(function(x){ return x.id === sm.itemId; });
  if (!it){ stockMoveState = null; render(); return; }
  var amt = Math.round(num(sm.qty, 0));
  if (!amt || amt <= 0){ sm.error = "Enter a quantity greater than 0."; render(); return; }
  var docLabel = sm.direction === "in" ? "DR number" : "PO number";
  if (!sm.noDoc && !(sm.docNumber || "").trim()){ sm.error = "Enter the " + docLabel + ", or check \"No " + (sm.direction === "in" ? "DR" : "PO") + "\"."; render(); return; }
  var oldQty = it.qty;
  var newQty;
  if (sm.direction === "in"){
    newQty = oldQty + amt;
  } else {
    if (amt > oldQty){ sm.error = "Only " + oldQty + " " + (it.unit||"") + " on hand — can't remove " + amt + "."; render(); return; }
    newQty = oldQty - amt;
  }
  var orderedRaw = sm.noDoc ? "" : sm.orderedQty;
  if (orderedRaw !== "" && orderedRaw != null){
    var orderedCheck = Math.round(num(orderedRaw, 0));
    if (orderedCheck > 0 && orderedCheck < amt){
      sm.error = "Ordered qty can't be less than the quantity you're " + (sm.direction === "in" ? "receiving" : "taking out") + "."; render(); return;
    }
  }
  var party = (sm.party || "").trim();
  var docNumber = sm.noDoc ? "" : (sm.docNumber || "").trim();
  stockMoveState = null;
  render();
  await updateDoc(doc(db, "items", it.id), { qty: newQty });
  await addLogEntry(it, oldQty, newQty, sm.direction === "in" ? "Stock in" : "Stock out", party, docNumber);
  await applyUnclaimedTracking(sm.direction === "in" ? "supplier" : "customer", docNumber, party, it, amt, orderedRaw, null);
  pushToast((sm.direction === "in" ? "Added " : "Removed ") + amt + " " + (it.unit||"") + " — " + it.name);
}

/* ============================= sign-in modal ============================= */
var signInState = null; // { email:"", password:"", error:"", busy:false }

function openSignInModal(){
  signInState = { email:"", password:"", error:"", busy:false };
  render();
  setTimeout(function(){
    var f = document.getElementById("auth-field-email");
    if (f) f.focus();
  }, 10);
}
function closeSignInModal(){ signInState = null; render(); }

function renderSignInModal(){
  if (!signInState) return "";
  var s = signInState;
  return (
    '<div class="modal-backdrop" data-action="backdrop-auth">' +
      '<div class="modal" role="dialog" aria-modal="true">' +
        '<h3>Sign in</h3>' +
        '<p class="modal-sub">Sign in with the account given to you to add or edit stock.</p>' +
        '<div class="field"><label for="auth-field-email">Email</label><input id="auth-field-email" type="email" value="' + esc(s.email) + '" data-authfield="email" autocomplete="username"></div>' +
        '<div class="field"><label for="auth-field-password">Password</label><input id="auth-field-password" type="password" value="' + esc(s.password) + '" data-authfield="password" autocomplete="current-password"></div>' +
        (s.error ? '<p style="color:var(--bad); font-size:13px; margin:0 0 8px;">' + esc(s.error) + '</p>' : "") +
        '<div class="modal-actions">' +
          '<span></span>' +
          '<div class="right">' +
            '<button class="btn btn-ghost" data-action="close-signin">Cancel</button>' +
            '<button class="btn btn-primary" data-action="submit-signin"' + (s.busy ? " disabled" : "") + '>' + (s.busy ? "Signing in…" : "Sign in") + '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

async function submitSignIn(){
  var s = signInState;
  if (!s.email.trim() || !s.password){ s.error = "Enter your email and password."; render(); return; }
  s.busy = true; s.error = ""; render();
  try {
    await signInWithEmailAndPassword(auth, s.email.trim(), s.password);
    signInState = null;
    render();
    pushToast("Signed in");
  } catch(err){
    s.busy = false;
    s.error = (err && (err.code === "auth/invalid-credential" || err.code === "auth/wrong-password" || err.code === "auth/user-not-found"))
      ? "Wrong email or password."
      : "Couldn't sign in — " + (err && err.message ? err.message : "please try again.");
    render();
  }
}

function renderModal(){
  if (!modalState) return "";
  var m = modalState;
  var it = m.item;
  var isAdd = m.mode === "add";
  var cats = getCategories();
  var datalist = '<datalist id="cat-list">' + cats.map(function(c){ return '<option value="' + esc(c) + '">'; }).join("") + '</datalist>';
  var whs = getWarehouses();
  var whDatalist = '<datalist id="wh-list">' + whs.map(function(w){ return '<option value="' + esc(w) + '">'; }).join("") + '</datalist>';

  var body = (
    '<div class="field"><label for="field-name">Item name</label><input id="field-name" type="text" value="' + esc(it.name) + '" data-mfield="name" placeholder="e.g. .5 x 10 (Blue)"></div>' +
    '<div class="field"><label for="field-cat">Category</label><input id="field-cat" type="text" list="cat-list" value="' + esc(it.category) + '" data-mfield="category" placeholder="e.g. Roofing"></div>' + datalist +
    '<div class="field"><label for="field-warehouse">Warehouse</label><input id="field-warehouse" type="text" list="wh-list" value="' + esc(itemWarehouse(it)) + '" data-mfield="warehouse" placeholder="e.g. Warehouse 1"></div>' + whDatalist +
    '<div class="field-row">' +
      '<div class="field"><label for="field-sku">SKU</label><input id="field-sku" type="text" value="' + esc(it.sku) + '" data-mfield="sku"></div>' +
      '<div class="field"><label for="field-unit">Unit</label><input id="field-unit" type="text" value="' + esc(it.unit) + '" data-mfield="unit" placeholder="pc, sheet, bag…"></div>' +
    '</div>' +
    '<div class="field-row">' +
      '<div class="field"><label for="field-qty">Quantity on hand</label><input id="field-qty" type="number" min="0" step="1" value="' + it.qty + '" data-mfield="qty"></div>' +
      '<div class="field"><label for="field-reorder">Reorder point</label><input id="field-reorder" type="number" min="0" step="1" value="' + it.reorder + '" data-mfield="reorder"></div>' +
    '</div>' +
    '<div class="field"><label for="field-price">Unit price (₱)</label><input id="field-price" type="number" min="0" step="0.01" value="' + it.price + '" data-mfield="price"></div>' +
    (m.error ? '<p style="color:var(--bad); font-size:13px; margin:0 0 8px;">' + esc(m.error) + '</p>' : "")
  );

  var confirmHtml = "";
  if (m.confirmDelete){
    confirmHtml = (
      '<div class="confirm-box">' +
        '<p>Delete <strong>' + esc(it.name) + '</strong>? This can’t be undone.</p>' +
        '<div class="row">' +
          '<button class="btn btn-ghost" data-action="cancel-delete">Cancel</button>' +
          '<button class="btn btn-danger" data-action="confirm-delete">Delete item</button>' +
        '</div>' +
      '</div>'
    );
  }

  var actions = (
    '<div class="modal-actions">' +
      (isAdd ? '<span></span>' : '<button class="btn btn-danger btn-ghost" data-action="ask-delete">Delete</button>') +
      '<div class="right">' +
        '<button class="btn btn-ghost" data-action="close-modal">Cancel</button>' +
        '<button class="btn btn-primary" data-action="save-item">' + (isAdd ? "Add item" : "Save changes") + '</button>' +
      '</div>' +
    '</div>'
  );

  return (
    '<div class="modal-backdrop" data-action="backdrop">' +
      '<div class="modal" role="dialog" aria-modal="true">' +
        '<h3>' + (isAdd ? "Add item" : "Edit item") + '</h3>' +
        '<p class="modal-sub">' + (isAdd ? "Add a new item to the inventory." : "SKU " + esc(it.sku)) + '</p>' +
        body +
        confirmHtml +
        actions +
      '</div>' +
    '</div>'
  );
}

/* ============================= toasts ============================= */
var toasts = [];
function pushToast(text, isErr){
  var t = { id: uid(), text:text, err:!!isErr };
  toasts.push(t);
  render();
  setTimeout(function(){
    toasts = toasts.filter(function(x){ return x.id !== t.id; });
    render();
  }, 4500);
}
function renderToasts(){
  if (!toasts.length) return "";
  return '<div class="toast-wrap">' + toasts.map(function(t){
    return '<div class="toast' + (t.err?" err":"") + '">' + esc(t.text) + '</div>';
  }).join("") + '</div>';
}

/* ============================= mutations ============================= */
async function updateItemField(id, field, rawValue){
  var it = state.items.find(function(x){ return x.id === id; });
  if (!it) return;
  var patch = {};
  if (field === "qty" || field === "reorder"){
    var newVal = Math.round(num(rawValue, it[field]));
    patch[field] = newVal;
    await updateDoc(doc(db, "items", id), patch);
    if (field === "qty" && newVal !== it.qty) await addLogEntry(it, it.qty, newVal, "Manual adjustment");
  } else if (field === "price"){
    patch[field] = num(rawValue, it[field]);
    await updateDoc(doc(db, "items", id), patch);
  } else {
    patch[field] = String(rawValue || "").trim();
    await updateDoc(doc(db, "items", id), patch);
  }
}

async function updateLogField(id, field, rawValue){
  var patch = {};
  patch[field] = String(rawValue || "").trim();
  await updateDoc(doc(db, "log", id), patch);
}

async function deleteLogEntry(id){
  var entry = state.log.find(function(x){ return x.id === id; });
  var msg = "Deleted log entry";
  if (entry && typeof entry.delta === "number" && entry.delta !== 0 && entry.itemId){
    var it = state.items.find(function(x){ return x.id === entry.itemId; });
    if (it){
      var restoredQty = Math.max(0, it.qty - entry.delta);
      await updateDoc(doc(db, "items", it.id), { qty: restoredQty });
      msg = "Deleted log entry — " + it.name + " reversed to " + restoredQty + " " + (it.unit||"");
    }
  }
  await deleteDoc(doc(db, "log", id));
  return msg;
}

async function submitModal(){
  var m = modalState;
  var it = m.item;
  if (!it.name.trim()){ m.error = "Item name is required."; render(); return; }
  if (!it.category.trim()){ m.error = "Category is required."; render(); return; }
  it.name = it.name.trim();
  it.category = it.category.trim();
  it.unit = (it.unit || "pc").trim() || "pc";
  it.sku = (it.sku || "").trim() || nextSku(it.category);
  it.warehouse = (it.warehouse || "").trim() || "Warehouse 1";
  it.qty = Math.round(num(it.qty, 0));
  it.reorder = Math.round(num(it.reorder, 0));
  it.price = num(it.price, 0);

  var docData = { name: it.name, category: it.category, sku: it.sku, unit: it.unit, warehouse: it.warehouse, qty: it.qty, reorder: it.reorder, price: it.price };

  if (m.mode === "add"){
    modalState = null;
    ui.view = "inventory";
    render();
    var ref = await addDoc(itemsCol, docData);
    if (it.qty > 0) await addLogEntry({ id: ref.id, name: it.name, sku: it.sku, category: it.category, unit: it.unit, warehouse: it.warehouse, price: it.price }, 0, it.qty, "Item added");
    pushToast("Added " + it.name);
  } else {
    var existing = state.items.find(function(x){ return x.id === it.id; });
    var prevQty = existing ? existing.qty : it.qty;
    modalState = null;
    render();
    await updateDoc(doc(db, "items", it.id), docData);
    if (prevQty !== it.qty) await addLogEntry(it, prevQty, it.qty, "Edited");
    pushToast("Saved " + it.name);
  }
}

async function deleteItem(id){
  var item = state.items.find(function(x){ return x.id === id; });
  if (!item) return;
  var name = item.name;
  modalState = null;
  render();
  if (item.qty !== 0) await addLogEntry(item, item.qty, 0, "Item deleted");
  await deleteDoc(doc(db, "items", id));
  pushToast("Deleted " + name);
}

/* ============================= export: CSV ============================= */
function csvEscape(v){
  var s = v == null ? "" : String(v);
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCsv(rows){
  return rows.map(function(r){ return r.map(csvEscape).join(","); }).join("\r\n");
}
function scopeLabel(){
  return ui.warehouse === "all" ? "All Warehouses" : ui.warehouse;
}
function filenameSuffix(){
  return ui.warehouse === "all" ? "" : "-" + ui.warehouse.replace(/\s+/g,"-");
}

function buildInventoryCsv(){
  var out = [];
  out.push(["Stockyard — " + scopeLabel() + " — Inventory"]);
  out.push(["Generated", fmtDateTime(new Date().toISOString())]);
  out.push([]);
  out.push(["Name","SKU","Category","Warehouse","Qty","Unit","Reorder Point","Unit Price (PHP)","Status"]);
  scopedItems().forEach(function(it){
    out.push([it.name, it.sku, it.category, itemWarehouse(it), it.qty, it.unit, it.reorder, it.price, statusLabel(statusOf(it))]);
  });
  return toCsv(out);
}
function buildLogCsv(){
  var out = [];
  out.push(["Stockyard — " + scopeLabel() + " — Stock Movement Log"]);
  out.push(["Generated", fmtDateTime(new Date().toISOString())]);
  out.push([]);
  out.push(["Date","Item","SKU","Category","Warehouse","Old Qty","New Qty","Change","Unit Price (PHP)","Value (PHP)","Reason","Delivered by / Customer","PO/DR #"]);
  scopedLog().forEach(function(e){
    out.push([fmtDateTime(e.ts), e.itemName, e.sku, e.category, itemWarehouse(e), e.oldQty, e.newQty, e.delta, e.unitPrice||0, e.value||0, e.reason||"", e.party||"", e.docNumber||""]);
  });
  return toCsv(out);
}

function buildReorderCsv(){
  var out = [];
  out.push(["Stockyard — " + scopeLabel() + " — Reorder Report"]);
  out.push(["Generated", fmtDateTime(new Date().toISOString())]);
  out.push([]);
  var byCat = {};
  computeReorderList().forEach(function(it){ (byCat[it.category] = byCat[it.category] || []).push(it); });
  getCategories().forEach(function(cat){
    var items = byCat[cat];
    if (!items || !items.length) return;
    out.push([cat]);
    out.push(["Name","SKU","Warehouse","Qty on Hand","Reorder Point","Suggested Order Qty","Unit","Status"]);
    items.forEach(function(it){
      out.push([it.name, it.sku, itemWarehouse(it), it.qty, it.reorder, it.suggestedOrder, it.unit, statusLabel(statusOf(it))]);
    });
    out.push([]);
  });
  return toCsv(out);
}

function buildDeadStockCsv(){
  var out = [];
  out.push(["Stockyard — " + scopeLabel() + " — Dead Stock Report (no movement in " + DEAD_STOCK_DAYS + "+ days)"]);
  out.push(["Generated", fmtDateTime(new Date().toISOString())]);
  out.push([]);
  out.push(["Name","SKU","Category","Warehouse","Qty on Hand","Unit","Last Movement","Days Since Movement","Value at Risk (PHP)"]);
  computeDeadStockList(DEAD_STOCK_DAYS).forEach(function(it){
    var lastStr = it.lastMovementTs ? fmtDateTime(new Date(it.lastMovementTs).toISOString()) : "Never recorded";
    var daysSince = it.lastMovementTs ? Math.floor((Date.now() - it.lastMovementTs) / 86400000) : "—";
    out.push([it.name, it.sku, it.category, itemWarehouse(it), it.qty, it.unit, lastStr, daysSince, it.qty * it.price]);
  });
  return toCsv(out);
}

function buildUnclaimedCsv(kind){
  kind = kind || "customer";
  var isSupplier = kind === "supplier";
  var partyLabel = isSupplier ? "Supplier" : "Customer";
  var out = [];
  out.push(["Stockyard — Unclaimed Items (" + partyLabel + ")"]);
  out.push(["Generated", fmtDateTime(new Date().toISOString())]);
  out.push([]);
  out.push([partyLabel,"PO/DR #","Item","SKU","Ordered",(isSupplier?"Received":"Taken"),"Still Owed","Status","Claimed On"]);
  computeUnclaimedList(kind, "all").forEach(function(r){
    var isClaimed = (r.status || "open") === "claimed";
    out.push([r.customer, r.docNumber, r.itemName, r.sku, r.ordered, r.taken, r.remaining, isClaimed ? "Claimed" : "Open", isClaimed ? fmtDateTime(r.claimedAt || r.updatedAt) : ""]);
  });
  return toCsv(out);
}

function buildReturnsCsv(){
  var out = [];
  out.push(["Stockyard — Returns"]);
  out.push(["Generated", fmtDateTime(new Date().toISOString())]);
  out.push([]);
  out.push(["Date","Type","Item","SKU","Qty","Party","PO/DR #","Reason"]);
  computeReturnsList().forEach(function(e){
    out.push([fmtDateTime(e.ts), e.reason, e.itemName, e.sku, Math.abs(e.delta), e.party||"", e.docNumber||"", e.note||""]);
  });
  return toCsv(out);
}

function downloadBlob(blob, filename){
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
}

function triggerInventoryCsvExport(){
  var stamp = new Date().toISOString().slice(0,10);
  var blob = new Blob([buildInventoryCsv()], { type: "text/csv;charset=utf-8;" });
  var filename = "Stockyard-Inventory" + filenameSuffix() + "-" + stamp + ".csv";
  downloadBlob(blob, filename);
  pushToast("Downloaded " + filename);
}
function triggerLogCsvExport(){
  var stamp = new Date().toISOString().slice(0,10);
  var blob = new Blob([buildLogCsv()], { type: "text/csv;charset=utf-8;" });
  var filename = "Stockyard-Log" + filenameSuffix() + "-" + stamp + ".csv";
  downloadBlob(blob, filename);
  pushToast("Downloaded " + filename);
}
function triggerReorderCsvExport(){
  var stamp = new Date().toISOString().slice(0,10);
  var blob = new Blob([buildReorderCsv()], { type: "text/csv;charset=utf-8;" });
  var filename = "Stockyard-ReorderReport" + filenameSuffix() + "-" + stamp + ".csv";
  downloadBlob(blob, filename);
  pushToast("Downloaded " + filename);
}
function triggerDeadStockCsvExport(){
  var stamp = new Date().toISOString().slice(0,10);
  var blob = new Blob([buildDeadStockCsv()], { type: "text/csv;charset=utf-8;" });
  var filename = "Stockyard-DeadStock" + filenameSuffix() + "-" + stamp + ".csv";
  downloadBlob(blob, filename);
  pushToast("Downloaded " + filename);
}
function triggerUnclaimedCsvExport(kind){
  kind = kind || "customer";
  var stamp = new Date().toISOString().slice(0,10);
  var blob = new Blob([buildUnclaimedCsv(kind)], { type: "text/csv;charset=utf-8;" });
  var filename = "Stockyard-Unclaimed" + (kind === "supplier" ? "Supplier" : "Customer") + "-" + stamp + ".csv";
  downloadBlob(blob, filename);
  pushToast("Downloaded " + filename);
}
function triggerReturnsCsvExport(){
  var stamp = new Date().toISOString().slice(0,10);
  var blob = new Blob([buildReturnsCsv()], { type: "text/csv;charset=utf-8;" });
  var filename = "Stockyard-Returns-" + stamp + ".csv";
  downloadBlob(blob, filename);
  pushToast("Downloaded " + filename);
}
/* ============================= export: PDF ============================= */
function pdfLibReady(){
  return !window.__pdfLibFailed && !!(window.jspdf && window.jspdf.jsPDF);
}

function pdfTableOpts(margin){
  return {
    styles: { fontSize: 8, cellPadding: 3, textColor: 25 },
    headStyles: { fillColor: [230, 224, 213], textColor: 25, fontStyle: "bold" },
    theme: "grid",
    margin: { left: margin, right: margin }
  };
}

function fmtMoneyPdf(n){
  return "PHP " + (Math.round(n*100)/100).toLocaleString("en-PH", {minimumFractionDigits:2, maximumFractionDigits:2});
}

function pdfStatsRow(doc, margin, y, stats){
  var pageW = doc.internal.pageSize.getWidth();
  var usableW = pageW - margin * 2;
  var tiles = [
    { value: String(stats.totalSkus), label: "SKUs" },
    { value: stats.totalUnits.toLocaleString("en-PH"), label: "Units on hand" },
    { value: String(stats.lowCount), label: "Low stock" },
    { value: String(stats.outCount), label: "Out of stock" },
    { value: fmtMoneyPdf(stats.totalValue), label: "Inventory value" }
  ];
  var colW = usableW / tiles.length;
  tiles.forEach(function(t, i){
    var x = margin + i * colW;
    doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(20);
    doc.text(t.value, x, y, { maxWidth: colW - 8 });
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(t.label, x, y + 13, { maxWidth: colW - 8 });
  });
  return y + 30;
}

function pdfHeader(doc, margin, subtitle){
  var y = margin;
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(20);
  doc.text("Stockyard — " + scopeLabel(), margin, y); y += 16;
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(110);
  doc.text(subtitle + " · Generated " + fmtDateTime(new Date().toISOString()), margin, y); y += 22;
  return y;
}

function buildInventoryPdfBlob(){
  var jsPDFCtor = window.jspdf.jsPDF;
  var doc = new jsPDFCtor({ unit: "pt", format: "a4" });
  var margin = 40, pageH = doc.internal.pageSize.getHeight();
  var y = pdfHeader(doc, margin, "Inventory");

  var stats = computeStats();
  y = pdfStatsRow(doc, margin, y, stats);

  var tableOpts = pdfTableOpts(margin);
  var showWarehouseCol = ui.warehouse === "all" && getWarehouses().length > 1;
  var head = showWarehouseCol
    ? ["Item","SKU","Warehouse","Qty","Unit","Reorder","Price","Status"]
    : ["Item","SKU","Qty","Unit","Reorder","Price","Status"];

  getCategories().forEach(function(cat){
    var items = scopedItems().filter(function(it){ return it.category === cat; });
    if (!items.length) return;
    if (y > pageH - 90){ doc.addPage(); y = margin; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(20);
    doc.text(cat, margin, y + 10);
    doc.autoTable(Object.assign({}, tableOpts, {
      startY: y + 16,
      head: [head],
      body: items.map(function(it){
        var row = [it.name, it.sku];
        if (showWarehouseCol) row.push(itemWarehouse(it));
        row.push(it.qty, it.unit, it.reorder, fmtMoneyPdf(it.price), statusLabel(statusOf(it)));
        return row;
      })
    }));
    y = doc.lastAutoTable.finalY + 18;
  });

  return doc.output("blob");
}

function buildLogPdfBlob(){
  var jsPDFCtor = window.jspdf.jsPDF;
  var doc = new jsPDFCtor({ unit: "pt", format: "a4" });
  var margin = 40;
  var y = pdfHeader(doc, margin, "Stock Movement Log");
  var tableOpts = pdfTableOpts(margin);
  var log = scopedLog();
  var showWarehouseCol = ui.warehouse === "all" && getWarehouses().length > 1;
  var head = showWarehouseCol
    ? ["Date","Item","SKU","Warehouse","Change","Qty","Value","Delivered by / Customer","PO/DR #"]
    : ["Date","Item","SKU","Change","Qty","Value","Delivered by / Customer","PO/DR #"];

  if (!log.length){
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(110);
    doc.text("No movements recorded yet.", margin, y + 12);
  } else {
    doc.autoTable(Object.assign({}, tableOpts, {
      startY: y,
      head: [head],
      body: log.map(function(e){
        var row = [fmtDateTime(e.ts), e.itemName, e.sku];
        if (showWarehouseCol) row.push(itemWarehouse(e));
        row.push((e.delta>0?"+":"")+e.delta, e.oldQty+" -> "+e.newQty, fmtMoneyPdf(e.value||0), e.party || "", e.docNumber || "");
        return row;
      })
    }));
  }

  return doc.output("blob");
}

function buildReorderPdfBlob(){
  var jsPDFCtor = window.jspdf.jsPDF;
  var doc = new jsPDFCtor({ unit: "pt", format: "a4" });
  var margin = 40, pageH = doc.internal.pageSize.getHeight();
  var y = pdfHeader(doc, margin, "Reorder Report");
  var tableOpts = pdfTableOpts(margin);
  var list = computeReorderList();
  var showWarehouseCol = ui.warehouse === "all" && getWarehouses().length > 1;
  var head = showWarehouseCol
    ? ["Item","SKU","Warehouse","Qty on hand","Reorder pt.","Suggested order","Unit"]
    : ["Item","SKU","Qty on hand","Reorder pt.","Suggested order","Unit"];

  if (!list.length){
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(110);
    doc.text("Nothing needs reordering right now.", margin, y + 12);
  } else {
    var byCat = {};
    list.forEach(function(it){ (byCat[it.category] = byCat[it.category] || []).push(it); });
    getCategories().forEach(function(cat){
      var items = byCat[cat];
      if (!items || !items.length) return;
      if (y > pageH - 90){ doc.addPage(); y = margin; }
      doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(20);
      doc.text(cat, margin, y + 10);
      doc.autoTable(Object.assign({}, tableOpts, {
        startY: y + 16,
        head: [head],
        body: items.map(function(it){
          var row = [it.name, it.sku];
          if (showWarehouseCol) row.push(itemWarehouse(it));
          row.push(it.qty, it.reorder, it.suggestedOrder, it.unit);
          return row;
        })
      }));
      y = doc.lastAutoTable.finalY + 18;
    });
  }

  return doc.output("blob");
}

function triggerReorderPdfExport(){
  if (!pdfLibReady()){
    pushToast("PDF export is still loading — give it a moment and try again.", true);
    return;
  }
  try {
    var blob = buildReorderPdfBlob();
    var stamp = new Date().toISOString().slice(0,10);
    var filename = "Stockyard-ReorderReport" + filenameSuffix() + "-" + stamp + ".pdf";
    downloadBlob(blob, filename);
    pushToast("Downloaded " + filename);
  } catch(err){
    pushToast("Couldn’t build the PDF — " + (err && err.message ? err.message : "please try again") + ".", true);
  }
}

function buildDeadStockPdfBlob(){
  var jsPDFCtor = window.jspdf.jsPDF;
  var doc = new jsPDFCtor({ unit: "pt", format: "a4" });
  var margin = 40;
  var y = pdfHeader(doc, margin, "Dead Stock Report — no movement in " + DEAD_STOCK_DAYS + "+ days");
  var tableOpts = pdfTableOpts(margin);
  var list = computeDeadStockList(DEAD_STOCK_DAYS);
  var showWarehouseCol = ui.warehouse === "all" && getWarehouses().length > 1;
  var head = showWarehouseCol
    ? ["Item","SKU","Category","Warehouse","Qty on hand","Last movement","Days idle","Value at risk"]
    : ["Item","SKU","Category","Qty on hand","Last movement","Days idle","Value at risk"];

  if (!list.length){
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(110);
    doc.text("Nothing has been sitting idle for " + DEAD_STOCK_DAYS + "+ days.", margin, y + 12);
  } else {
    doc.autoTable(Object.assign({}, tableOpts, {
      startY: y,
      head: [head],
      body: list.map(function(it){
        var lastStr = it.lastMovementTs ? fmtDateTime(new Date(it.lastMovementTs).toISOString()) : "Never recorded";
        var daysSince = it.lastMovementTs ? Math.floor((Date.now() - it.lastMovementTs) / 86400000) : "—";
        var row = [it.name, it.sku, it.category];
        if (showWarehouseCol) row.push(itemWarehouse(it));
        row.push(it.qty, lastStr, daysSince, fmtMoneyPdf(it.qty * it.price));
        return row;
      })
    }));
  }

  return doc.output("blob");
}

function triggerDeadStockPdfExport(){
  if (!pdfLibReady()){
    pushToast("PDF export is still loading — give it a moment and try again.", true);
    return;
  }
  try {
    var blob = buildDeadStockPdfBlob();
    var stamp = new Date().toISOString().slice(0,10);
    var filename = "Stockyard-DeadStock" + filenameSuffix() + "-" + stamp + ".pdf";
    downloadBlob(blob, filename);
    pushToast("Downloaded " + filename);
  } catch(err){
    pushToast("Couldn’t build the PDF — " + (err && err.message ? err.message : "please try again") + ".", true);
  }
}

function triggerInventoryPdfExport(){
  if (!pdfLibReady()){
    pushToast("PDF export is still loading — give it a moment and try again.", true);
    return;
  }
  try {
    var blob = buildInventoryPdfBlob();
    var stamp = new Date().toISOString().slice(0,10);
    var filename = "Stockyard-Inventory" + filenameSuffix() + "-" + stamp + ".pdf";
    downloadBlob(blob, filename);
    pushToast("Downloaded " + filename);
  } catch(err){
    pushToast("Couldn’t build the PDF — " + (err && err.message ? err.message : "please try again") + ".", true);
  }
}

function triggerLogPdfExport(){
  if (!pdfLibReady()){
    pushToast("PDF export is still loading — give it a moment and try again.", true);
    return;
  }
  try {
    var blob = buildLogPdfBlob();
    var stamp = new Date().toISOString().slice(0,10);
    var filename = "Stockyard-Log" + filenameSuffix() + "-" + stamp + ".pdf";
    downloadBlob(blob, filename);
    pushToast("Downloaded " + filename);
  } catch(err){
    pushToast("Couldn’t build the PDF — " + (err && err.message ? err.message : "please try again") + ".", true);
  }
}

// All log entries recorded together for one PO — a single Stock Out is a
// batch of one, a bulk Stock Out under the same PO/customer is a batch of many.
function computeStockOutBatch(docNumber, party){
  docNumber = (docNumber || "").trim();
  return state.log
    .filter(function(e){ return e.reason === "Stock out" && (e.docNumber || "").trim() === docNumber && (e.party || "") === party; })
    .slice()
    .sort(function(a, b){ return new Date(a.ts) - new Date(b.ts); });
}

// Cross-references the Unclaimed records (open + claimed) tied to this PO,
// so the printable PO can say whether it's still owed or when it was
// fully claimed — mirrors the Still owed / Claimed split on the Unclaimed tab.
function computePoFulfillmentNote(docNumber, party){
  var related = computeUnclaimedList("customer", "all").filter(function(r){
    return (r.docNumber || "").trim() === (docNumber || "").trim() && (r.customer || "") === party;
  });
  if (!related.length) return null;
  var open = related.filter(function(r){ return (r.status || "open") !== "claimed"; });
  if (open.length){
    var owedUnits = open.reduce(function(sum, r){ return sum + (r.remaining || 0); }, 0);
    return { tone: "warn", text: "Partially fulfilled — " + owedUnits + " unit" + (owedUnits !== 1 ? "s" : "") + " still owed across " + open.length + " item" + (open.length > 1 ? "s" : "") + "." };
  }
  var claimed = related.filter(function(r){ return r.status === "claimed"; });
  var latest = claimed.reduce(function(best, r){
    var t = r.claimedAt || r.updatedAt || "";
    return (!best || t > (best.claimedAt || best.updatedAt || "")) ? r : best;
  }, null);
  return { tone: "good", text: "Fully fulfilled — last balance claimed " + fmtDateTime(latest.claimedAt || latest.updatedAt) + "." };
}

function buildPoPdfBlob(docNumber, party, logId){
  var jsPDFCtor = window.jspdf.jsPDF;
  var doc = new jsPDFCtor({ unit: "pt", format: "a4" });
  var margin = 40;
  var pageW = doc.internal.pageSize.getWidth();
  var pageH = doc.internal.pageSize.getHeight();
  // No PO/DR number means this was a walk-in sale — there's nothing to batch
  // by PO, so print just this one transaction rather than every no-PO sale
  // to the same customer name.
  var batch = docNumber ? computeStockOutBatch(docNumber, party) : state.log.filter(function(e){ return e.id === logId; });
  var y = margin;

  doc.setFont("helvetica", "bold"); doc.setFontSize(17); doc.setTextColor(20);
  doc.text("Sample Hardware Co.", margin, y); y += 12;
  doc.setDrawColor(181, 98, 42); doc.setLineWidth(1.5);
  doc.line(margin, y, pageW - margin, y); y += 24;

  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(110);
  doc.text("STOCK OUT SUMMARY — PO", margin, y);
  doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(181, 98, 42);
  doc.text("#" + (docNumber || "None"), pageW - margin, y, { align: "right" }); y += 22;

  var dateStr = batch.length ? fmtDateTime(batch[batch.length-1].ts) : fmtDateTime(new Date().toISOString());
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(20);
  doc.text("Customer: " + (party || "—"), margin, y);
  doc.text("Date: " + dateStr, pageW - margin, y, { align: "right" }); y += 18;

  var fulfillment = computePoFulfillmentNote(docNumber, party);
  if (fulfillment){
    var noteColor = fulfillment.tone === "warn" ? [181, 98, 42] : [46, 125, 50];
    doc.setFont("helvetica", "bold"); doc.setFontSize(9.5);
    doc.setTextColor(noteColor[0], noteColor[1], noteColor[2]);
    doc.text(fulfillment.text, margin, y); y += 16;
  }

  var tableOpts = pdfTableOpts(margin);
  if (!batch.length){
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(110);
    doc.text("No matching Stock Out entries found for this PO.", margin, y + 12);
  } else {
    doc.autoTable(Object.assign({}, tableOpts, {
      startY: y,
      head: [["Date", "SKU", "Item", "Qty", "Unit", "Unit Price", "Amount"]],
      body: batch.map(function(e){
        return [fmtDateTime(e.ts), e.sku, e.itemName, Math.abs(e.delta), e.unit || "", fmtMoneyPdf(e.unitPrice || 0), fmtMoneyPdf(Math.abs(e.value || 0))];
      }),
      columnStyles: { 5: { halign: "right" }, 6: { halign: "right" } }
    }));
    y = doc.lastAutoTable.finalY + 18;

    var totalQty = batch.reduce(function(sum, e){ return sum + Math.abs(e.delta); }, 0);
    var totalAmount = batch.reduce(function(sum, e){ return sum + Math.abs(e.value || 0); }, 0);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(90);
    doc.text("Total qty: " + totalQty + " across " + batch.length + (batch.length > 1 ? " deliveries" : " delivery"), pageW - margin, y, { align: "right" }); y += 15;
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(20);
    doc.text("Total amount: " + fmtMoneyPdf(totalAmount), pageW - margin, y, { align: "right" });
    y += 56;
  }

  if (y > pageH - 70){ doc.addPage(); y = margin + 30; }
  var colW = (pageW - margin * 2 - 40) / 2;
  doc.setDrawColor(150); doc.setLineWidth(0.75);
  doc.line(margin, y, margin + colW, y);
  doc.line(margin + colW + 40, y, pageW - margin, y);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(110);
  doc.text("Released by", margin, y + 12);
  doc.text("Received by", margin + colW + 40, y + 12);

  doc.setFontSize(8); doc.setTextColor(150);
  doc.text("Generated from Stockyard — for internal records, not an official receipt.", pageW / 2, pageH - 30, { align: "center" });

  return doc.output("blob");
}

function triggerPoPdfExport(docNumber, party, logId){
  if (!pdfLibReady()){
    pushToast("PDF export is still loading — give it a moment and try again.", true);
    return;
  }
  try {
    var blob = buildPoPdfBlob(docNumber, party, logId);
    var stamp = new Date().toISOString().slice(0,10);
    var filename = "Stockyard-PO-" + (docNumber || "None") + "-" + stamp + ".pdf";
    downloadBlob(blob, filename);
    pushToast("Downloaded " + filename);
  } catch(err){
    pushToast("Couldn’t build the PDF — " + (err && err.message ? err.message : "please try again") + ".", true);
  }
}

/* ============================= events ============================= */
function attachDynamicHandlers(){
  var search = document.getElementById("search-input");
  if (search){
    search.addEventListener("input", function(){
      ui.search = search.value;
      render();
    });
  }
}

document.addEventListener("click", function(e){
  (async function(){
    try {
      if (ui.exportOpen && !e.target.closest(".export-wrap")){
        ui.exportOpen = false;
        render();
      }
      if (ui.bulkMenuOpen && !e.target.closest(".bulk-wrap")){
        ui.bulkMenuOpen = false;
        render();
      }
      var t = e.target.closest("[data-action]");
      if (!t) return;
      var action = t.getAttribute("data-action");
      if (action === "stock-in") openStockMoveModal(t.getAttribute("data-id"), "in");
      else if (action === "stock-out") openStockMoveModal(t.getAttribute("data-id"), "out");
      else if (action === "claim-unclaimed"){
        var claimKind = t.getAttribute("data-kind") || "customer";
        openStockMoveModal(t.getAttribute("data-id"), claimKind === "supplier" ? "in" : "out", {
          party: t.getAttribute("data-customer"), docNumber: t.getAttribute("data-docnumber")
        });
      }
      else if (action === "close-stockmove") closeStockMoveModal();
      else if (action === "backdrop-sm"){ if (e.target === t) closeStockMoveModal(); }
      else if (action === "submit-stockmove") await submitStockMove();
      else if (action === "count") openCountModal(t.getAttribute("data-id"));
      else if (action === "close-count") closeCountModal();
      else if (action === "backdrop-count"){ if (e.target === t) closeCountModal(); }
      else if (action === "submit-count") await submitCount();
      else if (action === "damage") openDamageModal(t.getAttribute("data-id"));
      else if (action === "close-damage") closeDamageModal();
      else if (action === "backdrop-damage"){ if (e.target === t) closeDamageModal(); }
      else if (action === "submit-damage") await submitDamage();
      else if (action === "return") openReturnModal(t.getAttribute("data-id"), "in");
      else if (action === "set-return-direction"){ returnState.direction = t.getAttribute("data-direction"); render(); }
      else if (action === "close-return") closeReturnModal();
      else if (action === "backdrop-return"){ if (e.target === t) closeReturnModal(); }
      else if (action === "submit-return") await submitReturn();
      else if (action === "open-bulk-in") openBulkMoveModal("in");
      else if (action === "open-bulk-out") openBulkMoveModal("out");
      else if (action === "close-bulk") closeBulkMoveModal();
      else if (action === "backdrop-bulk"){ if (e.target === t) closeBulkMoveModal(); }
      else if (action === "set-bulk-direction"){ bulkMoveState.direction = t.getAttribute("data-direction"); render(); }
      else if (action === "add-bulk-row"){ bulkMoveState.rows.push({ sku:"", qty:"", orderedQty:"" }); render(); }
      else if (action === "pick-bulk-suggestion" && bulkMoveState){
        var pickRowIdx = parseInt(t.getAttribute("data-rowindex"), 10);
        var pickedSku = t.getAttribute("data-sku");
        if (bulkMoveState.rows[pickRowIdx]){
          bulkMoveState.rows[pickRowIdx].sku = pickedSku;
          var skuInput = document.querySelector('input[data-bulkfield="sku"][data-bulkrow="' + pickRowIdx + '"]');
          if (skuInput) skuInput.value = pickedSku;
          updateBulkRowHint(pickRowIdx);
          hideBulkSuggestions(pickRowIdx);
          var qtyInput = document.querySelector('input[data-bulkfield="qty"][data-bulkrow="' + pickRowIdx + '"]');
          if (qtyInput) qtyInput.focus();
        }
      }
      else if (action === "remove-bulk-row"){
        var rowIdx = parseInt(t.getAttribute("data-rowindex"), 10);
        bulkMoveState.rows.splice(rowIdx, 1);
        render();
      }
      else if (action === "submit-bulk") await submitBulkMove();
      else if (action === "open-add") openAddModal();
      else if (action === "edit-item") openEditModal(t.getAttribute("data-id"));
      else if (action === "close-modal") closeModal();
      else if (action === "backdrop"){ if (e.target === t) closeModal(); }
      else if (action === "save-item") await submitModal();
      else if (action === "ask-delete"){ modalState.confirmDelete = true; render(); }
      else if (action === "cancel-delete"){ modalState.confirmDelete = false; render(); }
      else if (action === "confirm-delete") await deleteItem(modalState.item.id);
      else if (action === "quick-delete"){
        var it = state.items.find(function(x){ return x.id === t.getAttribute("data-id"); });
        if (it){ openEditModal(it.id); modalState.confirmDelete = true; render(); }
      }
      else if (action === "set-filter"){ ui.filter = t.getAttribute("data-filter"); render(); }
      else if (action === "toggle-qty-sort"){
        ui.skuSort = "none";
        ui.qtySort = ui.qtySort === "none" ? "asc" : ui.qtySort === "asc" ? "desc" : "none";
        render();
      }
      else if (action === "toggle-sku-sort"){
        ui.qtySort = "none";
        ui.skuSort = ui.skuSort === "none" ? "asc" : ui.skuSort === "asc" ? "desc" : "none";
        render();
      }
      else if (action === "set-warehouse"){ ui.warehouse = t.getAttribute("data-warehouse"); render(); }
      else if (action === "toggle-cat"){
        var cat = t.getAttribute("data-cat");
        ui.collapsed[cat] = !ui.collapsed[cat];
        render();
      }
      else if (action === "set-view"){ ui.view = t.getAttribute("data-view"); ui.exportOpen = false; render(); }
      else if (action === "set-log-filter"){ ui.logFilter = t.getAttribute("data-filter"); render(); }
      else if (action === "set-unclaimed-status"){ ui.unclaimedStatusFilter = t.getAttribute("data-status"); render(); }
      else if (action === "delete-log"){
        ui.confirmDeleteLogId = t.getAttribute("data-logid");
        render();
      }
      else if (action === "cancel-delete-log"){
        ui.confirmDeleteLogId = null;
        render();
      }
      else if (action === "confirm-delete-log"){
        ui.confirmDeleteLogId = null;
        var delMsg = await deleteLogEntry(t.getAttribute("data-logid"));
        pushToast(delMsg);
      }
      else if (action === "print-po"){
        var poEntry = state.log.find(function(x){ return x.id === t.getAttribute("data-logid"); });
        if (poEntry) triggerPoPdfExport(poEntry.docNumber, poEntry.party, poEntry.id);
      }
      else if (action === "toggle-export-menu"){ ui.exportOpen = !ui.exportOpen; ui.bulkMenuOpen = false; render(); }
      else if (action === "toggle-bulk-menu"){ ui.bulkMenuOpen = !ui.bulkMenuOpen; ui.exportOpen = false; render(); }
      else if (action === "export-inventory-pdf"){ ui.exportOpen = false; render(); triggerInventoryPdfExport(); }
      else if (action === "export-inventory-csv"){ ui.exportOpen = false; render(); triggerInventoryCsvExport(); }
      else if (action === "export-log-pdf"){ ui.exportOpen = false; render(); triggerLogPdfExport(); }
      else if (action === "export-log-csv"){ ui.exportOpen = false; render(); triggerLogCsvExport(); }
      else if (action === "export-reorder-pdf"){ ui.exportOpen = false; render(); triggerReorderPdfExport(); }
      else if (action === "export-reorder-csv"){ ui.exportOpen = false; render(); triggerReorderCsvExport(); }
      else if (action === "export-deadstock-pdf"){ ui.exportOpen = false; render(); triggerDeadStockPdfExport(); }
      else if (action === "export-deadstock-csv"){ ui.exportOpen = false; render(); triggerDeadStockCsvExport(); }
      else if (action === "export-unclaimed-csv"){ ui.exportOpen = false; render(); triggerUnclaimedCsvExport("customer"); }
      else if (action === "export-unclaimed-supplier-csv"){ ui.exportOpen = false; render(); triggerUnclaimedCsvExport("supplier"); }
      else if (action === "export-returns-csv"){ ui.exportOpen = false; render(); triggerReturnsCsvExport(); }
      else if (action === "open-signin"){ e.preventDefault(); openSignInModal(); }
      else if (action === "close-signin") closeSignInModal();
      else if (action === "backdrop-auth"){ if (e.target === t) closeSignInModal(); }
      else if (action === "submit-signin") await submitSignIn();
      else if (action === "sign-out"){ await signOut(auth); pushToast("Signed out"); }
    } catch(err){
      pushToast("Something went wrong — " + (err && err.message ? err.message : "please try again") + ".", true);
    }
  })();
});

document.addEventListener("input", function(e){
  var t = e.target;
  if (t.matches && t.matches('input[data-smfield="docNumber"]') && /\D/.test(t.value)){
    var pos = t.selectionStart;
    var before = t.value;
    t.value = t.value.replace(/\D/g, "");
    var removedBefore = before.slice(0, pos).replace(/\D/g, "").length;
    t.setSelectionRange(removedBefore, removedBefore);
    if (stockMoveState) stockMoveState.docNumber = t.value;
  } else if (t.matches && t.matches('input[data-bulkfield="sku"]') && t.hasAttribute("data-bulkrow") && bulkMoveState){
    var skuRowIdx = parseInt(t.getAttribute("data-bulkrow"), 10);
    // Keep state live on every keystroke (not just on blur) so suggestions
    // and the hint text always reflect what's actually on screen.
    if (bulkMoveState.rows[skuRowIdx]) bulkMoveState.rows[skuRowIdx].sku = t.value;
    updateBulkSuggestions(skuRowIdx, t.value);
    updateBulkRowHint(skuRowIdx);
  }
});

document.addEventListener("focusout", function(e){
  var t = e.target;
  if (t.matches && t.matches('input[data-bulkfield="sku"]') && t.hasAttribute("data-bulkrow")){
    var rowIdx = parseInt(t.getAttribute("data-bulkrow"), 10);
    // Delay so a tap on a suggestion button still registers as a click
    // before the dropdown disappears out from under it.
    setTimeout(function(){ hideBulkSuggestions(rowIdx); }, 150);
  }
});

document.addEventListener("change", function(e){
  (async function(){
    try {
      var t = e.target;
      if (t.matches("input[data-field]")){
        await updateItemField(t.getAttribute("data-id"), t.getAttribute("data-field"), t.value);
      } else if (t.matches("input[data-mfield]") && modalState){
        var field = t.getAttribute("data-mfield");
        modalState.item[field] = t.value;
        if (field === "category" && modalState.mode === "add"){
          // patch just the SKU preview in place — a full render() here would
          // race with whatever field the user tabs into next and can clobber it
          var newSku = nextSku(t.value.trim());
          modalState.item.sku = newSku;
          var skuField = document.getElementById("field-sku");
          if (skuField) skuField.value = newSku;
        }
      } else if (t.matches("input[data-logfield]")){
        await updateLogField(t.getAttribute("data-logid"), t.getAttribute("data-logfield"), t.value);
      } else if (t.matches("input[data-smfield]") && stockMoveState){
        var smField = t.getAttribute("data-smfield");
        if (smField === "noDoc"){
          stockMoveState.noDoc = t.checked;
          if (stockMoveState.noDoc){ stockMoveState.docNumber = ""; stockMoveState.orderedQty = ""; }
          stockMoveState.error = "";
          render();
        } else {
          var smVal = t.value;
          if (smField === "docNumber" && /\D/.test(smVal)){
            smVal = smVal.replace(/\D/g, "");
            t.value = smVal;
          }
          stockMoveState[smField] = smVal;
        }
      } else if (t.matches("input[data-countfield]") && countState){
        countState[t.getAttribute("data-countfield")] = t.value;
      } else if (t.matches("input[data-damagefield]") && damageState){
        damageState[t.getAttribute("data-damagefield")] = t.value;
      } else if (t.matches("input[data-returnfield]") && returnState){
        var retField = t.getAttribute("data-returnfield");
        var retVal = t.value;
        if (retField === "docNumber" && /\D/.test(retVal)){
          retVal = retVal.replace(/\D/g, "");
          t.value = retVal;
        }
        returnState[retField] = retVal;
      } else if (t.matches("input[data-bulkfield]") && bulkMoveState){
        var bmField = t.getAttribute("data-bulkfield");
        var bmRow = t.getAttribute("data-bulkrow");
        if (bmRow !== null){
          bulkMoveState.rows[parseInt(bmRow, 10)][bmField] = t.value;
          if (bmField === "sku") updateBulkRowHint(parseInt(bmRow, 10)); // patch in place — a full render() here would race with whatever field the user tabs into next
        } else if (bmField === "noDoc"){
          bulkMoveState.noDoc = t.checked;
          if (bulkMoveState.noDoc) bulkMoveState.docNumber = "";
          bulkMoveState.error = "";
          render();
        } else {
          var bmVal = t.value;
          if (bmField === "docNumber" && /\D/.test(bmVal)){
            bmVal = bmVal.replace(/\D/g, "");
            t.value = bmVal;
          }
          bulkMoveState[bmField] = bmVal;
        }
      } else if (t.matches("input[data-authfield]") && signInState){
        signInState[t.getAttribute("data-authfield")] = t.value;
      }
    } catch(err){
      pushToast("Something went wrong — " + (err && err.message ? err.message : "please try again") + ".", true);
    }
  })();
});

document.addEventListener("keydown", function(e){
  if (e.key === "Escape" && modalState){ closeModal(); }
  if (e.key === "Escape" && stockMoveState){ closeStockMoveModal(); }
  if (e.key === "Escape" && returnState){ closeReturnModal(); }
  if (e.key === "Escape" && signInState){ closeSignInModal(); }
  if (e.key === "Escape" && bulkMoveState){ closeBulkMoveModal(); }
  if (e.key === "Enter" && signInState && document.activeElement && document.activeElement.matches("input[data-authfield]")){
    // Commit the just-typed value first — Enter can fire before a blur/change
    // event has synced it into signInState, which would submit a stale value.
    signInState[document.activeElement.getAttribute("data-authfield")] = document.activeElement.value;
    submitSignIn();
  }
  if (e.key === "Enter" && bulkMoveState && e.target && e.target.matches && e.target.matches("input[data-bulkfield]") && e.target.hasAttribute("data-bulkrow")){
    e.preventDefault();
    var rowIdx = parseInt(e.target.getAttribute("data-bulkrow"), 10);
    var field = e.target.getAttribute("data-bulkfield");
    // Commit the just-typed value first — Enter can fire before a blur/change
    // event has synced it into bulkMoveState, which would render from stale state.
    bulkMoveState.rows[rowIdx][field] = e.target.value;
    if (field === "sku") updateBulkRowHint(rowIdx);
    if (rowIdx === bulkMoveState.rows.length - 1){
      // Enter on the last row adds a new one and jumps straight to it —
      // so entering a long list never requires reaching for the mouse.
      bulkMoveState.rows.push({ sku:"", qty:"", orderedQty:"" });
      render();
      var newRow = document.querySelector('input[data-bulkfield="sku"][data-bulkrow="' + (bulkMoveState.rows.length - 1) + '"]');
      if (newRow){ newRow.focus(); newRow.scrollIntoView({ block:"center" }); }
    } else {
      // Enter mid-list moves to the same field on the next row.
      var nextField = document.querySelector('input[data-bulkfield="' + field + '"][data-bulkrow="' + (rowIdx + 1) + '"]');
      if (nextField){ nextField.focus(); nextField.select(); nextField.scrollIntoView({ block:"center" }); }
    }
  }
});

/* ============================= boot ============================= */
render();

onSnapshot(itemsCol, function(snap){
  state.items = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
  itemsLoaded = true;
  syncState = "synced";
  render();
}, function(err){
  syncState = "error";
  render();
});

onSnapshot(query(logCol, orderBy("ts", "desc")), function(snap){
  state.log = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
  logLoaded = true;
  syncState = "synced";
  render();
}, function(err){
  syncState = "error";
  render();
});

onSnapshot(unclaimedCol, function(snap){
  state.unclaimed = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
  render();
}, function(err){
  syncState = "error";
  render();
});

onAuthStateChanged(auth, function(user){
  currentUser = user;
  readOnly = !user;
  render();
});

/* exposed for the one-time seed helper (see seed.html) */
window.__stockyardInternals = { itemsCol: itemsCol, writeBatch: writeBatch, db: db, doc: doc };
