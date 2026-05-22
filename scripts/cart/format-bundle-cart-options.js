import { parseBundleOptionUid } from '../pdp/bundle-options.js';

function resolveBundleValuePrice(value) {
  if (value?.priceV2?.value !== undefined && value?.priceV2?.value !== null) {
    return {
      amount: Number(value.priceV2.value),
      currency: value.priceV2.currency || 'USD',
    };
  }

  if (value?.original_price?.value !== undefined && value?.original_price?.value !== null) {
    return {
      amount: Number(value.original_price.value),
      currency: value.original_price.currency || 'USD',
    };
  }

  if (value?.price?.value !== undefined && value?.price?.value !== null) {
    return {
      amount: Number(value.price.value),
      currency: value.price.currency || 'USD',
    };
  }

  if (typeof value?.price === 'number') {
    return { amount: value.price, currency: 'USD' };
  }

  return null;
}

function formatBundleValueLine(value, locale = undefined) {
  const qty = Math.max(
    1,
    Number(value?.quantity) || parseBundleOptionUid(value?.uid)?.quantity || 1,
  );
  const label = value?.label || '';
  const price = resolveBundleValuePrice(value);

  let line = `${qty} x ${label}`;

  if (price && !Number.isNaN(price.amount)) {
    const lineTotal = price.amount * qty;

    try {
      line += ` ${new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: price.currency,
      }).format(lineTotal)}`;
    } catch {
      line += ` $${lineTotal.toFixed(2)}`;
    }
  }

  return line;
}

/**
 * Formats cart bundle_options into Magento-style configuration lines:
 * "Option Label: 2 x Selection Name $23.00"
 */
export function formatBundleCartOptions(bundleOptions, locale = undefined) {
  if (!bundleOptions?.length) {
    return null;
  }

  const formatted = {};

  bundleOptions.forEach((option) => {
    const values = option?.values || [];
    if (!values.length) {
      return;
    }

    formatted[option.label] = values
      .map((value) => formatBundleValueLine(value, locale))
      .join(', ');
  });

  return Object.keys(formatted).length ? formatted : null;
}

/**
 * CartModel transformer – receives raw GraphQL cart, returns partial model
 * merged by index into each cart line item.
 */
export function transformCartBundleOptions(rawCart, locale = undefined) {
  if (!rawCart?.itemsV2?.items?.length) {
    return {};
  }

  return {
    items: rawCart.itemsV2.items.map((rawItem) => {
      if (!rawItem || rawItem.__typename !== 'BundleCartItem') {
        return {};
      }

      const rowTotal = rawItem.prices?.row_total;
      const quantity = Math.max(1, Number(rawItem.quantity) || 1);
      const bundleItem = {
        bundleOptions: formatBundleCartOptions(rawItem.bundle_options, locale),
      };

      // Bundle lines use original_row_total / original_item_price in the drop-in,
      // but subtotal and row totals use row_total.
      if (rowTotal?.value != null) {
        const unitPrice = rowTotal.value / quantity;
        const currency = rowTotal.currency || 'USD';
        const unitPriceShape = { value: unitPrice, currency };

        bundleItem.total = { value: rowTotal.value, currency };
        bundleItem.price = unitPriceShape;
        bundleItem.regularPrice = unitPriceShape;

        const rowTotalInclTax = rawItem.prices?.row_total_including_tax;
        if (rowTotalInclTax?.value != null) {
          bundleItem.taxedPrice = {
            value: rowTotalInclTax.value / quantity,
            currency: rowTotalInclTax.currency || currency,
          };
        }
      }

      return bundleItem;
    }),
  };
}
