import { loadCSS, readBlockConfig } from '../../scripts/aem.js';
import { fetchApprovedTestimonials, submitTestimonial } from '../../scripts/testimonials.js';
import createModal from '../modal/modal.js';

const DEFAULT_SUCCESS_MESSAGE = 'Thank you! Your testimonial has been submitted and is pending review.';
const DEFAULT_CTA_LABEL = 'Submit Testimonial';
const DEFAULT_EMPTY_MESSAGE = 'We\'d love to hear about your experience.';
const AUTOPLAY_INTERVAL_MS = 10000;
const MODAL_CSS_HREF = `${window.hlx.codeBasePath}/blocks/modal/modal.css`;
const TESTIMONIALS_CSS_HREF = `${window.hlx.codeBasePath}/blocks/testimonials/testimonials.css`;

let modalStylesPrepared = false;

function ensureTestimonialsModalStyles() {
  const existingLink = document.querySelector(`head > link[href="${TESTIMONIALS_CSS_HREF}"]`);
  if (existingLink) {
    document.head.append(existingLink);
    return Promise.resolve();
  }
  return loadCSS(TESTIMONIALS_CSS_HREF);
}

const TESTIMONIALS_MODAL_CRITICAL_STYLE_ID = 'testimonials-modal-critical';

function injectTestimonialsModalCriticalStyles() {
  if (document.getElementById(TESTIMONIALS_MODAL_CRITICAL_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = TESTIMONIALS_MODAL_CRITICAL_STYLE_ID;
  style.textContent = `
    .modal dialog.testimonials-dialog {
      box-sizing: border-box;
      width: 520px;
      max-width: calc(100vw - 2rem);
      height: fit-content;
      margin: 0;
      padding: 0;
      inset: unset;
      top: 50%;
      left: 50%;
      right: auto;
      bottom: auto;
      transform: translate(-50%, -50%);
      overflow: hidden;
    }
    .modal dialog.testimonials-dialog .modal-content {
      position: relative;
      width: 100%;
      padding: 0;
    }
    .modal dialog.testimonials-dialog .testimonials__form {
      display: flex;
      flex-direction: column;
      width: 100%;
      position: relative;
      isolation: isolate;
    }
    .modal dialog.testimonials-dialog .close-button {
      top: 0 !important;
      right: 0 !important;
    }
  `;
  document.head.append(style);
}

function waitForNextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

async function prepareTestimonialsModalStyles() {
  if (modalStylesPrepared) return;

  injectTestimonialsModalCriticalStyles();
  await Promise.all([
    loadCSS(MODAL_CSS_HREF),
    ensureTestimonialsModalStyles(),
  ]);
  modalStylesPrepared = true;
}

function resolveWallpaperUrl(raw) {
  const value = (raw || '').trim();
  if (!value) return '';

  try {
    if (/^https?:\/\//i.test(value)) return value;
    return new URL(value, `${window.location.origin}/`).href;
  } catch {
    return '';
  }
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function parseMaxItems(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) return 10;
  return Math.min(parsed, 50);
}

function createStars(rating, labelPrefix = 'Rating') {
  const stars = document.createElement('div');
  stars.className = 'testimonials__stars';
  stars.setAttribute('role', 'img');
  stars.setAttribute('aria-label', `${labelPrefix}: ${rating} out of 5`);

  for (let index = 1; index <= 5; index += 1) {
    const star = document.createElement('span');
    star.className = 'testimonials__star';
    star.setAttribute('aria-hidden', 'true');
    if (index <= rating) {
      star.classList.add('testimonials__star--filled');
    }
    stars.append(star);
  }

  return stars;
}

function updateActiveSlide(slide) {
  const block = slide.closest('.testimonials');
  if (!block) return;

  const slideIndex = Number.parseInt(slide.dataset.slideIndex, 10);
  block.dataset.activeSlide = String(slideIndex);

  block.querySelectorAll('.testimonials__slide').forEach((item, idx) => {
    item.setAttribute('aria-hidden', idx !== slideIndex ? 'true' : 'false');
  });

  block.querySelectorAll('.testimonials__indicator').forEach((indicator, idx) => {
    const button = indicator.querySelector('button');
    if (!button) return;
    if (idx === slideIndex) {
      button.setAttribute('aria-current', 'true');
      button.setAttribute('disabled', 'true');
    } else {
      button.removeAttribute('aria-current');
      button.removeAttribute('disabled');
    }
  });
}

function showSlide(block, slideIndex = 0) {
  const slides = block.querySelectorAll('.testimonials__slide');
  if (!slides.length) return;

  let realSlideIndex = slideIndex;
  if (slideIndex < 0) realSlideIndex = slides.length - 1;
  if (slideIndex >= slides.length) realSlideIndex = 0;

  const activeSlide = slides[realSlideIndex];
  const track = block.querySelector('.testimonials__track');
  if (!track || !activeSlide) return;

  track.scrollTo({
    top: 0,
    left: activeSlide.offsetLeft,
    behavior: 'smooth',
  });
  updateActiveSlide(activeSlide);
}

function createNavigationButtons(block) {
  const nav = document.createElement('div');
  nav.className = 'testimonials__navigation';
  nav.setAttribute('aria-label', 'Testimonial slider controls');

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'testimonials__nav-button testimonials__nav-button--prev';
  prev.setAttribute('aria-label', 'Previous slide');

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'testimonials__nav-button testimonials__nav-button--next';
  next.setAttribute('aria-label', 'Next slide');

  prev.addEventListener('click', () => {
    const current = Number.parseInt(block.dataset.activeSlide || '0', 10);
    showSlide(block, current - 1);
  });

  next.addEventListener('click', () => {
    const current = Number.parseInt(block.dataset.activeSlide || '0', 10);
    showSlide(block, current + 1);
  });

  nav.append(prev, next);
  return nav;
}

function bindSliderEvents(block, autoplay) {
  const indicators = block.querySelector('.testimonials__indicators');
  if (indicators) {
    indicators.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', (event) => {
        const indicator = event.currentTarget.closest('.testimonials__indicator');
        if (!indicator) return;
        showSlide(block, Number.parseInt(indicator.dataset.targetSlide, 10));
      });
    });
  }

  const slideObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) updateActiveSlide(entry.target);
      });
    },
    { threshold: 0.6 },
  );

  block.querySelectorAll('.testimonials__slide').forEach((slide) => {
    slideObserver.observe(slide);
  });

  if (!autoplay) return undefined;

  const slides = block.querySelectorAll('.testimonials__slide');
  if (slides.length < 2) return undefined;

  const intervalId = window.setInterval(() => {
    const current = Number.parseInt(block.dataset.activeSlide || '0', 10);
    showSlide(block, (current + 1) % slides.length);
  }, AUTOPLAY_INTERVAL_MS);

  return () => window.clearInterval(intervalId);
}

