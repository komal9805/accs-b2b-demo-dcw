import { FetchGraphQL } from '@dropins/tools/fetch-graphql.js';
import { getConfigValue } from '@dropins/tools/lib/aem/configs.js';

const TESTIMONIALS_FETCH_GRAPHQL = new FetchGraphQL();

const GET_APPROVED_TESTIMONIALS_QUERY = `
  query GetApprovedTestimonials {
    approved_testimonials {
      items {
        id
        name
        company
        rating
        testimonial_text
        image_url
        created_at
      }
      total
    }
  }
`;

const SUBMIT_TESTIMONIAL_MUTATION = `
  mutation SubmitTestimonial($input: mutationInput_submit_testimonial_input_Input!) {
    submit_testimonial(input: $input) {
      testimonial {
        id
        status
      }
    }
  }
`;

let endpointInitialized = false;

export const TESTIMONIAL_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const TESTIMONIAL_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';
export const TESTIMONIAL_IMAGE_HINT = 'Max size 2 MB. Allowed: JPG, JPEG, PNG, WebP.';

const TESTIMONIAL_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Validates an optional testimonial image file before upload.
 * @param {File|null|undefined} file
 * @returns {string|null} Error message or null when valid / not provided
 */
export function validateTestimonialImage(file) {
  if (!file) return null;

  if (!TESTIMONIAL_IMAGE_TYPES.has(file.type)) {
    return 'Please upload a JPG, PNG, or WebP image (max 2 MB).';
  }

  if (file.size > TESTIMONIAL_IMAGE_MAX_BYTES) {
    return 'Image must be 2 MB or smaller.';
  }

  return null;
}

function getGraphQLErrorMessage(errors, fallbackMessage) {
  const fallback = fallbackMessage || 'Something went wrong. Please try again.';
  if (!errors?.length) return fallback;

  const friendlyError = errors.find((error) => {
    const responseMessage = error?.extensions?.responseJson?.error;
    if (typeof responseMessage === 'string' && responseMessage.trim()) {
      return true;
    }

    const message = error?.message?.trim();
    return Boolean(
      message
      && !message.includes('HTTP Error')
      && !message.includes('Could not invoke operation'),
    );
  });

  if (!friendlyError) return fallback;

  const responseMessage = friendlyError?.extensions?.responseJson?.error;
  if (typeof responseMessage === 'string' && responseMessage.trim()) {
    return responseMessage.trim();
  }

  return friendlyError.message.trim();
}

function ensureEndpoint() {
  if (endpointInitialized) return;

  const endpoint = getConfigValue('testimonials-mesh-endpoint');
  if (!endpoint) {
    throw new Error('Testimonials mesh endpoint is not configured.');
  }

  TESTIMONIALS_FETCH_GRAPHQL.setEndpoint(endpoint);
  endpointInitialized = true;
}

/**
 * Fetches approved testimonials from the Testimonials API Mesh.
 * Email is never returned by this query.
 * @returns {Promise<Array<object>>}
 */
export async function fetchApprovedTestimonials() {
  ensureEndpoint();

  const { data, errors } = await TESTIMONIALS_FETCH_GRAPHQL.fetchGraphQl(
    GET_APPROVED_TESTIMONIALS_QUERY,
  );

  if (errors?.length) {
    throw new Error(getGraphQLErrorMessage(
      errors,
      'Unable to load testimonials. Please try again later.',
    ));
  }

  const items = data?.approved_testimonials?.items ?? [];

  return items.map((item) => ({
    id: item.id,
    name: item.name,
    company: item.company || '',
    rating: item.rating,
    testimonialText: item.testimonial_text,
    imageUrl: item.image_url?.trim() || null,
    createdAt: item.created_at,
  }));
}

async function readFileAsBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

/**
 * Submits a testimonial for review.
 * @param {object} input Submission payload
 * @param {File} [image] Optional customer image
 * @returns {Promise<{ id: string, status: string }>}
 */
export async function submitTestimonial(input, image) {
  ensureEndpoint();

  const mutationInput = {
    name: input.name,
    company: input.company || undefined,
    email: input.email,
    rating: input.rating,
    testimonial_text: input.testimonialText,
  };

  if (image) {
    const validationError = validateTestimonialImage(image);
    if (validationError) {
      throw new Error(validationError);
    }

    mutationInput.image_base64 = await readFileAsBase64(image);
    mutationInput.image_mimetype = image.type;
    mutationInput.image_filename = image.name;
  }

  const { data, errors } = await TESTIMONIALS_FETCH_GRAPHQL.fetchGraphQl(
    SUBMIT_TESTIMONIAL_MUTATION,
    {
      method: 'POST',
      variables: {
        input: mutationInput,
      },
    },
  );

  if (errors?.length) {
    throw new Error(getGraphQLErrorMessage(
      errors,
      'Unable to submit your testimonial. Please try again.',
    ));
  }

  const testimonial = data?.submit_testimonial?.testimonial;
  if (!testimonial?.id) {
    throw new Error('Testimonial submission failed.');
  }

  return {
    id: testimonial.id,
    status: testimonial.status,
  };
}
