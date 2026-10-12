const $ = (s) => document.querySelector(s),
  content = $("#content"),
  notice = $("#notice");
const state = {
  cart: [],
  menu: [],
  idempotencyKey: null,
  config: { restaurantName: "The Green Fork", phone: "", taxRateBps: 0 },
};
const money = (paise) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(
    (paise || 0) / 100,
  );
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const api = async (path, options = {}) => {
  const res = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || `Request failed (${res.status})`);
  return data;
};
const notify = (msg, error = false) => {
  notice.textContent = msg;
  notice.className = "notice" + (error ? " error" : "");
  notice.style.display = "block";
  clearTimeout(notify.t);
  notify.t = setTimeout(() => (notice.style.display = "none"), 4500);
};
const badge = (s) =>
  `<span class="badge badge-${esc(String(s).toLowerCase())}">${esc(s)}</span>`;
const page = () => location.hash.slice(1).split("/")[0] || "dashboard";
function nav() {
  const p = page();
  document
    .querySelectorAll(".nav-link")
    .forEach((a) =>
      a.classList.toggle(
        "active",
        a.dataset.page === p ||
          (p === "receipt" && a.dataset.page === "orders"),
      ),
    );
  const names = {
    dashboard: "Overview",
    "new-order": "New order",
    menu: "Menu management",
    orders: "Order history",
    receipt: "Order receipt",
  };
  $("#page-title").textContent = names[p] || "Overview";
}
async function load() {
  nav();
  content.innerHTML = '<div class="loading" role="status">Loading…</div>';
  try {
    switch (page()) {
      case "dashboard":
        await dashboard();
        break;
      case "menu":
        await menuPage();
        break;
      case "new-order":
        await orderPage();
        break;
      case "orders":
        await historyPage();
        break;
      case "receipt":
        await receiptPage(Number(location.hash.split("/")[1]));
        break;
      default:
        location.hash = "#dashboard";
    }
  } catch (e) {
    content.innerHTML = `<div class="panel empty"><strong>Could not load this page</strong>${esc(e.message)}<p><button class="button button-light" onclick="load()">Try again</button></p></div>`;
  }
}
const empty = (title, sub) =>
  `<div class="empty"><strong>${title}</strong>${sub}</div>`;
