// Product Discovery Dropins
import SearchResults from '@dropins/storefront-product-discovery/containers/SearchResults.js';
import { render as provider } from '@dropins/storefront-product-discovery/render.js';
import { search } from '@dropins/storefront-product-discovery/api.js';
import { Button, Icon, provider as UI } from '@dropins/tools/components.js';
import * as cartApi from '@dropins/storefront-cart/api.js';
import { WishlistToggle } from '@dropins/storefront-wishlist/containers/WishlistToggle.js';
import { render as wishlistRender } from '@dropins/storefront-wishlist/render.js';
import { tryRenderAemAssetsImage } from '@dropins/tools/lib/aem/assets.js';
import { events } from '@dropins/tools/event-bus.js';

import { readBlockConfig } from '../../scripts/aem.js';
import { fetchPlaceholders, getProductLink } from '../../scripts/commerce.js';

import '../../scripts/initializers/search.js';
import '../../scripts/initializers/wishlist.js';

/**
 * Parses comma/space/semicolon-separated category ids from block config.
 * @param {string} raw
 * @returns {string[]}
 */
function parseCategoryIds(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default async function decorate(block) {
  const labels = await fetchPlaceholders();
  const config = readBlockConfig(block);

  const categoryIds = parseCategoryIds(
    config['category-ids'] || config.categoryids || config.categoryIds || '',
  );
  const pageSize = Math.min(
    Math.max(
      Number.parseInt(config['page-size'] || config.pagesize || '12', 10) || 12,
      1,
    ),
    48,
  );
  const heading = (config.heading || '').trim();

  [...block.children].forEach((row) => {
    row.style.display = 'none';
  });

  const searchScope = `category-product-slider-${crypto.randomUUID()}`;

  const fragment = document.createRange().createContextualFragment(`
    <div class="product-slider__inner">
      <div class="product-slider__viewport">
        <button type="button" class="product-slider__nav product-slider__nav--prev" aria-label="Previous products"></button>
        <div class="product-slider__track"></div>
        <button type="button" class="product-slider__nav product-slider__nav--next" aria-label="Next products"></button>
      </div>
    </div>
  `);
  const inner = fragment.querySelector('.product-slider__inner');
  if (heading) {
    const h2 = document.createElement('h2');
    h2.className = 'product-slider__heading';
    h2.textContent = heading;
    inner.insertBefore(h2, inner.firstChild);
  }

  const $track = fragment.querySelector('.product-slider__track');
  const $prev = fragment.querySelector('.product-slider__nav--prev');
  const $next = fragment.querySelector('.product-slider__nav--next');

  block.innerHTML = '';
  block.appendChild(fragment);

  if (categoryIds.length === 0) {
    block.classList.add('product-slider--empty');
    $track.innerHTML = `<p class="product-slider__message">Add one or more category IDs in the block configuration.</p>`;
    return;
  }

  const getAddToCartButton = (product) => {
    if (product.typename === 'ComplexProductView') {
      const button = document.createElement('div');
      UI.render(Button, {
        children: labels.Global?.AddProductToCart,
        icon: Icon({ source: 'Cart' }),
        href: getProductLink(product.urlKey, product.sku),
        variant: 'primary',
      })(button);
      return button;
    }
    const button = document.createElement('div');
    UI.render(Button, {
      children: labels.Global?.AddProductToCart,
      icon: Icon({ source: 'Cart' }),
      onClick: () => cartApi.addProductsToCart([{
        sku: product.sku,
        quantity: 1,
      }]),
      variant: 'primary',
    })(button);
    return button;
  };

  await search(
    {
      phrase: '',
      currentPage: 1,
      pageSize,
      sort: [{
        attribute: 'position',
        direction: 'DESC',
      }],
      filter: [
        {
          attribute: 'categoryIDs',
          in: categoryIds,
        },
        {
          attribute: 'visibility',
          in: ['Search', 'Catalog, Search'],
        },
      ],
    },
    { scope: searchScope },
  ).catch(() => {
    console.error('Product slider: error loading products for categories', categoryIds);
  });

  await provider.render(SearchResults, {
    scope: searchScope,
    routeProduct: (product) => getProductLink(product.urlKey, product.sku),
    slots: {
      ProductImage: (ctx) => {
        const { product, defaultImageProps } = ctx;
        const anchorWrapper = document.createElement('a');
        anchorWrapper.href = getProductLink(product.urlKey, product.sku);

        tryRenderAemAssetsImage(ctx, {
          alias: product.sku,
          imageProps: defaultImageProps,
          wrapper: anchorWrapper,
          params: {
            width: defaultImageProps.width,
            height: defaultImageProps.height,
          },
        });
      },
      ProductActions: async (ctx) => {
        const actionsWrapper = document.createElement('div');
        actionsWrapper.className = 'product-discovery-product-actions';
        const addToCartBtn = getAddToCartButton(ctx.product);
        addToCartBtn.className = 'product-discovery-product-actions__add-to-cart';
        const $wishlistToggle = document.createElement('div');
        $wishlistToggle.classList.add('product-discovery-product-actions__wishlist-toggle');
        wishlistRender.render(WishlistToggle, {
          product: ctx.product,
          variant: 'tertiary',
        })($wishlistToggle);
        actionsWrapper.appendChild(addToCartBtn);
        actionsWrapper.appendChild($wishlistToggle);

        try {
          const { initializeRequisitionList } = await import('../product-list-page/requisition-list.js');
          const $reqListContainer = await initializeRequisitionList({
            product: ctx.product,
            labels,
          });
          actionsWrapper.appendChild($reqListContainer);
        } catch (error) {
          console.warn('Requisition list module not available:', error);
        }

        ctx.replaceWith(actionsWrapper);
      },
    },
  })($track);

  events.on(
    'search/result',
    (payload) => {
      const total = payload.result?.totalCount ?? 0;
      block.classList.toggle('product-slider--empty', total === 0);
    },
    { eager: true, scope: searchScope },
  );

  const scrollStep = () => {
    const grid = $track.querySelector('.product-discovery-product-list__grid');
    if (!grid) return Math.max(280, block.clientWidth * 0.85);
    const card = grid.querySelector('.dropin-card, .product-discovery-product-item, [class*="product-item"]');
    if (card && card.getBoundingClientRect().width) {
      return card.getBoundingClientRect().width + 16;
    }
    return Math.max(280, block.clientWidth * 0.85);
  };

  $prev.addEventListener('click', () => {
    const grid = $track.querySelector('.product-discovery-product-list__grid');
    if (grid) grid.scrollBy({ left: -scrollStep(), behavior: 'smooth' });
  });
  $next.addEventListener('click', () => {
    const grid = $track.querySelector('.product-discovery-product-list__grid');
    if (grid) grid.scrollBy({ left: scrollStep(), behavior: 'smooth' });
  });
}
