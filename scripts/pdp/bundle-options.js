import { events } from '@dropins/tools/event-bus.js';
import {
  fetchProductData,
  getProductConfigurationValues,
  setProductConfigurationValues,
  setProductConfigurationValid,
} from '@dropins/storefront-pdp/api.js';
import { getProductBundleMeta, setProductBundleMeta } from './bundle-meta-store.js';

const BUNDLE_QTY_INPUT_TYPES = new Set(['radio', 'dropdown']);
const MULTI_VALUE_INPUT_TYPES = new Set(['checkbox', 'multiselect']);
const BUNDLE_PRICE_SYNC_DEBOUNCE_MS = 400;

/**
 * Magento admin "User Defined Qty" (GraphQL: can_change_quantity) applies to
 * bundle selections when explicitly enabled in admin.
 */
export function canCustomerChangeQuantity(inputType, canChangeQuantity) {
  if (!BUNDLE_QTY_INPUT_TYPES.has(inputType)) {
    return false;
  }

  return canChangeQuantity === true;
}

/**
 * Whether the selected bundle item allows customer qty edits on the storefront.
 */
export function canEditBundleOptionQuantity(inputType, selectedItem, meta = null, option = null) {
  if (!selectedItem?.id || !supportsUserDefinedQuantity(inputType)) {
    return false;
  }

  const bundleMeta = meta || getProductBundleMeta();
  if (bundleMeta && option) {
    return resolveItemCanChangeQuantity(selectedItem, option, bundleMeta);
  }

  return selectedItem.canChangeQuantity === true;
}

/**
 * When Catalog Service cannot expose input type, infer multiselect vs checkbox
 * from admin option title (e.g. "Multiple Carrying Bag" → multiselect).
 */
export function inferMultiInputTypeFromTitle(title = '') {
  const normalized = title.toLowerCase();
  if (
    normalized.includes('multiple')
    || normalized.includes('multi-select')
    || normalized.includes('multiselect')
  ) {
    return 'multiselect';
  }
  return 'checkbox';
}

function inferMultiInputType(option) {
  return inferMultiInputTypeFromTitle(option.title || option.label || '');
}

/**
 * Catalog Service exposes `multi` and `required` but not admin input type.
 * Prefer core GraphQL; fall back to multi/required heuristics.
 *
 * @see https://developer.adobe.com/commerce/services/graphql/catalog-service/products/#productviewoption-type
 */
export function getBundleInputType(option, typeOverride) {
  if (typeOverride) {
    return typeOverride;
  }

  const isMulti = option.multiple ?? option.multi;

  if (isMulti) {
    return inferMultiInputType(option);
  }

  // Single-select bundle options render as radio unless core GraphQL specifies dropdown.
  return 'radio';
}

/**
 * Magento admin "User Defined Qty" applies to radio and drop-down selections only.
 */
export function supportsUserDefinedQuantity(inputType) {
  return BUNDLE_QTY_INPUT_TYPES.has(inputType);
}

/**
 * Quantity map key – per option group for radio/dropdown.
 */
export function getBundleQuantityKey(option, item = null) {
  return option.id;
}

export function isDropdownInputType(inputType) {
  return inputType === 'dropdown';
}

export function isMultiValueInputType(inputType) {
  return MULTI_VALUE_INPUT_TYPES.has(inputType);
}

/**
 * Radio/dropdown selections support admin User Defined Qty and can be probed via cart.
 * Checkbox/multiselect use fixed default qty per Magento admin.
 */
export function supportsCartQtyProbe(inputType) {
  return supportsUserDefinedQuantity(inputType) && !isMultiValueInputType(inputType);
}

/**
 * Bundle option UIDs encode: bundle/{optionId}/{selectionId}/{quantity}
 */
export function parseBundleOptionUid(uid) {
  if (!uid) return null;

  const parsePath = (path) => {
    if (!path.startsWith('bundle/')) return null;

    const [, optionId, selectionId, quantity] = path.split('/');
    return {
      optionId,
      selectionId,
      quantity: Math.max(1, Number(quantity) || 1),
    };
  };

  try {
    return parsePath(atob(uid));
  } catch {
    return parsePath(String(uid));
  }
}

