import {
  Checkbox, Incrementer, RadioButton,
} from '@dropins/tools/components.js';
import { h, render } from '@dropins/tools/preact.js';
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo,
} from '@dropins/tools/preact-compat.js';
import { useText } from '@dropins/tools/i18n.js';
import { events } from '@dropins/tools/event-bus.js';
import { getProductConfigurationValues } from '@dropins/storefront-pdp/api.js';
import {
  applyBundleProductTransform,
  buildBundleSummaryLines,
  buildInitialQuantityMap,
  buildInitialSelectedMap,
  formatBundleItemLabel,
  getBundleInputType,
  getSelectedItemIds,
  isDropdownInputType,
  isMultiValueInputType,
  resolveBundleOptionInputType,
  resolveSelectionAdminQuantity,
  supportsUserDefinedQuantity,
  syncBundleSelection,
} from './bundle-options.js';
import { getProductBundleMeta } from './bundle-meta-store.js';
import {
  getSelectionSku,
  getUserDefinedQtyBySku,
  resolveAllUserDefinedQty,
  resolveSelectedUserDefinedQty,
  resolveUserDefinedQtyForItem,
} from './bundle-user-defined-qty.js';
import { getOptionsUIDsFromUrl } from '../commerce.js';
import { BundleSummary, DEFAULT_SUMMARY_LABEL } from './bundle-summary.js';

const DEFAULT_CHOOSE_LABEL = 'Choose a selection...';

function resolveInitialOptionsUIDs() {
  const urlUids = getOptionsUIDsFromUrl();
  if (urlUids?.length) {
    return urlUids;
  }

  const itemUid = new URLSearchParams(window.location.search).get('itemUid');
  if (itemUid) {
    const configUids = getProductConfigurationValues()?.optionsUIDs;
    if (configUids?.length) {
      return configUids;
    }
  }

  return [];
}

function formatSingleSelectItemLabel(item) {
  return item.label || item.title || '';
}

function formatOptionPrice(item) {
  const amount = item?.product?.price?.final?.amount;
  if (!amount || amount.value === undefined || amount.value === 0) {
    return '';
  }

  try {
    return ` +${new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: amount.currency || 'USD',
    }).format(amount.value)}`;
  } catch {
    return '';
  }
}

function getOptionInputType(option) {
  if (option.bundleInputType) {
    return option.bundleInputType;
  }

  const meta = getProductBundleMeta();
  if (meta) {
    return resolveBundleOptionInputType(option, meta);
  }

  return getBundleInputType(option);
}

function renderOptionItemWrapper(key, inputType, child) {
  return h('div', {
    key,
    className: `pdp-swatches__option-item pdp-swatches__option-item--${inputType}`,
  }, child);
}

function BundleOptionQuantity({
  optionId,
  quantity,
  disabled,
  min = 1,
  onQuantityChange,
}) {
  const inputId = `bundle-option-qty-${optionId}`;
  const minQty = Math.max(0, Number(min) || 0);
  const displayQty = minQty === 0 && disabled
    ? Math.max(0, Number(quantity) || 0)
    : Math.max(minQty || 1, Number(quantity) || minQty || 1);

  return h('div', {
    className: [
      'pdp-swatches__option-qty',
      disabled && 'pdp-swatches__option-qty--disabled',
      !disabled && 'pdp-swatches__option-qty--editable',
    ].filter(Boolean).join(' '),
  }, [
    h(Incrementer, {
      name: inputId,
      value: String(displayQty),
      min: minQty,
      disabled,
      showButtons: true,
      'aria-label': 'Quantity',
      className: 'pdp-swatches__option-qty-control',
      onValue: (nextQty) => {
        if (disabled) return;
        onQuantityChange(optionId, Math.max(minQty || 1, Number(nextQty) || minQty || 1));
      },
    }),
  ]);
}

function BundleDropdown({
  option,
  value,
  chooseLabel,
  onValueChange,
}) {
  return h('div', { className: 'pdp-swatches__dropdown-wrapper' }, [
    h('select', {
      id: `bundle-option-${option.id}`,
      name: option.id,
      className: 'pdp-swatches__dropdown',
      'aria-label': option.label,
      'aria-required': option.required || undefined,
      value: value || '',
      onChange: (event) => onValueChange(option.id, event.target.value),
    }, [
      h('option', { key: '__choose__', value: '' }, chooseLabel),
      ...option.items.map((item) => h('option', {
        key: item.id,
        value: item.id,
        disabled: !item.inStock,
      }, `${formatSingleSelectItemLabel(item)}${formatOptionPrice(item)}`)),
    ]),
  ]);
}

