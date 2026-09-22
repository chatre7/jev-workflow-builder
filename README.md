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
8. Optionally configure the HTTP connections and document catalog described below.
9. Run `npm run dev`, sign in with your owner password, and create a workflow.

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

### CSV → JSON

Add **CSV** from the canvas toolbar and connect `Input → CSV → Output`, or feed
it UTF-8 CSV text from an HTTP Request. It runs locally without an AI call.
The node consumes text; the **Run** panel can read a selected CSV file into Input.
It does not read arbitrary server disk paths, import a Knowledge catalog, or run
downstream nodes once per row.

Choose **Comma**, **Semicolon**, or **Tab** explicitly; delimiters are not guessed.
With **First row headers**, `order_id,amount` followed by `00123,1500` becomes
`[{"order_id":"00123","amount":"1500"}]`. With **No headers**, every row is retained
as a string array. All cells stay strings: leading zeros, whitespace, dates,
booleans, and formula-like text are neither coerced nor evaluated. Output is
JSON **text**, preserving the existing run API's named arrays of output strings.
For example, a downstream Transform can select `json.0.order_id` or all of `json`.

To ask questions about the whole table, connect `Input → CSV → LLM → Output`.
Keep `{{input}}` in the LLM node's **Prompt** where the JSON table should appear.
Use a general instruction such as `Use this table to answer the question supplied
for this run: {{input}}`, then type the question in **Question for this run**.
Avoid leaving unrelated fixed questions in the configured prompt. No For Each
node is needed.
Use **System** to request the answer language, preserve identifier strings,
and instruct the model to treat table cells as data rather than instructions
and acknowledge missing information. Real answers require the configured
OpenRouter key; model availability, application quotas, and size limits still
apply. For sums and counts, put a **Table** node before the LLM so code computes
the values and the model only explains them. Keep the Table output separately
when authoritative numbers matter; LLM prose is not an accounting calculation.

The **CSV file** picker appears when a CSV node receives its input directly from
Input, with no other incoming source. Files must be valid UTF-8 and fit the
existing 20,000 UTF-16-unit run-input limit. File size is checked before reading,
then decoded length is checked; invalid files never silently reuse the previous
input. Manual CSV entry remains available, along with removal and sample reset.

Preview uses that node's saved delimiter and header settings. If several eligible
CSV nodes exist, select which one to preview. The entire CSV is validated with
the execution parser before showing the first **5 data rows / 8 columns**; the
run always receives all input, not the visible subset. Change delimiter/header
mode in the CSV node and retry preview if its settings are still saving.
Upload/preview errors and pending validation disable Run.

The browser reads the selected file and sends its text to the owner-only,
same-origin `POST /api/workflows/WORKFLOW_ID/csv-preview` endpoint. It does not
store a file blob. Preview makes no AI call and reserves no execution quota.
Once Run is selected, input text is retained in the existing run trace.

**Question for this run** is optional, up to 4,000 UTF-16 units. It is appended
literally to every executed LLM node's resolved user prompt, separately from CSV
data; template-like text inside the question is not expanded. System instructions
remain unchanged. Leave it empty to use only configured prompts. The question
appears in run history and input trace and survives approval pauses/restarts.
Each new question starts a new run; this is not a stateful chat conversation.

The parser accepts a leading BOM, CRLF/LF/CR records, quoted delimiters and
newlines, and doubled quotes. Truly empty lines are skipped; whitespace-only
lines are data. Empty input returns `[]`; header-only input also returns `[]`
while retaining its column count in the trace. Headers are preserved exactly,
including Unicode; blank, duplicate, `__proto__`, `constructor`, and `prototype`
headers are rejected. Every record must have the same number of columns.

Limits are **500 data rows**, **64 columns**, **8,000 UTF-16 units per cell**,
and **128 per header**. Node input and JSON output each allow **32,000 UTF-16
units**; the initial run input still has its existing **20,000-unit** limit.
Repeated headers and JSON escaping count toward output size. Malformed quoting,
inconsistent widths, NUL characters, ill-formed Unicode, and over-limit data
fail rather than being repaired or truncated. The canvas and execution trace
show the JSON output, data-row count, column count, and header mode.

