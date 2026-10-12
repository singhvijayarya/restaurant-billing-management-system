const { createHash } = require('node:crypto');
const { db, safeOrder, transaction } = require('./database');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function validateMenu(input, currentId) {
  const { name, description = '', category, price, available = true } = input;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    throw bad('Name is required and must be at most 100 characters.');
  }
  if (typeof category !== 'string' || !category.trim() || category.trim().length > 50) {
    throw bad('Category is required and must be at most 50 characters.');
  }
  if (typeof description !== 'string' || description.length > 500) {
    throw bad('Description must be at most 500 characters.');
  }
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 9999999999.99 || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(String(price))) {
    throw bad('Price must be a non-negative amount with at most two decimal places.');
  }
  if (typeof available !== 'boolean') throw bad('Availability must be true or false.');
  const duplicate = db.prepare('SELECT id FROM menu_items WHERE name = ? COLLATE NOCASE AND id != ?').get(name.trim(), currentId || 0);
  if (duplicate) throw bad('A menu item with that name already exists.', 409);
  const [whole, fraction = ''] = String(price).split('.');
  return {
    name: name.trim(),
    description: description.trim(),
    category: category.trim(),
    price_paise: Number(whole) * 100 + Number(fraction.padEnd(2, '0')),
    available: Number(available),
  };
}

function orderRequest(input) {
  if (!Array.isArray(input.items) || input.items.length === 0) throw bad('Add at least one item to the order.');
  if (input.items.length > 50) throw bad('An order can contain at most 50 distinct items.');
  const type = input.order_type || 'Dine in';
  if (!['Dine in', 'Takeaway'].includes(type)) throw bad('Order type must be Dine in or Takeaway.');
  const table = input.table_number == null ? '' : String(input.table_number).trim();
  if (type === 'Dine in' && (!table || table.length > 20)) {
    throw bad('Enter a table number (up to 20 characters) for dine-in orders.');
  }
  const customer = input.customer_name == null ? '' : String(input.customer_name).trim();
  if (customer.length > 100) throw bad('Customer name must be at most 100 characters.');
  const requestedItems = input.items.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw bad('Each order item must be an object.');
    const menuId = Number(row.menu_item_id);
    const quantity = Number(row.quantity);
    if (!Number.isSafeInteger(menuId) || menuId < 1) throw bad('Invalid menu item.');
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) throw bad('Quantity must be between 1 and 99.');
    return { menuId, quantity };
  });
  if (new Set(requestedItems.map(item => item.menuId)).size !== requestedItems.length) {
    throw bad('Each menu item may appear only once; update its quantity instead.');
  }
  return { type, table: type === 'Dine in' ? table : null, customer, requestedItems };
}

function createOrder(input, idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
    throw bad('A valid Idempotency-Key header is required.');
  }
  const request = orderRequest(input);
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const existing = db.prepare('SELECT request_hash, order_id FROM idempotency_keys WHERE key = ?').get(idempotencyKey);
  if (existing) {
    if (existing.request_hash !== requestHash) throw bad('This idempotency key was already used for a different order.', 409);
    return { order: safeOrder(existing.order_id), replayed: true };
  }

  const items = request.requestedItems.map(({ menuId, quantity }) => {
    const item = db.prepare('SELECT id, name, price_paise, available FROM menu_items WHERE id = ?').get(menuId);
    if (!item) throw bad(`Menu item ${menuId} does not exist.`, 404);
    if (!item.available) throw bad(`${item.name} is unavailable and cannot be ordered.`);
    const lineTotal = item.price_paise * quantity;
    if (!Number.isSafeInteger(lineTotal)) throw bad('Order total is too large.');
    return { ...item, quantity, line_total_paise: lineTotal };
  });
  const subtotal = items.reduce((sum, item) => sum + item.line_total_paise, 0);
  if (!Number.isSafeInteger(subtotal)) throw bad('Order total is too large.');
  const rate = Number(process.env.TAX_RATE_BPS || 0);
  if (!Number.isInteger(rate) || rate < 0 || rate > 10000) throw bad('Server tax configuration is invalid.', 500);
  const tax = Number((BigInt(subtotal) * BigInt(rate) + 5000n) / 10000n);
  const total = subtotal + tax;
  if (!Number.isSafeInteger(total)) throw bad('Order total is too large.');

  const order = transaction(() => {
    const duplicate = db.prepare('SELECT request_hash, order_id FROM idempotency_keys WHERE key = ?').get(idempotencyKey);
    if (duplicate) {
      if (duplicate.request_hash !== requestHash) throw bad('This idempotency key was already used for a different order.', 409);
      return safeOrder(duplicate.order_id);
    }
    const result = db.prepare(`
      INSERT INTO orders(customer_name, order_type, table_number, subtotal_paise, tax_paise, total_paise)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(request.customer, request.type, request.table, subtotal, tax, total);
    const orderId = Number(result.lastInsertRowid);
    const insertItem = db.prepare(`
      INSERT INTO order_items(order_id, menu_item_id, name_snapshot, unit_price_paise, quantity, line_total_paise)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insertItem.run(orderId, item.id, item.name, item.price_paise, item.quantity, item.line_total_paise);
    }
    db.prepare('INSERT INTO idempotency_keys(key, request_hash, order_id) VALUES (?, ?, ?)')
      .run(idempotencyKey, requestHash, orderId);
    return safeOrder(orderId);
  });
  return { order, replayed: false };
}

module.exports = { bad, validateMenu, createOrder };
