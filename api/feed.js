// Thief Fine Wine & Beer — Wine-Searcher JSON Data Feed
// Deployed on Vercel. Queries Shopify GraphQL directly for live data.
// Wine-Searcher crawls this endpoint up to 5x/day.
//
// Feed URL (once deployed): https://thief-wine-searcher.vercel.app/api/feed
// Submit that URL to Wine-Searcher at: https://www.wine-searcher.com/trade/list-on-wine-searcher

const STORE    = process.env.SHOPIFY_STORE_HANDLE + ".myshopify.com";
const DOMAIN   = process.env.STORE_DOMAIN || "thiefshop.com";
const GQL      = `https://${STORE}/admin/api/2025-01/graphql.json`;

// ---- Shopify Auth (client credentials — same pattern as all Thief tools) ----

async function getToken() {
  const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Shopify auth failed");
  return data.access_token;
}

// ---- GraphQL query — paginate through all active Wine products ----

const PRODUCTS_QUERY = `
  query getProducts($cursor: String) {
    products(
      first: 250
      after: $cursor
      query: "product_type:Wine AND status:active"
    ) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          handle
          vendor
          images(first: 1) { edges { node { url } } }
          variants(first: 1) {
            edges {
              node {
                sku
                price
                inventoryQuantity
                inventoryPolicy
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchAllWines(token) {
  const products = [];
  let cursor = null;

  while (true) {
    const res = await fetch(GQL, {
      method:  "POST",
      headers: {
        "Content-Type":           "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
    });

    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));

    const page = json.data.products;
    products.push(...page.edges.map(e => e.node));

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return products;
}

// ---- Extract 4-digit vintage year from title ----

function extractVintage(title) {
  const match = title.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : "NV";
}

// ---- Map Shopify product → Wine-Searcher record ----

function toWineSearcherRecord(product) {
  const variant = product.variants.edges[0]?.node;
  if (!variant) return null;

  const price = parseFloat(variant.price);
  if (!price || price <= 0) return null;

  // Include if: continuous inventory policy (always available)
  // OR if inventory quantity > 0
  const inStock =
    variant.inventoryPolicy === "continue" ||
    (variant.inventoryQuantity != null && variant.inventoryQuantity > 0);

  if (!inStock) return null;

  const stock = variant.inventoryPolicy === "continue"
    ? 99  // "continue selling when out of stock" — treat as always available
    : Math.max(1, variant.inventoryQuantity);

  const imageUrl = product.images.edges[0]?.node?.url || null;

  return {
    sku:       variant.sku || product.id.replace("gid://shopify/Product/", ""),
    name:      product.title,
    vintage:   extractVintage(product.title),
    unit_size: "750ml",
    price:     price.toFixed(2),
    stock,
    url:       `https://${DOMAIN}/products/${product.handle}`,
    ...(imageUrl ? { image_url: imageUrl } : {}),
  };
}

// ---- Vercel handler ----

export default async function handler(req, res) {
  // Cache for 4 hours — Wine-Searcher crawls up to 5x/day, this keeps us responsive
  // without hammering Shopify on every crawl
  res.setHeader("Cache-Control", "public, s-maxage=14400, stale-while-revalidate=3600");
  res.setHeader("Content-Type", "application/json");

  try {
    const token    = await getToken();
    const products = await fetchAllWines(token);

    const records = products
      .map(toWineSearcherRecord)
      .filter(Boolean);

    res.status(200).json({
      store:      "Thief Fine Wine & Beer",
      location:   "Walla Walla, WA",
      currency:   "USD",
      generated:  new Date().toISOString(),
      count:      records.length,
      products:   records,
    });
  } catch (err) {
    console.error("Feed error:", err.message);
    res.status(500).json({ error: err.message });
  }
}