export function buildBundleOptionUid(optionId, selectionId, quantity = 1) {
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  return btoa(`bundle/${optionId}/${selectionId}/${qty}`);
}

/**
 * Aligns core/config type hints with Catalog Service multi/required flags.
 * Single-select options (!multi) must be radio or dropdown, never listbox/checkbox.
 */
function normalizeInputTypeOverride(option, override) {
  if (!override) {
    return undefined;
  }

  const isMulti = option.multiple ?? option.multi;

  if (!isMulti) {
    if (override === 'multiselect' || override === 'checkbox') {
      return option.required ? 'radio' : 'dropdown';
    }
    return override;
  }

  if (override === 'radio' || override === 'dropdown') {
    return inferMultiInputType(option);
  }

  return override;
}

function getOptionLabel(option) {
  return option.title || option.label || '';
}

function resolveOptionInputType(option, meta = {}) {
  const { optionTypes = {} } = meta;
  const label = getOptionLabel(option);
  const rawOverride = optionTypes[option.id] || optionTypes[`title:${label}`];

  if (rawOverride) {
    const override = normalizeInputTypeOverride(option, rawOverride);
    return getBundleInputType(option, override);
  }

  const perOptionType = meta.options?.[option.id]?.inputType;
  if (perOptionType) {
    return perOptionType;
  }

  return getBundleInputType(option, undefined);
}

/**
 * Resolves bundle input type for an option using persisted meta (core GraphQL + catalog).
 */
export function resolveBundleOptionInputType(option, meta = {}) {
  return resolveOptionInputType(option, meta);
}

function getCoreSelectionMeta(item, meta = {}, option = null) {
  const { selections = {} } = meta;
  const candidates = [];
  const parsed = parseBundleOptionUid(item.id);
  const itemLabel = (item.label || item.title || '').trim();
  const optionTitle = (option?.title || option?.label || '').trim();
  const sku = item.product?.sku;

  if (sku && selections[`sku:${sku}`]) {
    candidates.push(selections[`sku:${sku}`]);
  }

  if (selections[item.id]) {
    candidates.push(selections[item.id]);
  }

  if (parsed?.optionId && parsed?.selectionId) {
    const byIds = selections[`${parsed.optionId}:${parsed.selectionId}`];
    if (byIds) {
      candidates.push(byIds);
    }
  }

  if (optionTitle && itemLabel) {
    const byLabel = selections[`label:${optionTitle}:${itemLabel}`];
    if (byLabel) {
      candidates.push(byLabel);
    }
  }

  if (!candidates.some((entry) => parseCanChangeQuantity(entry.canChangeQuantity) !== undefined)) {
    const scanned = Object.values(selections).find((entry) => {
      if (sku && entry.sku === sku) {
        return true;
      }

      if (parsed?.selectionId && String(entry.selectionId) === String(parsed.selectionId)) {
        return !parsed.optionId || String(entry.optionId) === String(parsed.optionId);
      }

      if (!itemLabel || !optionTitle) {
        return false;
      }

      return (entry.label || '').trim() === itemLabel
        && (entry.optionTitle || '').trim() === optionTitle;
    });

    if (scanned) {
      candidates.push(scanned);
    }
  }

  return candidates.reduce((acc, entry) => {
    const merged = { ...acc, ...entry };
    const flag = parseCanChangeQuantity(entry.canChangeQuantity);
    if (flag !== undefined) {
      merged.canChangeQuantity = flag;
    }
    return merged;
  }, {});
}

/**
 * Resolves whether a bundle selection allows customer qty edits (from Magento meta).
 */
export function resolveItemCanChangeQuantity(item, option, meta) {
  if (!item?.id) {
    return false;
  }

  if (!meta?.selections || !Object.keys(meta.selections).length) {
    return item.canChangeQuantity === true;
  }

  const selectionMeta = getCoreSelectionMeta(item, meta, option);
  return parseCanChangeQuantity(selectionMeta.canChangeQuantity) === true;
}

export function parseCanChangeQuantity(value) {
  if (value === true || value === 1) {
    return true;
  }

  if (value === false || value === 0) {
    return false;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }

  return undefined;
}

