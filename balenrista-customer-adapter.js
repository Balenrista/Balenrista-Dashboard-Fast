/**
 * Balenrista Customer Adapter
 * Public storefront data is served only by the dedicated customer-api Edge Function.
 * Admin AI remains the source of truth; this adapter contains no menu/modifier master data.
 */
(function (global) {
  "use strict";

  const config = { apiUrl: "", anonKey: "" };

  function configure(options) {
    options = options || {};
    config.apiUrl = String(options.apiUrl || "").replace(/\/+$/, "");
    config.anonKey = String(options.anonKey || "").trim();
    if (!config.apiUrl || !config.anonKey) {
      throw new Error("กรุณาตั้งค่า Supabase URL และ Public Publishable Key");
    }
    return true;
  }

  async function request(path, options = {}) {
    if (!config.apiUrl || !config.anonKey) {
      throw new Error("Customer API ยังไม่ได้ตั้งค่า");
    }
    const response = await fetch(
      `${config.apiUrl}/functions/v1/customer-api/${path.replace(/^\/+/, "")}`,
      {
        method: options.method || "GET",
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          Accept: "application/json",
          ...(options.headers || {}),
        },
        cache: "no-store",
        body: options.body,
      }
    );
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { throw new Error(`Customer API ส่งข้อมูลไม่ใช่ JSON (HTTP ${response.status})`); }
    if (!response.ok || data.success === false) {
      throw new Error(data.message || data.error || `Customer API HTTP ${response.status}`);
    }
    return data;
  }

  const adapter = {
    configure,
    configureMenuRead: configure,

    async loadMenuCatalog() {
      const data = await request("/catalog");
      if (!Array.isArray(data.menus) || !data.modifiers) {
        throw new Error("รูปแบบ Catalog จาก Customer API ไม่ครบ");
      }
      const menus = data.menus.map((row) => ({
        id: row.id,
        name: row.name,
        loyverseName: row.name,
        thaiName: row.name,
        price: Number(row.sale_price || 0),
        sale_price: Number(row.sale_price || 0),
        category: String(row.category || "อื่นๆ").trim(),
        ingredients: String(row.ingredients || ""),
        image: String(row.image || ""),
        menu_images: Array.isArray(row.menu_images) ? row.menu_images : [],
        is_active: row.is_active === true,
      }));
      return {
        source: "customer-api",
        updated: true,
        generated_at: data.generated_at,
        menus,
        categories: Array.isArray(data.categories) ? data.categories : [],
        modifiers: data.modifiers,
      };
    },

    async loadStoreStatus() {
      return request("/store-status");
    },

    // Order history is private: the Customer API verifies this LINE ID Token
    // and returns only orders belonging to the authenticated LINE customer.
    async loadOrderHistory(idToken) {
      const token = String(idToken || "").trim();
      if (!token) {
        throw new Error("ไม่พบ LINE ID Token กรุณาเข้าสู่ระบบ LINE ใหม่");
      }
      return request("/history", {
        method: "GET",
        headers: {
          "X-Line-ID-Token": token
        }
      });
    },

    // Submit uses a dedicated server function. Identity and phone are loaded from the verified LINE member record.
    async submitOrder(input) {
      input = input || {};
      const liff = input.liff;
      if (!liff || typeof liff.isLoggedIn !== "function" || !liff.isLoggedIn()) {
        throw new Error("กรุณาเข้าสู่ระบบ LINE ก่อนสั่งซื้อ");
      }
      const idToken = typeof liff.getIDToken === "function" ? liff.getIDToken() : "";
      if (!idToken) throw new Error("ไม่พบ LINE ID Token กรุณาเข้าสู่ระบบ LINE ใหม่");
      const idempotencyKey = String(input.idempotencyKey || "").trim();
      if (!idempotencyKey) throw new Error("ไม่พบรหัสคำสั่งซื้อ กรุณากดสั่งซื้ออีกครั้ง");
      const customerPhone = String(input.customerPhone || "").trim();
      const response = await fetch(`${config.apiUrl}/functions/v1/customer-order-submit`, {
        method: "POST",
        headers: {
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          "Content-Type": "application/json",
          "X-Line-ID-Token": idToken,
          "X-Idempotency-Key": idempotencyKey
        },
        body: JSON.stringify({
          order_type: input.orderType,
          delivery_address: input.orderType === "delivery" ? String(input.address || "").trim() : null,
          pickup_at: input.pickupAt || null,
          cart: Array.isArray(input.cart) ? input.cart : [],
          customer_note: String(input.customerNote || ""),
          customer_phone: customerPhone,
          // LINE display name shown by the LIFF profile in Order.html.
          // The server still verifies the LINE ID Token before accepting the order.
          customer_name: String(input.customer?.name || input.customerName || "").trim()
        })
      });
      const raw = await response.text();
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = { error: raw }; }
      if (body.code === "PHONE_REQUIRED") return { needs_phone: true, message: body.error };
      if (!response.ok || body.success === false) {
        throw new Error(body.error || body.message || `Order API HTTP ${response.status}`);
      }
      return body;
    },
  };

  global.BalenristaCustomerAdapter = adapter;
})(window);
