const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { db, DB_PATH, ROOT, safeOrder, transaction } = require('./lib/database');
const { bad, validateMenu, createOrder } = require('./lib/domain');

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

async function bodyOf(req) {
  let text = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw bad('Request body is too large.', 413);
    text += chunk;
  }
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw bad('Request body must be valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('Request body must be a JSON object.');
  }
  return body;
}

function numericId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw bad('Invalid record ID.');
  return id;
}

function staticFile(res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return json(res, 400, { error: 'Invalid URL path.' });
  }
  if (pathname === '/') pathname = '/index.html';
  const publicDir = path.resolve(ROOT, 'public');
  const file = path.resolve(publicDir, pathname.slice(1));
  if (!file.startsWith(publicDir + path.sep)) return json(res, 403, { error: 'Forbidden.' });
  fs.readFile(file, (error, data) => {
    if (error) return json(res, 404, { error: 'Page not found.' });
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
    };
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  });
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const { pathname: route } = url;
    const method = req.method;

    if (!route.startsWith('/api/')) return staticFile(res, url);
    if (method === 'GET' && route === '/api/health') return json(res, 200, { status: 'ok' });
    if (method === 'GET' && route === '/api/config') {
      const rate = Number(process.env.TAX_RATE_BPS || 0);
      if (!Number.isInteger(rate) || rate < 0 || rate > 10000) throw bad('Server tax configuration is invalid.', 500);
      return json(res, 200, {
        restaurantName: process.env.RESTAURANT_NAME || 'The Green Fork',
        phone: process.env.RESTAURANT_PHONE || '',
        taxRateBps: rate,
      });
    }
    if (method === 'GET' && route === '/api/dashboard') {
      const today = new Date().toISOString().slice(0, 10);
      const stats = db.prepare(`
        SELECT COUNT(*) AS total_orders,
          COALESCE(SUM(CASE WHEN status = 'Completed' AND date(created_at) = ? THEN 1 ELSE 0 END), 0) AS completed_today,
          COALESCE(SUM(CASE WHEN payment_status = 'Paid' AND date(created_at) = ? THEN total_paise ELSE 0 END), 0) AS sales_today_paise,
          COALESCE(SUM(CASE WHEN status IN ('Pending', 'Preparing', 'Ready') THEN 1 ELSE 0 END), 0) AS pending_orders
        FROM orders
      `).get(today, today);
      return json(res, 200, stats);
    }
    if (method === 'GET' && route === '/api/menu') {
      const query = (url.searchParams.get('q') || '').slice(0, 100);
      const category = url.searchParams.get('category');
      const available = url.searchParams.get('available');
      if (available !== null && !['0', '1'].includes(available)) throw bad('Availability filter must be 0 or 1.');
      const items = db.prepare(`
        SELECT * FROM menu_items
        WHERE name LIKE ? AND (? IS NULL OR category = ?) AND (? IS NULL OR available = ?)
        ORDER BY category, name
      `).all(`%${query}%`, category, category, available, available === null ? null : Number(available));
      return json(res, 200, items);
    }
    if (method === 'POST' && route === '/api/menu') {
      const item = validateMenu(await bodyOf(req));
      const result = db.prepare(`
        INSERT INTO menu_items(name, description, category, price_paise, available) VALUES (?, ?, ?, ?, ?)
      `).run(item.name, item.description, item.category, item.price_paise, item.available);
      return json(res, 201, db.prepare('SELECT * FROM menu_items WHERE id = ?').get(Number(result.lastInsertRowid)));
    }

    let match = route.match(/^\/api\/menu\/(\d+)$/);
    if (match && method === 'PUT') {
      const id = numericId(match[1]);
      if (!db.prepare('SELECT id FROM menu_items WHERE id = ?').get(id)) throw bad('Menu item not found.', 404);
      const item = validateMenu(await bodyOf(req), id);
      db.prepare(`
        UPDATE menu_items SET name = ?, description = ?, category = ?, price_paise = ?, available = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(item.name, item.description, item.category, item.price_paise, item.available, id);
      return json(res, 200, db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id));
    }
    if (method === 'POST' && route === '/api/orders') {
      const result = createOrder(await bodyOf(req), req.headers['idempotency-key']);
      return json(res, result.replayed ? 200 : 201, result.order);
    }
    if (method === 'GET' && route === '/api/orders') {
      const query = (url.searchParams.get('q') || '').slice(0, 100);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const orders = db.prepare(`
        SELECT * FROM orders WHERE CAST(id AS TEXT) LIKE ? OR customer_name LIKE ?
        ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(`%${query}%`, `%${query}%`, limit);
      return json(res, 200, orders);
    }

    match = route.match(/^\/api\/orders\/(\d+)$/);
    if (match && method === 'GET') {
      const order = safeOrder(numericId(match[1]));
      return order ? json(res, 200, order) : json(res, 404, { error: 'Order not found.' });
    }
    match = route.match(/^\/api\/orders\/(\d+)\/status$/);
    if (match && method === 'PATCH') {
      const id = numericId(match[1]);
      const { status } = await bodyOf(req);
      const order = safeOrder(id);
      if (!order) throw bad('Order not found.', 404);
      const transitions = {
        Pending: ['Preparing', 'Cancelled'],
        Preparing: ['Ready', 'Cancelled'],
        Ready: ['Completed', 'Cancelled'],
        Completed: [],
        Cancelled: [],
      };
      if (!transitions[order.status]?.includes(status)) throw bad(`Cannot change order status from ${order.status} to ${status}.`);
      db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
      return json(res, 200, safeOrder(id));
    }
    match = route.match(/^\/api\/orders\/(\d+)\/payment$/);
    if (match && method === 'POST') {
      const id = numericId(match[1]);
      const { method: paymentMethod } = await bodyOf(req);
      const result = transaction(() => {
        const order = safeOrder(id);
        if (!order) throw bad('Order not found.', 404);
        if (order.status === 'Cancelled') throw bad('Cancelled orders cannot be paid.');
        if (order.payment_status === 'Paid') throw bad('This order has already been paid.', 409);
        if (!['Cash', 'UPI', 'Card'].includes(paymentMethod)) throw bad('Payment method must be Cash, UPI, or Card.');
        db.prepare('INSERT INTO payments(order_id, amount_paise, method) VALUES (?, ?, ?)')
          .run(id, order.total_paise, paymentMethod);
        db.prepare("UPDATE orders SET payment_status = 'Paid', updated_at = datetime('now') WHERE id = ?")
          .run(id);
        return safeOrder(id);
      });
      return json(res, 200, result);
    }
    return json(res, 404, { error: 'API route not found.' });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error(error);
    return json(res, status, { error: status === 500 ? 'An unexpected server error occurred.' : error.message });
  }
}

const server = http.createServer(handle);
if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`Restaurant Billing running at http://${host}:${port} (SQLite: ${DB_PATH})`));
}

module.exports = { server, db, DB_PATH };