function applyDefaultCtaVisual(visual) {
  if (visual.classList.contains('testimonials__cta-visual--default')) return;

  visual.classList.add('testimonials__cta-visual--default');
  visual.querySelectorAll('.testimonials__cta-wallpaper, .testimonials__cta-visual-content').forEach((node) => node.remove());

  const decorative = document.createElement('div');
  decorative.className = 'testimonials__cta-visual-content';

  const icon = document.createElement('span');
  icon.className = 'testimonials__cta-icon';
  icon.setAttribute('aria-hidden', 'true');

  const tagline = document.createElement('p');
  tagline.className = 'testimonials__cta-tagline';
  tagline.textContent = 'We\'re always happy to hear from our customers.';

  decorative.append(icon, tagline);
  const overlay = visual.querySelector('.testimonials__cta-visual-overlay');
  if (overlay) {
    visual.insertBefore(decorative, overlay);
  } else {
    visual.append(decorative);
  }
}

function createCtaSlide({
  slideIndex,
  blockId,
  ctaLabel,
  wallpaper,
  emptyMessage,
  hasTestimonials,
  onOpenModal,
}) {
  const slide = document.createElement('li');
  slide.className = 'testimonials__slide testimonials__slide--cta';
  slide.dataset.slideIndex = String(slideIndex);
  slide.id = `testimonials-${blockId}-slide-${slideIndex}`;
  slide.setAttribute('aria-hidden', slideIndex === 0 ? 'false' : 'true');

  const panel = document.createElement('div');
  panel.className = 'testimonials__cta-panel';

  const visual = document.createElement('div');
  visual.className = 'testimonials__cta-visual';

  const visualOverlay = document.createElement('div');
  visualOverlay.className = 'testimonials__cta-visual-overlay';
  visual.append(visualOverlay);

  const wallpaperUrl = resolveWallpaperUrl(wallpaper);
  if (wallpaperUrl) {
    const wallpaperImage = document.createElement('img');
    wallpaperImage.className = 'testimonials__cta-wallpaper';
    wallpaperImage.src = wallpaperUrl;
    wallpaperImage.alt = '';
    wallpaperImage.setAttribute('aria-hidden', 'true');
    wallpaperImage.addEventListener('error', () => {
      applyDefaultCtaVisual(visual);
    });
    visual.insertBefore(wallpaperImage, visualOverlay);
  } else {
    applyDefaultCtaVisual(visual);
  }

  const action = document.createElement('div');
  action.className = 'testimonials__cta-action';

  const content = document.createElement('div');
  content.className = 'testimonials__cta-content';

  const title = document.createElement('h3');
  title.className = 'testimonials__cta-title';
  title.textContent = 'Share your story';

  const description = document.createElement('p');
  description.className = 'testimonials__cta-description';
  description.textContent = hasTestimonials
    ? 'Tell us about your experience and help other customers.'
    : emptyMessage;

  const cta = document.createElement('button');
  cta.type = 'button';
  cta.className = 'button testimonials__cta-button';
  cta.textContent = ctaLabel;
  cta.addEventListener('click', onOpenModal);

  content.append(title, description, cta);
  action.append(content);
  panel.append(visual, action);
  slide.append(panel);
  return slide;
}

