/**
 * Balenrista Customer Adapter
 * เชื่อมหน้า Customer Website กับ Supabase Edge Functions
 *
 * หน้าที่:
 * 1. ส่งคำสั่งซื้อไปยัง customer-order-submit
 * 2. ส่ง LINE ID Token เพื่อยืนยันตัวตนลูกค้า
 * 3. สร้าง Idempotency Key ป้องกันคำสั่งซื้อซ้ำ
 * 4. รับผลการบันทึกคำสั่งซื้อกลับไปแสดงบนหน้าเว็บ
 */

(function (global) {
  "use strict";

  const CONFIG = {
    SUPABASE_URL: "https://iftsmcgvperrhjjfnhqa.supabase.co",

    SUPABASE_ANON_KEY:
      "sb_publishable_AezycpnUmhgvMWJlUsg2qA_S3JbiR0",

    SUBMIT_ENDPOINT:
      "https://iftsmcgvperrhjjfnhqa.supabase.co/functions/v1/customer-order-submit",
  };

  /**
   * สร้าง Idempotency Key
   * ใช้ป้องกันการกดสั่งซื้อซ้ำ
   */
  function createIdempotencyKey() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }

    return (
      "web-" +
      Date.now() +
      "-" +
      Math.random().toString(36).substring(2, 12)
    );
  }

  /**
   * ดึง LINE ID Token จาก LIFF
   */
  async function getLineIdToken() {
    if (!global.liff || typeof global.liff.getIDToken !== "function") {
      throw new Error("ไม่พบ LINE LIFF กรุณาเปิดเว็บไซต์ผ่าน LINE");
    }

    if (!global.liff.isLoggedIn()) {
      throw new Error("กรุณาเข้าสู่ระบบ LINE ก่อนสั่งซื้อ");
    }

    const token = global.liff.getIDToken();

    if (!token) {
      throw new Error("ไม่สามารถตรวจสอบตัวตน LINE ได้");
    }

    return token;
  }

  /**
   * ส่งคำสั่งซื้อไปยัง Supabase
   */
  async function submitOrder(orderData) {
    if (!orderData || typeof orderData !== "object") {
      throw new Error("ข้อมูลคำสั่งซื้อไม่ถูกต้อง");
    }

    const lineIdToken = await getLineIdToken();

    const idempotencyKey =
      orderData.idempotency_key || createIdempotencyKey();

    const response = await fetch(CONFIG.SUBMIT_ENDPOINT, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        apikey: CONFIG.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + CONFIG.SUPABASE_ANON_KEY,
        "X-Line-ID-Token": lineIdToken,
        "Idempotency-Key": idempotencyKey,
      },

      body: JSON.stringify({
        ...orderData,
        idempotency_key: idempotencyKey,
      }),
    });

    let result;

    try {
      result = await response.json();
    } catch {
      throw new Error("ระบบไม่สามารถอ่านผลตอบกลับจากเซิร์ฟเวอร์ได้");
    }

    if (!response.ok || result.success === false) {
      throw new Error(
        result.message ||
        result.error ||
        "ไม่สามารถบันทึกคำสั่งซื้อได้"
      );
    }

    return {
      success: true,
      data: result,
    };
  }

  /**
   * เปิดใช้งาน Adapter
   */
  global.BalenristaCustomerAdapter = {
    submitOrder,
    createIdempotencyKey,
  };

})(window);