function isBundleOption(option) {
  return getOptionSelections(option).some((value) => (
    value.__typename === 'ProductViewOptionValueProduct'
    || value.typename === 'ProductViewOptionValueProduct'
    || value.product?.sku
    || value.product
  ));
}

function isBundleProductOptions(options) {
  return options?.some(isBundleOption);
}

export function resolveSelectionAdminQuantity(item) {
  if (!item) return 1;

  return Math.max(
    1,
    Number(
      item.defaultQuantity
      ?? item.quantity
      ?? parseBundleOptionUid(item.id)?.quantity,
    ) || 1,
  );
}

function getOptionSelections(option) {
  if (option.values?.length) {
    return option.values;
  }
  return option.items || [];
}

function getBundleOptionGroupId(option) {
  const firstItem = option.items?.[0] || option.values?.[0];
  if (firstItem?.id) {
    return parseBundleOptionUid(firstItem.id)?.optionId ?? option.id;
  }
  return option.id;
}

/**
 * Builds metadata from raw Catalog Service product and optional core GraphQL meta.
 */
export function buildBundleItemMeta(rawProduct, meta = {}) {
  const items = {};
  const options = {};

  rawProduct?.options?.forEach((option) => {
    const inputType = resolveOptionInputType(option, meta);
    options[option.id] = { inputType };

    getOptionSelections(option).forEach((value) => {
      const isProductValue = value.__typename === 'ProductViewOptionValueProduct'
        || value.typename === 'ProductViewOptionValueProduct'
        || value.product;
      if (!isProductValue) return;

      const parsed = parseBundleOptionUid(value.id);
      const coreSelectionMeta = getCoreSelectionMeta(
        { id: value.id, product: value.product, label: value.title || value.label },
        meta,
        option,
      );
      const defaultQuantity = Math.max(
        1,
        Number(
          coreSelectionMeta.defaultQuantity
          ?? value.quantity
          ?? value.defaultQuantity
          ?? parsed?.quantity,
        ) || 1,
      );

      items[value.id] = {
        defaultQuantity,
        optionId: parsed?.optionId ?? option.id,
        selectionId: parsed?.selectionId,
        canChangeQuantity: resolveItemCanChangeQuantity(
          { id: value.id, product: value.product, label: value.title || value.label },
          option,
          meta,
        ),
        ...(coreSelectionMeta.isDefault === true ? { isDefault: true } : {}),
      };
    });
  });

  return { items, options };
}

function enrichBundleItem(item, option, meta, _bundleInputType) {
  const itemMeta = meta.items?.[item.id] || meta[item.id] || {};
  const coreSelectionMeta = getCoreSelectionMeta(item, meta, option);
  const parsed = parseBundleOptionUid(item.id);
  const defaultQuantity = Math.max(
    1,
    Number(
      itemMeta.defaultQuantity
      ?? coreSelectionMeta.defaultQuantity
      ?? item.quantity
      ?? item.defaultQuantity
      ?? parsed?.quantity,
    ) || 1,
  );
  const canChangeQuantity = resolveItemCanChangeQuantity(item, option, meta);
  const isDefault = coreSelectionMeta.isDefault === true || itemMeta.isDefault === true;

  return {
    ...item,
    defaultQuantity,
    bundleOptionId: itemMeta.optionId ?? parsed?.optionId ?? option.id,
    selectionId: itemMeta.selectionId ?? parsed?.selectionId,
    canChangeQuantity,
    isDefault,
  };
}

/**
 * ProductOptions optionsTransformer – maps bundle option types for the PDP drop-in.
 */
export function transformBundleOptions(options, meta = {}) {
  if (!options?.length || !isBundleProductOptions(options)) {
    return options;
  }

  return options.map((option) => {
    const bundleInputType = resolveOptionInputType(option, meta);
    const selections = getOptionSelections(option);

    return {
      ...option,
      bundleInputType,
      type: bundleInputType === 'dropdown' ? 'dropdown' : 'text',
      items: (option.items || selections).map(
        (item) => enrichBundleItem(item, option, meta, bundleInputType),
      ),
    };
  });
}

/**
 * ProductDetails transformer – applies bundle option mapping after drop-in transform.
 */
