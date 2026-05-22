import { CORE_FETCH_GRAPHQL, CS_FETCH_GRAPHQL } from '../commerce.js';
import {
  inferMultiInputTypeFromTitle,
  isMultiValueInputType,
  parseBundleOptionUid,
  parseCanChangeQuantity,
  supportsCartQtyProbe,
} from './bundle-options.js';

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
                  values { quantity }
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

function hasMagentoBundleMeta(magentoMeta = {}) {
  return Object.keys(magentoMeta.selections || {}).length > 0;
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
    CORE_FETCH_GRAPHQL.fetchGraphQl(CREATE_GUEST_CART_MUTATION, {}),
    CART_PROBE_TIMEOUT_MS,
  );

  if (errors?.length) {
    return null;
  }

  return data?.createGuestCart?.cart?.id || null;
}

function readCartSelectionQuantity(addToCartResult) {
  const items = addToCartResult?.cart?.itemsV2?.items || [];
  const bundleItems = items.filter((item) => item?.bundle_options?.length);
  const latestItem = bundleItems[bundleItems.length - 1];
  const firstValue = latestItem?.bundle_options?.[0]?.values?.[0];

  if (firstValue?.quantity === undefined) {
    return null;
  }

  return Number(firstValue.quantity);
}

/**
 * ACCS replaces core products(filter:) with Catalog Service, which omits
 * can_change_quantity. Probe via cart: fixed-qty selections ignore entered_options,
 * user-defined selections honor them.
 */
async function probeSelectionCanChangeQuantity(sku, uid, defaultQuantity, cartId) {
  const probeQty = Math.max(Number(defaultQuantity) + 1, 2);

  try {
    const { data, errors } = await withTimeout(
      CORE_FETCH_GRAPHQL.fetchGraphQl(
        buildProbeBundleQtyMutation(sku, uid, probeQty),
        { variables: { cartId } },
      ),
      CART_PROBE_TIMEOUT_MS,
    );

    if (errors?.length || data?.addProductsToCart?.user_errors?.length) {
      return false;
    }

    const cartQty = readCartSelectionQuantity(data?.addProductsToCart);
    if (cartQty === null || Number.isNaN(cartQty)) {
      return false;
    }

    return cartQty === probeQty;
  } catch {
    return false;
  }
}

async function probeCanChangeQuantityFromCart(sku, meta) {
  if (!sku || !meta?.selections) {
    return meta;
  }

  applyFixedQuantityForMultiValueOptions(meta);

  const probeTargets = collectPrimarySelectionUids(meta.selections)
    .map((uid) => ({ uid, entry: meta.selections[uid] }))
    .filter(({ entry }) => supportsCartQtyProbe(
      resolveSelectionInputType(meta.optionTypes, entry),
    ));

  if (!probeTargets.length) {
    return meta;
  }

  const cartId = await createGuestCartId();
  if (!cartId) {
    return meta;
  }

  await probeTargets.reduce(async (chain, { uid, entry }) => {
    await chain;
    const defaultQuantity = Math.max(1, Number(entry.defaultQuantity) || 1);
    const canChangeQuantity = await probeSelectionCanChangeQuantity(
      sku,
      uid,
      defaultQuantity,
      cartId,
    );

    applyCanChangeQuantityToSelection(meta, uid, canChangeQuantity, entry);
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

  if (!hasMagentoBundleMeta(magentoMeta)) {
    await probeCanChangeQuantityFromCart(sku, merged);
  } else {
    applyFixedQuantityForMultiValueOptions(merged);
  }

  return merged;
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
