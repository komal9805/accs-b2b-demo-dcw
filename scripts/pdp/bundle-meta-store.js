/** @type {object|null} */
let productBundleMeta = null;

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
