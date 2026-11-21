/**
 * Record listing functions: individual orders, products, customers, and shop overview
 */

import type { ShopifyConnectInfo } from '../credentials.js';
import type { RecordResult } from '../types.js';
import { rowsToResult, clamp } from '../helpers.js';
import {
  queryShopOverview,
  queryOrders,
  queryProducts,
  queryCustomers,
  DEFAULT_LIST_LIMIT_EXPORT,
  MAX_LIST_LIMIT_EXPORT,
} from '../queries.js';

export async function getShopOverview(conn: ShopifyConnectInfo): Promise<RecordResult> {
  const data = await queryShopOverview(conn);
  const row = {
    shopName: data.shop.name,
    email: data.shop.email ?? null,
    domain: data.shop.primaryDomain?.url ?? data.shop.myshopifyDomain,
    currency: data.shop.currencyCode,
    timezone: data.shop.ianaTimezone ?? null,
    plan: data.shop.plan?.displayName ?? null,
    country: data.shop.billingAddress?.country ?? null,
    totalProducts: data.productsCount?.count ?? null,
    totalOrders: data.ordersCount?.count ?? null,
    totalCustomers: data.customersCount?.count ?? null,
  };
  return rowsToResult([row]);
}

export type ListOrdersInput = {
  query?: string;
  limit?: number;
};

export async function listOrders(
  conn: ShopifyConnectInfo,
  input: ListOrdersInput,
): Promise<RecordResult> {
  const limit = clamp(input.limit, 1, MAX_LIST_LIMIT_EXPORT, DEFAULT_LIST_LIMIT_EXPORT);
  const data = await queryOrders(conn, limit, input.query ?? null);

  const rows = data.orders.edges.map(({ node }) => ({
    id: node.id,
    orderNumber: node.name,
    createdAt: node.createdAt,
    processedAt: node.processedAt ?? null,
    financialStatus: node.displayFinancialStatus ?? null,
    fulfillmentStatus: node.displayFulfillmentStatus ?? null,
    total: Number(node.currentTotalPriceSet.shopMoney.amount),
    subtotal: node.subtotalPriceSet ? Number(node.subtotalPriceSet.shopMoney.amount) : null,
    discounts: node.totalDiscountsSet ? Number(node.totalDiscountsSet.shopMoney.amount) : null,
    currency: node.currentTotalPriceSet.shopMoney.currencyCode,
    customerEmail: node.customer?.email ?? null,
    customerName: node.customer?.displayName ?? null,
    lineItems: node.lineItems.edges
      .map((e) => `${e.node.quantity}× ${e.node.title}`)
      .join('; '),
  }));
  return rowsToResult(rows);
}

export type ListProductsInput = {
  query?: string;
  limit?: number;
};

export async function listProducts(
  conn: ShopifyConnectInfo,
  input: ListProductsInput,
): Promise<RecordResult> {
  const limit = clamp(input.limit, 1, MAX_LIST_LIMIT_EXPORT, DEFAULT_LIST_LIMIT_EXPORT);
  const data = await queryProducts(conn, limit, input.query ?? null);

  const rows = data.products.edges.map(({ node }) => ({
    id: node.id,
    title: node.title,
    handle: node.handle,
    vendor: node.vendor ?? null,
    productType: node.productType ?? null,
    status: node.status,
    totalInventory: node.totalInventory ?? null,
    minPrice: Number(node.priceRangeV2.minVariantPrice.amount),
    maxPrice: Number(node.priceRangeV2.maxVariantPrice.amount),
    currency: node.priceRangeV2.minVariantPrice.currencyCode,
    variantCount: node.variants.edges.length,
    skus: node.variants.edges.map((e) => e.node.sku).filter(Boolean).join(', '),
    variants: node.variants.edges.map((e) => ({
      title: e.node.title ?? null,
      sku: e.node.sku ?? null,
      inventoryQuantity: e.node.inventoryQuantity ?? null,
    })),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  }));
  return rowsToResult(rows);
}

export type ListCustomersInput = {
  query?: string;
  limit?: number;
};

export async function listCustomers(
  conn: ShopifyConnectInfo,
  input: ListCustomersInput,
): Promise<RecordResult> {
  const limit = clamp(input.limit, 1, MAX_LIST_LIMIT_EXPORT, DEFAULT_LIST_LIMIT_EXPORT);
  const data = await queryCustomers(conn, limit, input.query ?? null);

  const rows = data.customers.edges.map(({ node }) => ({
    id: node.id,
    email: node.email ?? null,
    name: node.displayName ?? null,
    createdAt: node.createdAt,
    orderCount: Number(node.numberOfOrders),
    totalSpent: Number(node.amountSpent.amount),
    currency: node.amountSpent.currencyCode,
    state: node.state,
    country: node.defaultAddress?.country ?? null,
    city: node.defaultAddress?.city ?? null,
    lastOrderAt: node.lastOrder?.createdAt ?? null,
    lastOrderNumber: node.lastOrder?.name ?? null,
  }));
  return rowsToResult(rows);
}