function createTestimonialSlide({ testimonial, slideIndex, blockId }) {
  const slide = document.createElement('li');
  slide.className = 'testimonials__slide testimonials__slide--review';
  slide.dataset.slideIndex = String(slideIndex);
  slide.id = `testimonials-${blockId}-slide-${slideIndex}`;
  slide.setAttribute('aria-hidden', slideIndex === 0 ? 'false' : 'true');

  const card = document.createElement('blockquote');
  card.className = 'testimonials__card';

  const quote = document.createElement('p');
  quote.className = 'testimonials__quote';
  quote.textContent = testimonial.testimonialText;

  const author = document.createElement('div');
  author.className = 'testimonials__author';

  const name = document.createElement('cite');
  name.className = 'testimonials__name';
  name.textContent = testimonial.name;

  author.append(name);

  if (testimonial.company) {
    const company = document.createElement('span');
    company.className = 'testimonials__company';
    company.textContent = testimonial.company;
    author.append(company);
  }

  author.append(createStars(Math.min(5, Math.max(0, testimonial.rating || 0))));

  card.append(quote, author);
  slide.append(card);
  return slide;
}

function bindRatingField(field) {
  const group = field.querySelector('.testimonials__rating-options');
  if (!group) return;

  const options = [...group.querySelectorAll('.testimonials__rating-option')];

  const setHighlight = (rating) => {
    options.forEach((option) => {
      const input = option.querySelector('input');
      const star = option.querySelector('.testimonials__rating-star');
      const value = Number.parseInt(input.value, 10);
      star.classList.toggle('testimonials__rating-star--filled', value <= rating);
    });
  };

  const getCheckedRating = () => {
    const checked = group.querySelector('input:checked');
    return checked ? Number.parseInt(checked.value, 10) : 0;
  };

  options.forEach((option) => {
    const input = option.querySelector('input');
    const value = Number.parseInt(input.value, 10);

    option.addEventListener('mouseenter', () => setHighlight(value));
    input.addEventListener('change', () => setHighlight(value));
  });

  group.addEventListener('mouseleave', () => setHighlight(getCheckedRating()));
  setHighlight(getCheckedRating());
}

