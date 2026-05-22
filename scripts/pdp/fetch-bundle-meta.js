import { CORE_FETCH_GRAPHQL, CS_FETCH_GRAPHQL } from '../commerce.js';
import {
  applyBundleProductTransform,
  buildBundleItemMeta,
  getSelectionCanChangeQuantityFlag,
  inferMultiInputTypeFromTitle,
  isMultiValueInputType,
  isSelectionCanChangeQuantityResolved,
  parseBundleOptionUid,
  parseCanChangeQuantity,
  resolveBundleOptionInputType,
  supportsCartQtyProbe,
} from './bundle-options.js';
import {
  getCachedCanChangeQuantity,
  getCachedCanChangeQuantityMap,
  getProductBundleMeta,
  setCachedCanChangeQuantity,
  setProductBundleMeta,
} from './bundle-meta-store.js';

const MAGENTO_BUNDLE_QUERY = `
  query GetBundleOptionTypes($sku: String!) {
    products(filter: { sku: { eq: $sku } }) {
      items {
        ... on BundleProduct {
          items {
            uid
            title
            required
            type
            options {
              uid
              label
              quantity
              can_change_quantity
              is_default
              product {
                sku
              }
            }
          }
        }
      }
    }
  }
`;

const CATALOG_BUNDLE_QUERY = `
  query GetCatalogBundleMeta($skus: [String!]) {
    products(skus: $skus) {
      ... on ComplexProductView {
        sku
        options {
          id
          title
          required
          multi
          values {
            id
            title
            ... on ProductViewOptionValueProduct {
              quantity
              isDefault
              product {
                sku
              }
            }
          }
        }
      }
    }
  }
`;

const MAGENTO_TYPE_MAP = {
  select: 'dropdown',
  radio: 'radio',
  checkbox: 'checkbox',
  multi: 'multiselect',
};

const CORE_META_TIMEOUT_MS = 5000;
const CART_PROBE_TIMEOUT_MS = 8000;

const CREATE_GUEST_CART_MUTATION = `
  mutation CreateGuestCartForBundleProbe {
    createGuestCart {
      cart { id }
    }
  }
`;

function escapeGraphqlString(value) {
  return JSON.stringify(String(value));
}

