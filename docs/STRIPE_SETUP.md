# Stripe Configuration Guide

This guide walks you through setting up Stripe for MCP Everything subscriptions and payments.

## Prerequisites

- A Stripe account ([sign up here](https://dashboard.stripe.com/register))
- Access to the Stripe Dashboard

## Step 1: Get API Keys

1. Go to [Stripe Dashboard > API Keys](https://dashboard.stripe.com/apikeys)
2. Copy your **Publishable key** (`pk_test_...` or `pk_live_...`)
3. Copy your **Secret key** (`sk_test_...` or `sk_live_...`)

> **Note**: Use test keys during development. Switch to live keys for production.

## Step 2: Create Products and Prices

Navigate to [Stripe Dashboard > Products](https://dashboard.stripe.com/products) and create the following:

### Free Tier

- **Name**: MCP Everything Free
- **Description**: Basic MCP server generation with community support
- **Price**: $0/month (recurring)
- **Features to list**:
  - Basic generation
  - Community support
  - 5 servers/month

### Pro Tier

- **Name**: MCP Everything Pro
- **Description**: Unlimited MCP server generation with priority support
- **Prices** (create both):
  - **Monthly**: $29/month (recurring)
  - **Yearly**: $290/year (recurring) - 2 months free!
- **Features to list**:
  - Unlimited generation
  - Priority support
  - Private repositories
  - CI/CD integration

### Enterprise Tier

- **Name**: MCP Everything Enterprise
- **Description**: Full-featured plan for teams with SSO and SLA
- **Price**: $99/month (recurring)
- **Features to list**:
  - Everything in Pro
  - Custom domains
  - Team features
  - SSO integration
  - SLA guarantee

## Step 3: Copy Price IDs

After creating each price, copy the Price ID (starts with `price_`):

1. Click on the product
2. Find the price in the Pricing section
3. Click the **...** menu and select "Copy price ID"

You'll need:
- `STRIPE_PRICE_FREE` - Free tier price ID
- `STRIPE_PRICE_PRO` - Pro monthly price ID
- `STRIPE_PRICE_PRO_YEARLY` - Pro yearly price ID
- `STRIPE_PRICE_ENTERPRISE` - Enterprise monthly price ID

## Step 4: Set Up Webhook

1. Go to [Stripe Dashboard > Webhooks](https://dashboard.stripe.com/webhooks)
2. Click **Add endpoint**
3. Enter your webhook URL:
   - **Development**: Use [Stripe CLI](https://stripe.com/docs/stripe-cli) for local testing
   - **Production**: `https://your-domain.com/api/webhooks/stripe`
4. Select events to listen to:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `checkout.session.completed`
5. Copy the **Signing secret** (`whsec_...`)

### Local Development with Stripe CLI

For local development, use Stripe CLI to forward webhooks:

```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Login to Stripe
stripe login

# Forward webhooks to local server
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# The CLI will display your webhook signing secret (whsec_...)
```

## Step 5: Configure Environment Variables

Add the following to your `.env` file:

```bash
# Stripe API Keys
STRIPE_SECRET_KEY=sk_test_xxxxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxx

# Stripe Price IDs
STRIPE_PRICE_FREE=price_xxxxx
STRIPE_PRICE_PRO=price_xxxxx
STRIPE_PRICE_PRO_YEARLY=price_xxxxx
STRIPE_PRICE_ENTERPRISE=price_xxxxx
```

## Step 6: Configure Customer Portal

1. Go to [Stripe Dashboard > Settings > Billing > Customer portal](https://dashboard.stripe.com/settings/billing/portal)
2. Enable the customer portal
3. Configure allowed actions:
   - Allow customers to update subscriptions
   - Allow customers to cancel subscriptions
   - Show invoice history
4. Set the return URL to your account page (e.g., `https://your-domain.com/account`)

## Verification

To verify your setup is working:

1. Start the backend server: `npm run dev:backend`
2. Check the logs for: `Stripe client initialized`
3. If you see `STRIPE_SECRET_KEY not configured`, double-check your environment variables

## Testing Subscriptions

Use [Stripe test cards](https://stripe.com/docs/testing#cards) to test the checkout flow:

- **Successful payment**: `4242 4242 4242 4242`
- **Declined payment**: `4000 0000 0000 0002`
- **Requires authentication**: `4000 0025 0000 3155`

## Production Checklist

Before going live:

- [ ] Switch to live API keys (`sk_live_...`, `pk_live_...`)
- [ ] Update webhook endpoint to production URL
- [ ] Create live products/prices (or copy from test mode)
- [ ] Update price IDs in environment variables
- [ ] Test the complete checkout flow in live mode with a real card
- [ ] Configure tax collection if required for your jurisdiction

## Troubleshooting

### Webhook signature verification failed

- Ensure `STRIPE_WEBHOOK_SECRET` matches your endpoint's signing secret
- Verify raw body parsing is enabled in your NestJS app

### Stripe not configured error

- Check that `STRIPE_SECRET_KEY` is set correctly
- Verify the key format (`sk_test_...` or `sk_live_...`)

### Price ID not found

- Ensure prices are created in the same Stripe account (test vs live mode)
- Verify the price IDs in your environment variables match Stripe Dashboard
