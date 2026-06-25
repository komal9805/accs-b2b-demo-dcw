import { FetchGraphQL } from '@dropins/tools/fetch-graphql.js';
import { getConfigValue } from '@dropins/tools/lib/aem/configs.js';

const NOTICE_BOARD_FETCH_GRAPHQL = new FetchGraphQL();

const GET_NOTICES_QUERY = `
  query GetNotices {
    getNotices {
      id
      title
      message
      createdAt
    }
  }
`;

let endpointInitialized = false;

function ensureEndpoint() {
  if (endpointInitialized) return;

  const endpoint = getConfigValue('notice-board-mesh-endpoint');
  if (!endpoint) {
    throw new Error('Notice Board mesh endpoint is not configured.');
  }

  NOTICE_BOARD_FETCH_GRAPHQL.setEndpoint(endpoint);
  endpointInitialized = true;
}

/**
 * Fetches notices from the Notice Board API Mesh.
 * @returns {Promise<Array<{id: string, title: string, message: string, createdAt?: string}>>}
 */
export async function fetchNotices() {
  ensureEndpoint();

  const { data, errors } = await NOTICE_BOARD_FETCH_GRAPHQL.fetchGraphQl(GET_NOTICES_QUERY);

  if (errors?.length) {
    throw new Error(errors.map((error) => error.message).join(' '));
  }

  return data?.getNotices ?? [];
}