function buildProbeBundleQtyMutation(sku, uid, probeQty) {
  return `
    mutation ProbeBundleSelectionQty($cartId: String!) {
      addProductsToCart(
        cartId: $cartId
        cartItems: [{
          sku: ${escapeGraphqlString(sku)}
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

function isAdminDefaultFlag(value) {
  return value === true || value === 1 || value === '1';
}

function parseOptionIdFromUid(uid) {
  if (!uid) return null;

  try {
    const decoded = atob(uid);
    if (!decoded.startsWith('bundle/')) return null;
    return decoded.split('/')[1] || null;
  } catch {
    return null;
  }
}

function mapMagentoType(type) {
  return MAGENTO_TYPE_MAP[type] || type;
}

function inferCatalogInputType(option, allOptions = []) {
  const isMulti = option.multiple ?? option.multi;

  if (isMulti) {
    return inferMultiInputTypeFromTitle(option.title || option.label || '');
  }

  const singleSelectOptions = allOptions.filter(
    (entry) => !(entry.multiple ?? entry.multi),
  );
  const singleSelectIndex = singleSelectOptions.findIndex(
    (entry) => entry.id === option.id,
  );

  // First single-select option is typically radio; additional ones are drop-down in admin.
  return singleSelectIndex <= 0 ? 'radio' : 'dropdown';
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('fetchBundleCoreMeta timeout')), ms);
    }),
  ]);
}

function indexSelection(selections, key, data) {
  selections[key] = { ...selections[key], ...data };

  const {
    optionId, selectionId, optionTitle, label,
  } = data;
  if (optionId && selectionId) {
    selections[`${optionId}:${selectionId}`] = {
      ...(selections[`${optionId}:${selectionId}`] || {}),
      ...data,
    };
  }
  if (optionTitle && label) {
    const normalizedTitle = String(optionTitle).trim();
    const normalizedLabel = String(label).trim();
    selections[`label:${normalizedTitle}:${normalizedLabel}`] = {
      ...(selections[`label:${normalizedTitle}:${normalizedLabel}`] || {}),
      ...data,
      optionTitle: normalizedTitle,
      label: normalizedLabel,
    };
  }
  if (data.sku) {
    selections[`sku:${data.sku}`] = {
      ...(selections[`sku:${data.sku}`] || {}),
      ...data,
    };
  }
}

/**
 * Builds bundle meta from Catalog Service product data (quantities + inferred types).
 */
export function buildCatalogBundleMetaFromProduct(rawProduct) {
  const optionTypes = {};
  const selections = {};
  const allOptions = rawProduct?.options || [];

  allOptions.forEach((option) => {
    const label = (option.title || option.label || '').trim();
    const inputType = inferCatalogInputType(option, allOptions);

    optionTypes[option.id] = inputType;
    if (label) {
      optionTypes[`title:${label}`] = inputType;
    }

    const values = option.values?.length ? option.values : (option.items || []);

    values.forEach((value) => {
      const isProductValue = value.__typename === 'ProductViewOptionValueProduct'
        || value.typename === 'ProductViewOptionValueProduct'
        || value.product;
      if (!isProductValue) return;

      const parsed = parseBundleOptionUid(value.id);
      const optionId = parsed?.optionId ?? option.id;
      const selectionId = parsed?.selectionId;
      const defaultQuantity = Math.max(
        1,
        Number(value.quantity ?? value.defaultQuantity ?? parsed?.quantity) || 1,
      );

      indexSelection(selections, value.id, {
        defaultQuantity,
        optionId,
        selectionId,
        optionTitle: label,
        label: value.title || value.label,
        sku: value.product?.sku,
        ...(isAdminDefaultFlag(value.isDefault) ? { isDefault: true } : {}),
      });
    });
  });

  return { optionTypes, selections };
}

async function fetchMagentoBundleMeta(sku) {
  const empty = { optionTypes: {}, selections: {} };

  if (!sku) {
    return empty;
  }

  try {
    const { data, errors } = await withTimeout(
      CORE_FETCH_GRAPHQL.fetchGraphQl(MAGENTO_BUNDLE_QUERY, {
        variables: { sku },
      }),
      CORE_META_TIMEOUT_MS,
    );

    if (errors?.length || !data?.products?.items?.length) {
      return empty;
    }

    const optionTypes = {};
    const selections = {};

    data.products.items[0].items?.forEach((item) => {
      const optionId = parseOptionIdFromUid(item.uid);
      const inputType = mapMagentoType(item.type);

      if (optionId) {
        optionTypes[optionId] = inputType;
      }

      if (item.title) {
        optionTypes[`title:${item.title}`] = inputType;
      }

      item.options?.forEach((selection) => {
        const parsed = parseBundleOptionUid(selection.uid);
        const selectionId = parsed?.selectionId;
        const selectionSku = selection.product?.sku;

        indexSelection(selections, selection.uid, {
          ...(isAdminDefaultFlag(selection.is_default) ? { isDefault: true } : {}),
          canChangeQuantity: parseCanChangeQuantity(selection.can_change_quantity) ?? false,
          defaultQuantity: Math.max(1, Number(selection.quantity) || 1),
          optionId,
          selectionId,
          optionTitle: item.title,
          label: selection.label,
          sku: selectionSku,
        });
      });
    });

    return { optionTypes, selections };
  } catch {
    return empty;
  }
}

async function fetchCatalogBundleMeta(sku) {
  const empty = { optionTypes: {}, selections: {} };

  if (!sku) {
    return empty;
  }

  try {
    const { data, errors } = await withTimeout(
      CS_FETCH_GRAPHQL.fetchGraphQl(CATALOG_BUNDLE_QUERY, {
        variables: { skus: [sku] },
      }),
      CORE_META_TIMEOUT_MS,
    );

    if (errors?.length) {
      return empty;
    }

    const product = data?.products?.[0];
    if (!product) {
      return empty;
    }

    return buildCatalogBundleMetaFromProduct(product);
  } catch {
    return empty;
  }
}

function mergeBundleMetaSources(...sources) {
  const optionTypes = {};
  const selections = {};

  sources.forEach((source) => {
    Object.assign(optionTypes, source?.optionTypes || {});
    Object.entries(source?.selections || {}).forEach(([key, value]) => {
      selections[key] = { ...(selections[key] || {}), ...value };
    });
  });

  return { optionTypes, selections };
}

function resolveSelectionInputType(optionTypes, entry) {
  if (entry?.optionId && optionTypes[entry.optionId]) {
    return optionTypes[entry.optionId];
  }

  if (entry?.optionTitle) {
    return optionTypes[`title:${entry.optionTitle}`];
  }

  return undefined;
}

function collectPrimarySelectionUids(selections = {}) {
  return Object.keys(selections).filter((key) => parseBundleOptionUid(key));
}

function applyCanChangeQuantityToSelection(meta, uid, canChangeQuantity, entry) {
  indexSelection(meta.selections, uid, {
    ...entry,
    canChangeQuantity,
  });
}

function applyFixedQuantityForMultiValueOptions(meta) {
  const { optionTypes = {}, selections = {} } = meta;

  collectPrimarySelectionUids(selections).forEach((uid) => {
    const entry = selections[uid];
    const inputType = resolveSelectionInputType(optionTypes, entry);

    if (isMultiValueInputType(inputType)) {
      applyCanChangeQuantityToSelection(meta, uid, false, entry);
    }
  });
}

async function createGuestCartId() {
  const { data, errors } = await withTimeout(
    CS_FETCH_GRAPHQL.fetchGraphQl(CREATE_GUEST_CART_MUTATION, {}),
    CART_PROBE_TIMEOUT_MS,
  );

  if (errors?.length) {
    return null;
  }

  return data?.createGuestCart?.cart?.id || null;
}

function selectionIdsMatch(targetUid, cartValueUid) {
  if (targetUid === cartValueUid) {
    return true;
  }

  const target = parseBundleOptionUid(targetUid);
  const cartValue = parseBundleOptionUid(cartValueUid);
  const hasTargetIds = target?.optionId && target?.selectionId;
  const hasCartIds = cartValue?.optionId && cartValue?.selectionId;

  if (!hasTargetIds || !hasCartIds) {
    return false;
  }

  return String(target.optionId) === String(cartValue.optionId)
    && String(target.selectionId) === String(cartValue.selectionId);
}

function readCartSelectionQuantity(addToCartResult, selectionUid) {
  const items = addToCartResult?.cart?.itemsV2?.items || [];

  for (let i = items.length - 1; i >= 0; i -= 1) {
    const bundleOptions = items[i]?.bundle_options || [];

    const matchedValue = bundleOptions.reduce((found, option) => {
      if (found) {
        return found;
      }

      return option?.values?.find((value) => (
        selectionIdsMatch(selectionUid, value?.uid)
      )) || null;
    }, null);

    if (matchedValue?.quantity !== undefined && matchedValue?.quantity !== null) {
      return Number(matchedValue.quantity);
    }
  }

  return null;
}

/**
 * ACCS has no can_change_quantity on Catalog Service. Probe cart behavior instead.
 * @returns {boolean|null} true = user-defined, false = fixed, null = probe failed
 */
async function probeSelectionCanChangeQuantity(sku, uid, defaultQuantity) {
  const defaultQty = Math.max(1, Number(defaultQuantity) || 1);
  const probeQty = defaultQty + 1;
  const cartId = await createGuestCartId();

  if (!cartId) {
    return null;
  }

  try {
    const { data, errors } = await withTimeout(
      CS_FETCH_GRAPHQL.fetchGraphQl(
        buildProbeBundleQtyMutation(sku, uid, probeQty),
        { variables: { cartId } },
      ),
      CART_PROBE_TIMEOUT_MS,
    );

    if (errors?.length || data?.addProductsToCart?.user_errors?.length) {
      return null;
    }

    const cartQty = readCartSelectionQuantity(data?.addProductsToCart, uid);
    if (cartQty === null || Number.isNaN(cartQty)) {
      return null;
    }

    return cartQty === probeQty;
  } catch {
    return null;
  }
}

async function probeSelectionWithRetry(sku, uid, defaultQuantity) {
  const firstAttempt = await probeSelectionCanChangeQuantity(sku, uid, defaultQuantity);
  if (firstAttempt !== null) {
    return firstAttempt;
  }

  return probeSelectionCanChangeQuantity(sku, uid, defaultQuantity);
}

function applyCachedCanChangeQuantity(sku, meta) {
  const cached = getCachedCanChangeQuantityMap(sku);

  collectPrimarySelectionUids(meta.selections).forEach((uid) => {
    const entry = meta.selections[uid];
    let cacheKey = null;

    if (entry?.optionId != null && entry?.selectionId != null) {
      cacheKey = `${entry.optionId}:${entry.selectionId}`;
    } else if (entry?.sku) {
      cacheKey = `sku:${entry.sku}`;
    }

    if (cacheKey === null || cached[cacheKey] === undefined) {
      return;
    }

    applyCanChangeQuantityToSelection(meta, uid, cached[cacheKey], entry);
  });
}

function clearProbedCanChangeQuantityFlags(meta) {
  collectPrimarySelectionUids(meta.selections || {}).forEach((uid) => {
    const entry = meta.selections[uid];
    if (!entry) {
      return;
    }

    const inputType = resolveSelectionInputType(meta.optionTypes, entry);
    if (!supportsCartQtyProbe(inputType)) {
      return;
    }

    const keys = new Set([uid]);
    if (entry.optionId != null && entry.selectionId != null) {
      keys.add(`${entry.optionId}:${entry.selectionId}`);
    }
    if (entry.sku) {
      keys.add(`sku:${entry.sku}`);
    }
    if (entry.optionTitle && entry.label) {
      keys.add(`label:${entry.optionTitle}:${entry.label}`);
    }

    keys.forEach((key) => {
      if (meta.selections[key]) {
        delete meta.selections[key].canChangeQuantity;
      }
    });
  });
}

async function probeCanChangeQuantityFromCart(sku, meta, { force = false } = {}) {
  if (!sku || !meta?.selections) {
    return meta;
  }

  applyFixedQuantityForMultiValueOptions(meta);

  if (force) {
    clearProbedCanChangeQuantityFlags(meta);
  } else {
    applyCachedCanChangeQuantity(sku, meta);
  }

  const probeTargets = collectPrimarySelectionUids(meta.selections)
    .map((uid) => ({ uid, entry: meta.selections[uid] }))
    .filter(({ entry }) => supportsCartQtyProbe(
      resolveSelectionInputType(meta.optionTypes, entry),
    ))
    .filter(({ entry }) => (
      parseCanChangeQuantity(entry.canChangeQuantity) === undefined
    ));

  await probeTargets.reduce(async (chain, { uid, entry }) => {
    await chain;

    const cached = getCachedCanChangeQuantity(sku, entry);
    if (cached !== undefined) {
      applyCanChangeQuantityToSelection(meta, uid, cached, entry);
      return;
    }

    const defaultQuantity = Math.max(
      1,
      Number(entry.defaultQuantity) || parseBundleOptionUid(uid)?.quantity || 1,
    );
    const canChangeQuantity = await probeSelectionWithRetry(
      sku,
      uid,
      defaultQuantity,
    );

    if (canChangeQuantity === null) {
      return;
    }

    applyCanChangeQuantityToSelection(meta, uid, canChangeQuantity, entry);
    setCachedCanChangeQuantity(sku, entry, canChangeQuantity);
  }, Promise.resolve());

  return meta;
}

/**
 * Fetches bundle meta from Magento core GraphQL when available, with Catalog Service fallback.
 */
export async function fetchBundleCoreMeta(sku, rawProduct = null) {
  const catalogPromise = rawProduct
    ? Promise.resolve(buildCatalogBundleMetaFromProduct(rawProduct))
    : fetchCatalogBundleMeta(sku);

  const [magentoMeta, catalogMeta] = await Promise.all([
    fetchMagentoBundleMeta(sku),
    catalogPromise,
  ]);

  const merged = mergeBundleMetaSources(catalogMeta, magentoMeta);
  applyFixedQuantityForMultiValueOptions(merged);

  return merged;
}

/**
 * Probes a single selection when its user-defined qty flag is not yet known.
 */
export async function ensureSelectionCanChangeQuantity(sku, item, option) {
  const meta = getProductBundleMeta();
  if (!sku || !item?.id || !meta) {
    return false;
  }

  const inputType = resolveBundleOptionInputType(option, meta);
  if (!supportsCartQtyProbe(inputType)) {
    return false;
  }

  if (isSelectionCanChangeQuantityResolved(item, option, meta)) {
    return getSelectionCanChangeQuantityFlag(item, option, meta) === true;
  }

  const entry = meta.selections?.[item.id] || {};
  const defaultQuantity = Math.max(
    1,
    Number(entry.defaultQuantity) || parseBundleOptionUid(item.id)?.quantity || 1,
  );
  const result = await probeSelectionWithRetry(sku, item.id, defaultQuantity);

  if (result === null) {
    return false;
  }

  applyCanChangeQuantityToSelection(meta, item.id, result, {
    ...entry,
    optionId: entry.optionId ?? parseBundleOptionUid(item.id)?.optionId,
    selectionId: entry.selectionId ?? parseBundleOptionUid(item.id)?.selectionId,
    sku: entry.sku ?? item.product?.sku,
    label: entry.label ?? item.label ?? item.title,
    optionTitle: entry.optionTitle ?? option.title ?? option.label,
  });
  setCachedCanChangeQuantity(sku, meta.selections[item.id], result);

  if (meta.items?.[item.id]) {
    meta.items[item.id] = { ...meta.items[item.id], canChangeQuantity: result };
  }

  setProductBundleMeta({
    ...meta,
    selections: { ...meta.selections },
    items: meta.items ? { ...meta.items } : meta.items,
  });

  return result === true;
}

/**
 * Probes every radio/dropdown selection and refreshes bundle product options.
 */
export async function ensureAllCanChangeQuantityMeta(sku, rawProduct) {
  if (!sku || !rawProduct?.options?.length) {
    return rawProduct;
  }

  const current = getProductBundleMeta() || {};
  const catalogMeta = buildCatalogBundleMetaFromProduct(rawProduct);
  const optionTypes = mergeBundleOptionTypes(rawProduct, {
    optionTypes: { ...catalogMeta.optionTypes, ...current.optionTypes },
  });
  const metaForProbe = {
    optionTypes,
    selections: { ...catalogMeta.selections, ...current.selections },
  };

  await probeCanChangeQuantityFromCart(sku, metaForProbe, { force: true });

  const bundleMetaContext = { ...metaForProbe, sku, optionTypes };
  const bundleItemMeta = buildBundleItemMeta(rawProduct, bundleMetaContext);
  const productBundleMeta = {
    sku,
    ...bundleItemMeta,
    optionTypes,
    selections: metaForProbe.selections,
  };

  setProductBundleMeta(productBundleMeta);
  return applyBundleProductTransform(rawProduct);
}

/**
 * Re-runs cart probe for can_change_quantity and refreshes in-memory bundle meta + product options.
 */
export async function syncBundleCanChangeQuantityMeta(sku, rawProduct) {
  return ensureAllCanChangeQuantityMeta(sku, rawProduct);
}

/**
 * Maps core/catalog option types onto Catalog Service option ids by title.
 */
export function mergeBundleOptionTypes(rawProduct, coreMeta = {}) {
  const optionTypes = { ...(coreMeta.optionTypes || {}) };

  rawProduct?.options?.forEach((option) => {
    if (optionTypes[option.id]) {
      return;
    }

    const label = option.title || option.label || '';
    const titleKey = `title:${label}`;
    if (optionTypes[titleKey]) {
      optionTypes[option.id] = optionTypes[titleKey];
    }
  });

  return optionTypes;
}