function BundleMultiselect({ option, value, onValueChange }) {
  const selectRef = useRef(null);
  const selected = value || [];
  const selectedKey = selected.slice().sort().join('|');

  useLayoutEffect(() => {
    const el = selectRef.current;
    if (!el) return;
    Array.from(el.options).forEach((opt) => {
      opt.selected = selected.includes(opt.value);
    });
  }, [selectedKey, option.id]);

  return h('select', {
    ref: selectRef,
    id: `bundle-option-${option.id}`,
    name: `${option.id}[]`,
    className: 'pdp-swatches__multiselect',
    multiple: true,
    size: Math.max(option.items?.length || 2, 2),
    'aria-label': option.label,
    'aria-required': option.required || undefined,
    onChange: (event) => {
      const next = [...event.target.selectedOptions].map(({ value: v }) => v);
      onValueChange(option.id, next);
    },
  }, option.items.map((item) => h('option', {
    key: item.id,
    value: item.id,
    disabled: !item.inStock,
  }, `${formatBundleItemLabel(item, { includeFixedQuantity: true })}${formatOptionPrice(item)}`)));
}

function BundleOptionField({
  option,
  value,
  quantityMap,
  editableBySku,
  bundleSku,
  onValueChange,
  onQuantityChange,
  chooseLabel,
  requiredLabel,
}) {
  const inputType = getOptionInputType(option);
  const selectedIds = getSelectedItemIds(option, { [option.id]: value });
  const showError = option.required && selectedIds.length === 0;
  const isDropdown = isDropdownInputType(inputType);
  const bundleMeta = getProductBundleMeta();

  let control = null;

  if (isDropdown) {
    control = h('div', { className: 'pdp-swatches__options pdp-swatches__options--dropdown' }, h(BundleDropdown, {
      option, value, chooseLabel, onValueChange,
    }));
  } else if (inputType === 'radio') {
    control = h('div', {
      className: 'pdp-swatches__options pdp-swatches__options--radio',
      role: 'radiogroup',
      'aria-label': option.label,
    }, option.items.map((item) => renderOptionItemWrapper(item.id, inputType, h(RadioButton, {
      name: option.id,
      value: item.id,
      label: `${formatSingleSelectItemLabel(item)}${formatOptionPrice(item)}`,
      checked: value === item.id,
      disabled: !item.inStock,
      onChange: () => onValueChange(option.id, item.id),
    }))));
  } else if (inputType === 'multiselect') {
    control = h('div', { className: 'pdp-swatches__options pdp-swatches__options--multiselect' }, h(BundleMultiselect, {
      option, value, onValueChange,
    }));
  } else {
    control = h('div', {
      className: 'pdp-swatches__options pdp-swatches__options--checkbox',
      role: 'group',
      'aria-label': option.label,
    }, option.items.map((item) => {
      const checked = (value || []).includes(item.id);
      return renderOptionItemWrapper(item.id, inputType, h(Checkbox, {
        name: option.id,
        value: item.id,
        label: `${formatBundleItemLabel(item, { includeFixedQuantity: true })}${formatOptionPrice(item)}`,
        checked,
        disabled: !item.inStock,
        onChange: (event) => {
          const current = value || [];
          const next = event.target.checked
            ? [...current, item.id]
            : current.filter((id) => id !== item.id);
          onValueChange(option.id, next);
        },
      }));
    }));
  }

  const selectedId = selectedIds[0] || null;
  const selectedItem = selectedId
    ? option.items?.find(({ id }) => id === selectedId)
    : null;
  const hasSelection = Boolean(selectedId);
  const supportsQty = supportsUserDefinedQuantity(inputType);
  const selectionSku = getSelectionSku(selectedItem) || '';
  const userDefined = selectionSku
    ? (editableBySku[selectionSku] ?? getUserDefinedQtyBySku(bundleSku, selectionSku))
    : undefined;
  const canEditQty = hasSelection && userDefined === true;
  const adminQty = hasSelection
    ? resolveSelectionAdminQuantity(selectedItem, option, bundleMeta)
    : 0;
  let qtyValue = 0;
  if (hasSelection) {
    qtyValue = canEditQty
      ? (quantityMap[option.id] ?? adminQty)
      : adminQty;
  }
  const qtyDisabled = !hasSelection || userDefined !== true;
  const showQtyControl = supportsQty;

  return h('div', {
    className: `pdp-swatches__field pdp-swatches__field--${inputType}`,
    id: `swatch-item-${option.id}`,
    'data-slot-key': `product-swatch--${option.id}`,
    'data-input-type': inputType,
  }, [
    h('div', { className: 'pdp-swatches__field__label' }, [
      option.label,
      option.required && h('span', { className: 'pdp-swatches__required' }, '*'),
    ]),
    control,
    showQtyControl && h('div', { className: 'pdp-swatches__option-qty-slot' }, h(BundleOptionQuantity, {
      key: `${option.id}-${selectedId}-${userDefined === true ? 'edit' : 'fixed'}`,
      optionId: option.id,
      quantity: qtyValue,
      disabled: qtyDisabled,
      min: hasSelection ? 1 : 0,
      onQuantityChange,
    })),
    showError && h('div', { className: 'pdp-swatches__error', role: 'alert' }, requiredLabel),
  ]);
}

