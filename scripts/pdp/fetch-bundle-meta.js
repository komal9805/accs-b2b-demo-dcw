import { CORE_FETCH_GRAPHQL, CS_FETCH_GRAPHQL } from '../commerce.js';
import {
  inferMultiInputTypeFromTitle,
  parseBundleOptionUid,
  resolveCanChangeQuantity,
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

  const { optionId, selectionId, optionTitle, label } = data;
  if (optionId && selectionId) {
    selections[`${optionId}:${selectionId}`] = {
      ...(selections[`${optionId}:${selectionId}`] || {}),
      ...data,
    };
  }
  if (optionTitle && label) {
    selections[`label:${optionTitle}:${label}`] = {
      ...(selections[`label:${optionTitle}:${label}`] || {}),
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
        ...(isAdminDefaultFlag(value.isDefault) ? { isDefault: true } : {}),
        canChangeQuantity: resolveCanChangeQuantity(inputType, {}),
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

        indexSelection(selections, selection.uid, {
          ...(isAdminDefaultFlag(selection.is_default) ? { isDefault: true } : {}),
          ...(selection.can_change_quantity !== undefined && selection.can_change_quantity !== null
            ? { canChangeQuantity: Boolean(selection.can_change_quantity) }
            : {}),
          defaultQuantity: Math.max(1, Number(selection.quantity) || 1),
          optionId,
          selectionId,
          optionTitle: item.title,
          label: selection.label,
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

/**
 * Fetches bundle meta from Magento core GraphQL when available, with Catalog Service fallback.
 */
export async function fetchBundleCoreMeta(sku, rawProduct = null) {
  const [magentoMeta, catalogFromProduct, catalogFromApi] = await Promise.all([
    fetchMagentoBundleMeta(sku),
    rawProduct
      ? Promise.resolve(buildCatalogBundleMetaFromProduct(rawProduct))
      : Promise.resolve({ optionTypes: {}, selections: {} }),
    fetchCatalogBundleMeta(sku),
  ]);

  return mergeBundleMetaSources(catalogFromProduct, catalogFromApi, magentoMeta);
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
