import { readBlockConfig } from '../../scripts/aem.js';
import { fetchNotices } from '../../scripts/notices.js';

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function createTableShell() {
  const wrapper = document.createElement('div');
  wrapper.className = 'notice-board__table-wrapper';

  const table = document.createElement('table');
  table.className = 'notice-board__table';

  const caption = document.createElement('caption');
  caption.className = 'notice-board__caption';
  caption.textContent = 'Store notices';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  ['Title', 'Message', 'Date'].forEach((label) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    headerRow.append(th);
  });

  thead.append(headerRow);
  table.append(caption, thead);

  const tbody = document.createElement('tbody');
  table.append(tbody);
  wrapper.append(table);

  return { wrapper, table, tbody };
}

function renderLoading(container) {
  container.replaceChildren();
  const { wrapper, tbody } = createTableShell();
  wrapper.querySelector('.notice-board__table').setAttribute('aria-busy', 'true');

  for (let index = 0; index < 3; index += 1) {
    const row = document.createElement('tr');
    row.className = 'notice-board__row notice-board__row--skeleton';

    for (let cellIndex = 0; cellIndex < 3; cellIndex += 1) {
      const cell = document.createElement('td');
      const skeleton = document.createElement('span');
      skeleton.className = 'notice-board__skeleton';
      cell.append(skeleton);
      row.append(cell);
    }

    tbody.append(row);
  }

  container.append(wrapper);
}

function renderEmpty(container, message) {
  container.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'notice-board__empty';
  empty.textContent = message;
  container.append(empty);
}

function renderError(container, message) {
  container.replaceChildren();
  const error = document.createElement('p');
  error.className = 'notice-board__error';
  error.setAttribute('role', 'alert');
  error.textContent = message;
  container.append(error);
}

function renderNotices(container, notices) {
  container.replaceChildren();
  const { wrapper, tbody } = createTableShell();

  notices.forEach((notice) => {
    const row = document.createElement('tr');
    row.className = 'notice-board__row';
    row.dataset.noticeId = notice.id || '';

    const titleCell = document.createElement('th');
    titleCell.scope = 'row';
    titleCell.className = 'notice-board__title';
    titleCell.textContent = notice.title || 'Notice';

    const messageCell = document.createElement('td');
    messageCell.className = 'notice-board__message';
    messageCell.textContent = notice.message || '';

    const dateCell = document.createElement('td');
    dateCell.className = 'notice-board__date';

    const time = document.createElement('time');
    if (notice.createdAt) {
      time.dateTime = notice.createdAt;
    }
    time.textContent = formatDate(notice.createdAt);
    dateCell.append(time);

    row.append(titleCell, messageCell, dateCell);
    tbody.append(row);
  });

  container.append(wrapper);
}

export default async function decorate(block) {
  const {
    'empty-message': emptyMessage = 'No notices available right now.',
    'error-message': errorMessage = 'Unable to load notices. Please try again later.',
  } = readBlockConfig(block);

  block.textContent = '';

  const container = document.createElement('div');
  container.className = 'notice-board__container';
  block.append(container);

  renderLoading(container);

  try {
    const notices = await fetchNotices();

    if (!notices.length) {
      renderEmpty(container, emptyMessage);
      return;
    }

    renderNotices(container, notices);
  } catch (error) {
    console.error('Failed to load notices', error);
    renderError(container, errorMessage);
  }
}