export function transformBundleProduct(data, meta = {}) {
  if (!data?.isBundle || !data?.options) {
    return data;
  }

  return {
    ...data,
    options: transformBundleOptions(data.options, meta),
  };
}

/**
 * Re-applies bundle transforms to product data after catalog refetches.
 */
export function applyBundleProductTransform(product) {
  const meta = getProductBundleMeta();
  if (!product?.isBundle || !meta) {
    return product;
  }

  const refreshed = buildBundleItemMeta(product, meta);
  const mergedMeta = {
    ...meta,
    items: { ...meta.items, ...refreshed.items },
    options: { ...meta.options, ...refreshed.options },
  };

  setProductBundleMeta(mergedMeta);

  return transformBundleProduct(product, mergedMeta);
}

export function formatBundleItemLabel(item, { includeFixedQuantity = false } = {}) {
  const qty = item.defaultQuantity ?? 1;
  const prefix = includeFixedQuantity ? `${qty} x ` : '';
  return prefix + item.label;
}

/**
 * Returns selected item ids for an option from the selection map.
 */
export function getSelectedItemIds(option, selectedMap) {
  const inputType = option.bundleInputType || getBundleInputType(option);
  const value = selectedMap[option.id];

  if (isMultiValueInputType(inputType)) {
    return Array.isArray(value) ? value : [];
  }

  return value ? [value] : [];
}

function resolveSelectionQuantity(
  inputType,
  option,
  quantityMap,
  item,
  meta = getProductBundleMeta(),
) {
  const canEdit = canEditBundleOptionQuantity(inputType, item, meta, option);
  const qtyKey = getBundleQuantityKey(option, item);
  const mappedQty = quantityMap[qtyKey] ?? quantityMap[option.id];

  if (canEdit && mappedQty !== undefined && mappedQty !== null) {
    const minQty = isDropdownInputType(inputType) && mappedQty === 0 ? 0 : 1;
    return Math.max(minQty, Number(mappedQty) || 0);
  }

  return Math.max(1, Number(item.defaultQuantity ?? 1) || 1);
}

/**
 * Builds cart-ready optionsUIDs and enteredOptions from bundle selections.
 * @see https://developer.adobe.com/commerce/webapi/graphql/schema/cart/mutations/add-products/
 */
export function buildBundleSelectionPayload(options, selectedMap, quantityMap = {}) {
  const optionsUIDs = [];
  const enteredOptions = [];

  options.forEach((option) => {
    const inputType = option.bundleInputType || getBundleInputType(option);
    const selectedIds = getSelectedItemIds(option, selectedMap);

    selectedIds.forEach((itemId) => {
      const item = option.items?.find(({ id }) => id === itemId);
      if (!item) return;

      const bundleMeta = getProductBundleMeta();
      const quantity = resolveSelectionQuantity(
        inputType,
        option,
        quantityMap,
        item,
        bundleMeta,
      );
      const uid = buildBundleOptionUid(
        item.bundleOptionId,
        item.selectionId ?? parseBundleOptionUid(item.id)?.selectionId,
        quantity,
      );

      optionsUIDs.push(uid);

      if (canEditBundleOptionQuantity(inputType, item, bundleMeta, option)) {
        enteredOptions.push({ uid, value: String(quantity) });
      }
    });
  });

  return { optionsUIDs, enteredOptions };
}

/**
 * Builds Magento-style summary lines for the current bundle configuration.
 * @returns {{ optionId: string, optionLabel: string, values: string[] }[]}
 */
export function buildBundleSummaryLines(options, selectedMap, quantityMap = {}) {
  const lines = [];

  options?.forEach((option) => {
    const inputType = option.bundleInputType || getBundleInputType(option);
    const selectedIds = getSelectedItemIds(option, selectedMap);

    if (!selectedIds.length) {
      return;
    }

    const values = selectedIds
      .map((itemId) => {
        const item = option.items?.find(({ id }) => id === itemId);
        if (!item) return null;

        const qty = resolveSelectionQuantity(inputType, option, quantityMap, item);
        return `${qty} x ${item.label}`;
      })
      .filter(Boolean);

    if (values.length) {
      lines.push({
        optionId: option.id,
        optionLabel: option.label,
        values,
      });
    }
  });

  return lines;
}

