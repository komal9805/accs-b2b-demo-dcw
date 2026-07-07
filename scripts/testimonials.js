import { FetchGraphQL } from '@dropins/tools/fetch-graphql.js';
import { getCookie } from '@dropins/tools/lib.js';
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

const GET_MY_TESTIMONIALS_QUERY = `
  query GetMyTestimonials {
    customer_list_by_email {
      items {
        id
        name
        company
        email
        rating
        testimonial_text
        image_url
        status
        created_at
        updated_at
      }
      total
    }
  }
`;

const UPDATE_PENDING_TESTIMONIAL_MUTATION = `
  mutation UpdatePendingTestimonial($input: mutationInput_customer_update_pending_input_Input!) {
    customer_update_pending(input: $input) {
      testimonial {
        id
        name
        company
        rating
        testimonial_text
        image_url
        status
        created_at
        updated_at
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

function mapPublicTestimonialItem(item) {
  return {
    id: item.id,
    name: item.name,
    company: item.company || '',
    rating: item.rating,
    testimonialText: item.testimonial_text,
    imageUrl: item.image_url?.trim() || null,
    createdAt: item.created_at,
  };
}

function mapCustomerTestimonialItem(item) {
  return {
    ...mapPublicTestimonialItem(item),
    email: item.email || '',
    status: item.status,
    updatedAt: item.updated_at,
  };
}

async function fetchWithCustomerAuth(query, options = {}) {
  const token = getCookie('auth_dropin_user_token');
  if (!token) {
    throw new Error('Authentication required.');
  }

  TESTIMONIALS_FETCH_GRAPHQL.setFetchGraphQlHeader('Authorization', `Bearer ${token}`);
  try {
    return await TESTIMONIALS_FETCH_GRAPHQL.fetchGraphQl(query, {
      method: 'POST',
      ...options,
    });
  } finally {
    TESTIMONIALS_FETCH_GRAPHQL.removeFetchGraphQlHeader('Authorization');
  }
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

  return items.map((item) => mapPublicTestimonialItem(item));
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

/**
 * Fetches testimonials for the logged-in customer (matched by Commerce email).
 * @returns {Promise<Array<object>>}
 */
export async function fetchMyTestimonials() {
  ensureEndpoint();

  const { data, errors } = await fetchWithCustomerAuth(GET_MY_TESTIMONIALS_QUERY);

  if (errors?.length) {
    throw new Error(getGraphQLErrorMessage(
      errors,
      'Unable to load your testimonials. Please try again.',
    ));
  }

  const items = data?.customer_list_by_email?.items ?? [];

  return items.map((item) => mapCustomerTestimonialItem(item));
}

/**
 * Updates a pending testimonial for the logged-in customer.
 * @param {object} input Update payload (must include id; optional `removeImage`)
 * @param {File} [image] Optional replacement image
 * @returns {Promise<object>}
 */
export async function updateMyPendingTestimonial(input, image) {
  ensureEndpoint();

  const mutationInput = {
    id: input.id,
    name: input.name,
    company: input.company || null,
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
  } else if (input.removeImage) {
    mutationInput.remove_image = true;
  }

  const { data, errors } = await fetchWithCustomerAuth(
    UPDATE_PENDING_TESTIMONIAL_MUTATION,
    {
      variables: {
        input: mutationInput,
      },
    },
  );

  if (errors?.length) {
    throw new Error(getGraphQLErrorMessage(
      errors,
      'Unable to update your testimonial. Please try again.',
    ));
  }

  const testimonial = data?.customer_update_pending?.testimonial;
  if (!testimonial?.id) {
    throw new Error('Testimonial update failed.');
  }

  return mapCustomerTestimonialItem(testimonial);
}