### Table: Filter, Group by, Sum and Count

Connect `Input → CSV → Table → LLM → Output`, with CSV **First row headers**
enabled. Table consumes one JSON array of flat objects, not headerless arrays or
LLM prose. It runs without an AI provider call; starting the workflow still uses
the unchanged run/admission quota.

Add **Table** from the toolbar:

1. Add up to **8 filters**. Every filter must match (AND); no filters keeps all
   rows. Equals, does not equal and contains compare `String(cell)` literally,
   case-sensitively and without trimming. Numeric ordering uses exact decimals.
2. Optionally set **Group by** to one column, such as `customer`. Leave it empty
   for one aggregate across all matching rows. Groups retain the original value
   and type in first-seen order: string `"1"` and number `1` are different groups.
3. Configure up to **8 aggregates**. **Count rows** counts matching rows.
   **Sum** requires a numeric column. Give each metric a unique output name,
   such as `orders` or `total`, different from the grouping column.
4. Remove every aggregate for **filter-only output**. Grouping clears, and
   matching rows retain their original fields, cell types and order.

Column names are literal, including Thai, spaces and dots—not paths, templates,
SQL or JavaScript. Every configured column must exist in every input row, even
one that a filter would exclude. Names must be nonblank; reserved prototype keys
(`__proto__`, `constructor`, `prototype`) are rejected.

For example, filter `status Equals paid`, group by `customer`, Sum `amount` as
`total`, and Count rows as `orders`. Two matching amounts `"0.10"` and `"0.20"`
produce:

```json
[{"customer":"สมชาย","total":"0.3","orders":2}]
```

Sums use bounded integer coefficient/scale arithmetic and return **canonical
decimal strings**, without binary floating-point addition or implicit currency
rounding. Counts are JSON numbers. Decimal strings accept signs and exponent
notation, with at most **100 coefficient digits** and exponent magnitude **100**.
Blanks, surrounding whitespace, null, booleans, currency symbols, thousands
separators, hexadecimal and non-finite values are not numeric operands. Invalid
numeric comparisons or matched-row sums fail; excluded rows' sum cells are not
evaluated. JSON numeric cells must be finite and within `Number.MAX_SAFE_INTEGER`
in magnitude; use strings (as CSV already does) to preserve exact source precision.

With no matches, an ungrouped aggregate returns one row of zero metrics; grouped
and filter-only operations return `[]`. All input rows are checked for shape,
cell bounds and configured-column presence before filtering. Limits are **500
rows**, **64 columns per row**, **128 UTF-16 units per column/output name** and
**8,000 per string cell**. Nested objects/arrays are rejected. Input and output
each allow **32,000 UTF-16 units**, with existing cumulative text/trace budgets.
Over-limit input/output fails rather than truncating. Canvas and trace show input,
matched and output row counts.

Send Table's JSON to a separate named Output property as well as to the LLM when
you need both exact results and a narrative. Tell the model to preserve the
provided values, not recalculate them. Per-run questions do not change the saved
filters, grouping or aggregates; removed source columns are not available to the
downstream model.

### HTTP Request

Configure named connections in the server-only `WORKFLOW_HTTP_CONNECTIONS` JSON
environment variable. A node stores only the alias, method, relative path template,
and optional POST body template—not connection credentials.

```dotenv
WORKFLOW_HTTP_CONNECTIONS='{"support":{"baseUrl":"https://api.example.com/v1/","methods":["GET","POST"],"headers":{"Authorization":"Bearer YOUR_SERVER_SECRET"}}}'
```

Use aliases beginning with an ASCII letter, followed by letters, digits, `_`, or
`-` (maximum 64 characters). `methods` defaults to `["GET"]`; `headers` is optional.
Base paths gain a trailing slash. Requests must remain inside that HTTPS origin
and base path. Redirects, traversal, encoded path separators, private/reserved
addresses, and routing/proxy header overrides are rejected. DNS results are
validated and pinned to the TLS connection, with hostname verification retained.

