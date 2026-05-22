function normalizeMoney(value, currency = 'USD') {
  return { value: Number(value) || 0, currency: currency || 'USD' };
}

function buildTaxCalculations(itemPrices, discounted = false) {
  const { price, priceIncludingTax, originalPrice } = itemPrices;
  const baseOriginalValue = discounted ? originalPrice.value : priceIncludingTax.value;

  return {
    includeAndExcludeTax: {
      originalPrice,
      baseOriginalPrice: {
        value: baseOriginalValue,
        currency: originalPrice.currency,
      },
      baseDiscountedPrice: {
        value: priceIncludingTax.value,
        currency: priceIncludingTax.currency,
      },
      baseExcludingTax: {
        value: price.value,
        currency: price.currency,
      },
    },
    excludeTax: {
      originalPrice,
      baseOriginalPrice: {
        value: originalPrice.value,
        currency: priceIncludingTax.currency,
      },
      baseDiscountedPrice: {
        value: price.value,
        currency: price.currency,
      },
      baseExcludingTax: {
        value: price.value,
        currency: price.currency,
      },
    },
    includeTax: {
      singleItemPrice: {
        value: discounted ? originalPrice.value : priceIncludingTax.value,
        currency: priceIncludingTax.currency,
      },
      baseOriginalPrice: {
        value: baseOriginalValue,
        currency: priceIncludingTax.currency,
      },
      baseDiscountedPrice: {
        value: priceIncludingTax.value,
        currency: priceIncludingTax.currency,
      },
    },
  };
}

/**
 * OrderModel transformer – receives raw GraphQL order, returns partial model
 * merged into each order line item.
 *
 * Bundle order lines report a higher original_price than the configured sale
 * price, which makes the drop-in show a phantom discount after checkout.
 */
export function transformOrderBundleItems(rawOrder) {
  if (!rawOrder?.items?.length) {
    return {};
  }

  return {
    items: rawOrder.items.map((rawItem) => {
      if (!rawItem || rawItem.__typename !== 'BundleOrderItem') {
        return {};
      }

      const qty = Math.max(1, Number(rawItem.quantity_ordered) || 1);
      const saleUnitValue = rawItem.product_sale_price?.value ?? rawItem.prices?.price?.value;
      const currency = rawItem.product_sale_price?.currency
        ?? rawItem.prices?.price?.currency
        ?? 'USD';

      if (saleUnitValue == null) {
        return { discounted: false };
      }

      const unitPrice = normalizeMoney(saleUnitValue, currency);
      const unitPriceInclTax = rawItem.prices?.price_including_tax?.value != null
        ? normalizeMoney(
          rawItem.prices.price_including_tax.value,
          rawItem.prices.price_including_tax.currency || currency,
        )
        : unitPrice;

      const itemPrices = {
        price: unitPrice,
        priceIncludingTax: unitPriceInclTax,
        originalPrice: unitPrice,
        originalPriceIncludingTax: unitPriceInclTax,
        discounts: rawItem.prices?.discounts ?? [],
      };

      return {
        discounted: false,
        regularPrice: unitPrice,
        price: unitPrice,
        prices: itemPrices,
        itemPrices,
        taxCalculations: buildTaxCalculations(itemPrices, false),
        total: { value: unitPrice.value * qty, currency },
        totalInclTax: { value: unitPriceInclTax.value * qty, currency: unitPriceInclTax.currency },
      };
    }),
  };
}
