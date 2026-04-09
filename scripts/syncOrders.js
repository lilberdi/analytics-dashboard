import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const RETAILCRM_BASE_URL = process.env.RETAILCRM_BASE_URL || "";
const RETAILCRM_KEY = process.env.RETAILCRM_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

const RETAILCRM_ORDERS_PATH = "/api/v5/orders";
const PAGE_SIZE = 100;

function validateEnv() {
  const missing = [];
  if (!RETAILCRM_BASE_URL) missing.push("RETAILCRM_BASE_URL");
  if (!RETAILCRM_KEY) missing.push("RETAILCRM_KEY");
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_KEY) missing.push("SUPABASE_KEY");

  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

function mapOrderToSupabase(order) {
  const firstName = order?.firstName || "";
  const lastName = order?.lastName || "";
  const fullName = `${firstName} ${lastName}`.trim();
  const customerName = order?.customer?.name || fullName || "Unknown customer";

  const totalAmount = Number(order?.totalSumm ?? 0);
  const createdAt = order?.createdAt ? new Date(order.createdAt).toISOString() : new Date().toISOString();

  return {
    id: order.id,
    customer_name: customerName,
    total_amount: Number.isFinite(totalAmount) ? totalAmount : 0,
    created_at: createdAt,
    status: String(order?.status || "new"),
  };
}

async function fetchOrdersPage(page) {
  const url = new URL(RETAILCRM_ORDERS_PATH, RETAILCRM_BASE_URL);
  url.searchParams.set("apiKey", RETAILCRM_KEY);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(PAGE_SIZE));

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok || payload?.success === false) {
    const message =
      payload?.errorMsg ||
      (payload?.errors ? JSON.stringify(payload.errors) : null) ||
      payload?.raw ||
      `HTTP ${response.status}`;
    throw new Error(`RetailCRM fetch failed on page ${page}: ${message}`);
  }

  return Array.isArray(payload.orders) ? payload.orders : [];
}

async function fetchAllOrders() {
  const allOrders = [];
  let page = 1;

  while (true) {
    const pageOrders = await fetchOrdersPage(page);
    if (pageOrders.length === 0) break;

    allOrders.push(...pageOrders);
    if (pageOrders.length < PAGE_SIZE) break;
    page += 1;
  }

  return allOrders;
}

async function upsertOrders(supabase, orders) {
  if (orders.length === 0) return;

  const rows = orders.map(mapOrderToSupabase).filter((row) => row.id !== undefined && row.id !== null);
  if (rows.length === 0) {
    throw new Error("No valid orders to sync: all orders are missing id");
  }

  const { error } = await supabase.from("orders").upsert(rows, { onConflict: "id" });
  if (error) {
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }
}

async function main() {
  try {
    validateEnv();

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const orders = await fetchAllOrders();

    console.log(`Orders received from RetailCRM: ${orders.length}`);

    await upsertOrders(supabase, orders);
    console.log("Orders successfully uploaded to Supabase.");
  } catch (error) {
    console.error("Sync failed:", error.message);
    process.exit(1);
  }
}

await main();