Path and body templates support `{{input}}` and inherited `{{answers.<id>}}`
values. Substitution inserts **raw text**, not URL encoding or JSON escaping.
URL-encode query values before supplying them. To build a JSON body safely, use
Transform to select typed fields, then set the POST body to `{{input}}`.
Nonblank POST bodies must be valid JSON; GET has no body. The response is UTF-8
text, with its HTTP status in the trace. Non-2xx responses fail without recording
their body. Each request has a 15-second total deadline, no redirects or retries,
a 4,096-byte URL limit, and 128 KiB / 32,000-character body and response limits.

Trust the administrators of configured destinations: they receive the configured
headers. Common credential reflections are rejected, but arbitrary upstream
transformations cannot be recognized as secrets. Never put credentials in node
paths, bodies, or input. A POST timeout does **not** prove that the remote action
was not applied; check the upstream system before starting another run.

### Human Approval

An Approval node renders its review prompt, preserves its input, and pauses with
status `waiting`. Review the prompt and input in **Runs**, then select **Approve**
or **Reject**. Exactly one corresponding handle fires, passing the original input
unchanged. Waiting runs cannot be deleted from the history; decide first, or
select an expired run to delete it.

The checkpoint stores the graph snapshot, completed outputs, pending approvals,
trace, execution count, and cumulative budgets in Redis for up to **24 hours per
approval**. Pausing releases the active run lease and hosting timer. A resume
keeps the original run ID and uses the frozen graph even if the editor changed.
Completed HTTP, AI, and search nodes are not executed again. Unresolved approval
ancestry blocks downstream joins, including `any` joins; sequential and parallel
approvals are supported. Expiry never approves a request.

`POST /api/workflows/WORKFLOW_ID/runs/RUN_ID/approval` accepts only
`{"nodeId":"APPROVAL_NODE_ID","decision":"approved"}` or `"rejected"`.
It requires the owner cookie session and same-origin request. An `Authorization`
header is refused—even with a valid owner cookie. The response is `202` with the
same run ID; `?wait=true` returns the next phase's trace. Duplicate/busy decisions
return `409`; expired/unavailable checkpoints return `410`. The server records
the deciding owner and time.

Claims atomically consume the resumable snapshot before execution. If a claimed
resume is interrupted, it stays consumed and is **not automatically replayed**.
Verify external side effects before starting a new run. A checkpoint-save failure
fails closed; a phase token is published to the private feed only after Redis
acknowledges the save. If feed publication fails, the durable checkpoint may be
unavailable for approval rather than risking an unconfirmed resume. This is not
an exactly-once transaction with external APIs.

### Knowledge Search

Set `WORKFLOW_KNOWLEDGE_FILE` to a server-chosen JSON file, for example
`examples/knowledge.json`. Ship or mount that file with the deployment; workflows
cannot choose arbitrary paths. The included English/Thai policies are explicitly
**DEMO data**, not business policies for a production installation.

```json
[
  {
    "id": "refund-policy",
    "title": "Refund approval policy",
    "text": "Your actual approved policy text.",
    "url": "https://support.example.com/refunds"
  }
]
```

This is deterministic **lexical BM25 search**, using Thai/English word
segmentation—not AI, embeddings, or semantic search. Set a query template and
`topK` from 1–5. Output is JSON text with `query`, `match_count`, and `matches`;
each match contains its source `id`, `title`, optional HTTPS `url`, matched-region
`excerpt`, and score. `match_count` is the number returned, not the catalog's total
hits. The canvas and trace show actual citation IDs and excerpts. A valid query
with no matching words returns an empty list; missing or invalid configuration
fails instead of fabricating a no-hit result.

