# Notice Board Block

## Overview

The Notice Board block renders a table of store notices fetched from the Notice Board API Mesh (`getNotices` GraphQL query). It is intended for custom pages such as `/notices` and displays notice title, message, and created date. Notice content is managed in the Notice Board App Builder extension; this block is read-only on the storefront.

## Integration

### Block Configuration

| Configuration Key | Type | Default | Description | Required | Side Effects |
|-------------------|------|---------|-------------|----------|--------------|
| `empty-message` | string | `No notices available right now.` | Message shown when the API returns no notices | No | Replaces default empty state text |
| `error-message` | string | `Unable to load notices. Please try again later.` | Message shown when the notices API request fails | No | Replaces default error state text |

### Site Configuration

| Configuration Key | Location | Description | Required |
|-------------------|----------|-------------|----------|
| `notice-board-mesh-endpoint` | `config.json` or Configuration Service | GraphQL endpoint for the Notice Board API Mesh | Yes |

The mesh must include the storefront origin in `responseConfig.CORS.origin` so browser requests are allowed.

### URL Parameters

No URL parameters directly affect this block's behavior.

### Local Storage

No localStorage keys are used by this block.

### Events

#### Event Listeners

No direct event listeners are implemented in this block.

#### Event Emitters

No events are emitted by this block.

## Behavior Patterns

### Page Context Detection

- **Loading State**: Displays a skeleton table while fetching notices
- **Data Available**: Renders notices in a three-column table (Title, Message, Date)
- **Empty Response**: Shows the configured `empty-message` when no notices exist
- **API Failure**: Shows the configured `error-message` when the mesh request fails

### User Interaction Flows

1. **Block Decoration**: Block clears authored table rows and builds the notice table in the DOM
2. **Data Fetch**: `scripts/notices.js` calls the mesh `getNotices` query via `notice-board-mesh-endpoint`
3. **Render**: Notices are displayed in table rows with consistent typography across columns
4. **Long Messages**: Message text wraps in the table cell; full text is available via the native `title` tooltip on hover

### Error Handling

- **Missing Endpoint**: If `notice-board-mesh-endpoint` is not configured, the fetch throws and the error message is shown
- **GraphQL Errors**: GraphQL error responses are surfaced as fetch failures and trigger the error state
- **CORS Errors**: If the mesh does not allow the storefront origin, the browser blocks the response and the error state is shown; fix CORS on the mesh or use an allowed origin
- **Empty Data**: An empty notice array shows the empty state, not the error state
- **Fallback Behavior**: Default empty and error messages are used when block config keys are omitted

## Authoring

Add the block on a da.live page (for example `notices`):

```
| Notice Board |
|--------------|
```

Optional configuration rows:

```
| Notice Board |
|--------------|
| empty-message | No notices published yet. |
| error-message | Could not load notices. |
```

Notice rows do not need to be authored in the document; data is loaded from the API.