function getItemUnitPrice(item) {
  const amount = item?.product?.price?.final?.amount;
  if (!amount) return { value: 0, currency: 'USD' };

  return {
    value: Number(amount.value ?? amount) || 0,
    currency: amount.currency || 'USD',
  };
}

/**
 * Client-side configured bundle total (updates immediately on selection change).
 */
export function computeBundleConfiguredPrice(options, selectedMap, quantityMap = {}) {
  let total = 0;
  let currency = 'USD';
  let hasSelection = false;

  options?.forEach((option) => {
    const inputType = option.bundleInputType || getBundleInputType(option);
    const selectedIds = getSelectedItemIds(option, selectedMap);

    selectedIds.forEach((itemId) => {
      const item = option.items?.find(({ id }) => id === itemId);
      if (!item) return;

      const qty = resolveSelectionQuantity(inputType, option, quantityMap, item);
      const { value, currency: itemCurrency } = getItemUnitPrice(item);

      total += value * qty;
      currency = itemCurrency;
      hasSelection = true;
    });
  });

  return hasSelection ? { amount: total, currency } : null;
}

/**
 * Resolves a single final bundle price (never a range) for the summary header.
 */
export function resolveBundleSummaryPrice(product, options, selectedMap, quantityMap) {
  const computed = computeBundleConfiguredPrice(options, selectedMap, quantityMap);
  const prices = product?.prices;

  if (computed) {
    return {
      final: {
        amount: computed.amount,
        currency: computed.currency || prices?.final?.currency || 'USD',
      },
      regular: prices?.regular?.amount !== undefined
        && prices.regular.amount !== computed.amount
        ? prices.regular
        : null,
    };
  }

  if (prices?.final?.amount !== undefined && prices.final.amount !== null) {
    return {
      final: {
        amount: prices.final.amount,
        currency: prices.final.currency || 'USD',
      },
      regular: prices.regular?.amount !== undefined
        && prices.regular.amount !== prices.final.amount
        ? prices.regular
        : null,
    };
  }

  return null;
}

/**
 * Returns true when every required bundle option has at least one selection.
 */
export function isBundleConfigurationValid(product, selectedUIDs = []) {
  const options = product?.options || [];
  const requiredOptions = options.filter((opt) => opt.required);

  if (requiredOptions.length === 0) {
    return true;
  }

  return requiredOptions.every((opt) => selectedUIDs.some(
    (uid) => opt.items?.some((item) => {
      const parsed = parseBundleOptionUid(uid);
      const itemParsed = parseBundleOptionUid(item.id);
      return parsed && itemParsed
        && parsed.optionId === itemParsed.optionId
        && parsed.selectionId === itemParsed.selectionId;
    }),
  ));
}

/**
 * Syncs bundle selection with PDP drop-in state (values, validity).
 * Price refresh is debounced to avoid remount churn during rapid option changes.
 */
let syncPriceTimer = null;

export async function syncBundleSelection(options, selectedMap, quantityMap, product) {
  const { optionsUIDs, enteredOptions } = buildBundleSelectionPayload(
    options,
    selectedMap,
    quantityMap,
  );

  setProductConfigurationValues((prev) => ({
    ...prev,
    optionsUIDs,
    enteredOptions,
  }));

  setProductConfigurationValid(
    () => isBundleConfigurationValid(product, optionsUIDs),
  );

  return new Promise((resolve) => {
    clearTimeout(syncPriceTimer);
    syncPriceTimer = setTimeout(async () => {
      const updatedProduct = await fetchProductData(product.sku, {
        optionsUIDs,
        isBundle: true,
      });

      if (updatedProduct) {
        events.emit('pdp/data', applyBundleProductTransform(updatedProduct));
        setProductConfigurationValid(
          () => isBundleConfigurationValid(updatedProduct, optionsUIDs),
        );
      }

      resolve(updatedProduct);
    }, BUNDLE_PRICE_SYNC_DEBOUNCE_MS);
  });
}

/**
 * Registers PDP event listeners to correct bundle validation.
 */
