/** @type {object|null} */
let productBundleMeta = null;

const CAN_CHANGE_QTY_CACHE_KEY = 'accs-bundle-can-change-qty';

function buildSelectionCacheKey(entry) {
  if (entry?.optionId != null && entry?.selectionId != null) {
    return `${entry.optionId}:${entry.selectionId}`;
  }

  if (entry?.sku) {
    return `sku:${entry.sku}`;
  }

  return null;
}

/**
 * Persists bundle option meta (input types, default qty, can_change_quantity)
 * so it survives pdp/data refreshes from fetchProductData.
 */
export function setProductBundleMeta(meta) {
  productBundleMeta = meta;
}

export function getProductBundleMeta() {
  return productBundleMeta;
}

export function getCachedCanChangeQuantityMap(sku) {
  if (!sku) {
    return {};
  }

  try {
    const raw = sessionStorage.getItem(CAN_CHANGE_QTY_CACHE_KEY);
    if (!raw) {
      return {};
    }

    return JSON.parse(raw)[sku] || {};
  } catch {
    return {};
  }
}

export function getCachedCanChangeQuantity(sku, entry) {
  const key = buildSelectionCacheKey(entry);
  if (!key) {
    return undefined;
  }

  return getCachedCanChangeQuantityMap(sku)[key];
}

export function setCachedCanChangeQuantity(sku, entry, canChangeQuantity) {
  const key = buildSelectionCacheKey(entry);
  if (!sku || !key || canChangeQuantity === undefined || canChangeQuantity === null) {
    return;
  }

  try {
    const raw = sessionStorage.getItem(CAN_CHANGE_QTY_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    cache[sku] = {
      ...(cache[sku] || {}),
      [key]: canChangeQuantity === true,
    };
    sessionStorage.setItem(CAN_CHANGE_QTY_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore storage errors (private mode / quota).
  }
}