function BundleOptionsList({
  options,
  selection,
  editableBySku,
  setEditableBySku,
  productRef,
  onSelectionChange,
  chooseLabel,
  requiredLabel,
}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const syncSelection = useCallback(async (nextSelectedMap, nextQuantityMap) => {
    await syncBundleSelection(
      optionsRef.current,
      nextSelectedMap,
      nextQuantityMap,
      productRef.current,
    );
  }, [productRef]);

  const probeItem = useCallback(async (item) => {
    const bundleSku = productRef.current?.sku;
    const selectionSku = getSelectionSku(item);
    if (!bundleSku || !selectionSku || !item) return;

    const canEdit = await resolveUserDefinedQtyForItem(bundleSku, item, { force: true });
    if (canEdit !== undefined) {
      setEditableBySku((prev) => ({ ...prev, [selectionSku]: canEdit }));
    }
  }, [productRef, setEditableBySku]);

  const updateQuantityForSelection = useCallback((optionId, nextValue) => {
    const option = optionsRef.current.find(({ id }) => id === optionId);
    if (!option) return {};

    const inputType = getOptionInputType(option);
    if (isMultiValueInputType(inputType)) return {};
    if (!isDropdownInputType(inputType) && inputType !== 'radio') return {};
    if (!nextValue) return { [optionId]: 0 };

    const item = option.items?.find(({ id }) => id === nextValue);
    const bundleMeta = getProductBundleMeta();
    return { [optionId]: item ? resolveSelectionAdminQuantity(item, option, bundleMeta) : 0 };
  }, []);

  const commitSelection = useCallback((nextSelectedMap, nextQuantityMap) => {
    onSelectionChange({ selectedMap: nextSelectedMap, quantityMap: nextQuantityMap });
    requestAnimationFrame(() => {
      syncSelection(nextSelectedMap, nextQuantityMap);
    });
  }, [onSelectionChange, syncSelection]);

  const handleValueChange = useCallback(async (optionId, nextValue) => {
    const option = optionsRef.current.find(({ id }) => id === optionId);
    const nextSelectedMap = { ...selectionRef.current.selectedMap, [optionId]: nextValue };
    const nextQuantityMap = {
      ...selectionRef.current.quantityMap,
      ...updateQuantityForSelection(optionId, nextValue),
    };
    commitSelection(nextSelectedMap, nextQuantityMap);

    const item = option?.items?.find(({ id }) => id === nextValue);
    if (item) {
      await probeItem(item);
    }
  }, [commitSelection, probeItem, updateQuantityForSelection]);

  const handleQuantityChange = useCallback((qtyKey, quantity) => {
    commitSelection(
      selectionRef.current.selectedMap,
      { ...selectionRef.current.quantityMap, [qtyKey]: quantity },
    );
  }, [commitSelection]);

  const { selectedMap, quantityMap } = selection;
  const bundleSku = productRef.current?.sku || '';

  return h('div', { className: 'pdp-swatches__options-list' }, options.map(
    (option) => h(BundleOptionField, {
      key: `${option.id}-${JSON.stringify(editableBySku)}`,
      option,
      value: selectedMap[option.id],
      quantityMap,
      editableBySku,
      bundleSku,
      onValueChange: handleValueChange,
      onQuantityChange: handleQuantityChange,
      chooseLabel,
      requiredLabel,
    }),
  ));
}

const BundleSummaryMemo = memo(BundleSummary);

