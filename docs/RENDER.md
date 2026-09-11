# Render + Neon deployment

The Blueprint defines API, persistent worker, static React site and Key Value.
Postgres stays in the existing Neon Devscout project. The API and worker use the
pooled DATABASE_URL; migrations use DIRECT_DATABASE_URL without `-pooler`.
Both processes run migrations under a direct-connection advisory lock and check
RLS before accepting work. No synthetic data is seeded automatically.

Apply render.yaml from the GitHub repository in Render Blueprints. Supply secrets
from server/.env in the dashboard: DATABASE_URL, DIRECT_DATABASE_URL and
GEMINI_API_KEY. Set WEB_ORIGIN to the actual static-site HTTPS origin and
VITE_API_ORIGIN to the actual API HTTPS origin (no trailing /api). Rebuild the
static site after changing VITE_API_ORIGIN. Do not place secrets in VITE_ variables.
Use app/api subdomains of a shared custom domain for reliable cookie sessions;
unrelated domains can encounter browser third-party-cookie restrictions.

Optional: configure GITHUB_TOKEN on API and worker to ingest live profiles.
Stripe remains disabled until its secret, webhook signing secret and Team/Scale
price IDs are configured on the API. Register /api/billing/webhook with Stripe.
The Neon Data API URL is not an API key; DevScout uses pg through its own RBAC API.

Validate with `render blueprints validate render.yaml`, then check /api/health,
registration/login, search, saved pipelines, workspace isolation and worker logs.
Run integration tests on an isolated Neon branch or local database, never on the
production database. Paid API, worker and Key Value plans incur Render charges.
