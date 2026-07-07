import { events } from '@dropins/tools/event-bus.js';
import { readBlockConfig } from '../../scripts/aem.js';
import {
  checkIsAuthenticated,
  CUSTOMER_LOGIN_PATH,
  rootLink,
} from '../../scripts/commerce.js';
import {
  fetchMyTestimonials,
  TESTIMONIAL_IMAGE_ACCEPT,
  TESTIMONIAL_IMAGE_HINT,
  updateMyPendingTestimonial,
  validateTestimonialImage,
} from '../../scripts/testimonials.js';
import createModal from '../modal/modal.js';

import '../../scripts/initializers/auth.js';

const STATUS_LABELS = {
  pending: 'Pending review',
  approved: 'Approved',
  rejected: 'Rejected',
};

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function createStars(rating) {
  const stars = document.createElement('div');
  stars.className = 'commerce-account-testimonials__stars';
  stars.setAttribute('aria-label', `${rating} out of 5 stars`);

  for (let value = 1; value <= 5; value += 1) {
    const star = document.createElement('span');
    star.className = 'commerce-account-testimonials__star';
    if (value <= rating) {
      star.classList.add('commerce-account-testimonials__star--filled');
    }
    star.setAttribute('aria-hidden', 'true');
    stars.append(star);
  }

  return stars;
}

function createStatusBadge(status) {
  const badge = document.createElement('span');
  badge.className = `commerce-account-testimonials__status commerce-account-testimonials__status--${status}`;
  badge.textContent = STATUS_LABELS[status] || status;
  return badge;
}

function createFormField({
  id, label, type = 'text', required = false, multiline = false, value = '',
}) {
  const field = document.createElement('div');
  field.className = 'commerce-account-testimonials__field';

  const fieldLabel = document.createElement('label');
  fieldLabel.htmlFor = id;
  fieldLabel.textContent = label;
  field.append(fieldLabel);

  const control = multiline
    ? document.createElement('textarea')
    : document.createElement('input');

  if (!multiline) {
    control.type = type;
  }
  control.id = id;
  control.name = id;
  control.required = required;
  control.value = value;
  if (multiline) {
    control.rows = 3;
  }

  field.append(control);
  return { field, control };
}

function createRatingField(testimonialId, selectedRating) {
  const field = document.createElement('div');
  field.className = 'commerce-account-testimonials__field commerce-account-testimonials__field--rating';

  const labelId = `commerce-testimonial-rating-label-${testimonialId}`;
  const label = document.createElement('label');
  label.id = labelId;
  label.textContent = 'Rating';
  field.append(label);

  const group = document.createElement('div');
  group.className = 'commerce-account-testimonials__rating-options';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Rating');

  const control = document.createElement('input');
  control.type = 'hidden';
  control.name = `commerce-testimonial-rating-${testimonialId}`;
  control.required = true;
  control.value = String(selectedRating || '');

  const buttons = [];

  const updateSelection = (value) => {
    control.value = String(value);
    buttons.forEach((button, index) => {
      const isActive = index < value;
      button.classList.toggle('commerce-account-testimonials__rating-button--active', isActive);
      button.setAttribute('aria-checked', String(index + 1 === value));
    });
  };

  for (let value = 1; value <= 5; value += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'commerce-account-testimonials__rating-button';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-label', `${value} star${value === 1 ? '' : 's'}`);

    const visual = document.createElement('span');
    visual.className = 'commerce-account-testimonials__rating-star';
    visual.setAttribute('aria-hidden', 'true');

    button.append(visual);
    button.addEventListener('click', () => updateSelection(value));
    button.addEventListener('keydown', (event) => {
      const currentValue = Number.parseInt(control.value || '0', 10);
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        event.preventDefault();
        updateSelection(Math.min(5, currentValue + 1));
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        event.preventDefault();
        updateSelection(Math.max(1, currentValue - 1));
      }
    });

    buttons.push(button);
    group.append(button);
  }

  updateSelection(selectedRating || 0);
  field.append(group, control);
  return { field, control };
}

