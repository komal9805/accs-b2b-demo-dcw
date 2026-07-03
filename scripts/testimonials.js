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
    createdAt: item.created_at,
  }));
}

/**
 * Submits a testimonial for review.
 * @param {object} input Submission payload
 * @returns {Promise<{ id: string, status: string }>}
 */
export async function submitTestimonial(input) {
  ensureEndpoint();

  const { data, errors } = await TESTIMONIALS_FETCH_GRAPHQL.fetchGraphQl(
    SUBMIT_TESTIMONIAL_MUTATION,
    {
      method: 'POST',
      variables: {
        input: {
          name: input.name,
          company: input.company || undefined,
          email: input.email,
          rating: input.rating,
          testimonial_text: input.testimonialText,
        },
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
