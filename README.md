https://github.com/user-attachments/assets/7564c3be-77e2-4283-a5ad-88ff973a269b

## Jev workflow builder

A private, single-owner Jev/LLM workflow builder using Next.js, React Flow,
Liveblocks, password authentication, and shared Redis admission.

### Set up

1. Use Node.js **22 or newer** and run `npm ci`.
2. Copy `.env.example` to `.env.local`. Never commit real credentials.
3. Set `OWNER_PASSWORD` to a unique, randomly generated password (16–256
   characters). No GitHub account or OAuth App is required.
4. Set `NEXTAUTH_URL` to the exact origin, such as `http://localhost:3000` locally.
   HTTPS is required outside localhost. Generate a separate random
   `NEXTAUTH_SECRET` of at least 32 characters, for example:
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
5. Set `LIVEBLOCKS_SECRET_KEY` from the
   [Liveblocks dashboard](https://liveblocks.io/dashboard/apikeys).
6. Create an [Upstash Redis](https://upstash.com/) database and set its
   `UPSTASH_REDIS_REST_URL` (HTTPS) and `UPSTASH_REDIS_REST_TOKEN`.
   Redis is required for sign-in and every run, including mock AI runs. There is
   no unrestricted in-memory fallback when Redis is unavailable.
7. Optionally set `OPENROUTER_API_KEY` for both Jev and LLM nodes. Create it at
   [OpenRouter API keys](https://openrouter.ai/settings/keys) and ensure the
   account/key can pay for the selected model. No separate TypeSafe or Vercel
   AI Gateway key is required.
   Each Jev node has a **Model** menu: **Jev 1.13** is the default pinned version;
   **Jev Latest** automatically follows new releases. Jev uses OpenRouter's
   native `/api/alpha/decisions` endpoint for choice, score, and noul questions,
   not chat completions. Jev consumes credits even when the downstream LLM is free.
   Without the OpenRouter key, both node types use explicitly labeled mocks.
   A configured provider's failure is reported as an error, never a mock success.
8. Run `npm run dev`, sign in with your owner password, and create a workflow.

The owner accesses **one private workspace** from any signed-in device.
`WORKFLOW_WORKSPACE_ID` selects that workspace
on the server (default `private`), never from a URL parameter. Keep its value
stable, and use distinct values or separate Liveblocks projects for unrelated
deployments. Cookie-authenticated mutations must originate from `NEXTAUTH_URL`.

Missing authentication configuration locks private functionality rather than
enabling anonymous access. Sign-out is available in the workspace header.
Sessions last eight hours. Changing `OWNER_PASSWORD` and restarting/redeploying
invalidates existing application sessions; old GitHub sessions are not accepted.
Already-issued Liveblocks tokens/connections remain subject to Liveblocks' own
expiration/revocation. Keep the owner password separate from `NEXTAUTH_SECRET`
and `WORKFLOW_API_TOKEN`.

Sign-in accepts at most **10 attempts per minute per deployment origin**, shared
across all instances and including successful attempts. This deliberately does
not trust client-supplied IP headers. Someone repeatedly attempting sign-in can
temporarily block the owner's login; existing sessions remain usable.

The LLM menu contains 21 text models verified against the OpenRouter catalog,
including a **Free** group with Qwen3.8 27B, Nemotron 3.5 Lightning, and
LFM2.5 2.6B. New LLM nodes default to `liquid/lfm-2.5-2.6b:free`.
Existing nodes keep their saved model: select a model from **Free** explicitly
if an existing workflow uses a paid model. Free models still require an
OpenRouter API key and have provider rate limits and availability constraints;
failures are reported without automatically switching to a paid model.

Model IDs are stored in workflows. If an existing workflow selected
`moonshotai/kimi-k3-fast`, choose another model in the editor: that ID is not
available on OpenRouter. It is not silently remapped.

### Condition and Transform nodes

Both nodes run locally without an AI provider call or model tokens. Add them
from the canvas toolbar; they support the existing `any` / `all` activation modes.

**Condition** compares a source value with a configured value and fires exactly
one `true` or `false` handle, passing its input through unchanged. Operators are
equals, does not equal, contains, `>`, `>=`, `<`, and `<=`. Text comparisons are
case-sensitive. Numeric ordering accepts finite decimal numbers or decimal
strings, not blanks, whitespace, hexadecimal, booleans, or null. Equality uses
the source's scalar type; use `true`, `false`, or `null` for those JSON values.
Missing data, invalid JSON, or invalid operands fail the run rather than silently
taking the false branch.

**Transform** maps 1–8 source values to uniquely named JSON fields. Selected JSON
numbers, booleans, nulls, objects, and arrays keep their types; text sources stay
strings. It does not infer fields from LLM prose. Output is JSON **text**, so the
run API's existing named arrays of output strings are unchanged.

Source paths are not templates or JavaScript:

| Source | Value |
| --- | --- |
| `input` | Joined incoming text |
| `json` / `json.refund_amount` | Whole JSON input / an own field |
| `json.items.0.id` | A field in the first array item |
| `answers.risk.value` | An inherited Jev answer value |
| `answers.risk.confidence` / `.probability` | Confidence / probability |
| `parents.customer-draft` | Raw text from that immediate parent |

Connected parent labels and paths appear in each node's editor. A parent whose
connection did not fire is unavailable; use `all` when every mapped parent is
required. Paths and output field names reject reserved prototype keys.

For example, compare `json.refund_amount > 1000`, route `true` to a review
Transform and `false` to a customer-draft Transform. The review branch can retain
`internal_note`, while the customer branch selects only `customer_draft` and
`order_id`. This is deterministic routing, not authorization to transfer money.
Existing graph, input, trace, and output-size limits also apply to these nodes.

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
the suite against production Redis. No real AI or Liveblocks credentials are
needed for the regression suites; live cloud/provider verification requires
deployment credentials.

### Deferred feature: Provider selection

- Add a Provider selector alongside Model; implementation is deferred.
- Before implementation, clarify whether Provider means the model company
  (filter models while retaining OpenRouter), the API connection (OpenRouter
  versus a direct provider with separate credentials/billing), or the model's
  hosting provider within OpenRouter.
- No selection behavior has been decided. Keep the current OpenRouter integration
  unchanged until this scope is confirmed.