function createRatingField() {
  const field = document.createElement('div');
  field.className = 'testimonials__field testimonials__field--rating';

  const label = document.createElement('label');
  label.id = 'testimonial-rating-label';
  label.textContent = 'Rating';
  field.append(label);

  const fieldset = document.createElement('fieldset');
  fieldset.className = 'testimonials__rating-field';
  fieldset.setAttribute('aria-labelledby', 'testimonial-rating-label');
  fieldset.required = true;

  const group = document.createElement('div');
  group.className = 'testimonials__rating-options';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Rating');

  for (let value = 1; value <= 5; value += 1) {
    const option = document.createElement('label');
    option.className = 'testimonials__rating-option';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'rating';
    input.value = String(value);
    input.required = true;
    input.setAttribute('aria-label', `${value} star${value === 1 ? '' : 's'}`);

    const visual = document.createElement('span');
    visual.className = 'testimonials__rating-star';
    visual.setAttribute('aria-hidden', 'true');

    option.append(input, visual);
    group.append(option);
  }

  fieldset.append(group);
  field.append(fieldset);
  bindRatingField(field);
  return field;
}

function createFormField({
  id, label, type = 'text', required = false, multiline = false,
}) {
  const field = document.createElement('div');
  field.className = 'testimonials__field';

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
  if (multiline) {
    control.rows = 3;
  }

  field.append(control);
  return { field, control };
}

function createSubmitOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'testimonials__submit-overlay';
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');

  const spinner = document.createElement('div');
  spinner.className = 'testimonials__submit-overlay-spinner';
  spinner.setAttribute('aria-hidden', 'true');

  const message = document.createElement('p');
  message.className = 'testimonials__submit-overlay-message';
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  message.textContent = 'Submitting your testimonial…';

  overlay.append(spinner, message);

  return overlay;
}

function createSubmissionForm({
  onSubmit, onCancel, getSubmitControls, overlay,
}) {
  const form = document.createElement('form');
  form.className = 'testimonials__form testimonials__modal-panel';
  form.noValidate = false;

  const header = document.createElement('div');
  header.className = 'testimonials__form-header';

  const title = document.createElement('h2');
  title.id = 'testimonials-form-title';
  title.textContent = 'Submit a Testimonial';
  header.append(title);

  const body = document.createElement('div');
  body.className = 'testimonials__form-body';

  const error = document.createElement('p');
  error.className = 'testimonials__form-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const nameField = createFormField({
    id: 'testimonial-name',
    label: 'Name',
    required: true,
  });
  const companyField = createFormField({
    id: 'testimonial-company',
    label: 'Company (optional)',
    required: false,
  });
  const emailField = createFormField({
    id: 'testimonial-email',
    label: 'Email',
    type: 'email',
    required: true,
  });
  const ratingField = createRatingField();
  const testimonialField = createFormField({
    id: 'testimonial-text',
    label: 'Testimonial',
    required: true,
    multiline: true,
  });

  const actions = document.createElement('div');
  actions.className = 'testimonials__form-actions';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'button secondary testimonials__cancel-button';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', () => onCancel?.());

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'button testimonials__submit-button';
  submitButton.textContent = 'Submit';

  actions.append(cancelButton, submitButton);
  body.append(
    error,
    nameField.field,
    companyField.field,
    emailField.field,
    ratingField,
    testimonialField.field,
    actions,
  );
  form.append(header, body);
  if (overlay) {
    form.append(overlay);
  }

  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
    title.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const setSubmitting = (isSubmitting) => {
    form.classList.toggle('testimonials__form--submitting', isSubmitting);
    const controls = getSubmitControls?.();
    if (controls?.overlay) {
      controls.overlay.hidden = !isSubmitting;
      controls.overlay.setAttribute('aria-hidden', String(!isSubmitting));
    }
    if (controls?.closeButton) {
      controls.closeButton.disabled = isSubmitting;
    }
    submitButton.disabled = isSubmitting;
    cancelButton.disabled = isSubmitting;
    if (isSubmitting) {
      submitButton.setAttribute('aria-busy', 'true');
    } else {
      submitButton.removeAttribute('aria-busy');
    }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    error.textContent = '';

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const ratingInput = form.querySelector('input[name="rating"]:checked');
    if (!ratingInput) {
      showError('Please select a rating.');
      return;
    }

    setSubmitting(true);

    try {
      await onSubmit({
        name: nameField.control.value.trim(),
        company: companyField.control.value.trim(),
        email: emailField.control.value.trim(),
        rating: Number.parseInt(ratingInput.value, 10),
        testimonialText: testimonialField.control.value.trim(),
      });
    } catch (submitError) {
      console.error('Failed to submit testimonial', submitError);
      showError(submitError.message || 'Unable to submit your testimonial. Please try again.');
      setSubmitting(false);
    }
  });

  return form;
}

