https://github.com/user-attachments/assets/7564c3be-77e2-4283-a5ad-88ff973a269b

## Jev workflow builder

A private, collaborative Jev/LLM workflow builder using Next.js, React Flow,
Liveblocks, GitHub authentication, and shared Redis run admission.

### Set up

1. Use Node.js **22 or newer** and run `npm ci`.
2. Copy `.env.example` to `.env.local`. Never commit real credentials.
3. Create a GitHub OAuth App. Set its homepage to your deployment origin and its
   callback to `<NEXTAUTH_URL>/api/auth/callback/github`.
4. Set `GITHUB_ID`, `GITHUB_SECRET`, and `GITHUB_ALLOWED_USERS` (comma-separated
   GitHub logins). Only these accounts may sign in.
5. Set `NEXTAUTH_URL` to the exact origin, such as `http://localhost:3000` locally.
   HTTPS is required outside localhost. Generate a separate random
   `NEXTAUTH_SECRET` of at least 32 characters, for example:
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
6. Set `LIVEBLOCKS_SECRET_KEY` from the
   [Liveblocks dashboard](https://liveblocks.io/dashboard/apikeys).
7. Create an [Upstash Redis](https://upstash.com/) database and set its
   `UPSTASH_REDIS_REST_URL` (HTTPS) and `UPSTASH_REDIS_REST_TOKEN`.
   Redis is required for every run, including mock AI runs. There is no
   unrestricted in-memory fallback when Redis is unavailable.
8. Optionally set `TYPESAFE_API_KEY` and `AI_GATEWAY_API_KEY` to use real
   providers. Without these keys, nodes use explicitly labeled mock responses.
9. Run `npm run dev`, sign in, and create a workflow.

All allowlisted accounts collaborate in **one shared private workspace**; this
is not per-user private storage. `WORKFLOW_WORKSPACE_ID` selects that workspace
on the server (default `private`), never from a URL parameter. Keep its value
stable, and use distinct values or separate Liveblocks projects for unrelated
deployments. Cookie-authenticated mutations must originate from `NEXTAUTH_URL`.

Missing authentication configuration locks private functionality rather than
enabling anonymous access. Sign-out is available in the workspace header.
Allowlist changes are checked on application requests; already-issued Liveblocks
tokens/connections remain subject to Liveblocks' own expiration/revocation.

### Server-to-server runs

Generate an independent random `WORKFLOW_API_TOKEN` (32–256 non-whitespace
characters) on the workflow server and configure the same secret in the calling
service. This optional credential authorizes **runs only**, across this
deployment's private workspace. It cannot obtain collaboration tokens or edit
workflows. Never include it in browser code or `NEXT_PUBLIC_*` variables.

```sh
curl -X POST "https://your-app.example/api/workflows/WORKFLOW_ID/runs?wait=true" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WORKFLOW_API_TOKEN" \
  -d '{"input":"Please review this support ticket."}'
```

`?wait=true` returns a trace and named output arrays. Without it, the API returns
`202` with a run ID and continues work through Next.js `after()`. The distributed
run reservation stays held until execution settles. Requests without valid
credentials receive `401`; same-origin violations receive `403`; quota failures
receive `429` with `Retry-After`; Redis unavailability receives `503`.

### Resource and spending controls

Policy constants live in `app/workflow/server/run-admission.ts`,
`execution-policy.ts`, and `execution-validation.ts`.

| Scope | Limit |
| --- | --- |
| Simultaneous runs | 4/workspace, 2/principal, 1/workflow |
| Starts per minute | 30/workspace, 6/principal |
| Starts per UTC day | 200/workspace, 50/principal |
| Reserved LLM output tokens per UTC day | 5,120,000/workspace, 1,024,000/principal |
| Output-token reservation per accepted run | 51,200 (25 executions × 2,048 tokens) |
| Request body / input | 96 KiB JSON / 20,000 UTF-16 code units |
| Graph / fan-in | 26 nodes, 64 edges, 8 incoming edges/node |
| Executions / simultaneous provider calls | 25 non-input nodes / 4 per run |
| Jev questions / criteria | 1–8 questions, 2–16 criteria where applicable |
| LLM output | 2,048 tokens and 16,384 UTF-16 code units/node |
| Intermediate text | 32,000/node, 256,000/run |
| Resolved prompts | 40,000/node, 120,000/run |
| Retained trace | 160,000/node, 512,000/run serialized code units |
| Cumulative feed message payloads | 2,000,000 serialized code units/run |
| Deadline | 60 seconds plus at most 2 seconds of feed finalization |

Redis uses atomic admission across instances and expiring leases. Rate/day
reservations are **not refunded**, even for rejected graphs or failed runs. The
conservative token reservation makes the default effective daily ceiling at
most 100 runs/workspace and 20/principal, even if each run uses fewer tokens.
All automation calls share one principal.

These are request/token ceilings, **not a currency-denominated budget**. Provider
model prices, input-token charges, and Jev billing differ; also configure spending
limits in provider dashboards. Only models in the server's supported model list
are accepted. Over-budget data is rejected before concatenation/template
expansion/provider dispatch rather than silently truncated.

Malformed, cyclic, disconnected-invalid, or oversized graphs fail validation.
A workflow must have its Input and Output nodes and valid connections. A failure
or deadline stops further work and produces an error trace; provider and storage
requests receive cancellation signals. Feed persistence is bounded and
best-effort: a feed-service outage does not guarantee a saved history entry.

### Existing public demo data

New rooms use `jev:workflows:<workspace>:<workflowId>`, private default access,
and checked application/workspace metadata. They do not match the old
`liveblocks:examples:*` wildcard. Legacy public rooms are **not automatically
adopted, migrated, or deleted** and will not appear in the private workspace.
Create private workflows again after deployment. Back up and retire old public
rooms separately; for a previously public installation, a separate Liveblocks
project provides the clearest separation from existing access grants.

The optional local Liveblocks dev server does not implement every production
API, and some versions ignore room metadata or stub feeds. Such rooms are
intentionally rejected by the authorization checks; do not disable those checks
to make a local stub appear production-equivalent.

### Verification

```sh
npm run typecheck
npm test
npm run build
npm audit --package-lock-only
```

Security regressions use Node's test runner and unchanged application modules
with isolated external services. They cover authorization, workspace isolation,
request bounds, graph amplification, provider cancellation, and deadlines.

The separate Redis integration suite executes the actual Lua admission scripts
against an ephemeral local Redis container:

```sh
docker run --rm --name jev-security-redis redis:7-alpine redis-server --save "" --appendonly no
# In another terminal:
npm run test:redis
# After testing:
docker stop jev-security-redis
```

`TEST_REDIS_CONTAINER` may select another disposable test container. Do not run
the suite against production Redis. No real AI or GitHub OAuth credentials are
needed for the regression suites; live OAuth and provider verification require
deployment credentials.
