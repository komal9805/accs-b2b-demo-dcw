# Commerce Account Testimonials Block

## Overview

Authenticated customers can view their submitted testimonials and edit entries that are still pending review. Approved and rejected testimonials are read-only.

## Integration

### Block Configuration

| Configuration Key | Type | Default | Description |
|-------------------|------|---------|-------------|
| `homepage-link` | string | `/` | Link target for rejected-state CTA to submit a new testimonial |

### Site Configuration

| Configuration Key | Location | Description | Required |
|-------------------|----------|-------------|----------|
| `testimonials-mesh-endpoint` | `config.json` | GraphQL endpoint for the Testimonials API Mesh | Yes |

Mesh operations used:

- Query: `customer_list_by_email`
- Mutation: `customer_update_pending(input: { id, name, company, rating, testimonial_text, image_base64?, image_mimetype?, image_filename?, remove_image? })`

Customer operations require a Commerce `Authorization: Bearer` token. The mesh forwards this header to the testimonials app, which resolves the customer email from Commerce GraphQL.

### URL

- Page path: `/customer/testimonials`
- Sidebar item: **My Testimonials** (injected by `commerce-account-sidebar` when missing from the fragment)

## Behavior

- **Login required**: Guests are redirected to `/customer/login`
- **Pending**: Edit button opens an inline form; save calls `customer_update_pending`
- **Rejected**: Read-only card with homepage link
- **Approved**: Read-only card
- **States**: loading, empty, error (with retry), success toast after update

## Authoring

Create a customer account page at `/customer/testimonials` with:

- `commerce-account-header`
- `commerce-account-sidebar`
- `commerce-account-testimonials`

Optional block config:

```
| commerce-account-testimonials |
|-------------------------------|
| homepage-link | /#testimonials |
```