async function dashboard() {
  const [d, orders] = await Promise.all([
    api("/dashboard"),
    api("/orders?limit=6"),
  ]);
  content.innerHTML = `<div class="stats"><article class="stat"><div class="stat-top">All orders <span class="stat-icon">◷</span></div><strong>${d.total_orders || 0}</strong><small>Orders recorded</small></article><article class="stat"><div class="stat-top">Completed today <span class="stat-icon">✓</span></div><strong>${d.completed_today || 0}</strong><small>Completed orders</small></article><article class="stat"><div class="stat-top">Paid sales today <span class="stat-icon">₹</span></div><strong>${money(d.sales_today_paise)}</strong><small>Payments recorded today</small></article><article class="stat"><div class="stat-top">Active orders <span class="stat-icon">⌁</span></div><strong>${d.pending_orders || 0}</strong><small>Pending, preparing or ready</small></article></div><div class="grid-2"><div class="panel"><div class="panel-title"><h3>Recent orders</h3><a class="text-link" href="#orders">View all →</a></div>${orders.length ? `<div class="table-wrap"><table><thead><tr><th>ORDER</th><th>TYPE</th><th>DATE</th><th>STATUS</th><th>TOTAL</th></tr></thead><tbody>${orders.map((o) => `<tr><td><a class="id-link" href="#receipt/${o.id}">#${o.id}</a></td><td>${esc(o.order_type)}${o.table_number ? " · " + esc(o.table_number) : ""}</td><td>${new Date(o.created_at + "Z").toLocaleDateString()}</td><td>${badge(o.status)}</td><td>${money(o.total_paise)}</td></tr>`).join("")}</tbody></table></div>` : empty("No orders yet", "Create an order to get started.")}</div><div class="panel"><div class="panel-title"><h3>Quick actions</h3></div><div class="quick-actions"><a class="quick-action" href="#new-order">Start a new order <span>↗</span></a><a class="quick-action" href="#menu">Manage the menu <span>↗</span></a><a class="quick-action" href="#orders">Search order history <span>↗</span></a></div></div></div>`;
}
async function menuPage() {
  const items = await api("/menu"),
    categories = [...new Set(items.map((i) => i.category))];
  content.innerHTML = `<div class="page-head"><div><h2>Menu items</h2><div class="subtle">Manage dishes, pricing, and availability.</div></div><button class="button button-dark" onclick="menuModal()">＋ Add item</button></div><div class="toolbar"><input id="menu-search" class="search" placeholder="Search items…"><select id="menu-category" class="select"><option value="">All categories</option>${categories.map((c) => `<option>${esc(c)}</option>`).join("")}</select><select id="menu-availability" class="select"><option value="">All availability</option><option value="1">Available</option><option value="0">Unavailable</option></select></div><div id="menu-list" class="menu-grid"></div>`;
  state.menu = items;
  $("#menu-search").oninput = renderMenu;
  $("#menu-category").onchange = renderMenu;
  $("#menu-availability").onchange = renderMenu;
  renderMenu();
}
function renderMenu() {
  const q = $("#menu-search").value.toLowerCase(),
    cat = $("#menu-category").value,
    av = $("#menu-availability").value;
  const list = state.menu.filter(
    (i) =>
      i.name.toLowerCase().includes(q) &&
      (!cat || i.category === cat) &&
      (av === "" || String(i.available) === av),
  );
  $("#menu-list").innerHTML = list.length
    ? list
        .map(
          (i) =>
            `<article class="menu-card"><div class="menu-card-foot"><span class="category-pill">${esc(i.category)}</span>${i.available ? '<span class="badge badge-ready">Available</span>' : '<span class="badge">Unavailable</span>'}</div><h3>${esc(i.name)}</h3><p>${esc(i.description || "No description")}</p><div class="menu-card-foot"><span class="price">${money(i.price_paise)}</span><button class="button button-outline" onclick="menuModal(${i.id})">Edit</button></div></article>`,
        )
        .join("")
    : empty("No menu items found", "Try another search or add a menu item.");
}
function menuModal(id) {
  const item = id
    ? state.menu.find((x) => x.id === id)
    : {
        name: "",
        description: "",
        category: "Main course",
        price_paise: 0,
        available: true,
      };
  $("#modal-root").innerHTML =
    `<div class="modal-backdrop" onclick="if(event.target===this)closeModal()"><form class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onsubmit="saveMenu(event,${id || "null"})"><h2 id="modal-title">${id ? "Edit menu item" : "Add menu item"}</h2><div class="form-group"><label for="m-name">Name</label><input class="field" id="m-name" name="name" maxlength="100" required value="${esc(item.name)}"></div><div class="form-group" style="margin-top:10px"><label for="m-desc">Description</label><input class="field" id="m-desc" name="description" maxlength="500" value="${esc(item.description)}"></div><div class="form-row" style="margin-top:10px"><div class="form-group"><label for="m-cat">Category</label><input id="m-cat" name="category" maxlength="50" required value="${esc(item.category)}"></div><div class="form-group"><label for="m-price">Price (₹)</label><input id="m-price" name="price" type="number" min="0" step="0.01" required value="${(item.price_paise / 100).toFixed(2)}"></div></div><label class="subtle"><input name="available" type="checkbox" ${item.available ? "checked" : ""}> Available to order</label><div class="modal-actions"><button type="button" class="button button-outline" onclick="closeModal()">Cancel</button><button class="button button-dark">Save item</button></div></form></div>`;
  $("#m-name").focus();
}
async function saveMenu(e, id) {
  e.preventDefault();
  const f = new FormData(e.currentTarget),
    payload = {
      name: f.get("name"),
      description: f.get("description"),
      category: f.get("category"),
      price: Number(f.get("price")),
      available: f.has("available"),
    };
  try {
    await api(id ? `/menu/${id}` : "/menu", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    closeModal();
    notify("Menu item saved.");
    await menuPage();
  } catch (err) {
    notify(err.message, true);
  }
}
function closeModal() {
  $("#modal-root").innerHTML = "";
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#modal-root").innerHTML) closeModal();
});
async function orderPage() {
  const items = await api("/menu?available=1");
  state.menu = items;
  state.cart = [];
  state.idempotencyKey = crypto.randomUUID();
  content.innerHTML = `<div class="page-head"><div><h2>Build an order</h2><div class="subtle">Choose items, set quantities, then review the bill.</div></div></div><div class="order-layout"><div class="panel"><div class="order-tools"><input class="search" id="item-search" placeholder="Search available dishes…"><select class="select" id="item-cat"><option value="">All categories</option>${[...new Set(items.map((i) => i.category))].map((c) => `<option>${esc(c)}</option>`).join("")}</select></div><div id="item-list" class="item-list"></div></div><form class="panel cart-panel" id="checkout" onsubmit="submitOrder(event)"><div class="panel-title"><h3>Order details</h3><span class="badge">NEW</span></div><div class="form-row"><div class="form-group"><label for="o-type">Order type</label><select id="o-type" onchange="toggleTable()"><option>Dine in</option><option>Takeaway</option></select></div><div class="form-group" id="table-field"><label for="o-table">Table number</label><input id="o-table" maxlength="20" required placeholder="e.g. 04"></div></div><div class="form-group"><label for="o-customer">Customer name <span class="muted">(optional)</span></label><input id="o-customer" maxlength="100" placeholder="Name for the order"></div><div id="cart-items" class="cart-items"></div><div id="cart-total" class="totals"></div><button class="button button-dark wide" id="submit-order">Create order & open bill →</button></form></div>`;
  $("#item-search").oninput = renderItems;
  $("#item-cat").onchange = renderItems;
  renderItems();
  renderCart();
}
function renderItems() {
  const q = $("#item-search").value.toLowerCase(),
    cat = $("#item-cat").value;
  const list = state.menu.filter(
    (i) => i.name.toLowerCase().includes(q) && (!cat || cat === i.category),
  );
  $("#item-list").innerHTML = list.length
    ? list
        .map(
          (i) =>
            `<article class="add-card"><div><h4>${esc(i.name)}</h4><small>${esc(i.category)} · ${money(i.price_paise)}</small></div><button type="button" class="button button-light" onclick="addItem(${i.id})" aria-label="Add ${esc(i.name)}">＋ Add</button></article>`,
        )
        .join("")
    : empty("No available items", "Add items in Menu management first.");
}
function addItem(id) {
  const item = state.menu.find((i) => i.id === id),
    line = state.cart.find((x) => x.id === id);
  if (line) {
    if (line.quantity >= 99) return notify("Maximum quantity is 99.", true);
    line.quantity++;
  } else state.cart.push({ ...item, quantity: 1 });
  renderCart();
}
function adjust(id, delta) {
  const item = state.cart.find((x) => x.id === id);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity < 1) state.cart = state.cart.filter((x) => x.id !== id);
  else if (item.quantity > 99) item.quantity = 99;
  renderCart();
}
function renderCart() {
  const box = $("#cart-items");
  if (!box) return;
  box.innerHTML = state.cart.length
    ? state.cart
        .map(
          (i) =>
            `<div class="cart-line"><div><div class="cart-line-name">${esc(i.name)}</div><div class="cart-line-price">${money(i.price_paise)} × ${i.quantity} · ${money(i.price_paise * i.quantity)}</div></div><div class="qty"><button type="button" aria-label="Decrease ${esc(i.name)} quantity" onclick="adjust(${i.id},-1)">−</button><b>${i.quantity}</b><button type="button" aria-label="Increase ${esc(i.name)} quantity" onclick="adjust(${i.id},1)">+</button></div></div>`,
        )
        .join("")
    : empty("Your cart is empty", "Add an item from the menu to begin.");
  const subtotal = state.cart.reduce(
      (n, i) => n + i.price_paise * i.quantity,
      0,
    ),
    tax = Math.round((subtotal * state.config.taxRateBps) / 10000);
  $("#cart-total").innerHTML =
    `<div class="total-row"><span>Subtotal</span><b>${money(subtotal)}</b></div>${tax ? `<div class="total-row"><span>Tax (${(state.config.taxRateBps / 100).toFixed(2)}%)</span><b>${money(tax)}</b></div>` : ""}<div class="total-row grand"><span>Total</span><b>${money(subtotal + tax)}</b></div>`;
  $("#submit-order").disabled = !state.cart.length;
}
function toggleTable() {
  const dine = $("#o-type").value === "Dine in";
  $("#table-field").style.display = dine ? "grid" : "none";
  $("#o-table").required = dine;
}
async function submitOrder(e) {
  e.preventDefault();
  if (!state.cart.length) return;
  const btn = $("#submit-order");
  btn.disabled = true;
  btn.textContent = "Saving order…";
  try {
    const order = await api("/orders", {
      method: "POST",
      headers: { "Idempotency-Key": state.idempotencyKey },
      body: JSON.stringify({
        order_type: $("#o-type").value,
        table_number:
          $("#o-type").value === "Dine in" ? $("#o-table").value : null,
        customer_name: $("#o-customer").value,
        items: state.cart.map((i) => ({
          menu_item_id: i.id,
          quantity: i.quantity,
        })),
      }),
    });
    state.cart = [];
    notify(`Order #${order.id} created.`);
    location.hash = `#receipt/${order.id}`;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Create order & open bill →";
    notify(err.message, true);
  }
}
async function historyPage() {
  content.innerHTML = `<div class="page-head"><div><h2>Order history</h2><div class="subtle">Browse and reopen previous bills.</div></div></div><div class="toolbar"><input id="history-search" class="search" placeholder="Search order number or customer…"></div><div class="panel"><div id="history-list"></div></div>`;
  const field = $("#history-search");
  let timer;
  const refresh = async () => {
    const rows = await api("/orders?q=" + encodeURIComponent(field.value));
    $("#history-list").innerHTML = rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>ORDER</th><th>DATE & TIME</th><th>CUSTOMER</th><th>TYPE</th><th>STATUS</th><th>PAYMENT</th><th>TOTAL</th><th></th></tr></thead><tbody>${rows.map((o) => `<tr><td><a class="id-link" href="#receipt/${o.id}">#${o.id}</a></td><td>${new Date(o.created_at + "Z").toLocaleString()}</td><td>${esc(o.customer_name || "—")}</td><td>${esc(o.order_type)}${o.table_number ? " · " + esc(o.table_number) : ""}</td><td>${badge(o.status)}</td><td>${badge(o.payment_status)}</td><td>${money(o.total_paise)}</td><td><a class="text-link" href="#receipt/${o.id}">View bill →</a></td></tr>`).join("")}</tbody></table></div>`
      : empty("No matching orders", "Orders appear here after checkout.");
  };
  field.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => refresh().catch((error) => notify(error.message, true)),
      180,
    );
  };
  await refresh();
}
async function receiptPage(id) {
  if (!Number.isSafeInteger(id) || id < 1)
    throw Error("This order number is invalid.");
  const order = await api(`/orders/${id}`),
    cfg = state.config;
  const date = new Date(order.created_at + "Z");
  content.innerHTML = `<div class="page-head no-print"><div><h2>Order #${order.id}</h2><div class="subtle">Review the bill, update status, or record payment.</div></div><a href="#orders" class="button button-outline">← Order history</a></div><div class="receipt"><div class="receipt-head"><h2>${esc(cfg.restaurantName)}</h2>${cfg.phone ? `<p>${esc(cfg.phone)}</p>` : ""}<p>Restaurant receipt</p></div><div class="receipt-meta"><div><span>Order</span><br><strong>#${order.id}</strong></div><div><span>Date & time</span><br><strong>${date.toLocaleString()}</strong></div><div><span>Order type</span><br><strong>${esc(order.order_type)}${order.table_number ? " · Table " + esc(order.table_number) : ""}</strong></div><div><span>Customer</span><br><strong>${esc(order.customer_name || "—")}</strong></div><div><span>Status</span><br>${badge(order.status)}</div><div><span>Payment</span><br>${badge(order.payment_status)}${order.payment ? " · " + esc(order.payment.method) : ""}</div></div><table class="receipt-items"><thead><tr><th>ITEM</th><th>QTY</th><th>PRICE</th><th>AMOUNT</th></tr></thead><tbody>${order.items.map((i) => `<tr><td>${esc(i.name)}</td><td>${i.quantity}</td><td>${money(i.unit_price_paise)}</td><td>${money(i.line_total_paise)}</td></tr>`).join("")}</tbody></table><div class="totals"><div class="total-row"><span>Subtotal</span><b>${money(order.subtotal_paise)}</b></div>${order.tax_paise ? `<div class="total-row"><span>Tax</span><b>${money(order.tax_paise)}</b></div>` : ""}<div class="total-row grand"><span>Grand total</span><b>${money(order.total_paise)}</b></div></div><div class="receipt-actions"><button class="button button-outline" onclick="window.print()">Print receipt</button>${order.payment_status === "Unpaid" && order.status !== "Cancelled" ? `<button class="button button-dark" onclick="paymentModal(${order.id})">Record payment</button>` : ""}</div><div class="receipt-actions no-print"><label class="subtle" for="order-status">Order status</label><select id="order-status" class="status-select" onchange="updateStatus(${order.id},this.value,this)">${["Pending", "Preparing", "Ready", "Completed", "Cancelled"].map((s) => `<option ${s === order.status ? "selected" : ""}>${s}</option>`)}</select></div></div>`;
}
async function updateStatus(id, status, el) {
  if (
    status === "Cancelled" &&
    !window.confirm(`Cancel order #${id}? This action cannot be reversed.`)
  ) {
    await receiptPage(id);
    return;
  }
  try {
    await api(`/orders/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    notify("Order status updated.");
    await receiptPage(id);
  } catch (e) {
    notify(e.message, true);
    await receiptPage(id);
  }
}
function paymentModal(id) {
  $("#modal-root").innerHTML =
    `<div class="modal-backdrop" onclick="if(event.target===this)closeModal()"><form class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onsubmit="recordPayment(event,${id})"><h2 id="modal-title">Record payment</h2><p class="subtle">Select how the customer paid. This records the payment against order #${id}.</p><div class="form-group"><label for="pay-method">Payment method</label><select id="pay-method"><option>Cash</option><option>UPI</option><option>Card</option></select></div><div class="modal-actions"><button type="button" class="button button-outline" onclick="closeModal()">Cancel</button><button class="button button-dark">Confirm payment</button></div></form></div>`;
  $("#pay-method").focus();
}
async function recordPayment(e, id) {
  e.preventDefault();
  try {
    await api(`/orders/${id}/payment`, {
      method: "POST",
      body: JSON.stringify({ method: $("#pay-method").value }),
    });
    closeModal();
    notify("Payment recorded.");
    await receiptPage(id);
  } catch (err) {
    notify(err.message, true);
  }
}
window.addEventListener("hashchange", load);
document.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (a && a.hash === location.hash) {
    setTimeout(load, 0);
  }
});
(async () => {
  try {
    state.config = await api("/config");
    $("#brand-name").textContent = state.config.restaurantName;
    await load();
  } catch (e) {
    content.innerHTML = `<div class="panel empty"><strong>Could not connect to the application</strong>${esc(e.message)}<p>Start the server with <code>npm start</code> and refresh.</p></div>`;
  }
})();