function createImageField(testimonialId) {
  const field = document.createElement('div');
  field.className = 'commerce-account-testimonials__field commerce-account-testimonials__field--image';

  const controlId = `commerce-testimonial-image-${testimonialId}`;
  const fieldLabel = document.createElement('label');
  fieldLabel.htmlFor = controlId;
  fieldLabel.textContent = 'Image (optional)';
  field.append(fieldLabel);

  const control = document.createElement('input');
  control.type = 'file';
  control.id = controlId;
  control.name = controlId;
  control.accept = TESTIMONIAL_IMAGE_ACCEPT;

  const fieldHint = document.createElement('p');
  fieldHint.className = 'commerce-account-testimonials__field-hint';
  fieldHint.textContent = TESTIMONIAL_IMAGE_HINT;

  const fieldError = document.createElement('p');
  fieldError.className = 'commerce-account-testimonials__field-error';
  fieldError.setAttribute('role', 'alert');
  fieldError.hidden = true;

  field.append(control, fieldHint, fieldError);

  const showFieldError = (message) => {
    if (message) {
      fieldError.textContent = message;
      fieldError.hidden = false;
      return;
    }

    fieldError.textContent = '';
    fieldError.hidden = true;
  };

  control.addEventListener('change', () => {
    const selectedFile = control.files?.[0];
    if (!selectedFile) {
      showFieldError(null);
      return;
    }

    showFieldError(validateTestimonialImage(selectedFile));
  });

  return { field, control, showFieldError };
}

function createToast(message) {
  const toast = document.createElement('p');
  toast.className = 'commerce-account-testimonials__toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.textContent = message;
  return toast;
}

function createLoadingState() {
  const loading = document.createElement('p');
  loading.className = 'commerce-account-testimonials__loading';
  loading.textContent = 'Loading your testimonials…';
  return loading;
}

function createEmptyState() {
  const empty = document.createElement('p');
  empty.className = 'commerce-account-testimonials__empty';
  empty.textContent = 'You have not submitted any testimonials yet.';
  return empty;
}

function createErrorState(message, onRetry) {
  const error = document.createElement('div');
  error.className = 'commerce-account-testimonials__error';

  const messageEl = document.createElement('p');
  messageEl.textContent = message;

  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.className = 'button';
  retryButton.textContent = 'Try again';
  retryButton.addEventListener('click', onRetry);

  error.append(messageEl, retryButton);
  return error;
}

function createCardImage(testimonial) {
  if (!testimonial.imageUrl) return null;

  const image = document.createElement('img');
  image.className = 'commerce-account-testimonials__image';
  image.src = testimonial.imageUrl;
  image.alt = `${testimonial.name} image`;
  image.loading = 'lazy';
  image.decoding = 'async';
  return image;
}

