# Testimonials Block

## Overview

The Testimonials block renders a responsive homepage slider of approved customer testimonials fetched from the Testimonials API Mesh. The first slide always includes a **Submit Testimonial** CTA with an optional wallpaper background. Visitors can submit testimonials through an accessible modal form; submissions are sent for review and are not shown publicly until approved.

## Integration

### Block Configuration

| Configuration Key | Type | Default | Description | Required | Side Effects |
|-------------------|------|---------|-------------|----------|--------------|
| `heading` | string | — | Section heading above the slider | No | Renders an `h2` when provided |
| `wallpaper` | image URL | — | Background image for the CTA (first) slide | No | Applied as a cover background with overlay |
| `cta-label` | string | `Submit Testimonial` | Label for the CTA button on the first slide | No | Updates CTA button text |
| `success-message` | string | `Thank you! Your testimonial has been submitted and is pending review.` | Message shown after successful form submission | No | Replaces modal form content on success |
| `max-items` | number | `10` | Maximum number of latest approved testimonials to show | No | Client-side limit after sorting by `created_at` desc |
| `autoplay` | boolean | `true` | Whether the slider auto-advances | No | Disables autoplay when set to `false` |

### Site Configuration

| Configuration Key | Location | Description | Required |
|-------------------|----------|-------------|----------|
| `testimonials-mesh-endpoint` | `config.json` or Configuration Service | GraphQL endpoint for the Testimonials API Mesh | Yes |

The mesh must expose:

- Query: `approved_testimonials { items { id name company rating testimonial_text created_at } total }`
- Mutation: `submit_testimonial(input: { name, company, email, rating, testimonial_text })`

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

- **Loading State**: Shows a loading message while fetching approved testimonials
- **Data Available**: Renders a slider with the CTA slide first, followed by approved testimonial slides
- **Empty Response**: Shows only the CTA slide with the default empty-state copy
- **API Failure**: Logs the error to the console and removes the block section from the page
- **Submission Success**: Replaces the modal form with the configured `success-message`

### User Interaction Flows

1. **Block Decoration**: Block reads configuration, fetches approved testimonials, and builds the slider
2. **CTA Slide**: First slide always includes the submit CTA; optional wallpaper is applied when configured
3. **Submit Testimonial**: Opens an accessible modal with name, company, email, rating, and testimonial fields
4. **Submission**: Calls `submit_testimonial` via `scripts/testimonials.js`; email is sent to the API but never displayed in the public slider
5. **Slider Navigation**: Indicators and autoplay (when enabled) navigate between slides

### Error Handling

- **Missing Endpoint**: Falls back to the sandbox mesh endpoint; if the request still fails, the block is removed
- **GraphQL Errors**: GraphQL error responses are logged and the block is removed
- **CORS Errors**: Browser-blocked responses are logged and the block is removed; fix CORS on the mesh
- **Submission Errors**: Form-level error message is shown in the modal; the form remains open for correction
- **Fallback Behavior**: Default messages are used when optional block config keys are omitted

## Authoring

Add the block on a homepage or landing page:

```
| Testimonials |
|--------------|
| heading | What our customers say |
| wallpaper | /path/to/image.jpg |
| cta-label | Share your story |
| success-message | Thanks! We'll review your testimonial soon. |
| max-items | 10 |
| autoplay | true |
```

Testimonial content is loaded from the API; individual testimonial rows do not need to be authored in the document.
