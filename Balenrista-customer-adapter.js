/**
 * Balenrista Customer Adapter v1.0
 *
 * Connects Balenrista Customer Checkout to Supabase.
 * Uses a public client key only. Never put service_role here.
 *
 * Required Edge Function:
 * POST https://<project-ref>.supabase.co/functions/v1/customer-orders/orders
 */
(function (global) {
  "use strict";

  let config = {
    apiUrl: "",
    anonKey: "",
    menuApiUrl: "",
    menuAnonKey: ""
  };

  const MENU_IMAGE_BUCKET = "balenrista-menu-images";

  function menuHeaders() {
    if (!config.menuApiUrl || !config.menuAnonKey) {
      throw new Error("ยังไม่ได้ตั้งค่าการอ่านเมนูจาก Supabase");
    }
    return {
      apikey: config.menuAnonKey,
      Authorization: `Bearer ${config.menuAnonKey}`
    };
  }

  async function readMenuTable(table, query) {
    const url = `${config.menuApiUrl}/rest/v1/${table}?${query}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { ...menuHeaders(), Accept: "application/json" },
      cache: "no-store"
    });

    const raw = await response.text();
    let body;

    try {
      body = raw ? JSON.parse(raw) : [];
    } catch (_) {
      throw new Error(`อ่าน ${table} ไม่สำเร็จ: รูปแบบข้อมูลไม่ถูกต้อง`);
    }

    if (!response.ok) {
      const message = body && (body.message || body.error || body.hint);
      throw new Error(
        `อ่าน ${table} ไม่สำเร็จ (${response.status}): ${message || raw}`
      );
    }

    return Array.isArray(body) ? body : [];
  }

  function publicMenuImageUrl(storagePath) {
    const path = String(storagePath || "").replace(/^\/+/, "");
    if (!path) return "";

    const encodedPath = path
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    return `${config.menuApiUrl}/storage/v1/object/public/${MENU_IMAGE_BUCKET}/${encodedPath}`;
  }

  function normalizeMenuRow(row, detail, images, storeMenu) {
    const name = String(row.name || "").trim();
    const image = images.length
      ? publicMenuImageUrl(images[0].storage_path)
      : "";

    const legacy = storeMenu || {};

    return {
      ...legacy,
      id: row.id,
      name,
      loyverseName: name,
      thaiName: name,
      price: Number(row.sale_price || 0),
      sale_price: Number(row.sale_price || 0),
      category: String(
        (detail && detail.category) ||
        row.group_name ||
        row.food_group ||
        "อื่นๆ"
      ).trim(),
      ingredients: String(
        (detail && detail.ingredients) || ""
      ),
      image,
      menu_images: images,
      is_active: row.is_active === true
    };
  }

  function requireConfig() {
    if (!config.apiUrl || !config.anonKey) {
      throw new Error(
        "Customer API ยังไม่ได้ตั้งค่า Supabase URL / anon key"
      );
    }
  }

  function normalizeBaseUrl(value) {
    return String(value || "").replace(/\/+$/, "");
  }

  async function request(path, options) {
    requireConfig();

    const response = await fetch(
      `${normalizeBaseUrl(config.apiUrl)}/functions/v1/customer-orders${path}`,
      {
        ...options,
        headers: {
          "Content-Type": "application/json",
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          ...(options && options.headers ? options.headers : {})
        }
      }
    );

    const raw = await response.text();
    let body = {};

    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (_) {
      body = {
        error: raw || "Invalid response from Customer API"
      };
    }

    if (!response.ok) {
      throw new Error(
        body.error ||
        body.message ||
        `Customer API HTTP ${response.status}`
      );
    }

    return body;
  }

  async function getVerifiedLineIdToken(liff) {
    if (
      !liff ||
      typeof liff.isLoggedIn !== "function" ||
      !liff.isLoggedIn()
    ) {
      throw new Error("กรุณาเข้าสู่ระบบ LINE ก่อนสั่งซื้อ");
    }

    if (typeof liff.getIDToken !== "function") {
      throw new Error(
        "ไม่สามารถอ่าน LINE ID Token ได้ กรุณาอัปเดต LIFF SDK"
      );
    }

    const idToken = liff.getIDToken();

    if (!idToken) {
      throw new Error(
        "ไม่พบ LINE ID Token กรุณาออกจากระบบ LINE แล้วเข้าสู่ระบบใหม่"
      );
    }

    return idToken;
  }

  const adapter = {
    configure(options) {
      options = options || {};

      config.apiUrl = normalizeBaseUrl(options.apiUrl);
      config.anonKey = String(options.anonKey || "").trim();

      if (!config.apiUrl || !config.anonKey) {
        throw new Error("กรุณาระบุ apiUrl และ anonKey");
      }

      return true;
    },

    configureMenuRead(options) {
      options = options || {};

      config.menuApiUrl = normalizeBaseUrl(options.apiUrl);
      config.menuAnonKey = String(options.anonKey || "").trim();

      if (!config.menuApiUrl || !config.menuAnonKey) {
        throw new Error(
          "กรุณาระบุ Supabase URL และ public anon/publishable key สำหรับเมนู"
        );
      }

      return true;
    },

    async loadMenuCatalog() {
      menuHeaders();

      const menus = await readMenuTable(
        "menus",
        "select=id,name,sale_price,group_name,food_group,is_active&is_active=eq.true&order=name.asc&limit=2000"
      );

      const ids = menus.map(row => row.id).filter(Boolean);

      if (!ids.length) {
        return {
          source: "supabase",
          updated: true,
          menus: [],
          categories: [],
          modifiers: {
            lists: [],
            options: [],
            rules: []
          }
        };
      }

      const inIds = `in.(${ids
        .map(id => String(id).replace(/[(),]/g, ""))
        .join(",")})`;

      const [details, imageRows] = await Promise.all([
        readMenuTable(
          "customer_menu_details",
          `select=menu_id,category,ingredients&menu_id=${encodeURIComponent(inIds)}&limit=5000`
        ),
        readMenuTable(
          "menu_images",
          `select=image_id,menu_id,file_name,storage_path,mime_type,created_at&menu_id=${encodeURIComponent(inIds)}&order=created_at.desc&limit=5000`
        )
      ]);

      const detailByMenu = new Map(
        details.map(row => [row.menu_id, row])
      );

      const imagesByMenu = new Map();

      imageRows.forEach(image => {
        if (!image.storage_path) return;

        const list = imagesByMenu.get(image.menu_id) || [];
        list.push(image);
        imagesByMenu.set(image.menu_id, list);
      });

      let modifiers = {
        lists: [],
        options: [],
        rules: [],
        warning: null
      };

      try {
        const [lists, options, rules] = await Promise.all([
          readMenuTable(
            "modifier_lists",
            "select=id,name,is_active&is_active=eq.true&limit=1000"
          ),
          readMenuTable(
            "modifier_options",
            "select=id,modifier_list_id,name,price,is_active&is_active=eq.true&limit=3000"
          ),
          readMenuTable(
            "modifier_list_rules",
            "select=modifier_list_id,scope_type,scope_value,is_active&is_active=eq.true&limit=3000"
          )
        ]);

        modifiers = {
          lists,
          options,
          rules,
          warning: null
        };
      } catch (error) {
        modifiers.warning = error.message || String(error);
        console.warn(
          "Customer modifier catalog unavailable:",
          modifiers.warning
        );
      }

      const normalizedMenus = menus.map(row =>
        normalizeMenuRow(
          row,
          detailByMenu.get(row.id),
          imagesByMenu.get(row.id) || [],
          null
        )
      );

      const categoryNames = [
        ...new Set(
          normalizedMenus
            .map(row => row.category)
            .filter(Boolean)
        )
      ].sort((a, b) => a.localeCompare(b, "th"));

      const categories = categoryNames.map(name => ({ name }));

      return {
        source: "supabase",
        updated: true,
        menus: normalizedMenus,
        categories,
        modifiers
      };
    },

    mergeMenuCatalog(storeData, supabaseCatalog) {
      storeData = storeData || {};

      if (!supabaseCatalog || supabaseCatalog.source !== "supabase") {
        throw new Error(
          "ไม่พบ Catalog จาก Supabase จึงไม่ใช้เมนูเก่ามาแสดงแทน"
        );
      }

      const oldMenus = Array.isArray(storeData.menus)
        ? storeData.menus
        : [];

      const oldByName = new Map(
        oldMenus.map(row => [
          String(row.loyverseName || row.name || "")
            .trim()
            .toLowerCase(),
          row
        ])
      );

      const menus = supabaseCatalog.menus.map(row => {
        const old = oldByName.get(
          String(row.loyverseName || "")
            .trim()
            .toLowerCase()
        ) || null;

        return {
          ...row,
          ...(old || {}),
          ...row
        };
      });

      return {
        ...storeData,
        menus,
        categories: supabaseCatalog.categories,
        menuCatalogSource: "supabase",
        modifiers: supabaseCatalog.modifiers
      };
    },

    async submitOrder(input) {
      input = input || {};

      const liff = input.liff;
      const idToken = await getVerifiedLineIdToken(liff);

      const orderType = input.orderType;

      if (!["pickup", "delivery"].includes(orderType)) {
        throw new Error("ประเภทการรับสินค้าไม่ถูกต้อง");
      }

      const customer = input.customer || {};
      const cart = Array.isArray(input.cart) ? input.cart : [];

      if (!customer.name || !customer.phone) {
        throw new Error("กรุณากรอกชื่อและเบอร์โทรศัพท์");
      }

      if (cart.length === 0) {
        throw new Error("ยังไม่มีสินค้าในตะกร้า");
      }

      if (
        orderType === "delivery" &&
        !String(input.address || "").trim()
      ) {
        throw new Error("กรุณากรอกที่อยู่จัดส่ง");
      }

      const totalCups = cart.reduce(
        (sum, item) =>
          sum + Math.max(0, Number(item && item.qty) || 0),
        0
      );

      if (orderType === "delivery" && totalCups < 4) {
        throw new Error("บริการจัดส่งต้องสั่งขั้นต่ำ 4 แก้ว");
      }

      const idempotencyKey = String(
        input.idempotencyKey || ""
      ).trim();

      if (!idempotencyKey) {
        throw new Error(
          "ไม่พบรหัสคำสั่งซื้อ กรุณากดสั่งซื้ออีกครั้ง"
        );
      }

      return request("/orders", {
        method: "POST",
        headers: {
          "X-Line-ID-Token": idToken,
          "X-Idempotency-Key": idempotencyKey
        },
        body: JSON.stringify({
          source: "website",
          order_type: orderType,
          payment_method:
            input.paymentMethod === "qr" ? "qr" : "cash",
          customer: {
            name: String(customer.name).trim(),
            phone: String(customer.phone).trim()
          },
          delivery_address:
            orderType === "delivery"
              ? String(input.address).trim()
              : null,
          pickup_at: input.pickupAt || null,
          cart,
          idempotency_key: idempotencyKey
        })
      });
    }
  };

  global.BalenristaCustomerAdapter = adapter;

})(window);
