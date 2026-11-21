/**
 * Shopify product access for the Content Studio
 * =========================================
 * The content generator only carries an `orgId`. To let the content agent ground
 * its copy and visuals in the merchant's real catalogue, we resolve the org's
 * active Shopify integration and pull a compact set of products — title,
 * description, price, and crucially the real product image URLs — so the agent
 * can drop actual product photography into the content instead of inventing fake
 * CSS/SVG "product" shapes.
 *
 * Everything here is best-effort: if the org has no Shopify connection, or the
 * call fails, we return an empty list and content generation proceeds without
 * product grounding rather than hard-failing.
 */

import { resolveShopifySource, getShopifyConn } from '../analyst/modules/shopify-shared.js';
import { shopifyGraphQL } from '../agents/shopify/graphql.js';

export type ContentProduct = {
  id: string;
  title: string;
  description: string | null;
  handle: string;
  productType: string | null;
  vendor: string | null;
  price: number | null;
  currency: string | null;
  /** Absolute, CDN-hosted product image URLs the content may render directly. */
  imageUrls: string[];
};

type ProductsGraphQLResponse = {
  products: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        handle: string;
        description?: string | null;
        productType?: string | null;
        vendor?: string | null;
        status: string;
        featuredImage?: { url: string } | null;
        priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string } };
        images: { edges: Array<{ node: { url: string } }> };
      };
    }>;
  };
};

const DEFAULT_PRODUCT_LIMIT = 12;
const MAX_IMAGES_PER_PRODUCT = 4;

/**
 * Fetch a compact catalogue snapshot for the org's active Shopify store.
 *
 * @param orgId       organisation whose store to read
 * @param productIds  optional Shopify product GIDs to restrict to (the user
 *                    picked specific products in the studio). When omitted we
 *                    pull the most recently updated published products.
 */
export async function fetchContentProducts(
  orgId: string,
  productIds?: string[] | null,
  limit: number = DEFAULT_PRODUCT_LIMIT,
): Promise<ContentProduct[]> {
  try {
    const integrationId = await resolveShopifySource(orgId);
    if (!integrationId) return [];

    const conn = await getShopifyConn(integrationId);

    // When specific products are requested, filter by their numeric IDs;
    // otherwise pull the most recently updated *published* (active) products,
    // which are the ones a merchant would actually advertise.
    const idFilter =
      productIds && productIds.length > 0
        ? productIds
            .map((gid) => `id:${gid.split('/').pop()}`)
            .join(' OR ')
        : 'status:active';

    const query = /* GraphQL */ `
      query ContentProducts($first: Int!, $q: String, $imgs: Int!) {
        products(first: $first, query: $q, sortKey: UPDATED_AT, reverse: true) {
          edges {
            node {
              id
              title
              handle
              description
              productType
              vendor
              status
              featuredImage { url }
              priceRangeV2 { minVariantPrice { amount currencyCode } }
              images(first: $imgs) { edges { node { url } } }
            }
          }
        }
      }
    `;

    const data = await shopifyGraphQL<ProductsGraphQLResponse>(conn, query, {
      first: Math.max(1, Math.min(limit, 50)),
      q: idFilter,
      imgs: MAX_IMAGES_PER_PRODUCT,
    });

    return data.products.edges.map(({ node }) => {
      // featuredImage first (best hero), then the rest, de-duplicated.
      const urls = [
        ...(node.featuredImage?.url ? [node.featuredImage.url] : []),
        ...node.images.edges.map((e) => e.node.url),
      ];
      const imageUrls = Array.from(new Set(urls)).slice(0, MAX_IMAGES_PER_PRODUCT);

      const amount = node.priceRangeV2?.minVariantPrice?.amount;
      return {
        id: node.id,
        title: node.title,
        description: cleanDescription(node.description),
        handle: node.handle,
        productType: node.productType ?? null,
        vendor: node.vendor ?? null,
        price: amount != null ? Number(amount) : null,
        currency: node.priceRangeV2?.minVariantPrice?.currencyCode ?? null,
        imageUrls,
      };
    });
  } catch (err) {
    console.warn('[content] product fetch failed, continuing without product grounding:', err);
    return [];
  }
}

// Shopify `description` is plaintext (descriptionHtml is the rich one). Trim and
// cap it so we don't blow the prompt out with a 2,000-word product essay.
function cleanDescription(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}

/**
 * Render the product catalogue into a prompt section the content agent can
 * use. Includes real image URLs explicitly so the model is encouraged to embed
 * actual product photography via <img src="...">.
 */
export function formatProductsForPrompt(products: ContentProduct[]): string {
  if (products.length === 0) return '';

  const blocks = products.map((p, i) => {
    const lines: string[] = [`${i + 1}. ${p.title}`];
    if (p.price != null) lines.push(`   Price: ${p.currency ?? ''} ${p.price}`.trimEnd());
    if (p.productType) lines.push(`   Type: ${p.productType}`);
    if (p.vendor) lines.push(`   Brand/Vendor: ${p.vendor}`);
    if (p.description) lines.push(`   Description: ${p.description}`);
    if (p.imageUrls.length) {
      lines.push('   Product image URLs (use these REAL images via <img src="...">):');
      for (const url of p.imageUrls) lines.push(`     - ${url}`);
    }
    return lines.join('\n');
  });

  return [
    'SHOPIFY PRODUCT CATALOGUE (the merchant\'s real products — ground the content in these):',
    'Use the real product titles, prices, and descriptions below. When the content features a product,',
    'embed the REAL product image via <img src="<one of the URLs below>"> — these are live Shopify',
    'CDN URLs and will render. Do NOT invent prices or product names.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
