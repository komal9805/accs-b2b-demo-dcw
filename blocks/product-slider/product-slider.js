import { readBlockConfig } from '../../scripts/aem.js';
import { decorateProductCarousel } from './product-slider-shared.js';

function parseCategoryIds(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default async function decorate(block) {
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

  await decorateProductCarousel(block, {
    categoryIds,
    categoryPath: null,
    pageSize,
    heading,
    emptyMessage: 'Add one or more category IDs in the block configuration.',
    errorContext: 'Product slider',
  });
}