function BundleSwatchesShell({
  options,
  selection,
  editableBySku,
  setEditableBySku,
  productRef,
  onSelectionChange,
  chooseLabel,
  requiredLabel,
  summaryProduct,
  summaryLabel,
}) {
  const hasSummaryItems = useMemo(
    () => buildBundleSummaryLines(
      options,
      selection.selectedMap,
      selection.quantityMap,
    ).length > 0,
    [options, selection.selectedMap, selection.quantityMap],
  );

  return h('div', {
    className: [
      'pdp-swatches',
      'pdp-swatches--bundle',
      !hasSummaryItems && 'pdp-swatches--bundle-no-summary',
    ].filter(Boolean).join(' '),
  }, [
    h(BundleOptionsList, {
      options,
      selection,
      editableBySku,
      setEditableBySku,
      productRef,
      onSelectionChange,
      chooseLabel,
      requiredLabel,
    }),
    h(BundleSummaryMemo, {
      product: summaryProduct,
      options,
      selectedMap: selection.selectedMap,
      quantityMap: selection.quantityMap,
      summaryLabel,
    }),
  ]);
}

function BundleSwatchesRoot({ ctx }) {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const chooseLabelText = useText('PDP.Swatches.ChooseOption.label');
  const chooseLabel = chooseLabelText?.label || DEFAULT_CHOOSE_LABEL;
  const requiredLabel = useText('PDP.Swatches.Required.label').label;
  const summaryLabel = useText('PDP.Bundle.Summary.label')?.label || DEFAULT_SUMMARY_LABEL;

  const initialProduct = useMemo(
    () => applyBundleProductTransform(ctx.data),
    [ctx],
  );
  const productRef = useRef(initialProduct);
  const [options, setOptions] = useState(() => initialProduct?.options || []);
  const [summaryProduct, setSummaryProduct] = useState(initialProduct);
  const [editableBySku, setEditableBySku] = useState({});
  const [selection, setSelection] = useState(() => {
    const initialUids = resolveInitialOptionsUIDs();
    const initialOptions = initialProduct?.options || [];
    const bundleMeta = getProductBundleMeta();
    return {
      selectedMap: buildInitialSelectedMap(initialOptions, initialUids, bundleMeta),
      quantityMap: buildInitialQuantityMap(initialOptions, initialUids, bundleMeta),
    };
  });

  const onSelectionChange = useCallback((nextSelection) => {
    setSelection(nextSelection);
  }, []);

  const didProbeRef = useRef(false);

  useEffect(() => {
    if (didProbeRef.current) return undefined;
    didProbeRef.current = true;

    let cancelled = false;
    (async () => {
      const product = productRef.current;
      if (!product?.sku || !product?.options?.length) return;

      const bundleMeta = getProductBundleMeta();
      const selectedMap = buildInitialSelectedMap(
        product.options,
        resolveInitialOptionsUIDs(),
        bundleMeta,
      );

      const selectedFlags = await resolveSelectedUserDefinedQty(
        product.sku,
        product.options,
        selectedMap,
      );
      if (!cancelled && Object.keys(selectedFlags).length) {
        setEditableBySku((prev) => ({ ...prev, ...selectedFlags }));
      }

      const allFlags = await resolveAllUserDefinedQty(product.sku, product.options);
      if (!cancelled) {
        setEditableBySku((prev) => ({ ...prev, ...allFlags }));
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const didSyncInitialRef = useRef(false);
  useEffect(() => {
    if (didSyncInitialRef.current) return;
    didSyncInitialRef.current = true;

    const initialUids = resolveInitialOptionsUIDs();
    const bundleMeta = getProductBundleMeta();
    const selectedMap = buildInitialSelectedMap(options, initialUids, bundleMeta);
    const quantityMap = buildInitialQuantityMap(options, initialUids, bundleMeta);
    setSelection({ selectedMap, quantityMap });
    syncBundleSelection(options, selectedMap, quantityMap, productRef.current);
  }, [options]);

  useEffect(() => {
    ctx.onChange(() => {
      const next = applyBundleProductTransform(ctxRef.current.data);
      productRef.current = next;
      setOptions(next?.options || []);
      setSummaryProduct(next);
    });

    const off = events.on('pdp/data', (data) => {
      if (data?.sku === ctxRef.current.data?.sku) {
        const next = applyBundleProductTransform(data);
        productRef.current = next;
        setOptions(next?.options || []);
        setSummaryProduct(next);
      }
    });

    return () => { off?.off?.(); };
  }, [ctx]);

  return h(BundleSwatchesShell, {
    options,
    selection,
    editableBySku,
    setEditableBySku,
    productRef,
    onSelectionChange,
    chooseLabel,
    requiredLabel,
    summaryProduct,
    summaryLabel,
  });
}

export function bundleSwatchesSlot(ctx) {
  if (!ctx.data?.isBundle) {
    return;
  }

  const container = document.createElement('div');
  ctx.replaceWith(container);
  render(h(BundleSwatchesRoot, { ctx }), container);
}