function createEditPanel(testimonial, { onCancel, onSaved }) {
  const panel = document.createElement('div');
  panel.className = 'commerce-account-testimonials__edit-panel';

  const form = document.createElement('form');
  form.className = 'commerce-account-testimonials__edit-form';
  form.noValidate = false;

  const header = document.createElement('div');
  header.className = 'commerce-account-testimonials__form-header';

  const heading = document.createElement('h3');
  heading.className = 'commerce-account-testimonials__edit-title';
  heading.textContent = 'Edit Testimonial';
  header.append(heading);

  const body = document.createElement('div');
  body.className = 'commerce-account-testimonials__form-body';

  const error = document.createElement('p');
  error.className = 'commerce-account-testimonials__form-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const nameField = createFormField({
    id: `commerce-testimonial-name-${testimonial.id}`,
    label: 'Name',
    required: true,
    value: testimonial.name,
  });
  const companyField = createFormField({
    id: `commerce-testimonial-company-${testimonial.id}`,
    label: 'Company (optional)',
    value: testimonial.company,
  });
  const ratingField = createRatingField(testimonial.id, testimonial.rating);
  const testimonialField = createFormField({
    id: `commerce-testimonial-text-${testimonial.id}`,
    label: 'Testimonial',
    required: true,
    multiline: true,
    value: testimonial.testimonialText,
  });
  const imageField = createImageField(testimonial.id);
  const imageLabel = imageField.field.querySelector('label');
  if (imageLabel) {
    imageLabel.textContent = 'Image (optional)';
  }
  let removeImageSelected = false;
  let replacementImageSelected = false;

  if (testimonial.imageUrl) {
    const imageTools = document.createElement('div');
    imageTools.className = 'commerce-account-testimonials__image-tools';

    const currentImagePreview = createCardImage(testimonial);
    if (currentImagePreview) {
      currentImagePreview.classList.add('commerce-account-testimonials__image-tools-preview');
    }

    const removeImageAction = document.createElement('button');
    removeImageAction.type = 'button';
    removeImageAction.className = 'button secondary commerce-account-testimonials__image-action';
    removeImageAction.textContent = 'Remove Image';
    removeImageAction.setAttribute('aria-pressed', 'false');

    const removeImageNote = document.createElement('p');
    removeImageNote.className = 'commerce-account-testimonials__remove-image-note';
    removeImageNote.textContent = 'Image will be removed when you save.';
    removeImageNote.hidden = true;

    if (currentImagePreview) {
      imageTools.append(currentImagePreview);
    }
    imageTools.append(removeImageAction);
    imageField.field.insertBefore(imageTools, imageField.control);
    imageField.field.insertBefore(removeImageNote, imageField.control.nextSibling);

    const applyRemoveImageState = (shouldRemove) => {
      removeImageSelected = shouldRemove;
      imageTools.classList.toggle('commerce-account-testimonials__image-tools--pending-remove', shouldRemove);
      imageField.field.classList.toggle('commerce-account-testimonials__field--replacement-selected', replacementImageSelected);
      removeImageAction.textContent = shouldRemove ? 'Undo Remove' : 'Remove Image';
      removeImageAction.setAttribute('aria-pressed', String(shouldRemove));
      removeImageNote.hidden = !shouldRemove || replacementImageSelected;
      if (currentImagePreview) {
        currentImagePreview.hidden = shouldRemove || replacementImageSelected;
      }
      if (shouldRemove && !replacementImageSelected) {
        imageField.control.value = '';
        imageField.showFieldError(null);
      }
    };

    removeImageAction.addEventListener('click', () => {
      applyRemoveImageState(!removeImageSelected);
    });

    imageField.control.addEventListener('change', () => {
      const selectedFile = imageField.control.files?.[0];
      if (selectedFile) {
        replacementImageSelected = true;
        applyRemoveImageState(removeImageSelected);
        imageField.showFieldError(validateTestimonialImage(selectedFile));
        return;
      }

      replacementImageSelected = false;
      applyRemoveImageState(removeImageSelected);
    });

    applyRemoveImageState(false);
  }

  const actions = document.createElement('div');
  actions.className = 'commerce-account-testimonials__form-actions';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'button secondary';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', () => onCancel?.());

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'button';
  saveButton.textContent = 'Save changes';

  actions.append(cancelButton, saveButton);
  body.append(
    error,
    nameField.field,
    companyField.field,
    ratingField.field,
    testimonialField.field,
    imageField.field,
    actions,
  );
  form.append(header, body);
  panel.append(form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    error.textContent = '';

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const ratingValue = Number.parseInt(ratingField.control.value, 10);
    if (!ratingValue) {
      error.textContent = 'Please select a rating.';
      error.hidden = false;
      return;
    }

    const selectedImage = imageField.control.files?.[0] || null;
    const imageValidationError = validateTestimonialImage(selectedImage);
    if (imageValidationError) {
      imageField.showFieldError(imageValidationError);
      return;
    }

    imageField.showFieldError(null);
    saveButton.disabled = true;
    cancelButton.disabled = true;

    try {
      await updateMyPendingTestimonial({
        id: testimonial.id,
        name: nameField.control.value.trim(),
        company: companyField.control.value.trim(),
        rating: ratingValue,
        testimonialText: testimonialField.control.value.trim(),
        removeImage: removeImageSelected,
      }, selectedImage);
      await onSaved?.();
    } catch (updateError) {
      console.error('Failed to update testimonial', updateError);
      error.textContent = updateError.message || 'Unable to update your testimonial. Please try again.';
      error.hidden = false;
      saveButton.disabled = false;
      cancelButton.disabled = false;
    }
  });

  return panel;
}

