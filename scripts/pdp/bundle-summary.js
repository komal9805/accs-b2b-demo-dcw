import { Price } from '@dropins/tools/components.js';
import { h } from '@dropins/tools/preact.js';
import { useMemo } from '@dropins/tools/preact-compat.js';
import {
  buildBundleSummaryLines,
  resolveBundleSummaryPrice,
} from './bundle-options.js';

export const DEFAULT_SUMMARY_LABEL = 'Summary';

/**
 * Magento-style bundle customization summary with final price above the list.
 */
export function BundleSummary({
  product,
  options,
  selectedMap,
  quantityMap,
  summaryLabel,
}) {
  const title = summaryLabel || DEFAULT_SUMMARY_LABEL;
  const lines = useMemo(
    () => buildBundleSummaryLines(options, selectedMap, quantityMap),
    [options, selectedMap, quantityMap],
  );

  const priceInfo = useMemo(
    () => resolveBundleSummaryPrice(product, options, selectedMap, quantityMap),
    [product, options, selectedMap, quantityMap],
  );

  if (!lines.length) {
    return null;
  }

  return h('div', { className: 'pdp-bundle-summary' }, [
    priceInfo && h('div', { className: 'pdp-bundle-summary__price-row' }, [
      priceInfo.regular?.amount !== undefined && h(Price, {
        className: 'pdp-bundle-summary__price pdp-bundle-summary__price--regular',
        amount: priceInfo.regular.amount,
        currency: priceInfo.regular.currency,
      }),
      h(Price, {
        className: 'pdp-bundle-summary__price pdp-bundle-summary__price--final',
        amount: priceInfo.final.amount,
        currency: priceInfo.final.currency,
      }),
    ]),
    h('h3', { className: 'pdp-bundle-summary__title' }, title),
    h(
      'div',
      { className: 'pdp-bundle-summary__list' },
      lines.map((line) => h('div', {
        key: line.optionId,
        className: 'pdp-bundle-summary__item',
      }, [
        h('div', { className: 'pdp-bundle-summary__option' }, `${line.optionLabel}:`),
        ...line.values.map((value) => h('div', {
          key: `${line.optionId}-${value}`,
          className: 'pdp-bundle-summary__value-line',
        }, value)),
      ])),
    ),
  ]);
}
