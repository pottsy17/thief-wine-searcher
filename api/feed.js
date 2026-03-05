// Thief Fine Wine & Beer — Wine-Searcher JSON Data Feed
// Deployed on Vercel. Queries Supabase for near-instant response.
// Wine-Searcher crawls this endpoint up to 5x/day.
//
// Feed URL: https://thief-wine-searcher.vercel.app/api/feed
// Submit to Wine-Searcher at: https://www.wine-searcher.com/trade/list-on-wine-searcher

const DOMAIN       = process.env.STORE_DOMAIN || "thiefshop.com";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---- Supabase REST query — no SDK needed ----

async function fetchWines() {
  const url = `${SUPABASE_URL}/rest/v1/shopify_products` +
    `?select=title,handle,sku,price,image_url,variants` +
    `&product_type=eq.Wine` +
    `&status=eq.active` +
    `&price=gt.0` +
    `&order=title.asc` +
    `&limit=10000`;

  const res = await fetch(url, {
    headers: {
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Accept":        "application/json",
    },
  });

  if (!res.ok) throw new Error(`Supabase query failed: ${res.status}`);
  return res.json();
}

// ---- Extract 4-digit vintage year from title ----

function extractVintage(title) {
  const match = title.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : "NV";
}

// ---- Check inventory policy from variants JSONB ----
// Note: inventory_quantity is not stored in variants JSONB — only inventory_policy.
// Active products with price > 0 are treated as available (stale/zero-inventory
// products are archived nightly, so active = in stock is a reliable signal).

function getStock(variants) {
  if (!variants) return 1;
  const parsed = typeof variants === "string" ? JSON.parse(variants) : variants;
  if (Array.isArray(parsed) && parsed.length > 0) {
    if (parsed[0].inventory_policy === "continue") return 99;
  }
  return 1; // active + price > 0 means available
}

// ---- Map row → Wine-Searcher record ----

function toRecord(row) {
  return {
    sku:       row.sku || row.handle,
    name:      row.title,
    vintage:   extractVintage(row.title),
    unit_size: "750ml",
    price:     parseFloat(row.price).toFixed(2),
    stock:     getStock(row.variants),
    url:       `https://${DOMAIN}/products/${row.handle}`,
    ...(row.image_url ? { image_url: row.image_url } : {}),
  };
}

// ---- Vercel handler ----

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, s-maxage=14400, stale-while-revalidate=3600");
  res.setHeader("Content-Type", "application/json");

  try {
    const rows    = await fetchWines();
    const records = rows.map(toRecord).filter(Boolean);

    res.status(200).json({
      store:     "Thief Fine Wine & Beer",
      location:  "Walla Walla, WA",
      currency:  "USD",
      generated: new Date().toISOString(),
      count:     records.length,
      products:  records,
    });
  } catch (err) {
    console.error("Feed error:", err.message);
    res.status(500).json({ error: err.message });
  }
}