function createSuccessMessage(message) {
  const wrapper = document.createElement('div');
  wrapper.className = 'testimonials__success testimonials__modal-panel';
  wrapper.setAttribute('role', 'status');

  const header = document.createElement('div');
  header.className = 'testimonials__form-header';

  const heading = document.createElement('h2');
  heading.textContent = 'Submission Received';
  header.append(heading);

  const body = document.createElement('div');
  body.className = 'testimonials__success-body';

  const text = document.createElement('p');
  text.textContent = message;

  body.append(text);
  wrapper.append(header, body);
  return wrapper;
}

function renderLoading(container) {
  container.replaceChildren();
  const skeleton = document.createElement('div');
  skeleton.className = 'testimonials__loading';
  skeleton.setAttribute('aria-busy', 'true');
  skeleton.setAttribute('aria-live', 'polite');
  skeleton.textContent = 'Loading testimonials…';
  container.append(skeleton);
}

function removeTestimonialsBlock(block) {
  const section = block.closest('.section');
  if (section) {
    section.remove();
    return;
  }
  block.remove();
}

function buildSlider(block, {
  blockId,
  heading,
  ctaLabel,
  wallpaper,
  emptyMessage,
  testimonials,
  autoplay,
  onOpenModal,
}) {
  if (block._testimonialsStopAutoplay) {
    block._testimonialsStopAutoplay();
    block._testimonialsStopAutoplay = undefined;
  }

  block.replaceChildren();
  block.dataset.activeSlide = '0';
  block.setAttribute('role', 'region');
  block.setAttribute('aria-roledescription', 'carousel');
  block.setAttribute('aria-label', heading || 'Customer testimonials');

  if (heading) {
    const headingEl = document.createElement('h2');
    headingEl.className = 'testimonials__heading';
    headingEl.textContent = heading;
    block.append(headingEl);
  }

  const viewport = document.createElement('div');
  viewport.className = 'testimonials__viewport';

  const track = document.createElement('ul');
  track.className = 'testimonials__track';

  const slides = [
    createCtaSlide({
      slideIndex: 0,
      blockId,
      ctaLabel,
      wallpaper,
      emptyMessage,
      hasTestimonials: testimonials.length > 0,
      onOpenModal,
    }),
    ...testimonials.map((testimonial, index) => createTestimonialSlide({
      testimonial,
      slideIndex: index + 1,
      blockId,
    })),
  ];

  slides.forEach((slide) => track.append(slide));
  viewport.append(track);

  if (slides.length > 1) {
    viewport.append(createNavigationButtons(block));
  }

  block.append(viewport);

  if (slides.length > 1) {
    const nav = document.createElement('nav');
    nav.className = 'testimonials__nav';
    nav.setAttribute('aria-label', 'Testimonial slides');

    const indicators = document.createElement('ol');
    indicators.className = 'testimonials__indicators';

    slides.forEach((slide, index) => {
      const indicator = document.createElement('li');
      indicator.className = 'testimonials__indicator';
      indicator.dataset.targetSlide = String(index);

      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', `Show slide ${index + 1} of ${slides.length}`);
      if (index === 0) {
        button.setAttribute('aria-current', 'true');
        button.setAttribute('disabled', 'true');
      }

      indicator.append(button);
      indicators.append(indicator);
    });

    nav.append(indicators);
    block.append(nav);
    const stopAutoplay = bindSliderEvents(block, autoplay);
    if (stopAutoplay) {
      block._testimonialsStopAutoplay = stopAutoplay;
    }
  }
}

