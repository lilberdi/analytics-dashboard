import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  RETAILCRM_BASE_URL,
  RETAILCRM_KEY,
  RETAILCRM_SITE,
} = process.env;

function requireEnv() {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_KEY",
    "TG_BOT_TOKEN",
    "TG_CHAT_ID",
    "RETAILCRM_BASE_URL",
    "RETAILCRM_KEY",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

requireEnv();

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });
const POLL_INTERVAL_MS = 60 * 1000;
const RETAILCRM_ORDERS_PATH = "/api/v5/orders";
const ORDER_LIMIT = 100;

let lastCheckedCreatedAt = null;
let isPolling = false;

function mapRetailOrder(order) {
  const customerName =
    order?.customer?.name ||
    `${order?.firstName || ""} ${order?.lastName || ""}`.trim() ||
    "Unknown customer";

  const totalAmount = Number(order?.totalSumm ?? 0);
  const createdAt = order?.createdAt ? new Date(order.createdAt).toISOString() : new Date().toISOString();

  return {
    id: order.id,
    customer_name: customerName,
    total_amount: Number.isFinite(totalAmount) ? totalAmount : 0,
    status: String(order?.status || "new"),
    created_at: createdAt,
  };
}

async function initLastCheckpoint() {
  const { data, error } = await supabase
    .from("orders")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read last checkpoint from Supabase: ${error.message}`);
  }

  lastCheckedCreatedAt = data?.created_at || new Date(0).toISOString();
  console.log(`[init] Last checkpoint: ${lastCheckedCreatedAt}`);
}

async function fetchRetailOrdersPage(page, createdAtFrom) {
  const url = new URL(RETAILCRM_ORDERS_PATH, RETAILCRM_BASE_URL);
  url.searchParams.set("apiKey", RETAILCRM_KEY);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(ORDER_LIMIT));
  url.searchParams.set("filter[createdAtFrom]", createdAtFrom);
  if (RETAILCRM_SITE) url.searchParams.set("site", RETAILCRM_SITE);

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }

  if (!response.ok || payload?.success === false) {
    const message =
      payload?.errorMsg ||
      (payload?.errors ? JSON.stringify(payload.errors) : null) ||
      payload?.raw ||
      `HTTP ${response.status}`;
    throw new Error(`RetailCRM request failed: ${message}`);
  }

  return Array.isArray(payload.orders) ? payload.orders : [];
}

async function fetchNewRetailOrders(createdAtFrom) {
  const orders = [];
  let page = 1;

  while (true) {
    const pageOrders = await fetchRetailOrdersPage(page, createdAtFrom);
    if (pageOrders.length === 0) break;
    orders.push(...pageOrders);
    if (pageOrders.length < ORDER_LIMIT) break;
    page += 1;
  }

  return orders;
}

async function notifyHighValueOrders(orders) {
  for (const order of orders) {
    if (Number(order.total_amount) <= 50000) continue;

    const message = [
      "💰 Новый большой заказ!",
      `ID: ${order.id}`,
      `Клиент: ${order.customer_name}`,
      `Сумма: ${order.total_amount} ₸`,
      `Статус: ${order.status}`,
      `Дата: ${new Date(order.created_at).toLocaleString("ru-RU")}`,
    ].join("\n");

    await bot.sendMessage(TG_CHAT_ID, message);
    console.log(`[telegram] Sent alert for order ${order.id}`);
  }
}

async function getExistingOrderIds(orderIds) {
  if (orderIds.length === 0) return new Set();

  const { data, error } = await supabase.from("orders").select("id").in("id", orderIds);
  if (error) {
    throw new Error(`Failed to load existing orders: ${error.message}`);
  }

  return new Set((data || []).map((row) => row.id));
}

async function syncOrders() {
  if (isPolling) {
    console.log("[poll] Previous cycle still running, skip");
    return;
  }
  isPolling = true;

  try {
    const sourceFrom = lastCheckedCreatedAt || new Date(0).toISOString();
    console.log(`[poll] Checking RetailCRM from ${sourceFrom}`);

    const retailOrders = await fetchNewRetailOrders(sourceFrom);
    if (retailOrders.length === 0) {
      console.log("[poll] No new orders");
      return;
    }

    retailOrders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const mappedOrders = retailOrders.map(mapRetailOrder);
    const existingIds = await getExistingOrderIds(mappedOrders.map((order) => order.id));
    const newOrders = mappedOrders.filter((order) => !existingIds.has(order.id));

    const { error } = await supabase.from("orders").upsert(mappedOrders, { onConflict: "id" });
    if (error) {
      throw new Error(`Supabase upsert failed: ${error.message}`);
    }

    console.log(`[supabase] Upserted ${mappedOrders.length} orders (${newOrders.length} new)`);
    await notifyHighValueOrders(newOrders);

    const newest = mappedOrders[mappedOrders.length - 1];
    lastCheckedCreatedAt = newest.created_at;
    console.log(`[poll] Updated checkpoint: ${lastCheckedCreatedAt}`);
  } catch (error) {
    console.error(`[poll] Error: ${error.message}`);
  } finally {
    isPolling = false;
  }
}

async function start() {
  await initLastCheckpoint();
  await syncOrders();
  setInterval(syncOrders, POLL_INTERVAL_MS);
  console.log(`[start] Polling RetailCRM every ${POLL_INTERVAL_MS / 1000}s`);
}

start().catch((error) => {
  console.error(`[fatal] ${error.message}`);
  process.exit(1);
});