function createTestimonialCard(testimonial, { homepageUrl, onSaved }) {
  const card = document.createElement('article');
  card.className = 'commerce-account-testimonials__card';
  card.dataset.status = testimonial.status;

  const header = document.createElement('div');
  header.className = 'commerce-account-testimonials__card-header';

  const title = document.createElement('h3');
  title.className = 'commerce-account-testimonials__card-title';
  title.textContent = testimonial.name;

  const meta = document.createElement('div');
  meta.className = 'commerce-account-testimonials__card-meta';
  meta.append(createStatusBadge(testimonial.status));

  const date = document.createElement('time');
  date.className = 'commerce-account-testimonials__card-date';
  date.dateTime = testimonial.updatedAt || testimonial.createdAt;
  date.textContent = formatDate(testimonial.updatedAt || testimonial.createdAt);
  meta.append(date);

  header.append(title, meta);

  const body = document.createElement('div');
  body.className = 'commerce-account-testimonials__card-body';

  const content = document.createElement('div');
  content.className = 'commerce-account-testimonials__card-content';

  if (testimonial.company) {
    const company = document.createElement('p');
    company.className = 'commerce-account-testimonials__card-company';
    company.textContent = testimonial.company;
    content.append(company);
  }

  content.append(createStars(Math.min(5, Math.max(0, testimonial.rating || 0))));

  const quote = document.createElement('p');
  quote.className = 'commerce-account-testimonials__card-text';
  quote.textContent = testimonial.testimonialText;
  content.append(quote);

  const image = createCardImage(testimonial);
  body.append(content);
  if (image) {
    body.append(image);
  }

  const footer = document.createElement('div');
  footer.className = 'commerce-account-testimonials__card-footer';

  if (testimonial.status === 'pending') {
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'button secondary commerce-account-testimonials__edit-button';
    editButton.textContent = 'Edit';
    editButton.addEventListener('click', async () => {
      if (editButton.disabled) return;
      editButton.disabled = true;

      let activeModal;
      const editPanel = createEditPanel(testimonial, {
        onCancel: () => activeModal?.removeModal(),
        onSaved: async () => {
          activeModal?.removeModal();
          await onSaved?.('Your testimonial was updated successfully.');
        },
      });

      activeModal = await createModal([editPanel]);
      const dialog = activeModal.block.querySelector('dialog');
      const modalContent = activeModal.block.querySelector('.modal-content');

      dialog?.classList.add('commerce-account-testimonials__dialog', 'testimonials-dialog');
      modalContent?.classList.add('commerce-account-testimonials__modal-content', 'testimonials-modal-content');
      dialog?.addEventListener('close', () => {
        editButton.disabled = false;
      }, { once: true });

      activeModal.showModal();
    });
    footer.append(editButton);
  } else if (testimonial.status === 'rejected') {
    const message = document.createElement('p');
    message.className = 'commerce-account-testimonials__rejected-message';
    message.append('Please submit a new testimonial from the ');

    const link = document.createElement('a');
    link.className = 'commerce-account-testimonials__homepage-link';
    link.href = homepageUrl;
    link.textContent = 'homepage';

    message.append(link, '.');
    footer.append(message);
  }

  card.append(header, body, footer);

  return card;
}

function sortTestimonials(testimonials) {
  return [...testimonials].sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.createdAt).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt).getTime();
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  });
}

export default async function decorate(block) {
  const { 'homepage-link': homepageLink = '/' } = readBlockConfig(block);
  const homepageUrl = rootLink(homepageLink);

  block.textContent = '';
  block.classList.add('commerce-account-testimonials');

  const container = document.createElement('div');
  container.className = 'commerce-account-testimonials__container';
  block.append(container);

  if (!checkIsAuthenticated()) {
    window.location.href = rootLink(CUSTOMER_LOGIN_PATH);
    return;
  }

  let toastTimeoutId;

  const showToast = (message) => {
    const existingToast = container.querySelector('.commerce-account-testimonials__toast');
    existingToast?.remove();
    if (toastTimeoutId) {
      window.clearTimeout(toastTimeoutId);
    }

    const toast = createToast(message);
    container.prepend(toast);
    toastTimeoutId = window.setTimeout(() => {
      toast.remove();
    }, 5000);
  };

  const loadTestimonials = async () => {
    container.replaceChildren(createLoadingState());

    try {
      const testimonials = sortTestimonials(await fetchMyTestimonials());

      if (!testimonials.length) {
        container.replaceChildren(createEmptyState());
        return;
      }

      const list = document.createElement('div');
      list.className = 'commerce-account-testimonials__list';

      testimonials.forEach((testimonial) => {
        list.append(createTestimonialCard(testimonial, {
          homepageUrl,
          onSaved: async (message) => {
            await loadTestimonials();
            showToast(message);
          },
        }));
      });

      container.replaceChildren(list);
    } catch (loadError) {
      console.error('Failed to load customer testimonials', loadError);
      container.replaceChildren(createErrorState(
        loadError.message || 'Unable to load your testimonials. Please try again.',
        loadTestimonials,
      ));
    }
  };

  events.on('authenticated', (isAuthenticated) => {
    if (!isAuthenticated) {
      window.location.href = rootLink(CUSTOMER_LOGIN_PATH);
    }
  });

  await loadTestimonials();
}