Catalogs are limited to 1 MiB and 100 documents. Each document has a unique safe
ASCII ID (96 characters), title (160), text (8,000), and optional credential-free
HTTPS URL (2,048). Unknown fields are rejected. Excerpts are at most 600
characters; resolved queries and outputs are bounded to 32,000 characters.

### Server-to-server runs

Generate an independent random `WORKFLOW_API_TOKEN` (32–256 non-whitespace
characters) on the workflow server and configure the same secret in the calling
service. This optional credential authorizes **runs only**, across this
deployment's private workspace. It cannot approve requests, obtain collaboration
tokens, or edit workflows. Never include it in browser code or `NEXT_PUBLIC_*` variables.

```sh
curl -X POST "https://your-app.example/api/workflows/WORKFLOW_ID/runs?wait=true" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $WORKFLOW_API_TOKEN" \
  -d '{"input":"Please review this support ticket."}'
```

The JSON body also accepts optional `"question": "What should this run answer?"`
(maximum 4,000 UTF-16 units). It requires an LLM reachable from Input. Invalid
question types, excessive length, and missing reachable LLMs are rejected before
admission reserves execution quota. Preview is browser-owner-only; run-only API
tokens cannot access the preview endpoint.

`?wait=true` returns a trace and named output arrays, stopping at `waiting` when
human review is needed. Without it, the API returns `202` with a run ID and
continues work through Next.js `after()`. The distributed run reservation stays
held until the active phase settles.
Requests without valid credentials receive `401`; same-origin violations receive `403`; quota failures
receive `429` with `Retry-After`; Redis unavailability receives `503`.

### Resource and spending controls

Policy constants live in `app/workflow/shared.ts`,
`app/workflow/server/run-admission.ts`, `execution-policy.ts`, and
`execution-validation.ts`.

| Scope | Limit |
| --- | --- |
| Simultaneous active phases | 4/workspace, 2/principal, 1/workflow |
| Starts/resumes per minute | 30/workspace, 6/principal |
| Starts/resumes per UTC day | 200/workspace, 50/principal |
| Reserved LLM output tokens per UTC day | 5,120,000/workspace, 1,024,000/principal |
| Output-token reservation per accepted phase | 51,200 (25 executions × 2,048 tokens) |
| Request body / input | 96 KiB JSON / 20,000 UTF-16 code units |
| Optional run question | 4,000 UTF-16 code units; included in prompt and trace budgets |
| Graph / fan-in | 26 nodes, 64 edges, 8 incoming edges/node |
| Executions / simultaneous provider calls | 25 non-input nodes / 4 per run |
| Jev questions / criteria | 1–8 questions, 2–16 criteria where applicable |
| LLM output | 2,048 tokens and 16,384 UTF-16 code units/node |
| Intermediate text | 32,000/node, 256,000/run |
| Resolved prompts | 40,000/node, 120,000/run |
| Retained trace | 160,000/node, 512,000/run serialized code units |
| Cumulative feed message payloads | 2,000,000 serialized code units/run |
| Approval checkpoint | 512,000 serialized code units and 384 KiB UTF-8; 768 KiB storage request |
| Deadline | 60 seconds/active phase; up to 5 seconds approval finalization and 2 seconds feed cleanup |

Redis uses atomic admission across instances and expiring leases. Rate/day
reservations are **not refunded**, even for rejected graphs or failed runs. The
conservative token reservation makes the default effective daily ceiling at
most 100 active phases/workspace and 20/principal, even for runs without AI.
Each approval resume acquires a fresh phase reservation; logical execution and
text/trace budgets remain cumulative across the whole run. All automation calls
share one principal.

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
request bounds, graph amplification, provider cancellation, deadlines, HTTP SSRF
and credential handling, lexical retrieval, approval resume/replay boundaries,
CSV quoting, Unicode, row/column bounds, JSON-size amplification, preview access
and full-data validation, literal questions across approval resumes, and exact
Table arithmetic, typed grouping, filtering and output-budget boundaries.

The separate Redis integration suite executes the actual Lua admission and
approval claim/fencing scripts against an ephemeral local Redis container:

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
