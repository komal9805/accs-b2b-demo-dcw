# Commerce B2B Quick Order Block

## Overview

The Commerce B2B Quick Order block renders the Adobe Quick Order drop-in: search and add multiple SKUs, upload CSV, and add lines to the cart. It wires `QuickOrderItems`, `QuickOrderMultipleSku`, and `QuickOrderCsvUpload` with PDP slots for price and options, cart add, and product discovery search.

## Integration

### Initializers

The block side-loads these initializers (must run before render):

- `scripts/initializers/quick-order.js` — Quick Order API and `placeholders/quick-order.json` labels
- `scripts/initializers/search.js` — Catalog Service GraphQL for `productsSearch`
- `scripts/initializers/cart.js` — Cart API for `addProductsToCart`
- `scripts/initializers/pdp.js` — PDP data for product slots

### Placeholders

Labels are merged from `placeholders/quick-order.json` (see `scripts/initializers/quick-order.js`). Ensure that sheet exists in your AEM / Edge Delivery content so i18n strings resolve.

### Behavior

1. **Quick Order items**: Search filters include visibility (`Search`, `Catalog, Search`) and `categoryPath` empty string for catalog-wide search (aligned with drop-in defaults).
2. **Add to cart**: `handleAddToCart` calls `cartApi.addProductsToCart` then navigates to `rootLink('/cart')`. On failure, the returned string is shown as a backend error in the Quick Order UI.
3. **Slots**: `ProductPrice` and `ProductOptions` use the PDP renderer scoped per line item.

### Error handling

- **Cart API errors**: Caught and surfaced as a string to the Quick Order notification (backend error variant).
- **Empty add**: No-op when there are no line items to add.
