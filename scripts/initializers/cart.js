import { initializers } from '@dropins/tools/initializer.js';
import { events } from '@dropins/tools/event-bus.js';
import { initialize, setEndpoint } from '@dropins/storefront-cart/api.js';
import { initializeDropin } from './index.js';
import { CORE_FETCH_GRAPHQL, fetchPlaceholders } from '../commerce.js';
import { transformCartBundleOptions } from '../cart/format-bundle-cart-options.js';

let cartLocale;

await initializeDropin(async () => {
  // Set Fetch GraphQL (Core)
  setEndpoint(CORE_FETCH_GRAPHQL);

  events.on('locale', (locale) => {
    cartLocale = locale;
  }, { eager: true });

  // Fetch placeholders
  const labels = await fetchPlaceholders('placeholders/cart.json');

  const langDefinitions = {
    default: {
      ...labels,
    },
  };

  // Initialize cart
  return initializers.mountImmediately(initialize, {
    langDefinitions,
    models: {
      CartModel: {
        transformer: (rawCart) => transformCartBundleOptions(rawCart, cartLocale),
      },
    },
  });
})();
