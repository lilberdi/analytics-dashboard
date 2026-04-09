import fs from "node:fs/promises";
import path from "node:path";

const API_PATH = "/api/v5/orders/create";
const DEFAULTS = {
  orderType: "main",
  orderMethod: "shopping-cart",
  status: "new",
  contragentType: "individual",
};

const ALLOWED_CODES = {
  orderType: new Set(["main"]),
  orderMethod: new Set(["shopping-cart"]),
};

function parseArgs(argv) {
  const args = {
    file: "./mock_orders.json",
    site: "",
    delay: 0,
    dryRun: false,
    limit: null,
    help: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") args.file = argv[++i];
    else if (arg === "--site") args.site = argv[++i];
    else if (arg === "--delay") args.delay = Number(argv[++i]);
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`
Import orders to RetailCRM

Usage:
  RETAILCRM_BASE_URL="https://your-project.retailcrm.ru" \\
  RETAILCRM_API_KEY="YOUR_API_KEY" \\
  node import-retailcrm-orders.js [options]

Options:
  --file <path>   Path to orders JSON (default: ./mock_orders.json)
  --site <code>   Optional RetailCRM site code
  --delay <ms>    Delay between requests (default: 0)
  --limit <n>     Import only first N orders
  --dry-run       Print transformed payload, do not send
  --help, -h      Show this help
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeContragentType(source) {
  const raw = String(source || DEFAULTS.contragentType).trim().toLowerCase();
  const map = {
    individual: "individual",
    "legal-entity": "legal-entity",
    enterpreneur: "enterpreneur",
    physical: "individual",
    legal: "legal-entity",
  };
  return map[raw] || DEFAULTS.contragentType;
}

function normalizeCode(value, fallback, allowedSet) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  return allowedSet.has(raw) ? raw : fallback;
}

function toCustomFieldsObject(customFields) {
  if (!customFields) return {};
  if (Array.isArray(customFields)) {
    return customFields.reduce((acc, field) => {
      if (field && typeof field.code === "string") {
        acc[field.code] = field.value ?? null;
      }
      return acc;
    }, {});
  }
  if (typeof customFields === "object") {
    return { ...customFields };
  }
  throw new Error("customFields must be an object or array");
}

function normalizeItem(item, index) {
  const quantity = Number(item?.quantity ?? 1);
  const initialPrice = Number(item?.initialPrice ?? 0);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`items[${index}].quantity must be a positive number`);
  }
  if (!Number.isFinite(initialPrice) || initialPrice < 0) {
    throw new Error(`items[${index}].initialPrice must be >= 0`);
  }

  const normalized = {
    quantity,
    initialPrice,
  };

  const offerId = item?.offer?.id ?? item?.offerId;
  if (offerId !== undefined && offerId !== null && offerId !== "") {
    const parsedOfferId = Number(offerId);
    if (!Number.isFinite(parsedOfferId) || parsedOfferId <= 0) {
      throw new Error(`items[${index}].offer.id must be a positive number`);
    }
    normalized.offer = { id: parsedOfferId };
  } else {
    const productName = String(item?.productName || "").trim();
    if (!productName) {
      throw new Error(`items[${index}] must contain offer.id or productName`);
    }
    normalized.productName = productName;
  }

  if (item?.properties && Array.isArray(item.properties)) {
    normalized.properties = item.properties;
  }

  return normalized;
}

function transformOrder(sourceOrder) {
  if (!sourceOrder || typeof sourceOrder !== "object") {
    throw new Error("order must be an object");
  }

  const addressText = String(sourceOrder?.delivery?.address?.text || "").trim();
  const city = String(sourceOrder?.delivery?.address?.city || "").trim();
  if (!addressText || !city) {
    throw new Error("delivery.address must include non-empty text and city");
  }

  if (!Array.isArray(sourceOrder.items) || sourceOrder.items.length === 0) {
    throw new Error("items must be a non-empty array");
  }

  const transformed = {
    ...sourceOrder,
    // Force known-good symbolic codes for this CRM instance.
    orderType: normalizeCode(sourceOrder.orderType, DEFAULTS.orderType, ALLOWED_CODES.orderType),
    orderMethod: normalizeCode(
      sourceOrder.orderMethod,
      DEFAULTS.orderMethod,
      ALLOWED_CODES.orderMethod,
    ),
    status: sourceOrder.status || DEFAULTS.status,
    contragent: {
      ...(sourceOrder.contragent || {}),
      contragentType: normalizeContragentType(
        sourceOrder?.contragent?.contragentType || sourceOrder?.contragentType,
      ),
    },
    items: sourceOrder.items.map((item, idx) => normalizeItem(item, idx)),
    delivery: {
      ...(sourceOrder.delivery || {}),
      address: {
        ...(sourceOrder.delivery?.address || {}),
        text: addressText,
        city,
      },
    },
    customFields: toCustomFieldsObject(sourceOrder.customFields),
  };

  return transformed;
}

function buildErrorMessage(payload, statusCode) {
  if (!payload) return `HTTP ${statusCode}`;

  const parts = [];
  if (payload.errorMsg) parts.push(payload.errorMsg);

  if (Array.isArray(payload.errors)) {
    parts.push(payload.errors.join("; "));
  } else if (payload.errors && typeof payload.errors === "object") {
    for (const [field, messages] of Object.entries(payload.errors)) {
      if (Array.isArray(messages)) parts.push(`${field}: ${messages.join(", ")}`);
      else parts.push(`${field}: ${String(messages)}`);
    }
  }

  if (parts.length === 0 && payload.raw) parts.push(payload.raw);
  return parts.length > 0 ? parts.join(" | ") : `HTTP ${statusCode}`;
}

async function createOrder({ baseUrl, apiKey, site, order }) {
  const endpoint = new URL(API_PATH, baseUrl);
  endpoint.searchParams.set("apiKey", apiKey);
  if (site) {
    endpoint.searchParams.set("site", site);
  }

  const body = new URLSearchParams();
  body.set("order", JSON.stringify(order));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const rawText = await response.text();
  let payload = null;
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = { raw: rawText };
  }

  if (!response.ok || payload?.success === false) {
    throw new Error(buildErrorMessage(payload, response.status));
  }

  return payload;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  if (!Number.isFinite(args.delay) || args.delay < 0) {
    throw new Error("--delay must be a non-negative number");
  }
  if (args.limit !== null && (!Number.isFinite(args.limit) || args.limit <= 0)) {
    throw new Error("--limit must be a positive number");
  }

  const baseUrl = process.env.RETAILCRM_BASE_URL;
  const apiKey = process.env.RETAILCRM_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("Set RETAILCRM_BASE_URL and RETAILCRM_API_KEY environment variables");
  }

  const filePath = path.resolve(process.cwd(), args.file);
  const raw = await fs.readFile(filePath, "utf8");

  let orders;
  try {
    orders = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${args.file}: ${error.message}`);
  }

  if (!Array.isArray(orders)) {
    throw new Error(`${args.file} must contain an array of orders`);
  }

  const importOrders = args.limit ? orders.slice(0, args.limit) : orders;

  console.log(`Orders to process: ${importOrders.length}`);
  console.log(`Endpoint: ${new URL(API_PATH, baseUrl).toString()}`);
  if (args.site) console.log(`Site: ${args.site}`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < importOrders.length; i += 1) {
    const source = importOrders[i];
    try {
      const order = transformOrder(source);

      if (args.dryRun) {
        console.log(`[DRY RUN] #${i + 1}\n${JSON.stringify(order, null, 2)}`);
      } else {
        const result = await createOrder({ baseUrl, apiKey, site: args.site, order });
        const orderId = result?.id ?? result?.order?.id ?? "unknown";
        console.log(`OK #${i + 1}: created order id ${orderId}`);
      }
      success += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`FAIL #${i + 1}: ${message}`);
    }

    if (args.delay > 0 && i < importOrders.length - 1) {
      await sleep(args.delay);
    }
  }

  console.log(`Done. Success: ${success}, Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});