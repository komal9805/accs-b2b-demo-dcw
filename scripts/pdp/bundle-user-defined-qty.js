import { getConfigValue, getHeaders } from '@dropins/tools/lib/aem/configs.js';
import {
  getBundleInputType,
  parseBundleOptionUid,
  resolveBundleOptionInputType,
  supportsUserDefinedQuantity,
} from './bundle-options.js';
import { getProductBundleMeta } from './bundle-meta-store.js';

const CACHE_KEY = 'bundle-user-defined-qty-v2';
const PROBE_TIMEOUT_MS = 12000;

/** @type {Map<string, boolean>} */
const memoryCache = new Map();

function getGraphqlEndpoint() {
  return getConfigValue('commerce-core-endpoint')
    || getConfigValue('commerce-endpoint')
    || '';
}

function getGraphqlHeaders() {
  return {
    'Content-Type': 'application/json',
    ...getHeaders('all'),
    ...getHeaders('cs'),
  };
}

export function getSelectionSku(item) {
  return item?.product?.sku || item?.sku || null;
}

function cacheKey(bundleSku, selectionSku) {
  return `${bundleSku}:${selectionSku}`;
}

function readSessionCache(bundleSku) {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw)[bundleSku] || {}) : {};
  } catch {
    return {};
  }
}

function writeSessionCache(bundleSku, selectionSku, value) {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[bundleSku] = { ...(all[bundleSku] || {}), [selectionSku]: value };
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

function escapeGraphqlString(value) {
  return JSON.stringify(String(value));
}

function buildAddToCartMutation(bundleSku, uid, probeQty) {
  return `
    mutation ProbeBundleQty($cartId: String!) {
      addProductsToCart(
        cartId: $cartId
        cartItems: [{
          sku: ${escapeGraphqlString(bundleSku)}
          quantity: 1
          selected_options: [${escapeGraphqlString(uid)}]
          entered_options: [{
            uid: ${escapeGraphqlString(uid)}
            value: ${escapeGraphqlString(String(probeQty))}
          }]
        }]
      ) {
        cart {
          itemsV2 {
            items {
              ... on BundleCartItem {
                bundle_options {
                  values { uid quantity }
                }
              }
            }
          }
        }
        user_errors { message }
      }
    }
  `;
}

const CREATE_GUEST_CART = `
  mutation CreateGuestCart { createGuestCart { cart { id } } }
`;

function selectionIdsMatch(targetUid, cartUid) {
  if (targetUid === cartUid) return true;
  const a = parseBundleOptionUid(targetUid);
  const b = parseBundleOptionUid(cartUid);
  if (!a?.optionId || !a?.selectionId || !b?.optionId || !b?.selectionId) return false;
  return String(a.optionId) === String(b.optionId)
    && String(a.selectionId) === String(b.selectionId);
}

function readQtyFromCart(cartPayload, uid) {
  const items = cartPayload?.cart?.itemsV2?.items || [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const values = (items[i]?.bundle_options || []).flatMap((o) => o?.values || []);
    const match = values.find((v) => selectionIdsMatch(uid, v?.uid));
    if (match?.quantity != null) return Number(match.quantity);
  }
  return null;
}

async function graphqlRequest(query, variables = {}) {
  const endpoint = getGraphqlEndpoint();
  if (!endpoint) {
    throw new Error('GraphQL endpoint not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: getGraphqlHeaders(),
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error(payload.errors[0]?.message || 'GraphQL error');
    }
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

async function createGuestCartId() {
  const data = await graphqlRequest(CREATE_GUEST_CART);
  return data?.createGuestCart?.cart?.id || null;
}

/**
 * Probe cart: entered qty honored = user-defined for this selection SKU.
 * Returns true/false on success, undefined if probe could not run.
 */
async function probeUserDefinedQty(bundleSku, item, { force = false } = {}) {
  const selectionSku = getSelectionSku(item);
  const uid = item?.id;
  if (!bundleSku || !selectionSku || !uid) return undefined;

  const key = cacheKey(bundleSku, selectionSku);

  if (!force) {
    if (memoryCache.has(key)) return memoryCache.get(key);
    const session = readSessionCache(bundleSku);
    if (session[selectionSku] !== undefined) {
      memoryCache.set(key, session[selectionSku]);
      return session[selectionSku];
    }
  } else {
    memoryCache.delete(key);
  }

  const defaultQty = Math.max(1, Number(parseBundleOptionUid(uid)?.quantity) || 1);
  const probeQty = defaultQty + 1;

  try {
    const cartId = await createGuestCartId();
    if (!cartId) return undefined;

    const data = await graphqlRequest(
      buildAddToCartMutation(bundleSku, uid, probeQty),
      { cartId },
    );

    if (data?.addProductsToCart?.user_errors?.length) return undefined;

    const cartQty = readQtyFromCart(data?.addProductsToCart, uid);
    if (cartQty === null || Number.isNaN(cartQty)) return undefined;

    const userDefined = cartQty === probeQty;
    memoryCache.set(key, userDefined);
    writeSessionCache(bundleSku, selectionSku, userDefined);
    return userDefined;
  } catch {
    return undefined;
  }
}

function resolveOptionInputType(option) {
  const meta = getProductBundleMeta();
  return option?.bundleInputType
    || resolveBundleOptionInputType(option, meta)
    || getBundleInputType(option);
}

function collectRadioDropdownItems(options = []) {
  const items = [];
  options.forEach((option) => {
    const inputType = resolveOptionInputType(option);
    if (!supportsUserDefinedQuantity(inputType)) return;
    (option.items || []).forEach((item) => {
      if (getSelectionSku(item)) items.push(item);
    });
  });
  return items;
}

export function getUserDefinedQtyBySku(bundleSku, selectionSku) {
  if (!bundleSku || !selectionSku) return undefined;
  const key = cacheKey(bundleSku, selectionSku);
  if (memoryCache.has(key)) return memoryCache.get(key);
  const session = readSessionCache(bundleSku);
  if (session[selectionSku] !== undefined) {
    memoryCache.set(key, session[selectionSku]);
    return session[selectionSku];
  }
  return undefined;
}

export async function resolveUserDefinedQtyForItem(bundleSku, item, options = {}) {
  return probeUserDefinedQty(bundleSku, item, options);
}

export async function resolveAllUserDefinedQty(bundleSku, options = []) {
  const items = collectRadioDropdownItems(options);
  const results = {};

  await items.reduce(async (chain, item) => {
    await chain;
    const sku = getSelectionSku(item);
    const value = await probeUserDefinedQty(bundleSku, item);
    if (value !== undefined) {
      results[sku] = value;
    }
  }, Promise.resolve());

  return results;
}

export async function resolveSelectedUserDefinedQty(bundleSku, options = [], selectedMap = {}) {
  const results = {};

  await Object.entries(selectedMap).reduce(async (chain, [optionId, selectedValue]) => {
    await chain;
    if (!selectedValue) return;

    const option = options.find(({ id }) => id === optionId);
    if (!option) return;

    const inputType = resolveOptionInputType(option);
    if (!supportsUserDefinedQuantity(inputType)) return;

    const selectedId = Array.isArray(selectedValue) ? selectedValue[0] : selectedValue;
    const item = option.items?.find(({ id }) => id === selectedId);
    const sku = getSelectionSku(item);
    if (!item || !sku) return;

    const value = await probeUserDefinedQty(bundleSku, item, { force: true });
    if (value !== undefined) {
      results[sku] = value;
    }
  }, Promise.resolve());

  return results;
}