let testimonialsBlockId = 0;

export default async function decorate(block) {
  const config = readBlockConfig(block);

  const heading = (config.heading || '').trim();
  const wallpaper = (config.wallpaper || '').trim();
  const ctaLabel = (config['cta-label'] || DEFAULT_CTA_LABEL).trim();
  const successMessage = (config['success-message'] || DEFAULT_SUCCESS_MESSAGE).trim();
  const emptyMessage = (config['empty-message'] || DEFAULT_EMPTY_MESSAGE).trim();
  const maxItems = parseMaxItems(config['max-items']);
  const autoplay = parseBoolean(config.autoplay, true);

  testimonialsBlockId += 1;
  const blockId = testimonialsBlockId;

  block.textContent = '';
  block.classList.add('testimonials');

  await prepareTestimonialsModalStyles();

  const container = document.createElement('div');
  container.className = 'testimonials__container';
  block.append(container);

  let activeModalInstance = null;

  const openSubmissionModal = async () => {
    if (activeModalInstance) return;

    let activeModal;
    let closeButton;
    const overlay = createSubmitOverlay();

    await prepareTestimonialsModalStyles();

    const form = createSubmissionForm({
      overlay,
      getSubmitControls: () => ({ overlay, closeButton }),
      onSubmit: async (input) => {
        try {
          await submitTestimonial(input);
          const dialogContent = activeModal.block.querySelector('.modal-content');
          if (dialogContent) {
            dialogContent.replaceChildren(createSuccessMessage(successMessage));
          }
        } finally {
          overlay.hidden = true;
          overlay.setAttribute('aria-hidden', 'true');
          if (closeButton) {
            closeButton.disabled = false;
          }
        }
      },
      onCancel: () => activeModal?.removeModal(),
    });

    activeModal = await createModal([form]);
    activeModalInstance = activeModal;

    const dialog = activeModal.block.querySelector('dialog');
    const modalContent = activeModal.block.querySelector('.modal-content');
    dialog?.classList.add('testimonials-dialog');
    modalContent?.classList.add('testimonials-modal-content');
    closeButton = activeModal.block.querySelector('.close-button');

    dialog?.addEventListener('close', () => {
      activeModalInstance = null;
    }, { once: true });

    await waitForNextFrame();
    activeModal.showModal();
  };

  const loadTestimonials = async () => {
    renderLoading(container);

    try {
      const testimonials = await fetchApprovedTestimonials();
      const latestTestimonials = testimonials
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, maxItems);

      buildSlider(block, {
        blockId,
        heading,
        ctaLabel,
        wallpaper,
        emptyMessage,
        testimonials: latestTestimonials,
        autoplay,
        onOpenModal: openSubmissionModal,
      });
    } catch (error) {
      console.error('Failed to load testimonials', error);
      removeTestimonialsBlock(block);
    }
  };

  await loadTestimonials();
}