export function setupBundleValidation() {
  const correctValidity = () => {
    const product = events.lastPayload('pdp/data');
    if (!product?.isBundle) {
      return;
    }

    const values = getProductConfigurationValues();
    const expected = isBundleConfigurationValid(product, values?.optionsUIDs);

    setProductConfigurationValid(() => expected);
  };

  events.on('pdp/valid', (valid) => {
    const product = events.lastPayload('pdp/data');
    if (!product?.isBundle) {
      return;
    }

    const values = getProductConfigurationValues();
    const expected = isBundleConfigurationValid(product, values?.optionsUIDs);

    if (valid !== expected) {
      setProductConfigurationValid(() => expected);
    }
  });

  events.on('pdp/data', correctValidity, { eager: true });
  events.on('pdp/values', correctValidity);
}

/**
 * Returns the catalog/core admin default item id for a dropdown option, or ''.
 */
function getDropdownAdminDefaultItemId(option, meta = getProductBundleMeta()) {
  if (!option?.items?.length) {
    return '';
  }

  const defaultItem = option.items.find((item) => {
    const itemMeta = meta?.items?.[item.id] || {};
    if (itemMeta.isDefault === true) {
      return true;
    }

    return getCoreSelectionMeta(item, meta, option).isDefault === true;
  });

  return defaultItem?.id || '';
}

export function buildInitialQuantityMap(options, optionsUIDs = [], meta = getProductBundleMeta()) {
  const quantityMap = {};

  options?.forEach((option) => {
    const inputType = option.bundleInputType || getBundleInputType(option);

    if (!supportsUserDefinedQuantity(inputType)) {
      return;
    }

    const matchingUid = optionsUIDs.find((uid) => {
      const parsed = parseBundleOptionUid(uid);
      return parsed?.optionId === getBundleOptionGroupId(option);
    });

    if (matchingUid) {
      quantityMap[option.id] = parseBundleOptionUid(matchingUid)?.quantity ?? 1;
      return;
    }

    if (inputType === 'dropdown') {
      const adminDefaultId = getDropdownAdminDefaultItemId(option, meta);
      if (adminDefaultId) {
        const defaultItem = option.items?.find(({ id }) => id === adminDefaultId);
        quantityMap[option.id] = resolveSelectionAdminQuantity(defaultItem);
        return;
      }
      quantityMap[option.id] = 0;
      return;
    }

    const defaultItem = option.items?.find(({ isDefault }) => isDefault);

    if (defaultItem) {
      quantityMap[option.id] = resolveSelectionAdminQuantity(defaultItem);
      return;
    }

    quantityMap[option.id] = 0;
  });

  return quantityMap;
}

/**
 * Resolves the initial selection for a single-select bundle option.
 * Dropdowns: admin default only, otherwise empty (placeholder).
 */
function resolveInitialSingleSelectValue(option, matchingItems, inputType, meta) {
  if (matchingItems.length) {
    return matchingItems[0].id;
  }

  if (isDropdownInputType(inputType)) {
    return getDropdownAdminDefaultItemId(option, meta);
  }

  const adminDefaultItem = (option.items || []).find((item) => {
    const itemMeta = meta?.items?.[item.id] || {};
    if (itemMeta.isDefault === true) {
      return true;
    }

    return getCoreSelectionMeta(item, meta, option).isDefault === true;
  });

  if (adminDefaultItem) {
    return adminDefaultItem.id;
  }

  const catalogDefault = option.items?.find(({ isDefault }) => isDefault);
  return catalogDefault?.id || '';
}

export function buildInitialSelectedMap(options, optionsUIDs = [], meta = getProductBundleMeta()) {
  const map = {};

  options?.forEach((option) => {
    const inputType = option.bundleInputType || getBundleInputType(option);
    const matchingItems = option.items?.filter((item) => {
      const itemParsed = parseBundleOptionUid(item.id);
      return optionsUIDs.some((uid) => {
        const parsed = parseBundleOptionUid(uid);
        return parsed && itemParsed
          && parsed.optionId === itemParsed.optionId
          && parsed.selectionId === itemParsed.selectionId;
      });
    }) || [];

    if (isMultiValueInputType(inputType)) {
      map[option.id] = matchingItems.map((item) => item.id);
    } else {
      map[option.id] = resolveInitialSingleSelectValue(
        option,
        matchingItems,
        inputType,
        meta,
      );
    }
  });

  return map;
}
