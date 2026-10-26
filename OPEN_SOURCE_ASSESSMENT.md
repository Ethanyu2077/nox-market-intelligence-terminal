# NOX open-source integration assessment

Reviewed 2026-10-23. This is a component-level source review and a bounded NOX proof of concept, not a security certification of either upstream application.

## Sources and licensing

- [OpenTerminalUI](https://github.com/Hitheshkaranth/OpenTerminalUI), commit `5ceeb3860308c05ddb9424eb25932312417355a2`: root MIT license, copyright 2026 OpenTerminalUI Contributors. Architectural patterns can be adapted; copied substantial code requires its notice. No upstream application code was vendored in this POC.
- [NewsLiquid signal skill](https://github.com/6551Team/newsliquid-signal-skill), commit `9cd6d189b87d10c3626506f0011ebf2b31632164`: no LICENSE/COPYING file found and TypeScript package has no license declaration. Public visibility is not permission to redistribute SDK source. NOX independently implements its documented push protocol; obtain licensing clarification before adopting the SDK.
- [React Mosaic](https://github.com/nomcopter/react-mosaic), installed `7.2.1`: Apache-2.0, copyright 2019 Kevin Verdieck, originally developed at Palantir Technologies. Keep dependency license notices in distributions. The older 6.1.1 used in the reference dependency manifest pulls an affected uuid release; NOX uses the patched current library instead. `npm install` audit reported zero vulnerabilities after upgrade. The v7 n-ary layout format differs from v6 binary trees; NOX validates its own persisted schema rather than importing old layouts.

## Component-level reuse decisions

| Capability | Inspected upstream implementation | NOX decision |
|---|---|---|
| Persistent, resizable panels | `frontend/src/components/layout/LaunchpadWorkspace.tsx`, `LaunchpadGrid.tsx` (react-grid-layout), Mosaic dependency, `workspace/savedViewRestore.ts` | Adapt architecture, use current Mosaic directly. Four panels, validated per-project local layout persistence, drag docking, divider resizing, reset. No full application transplant. |
| Command navigation | `components/layout/CommandPalette.tsx`, `commanding.ts` | Independently implement a workspace-scoped Cmd/Ctrl-K menu, filtering, arrows, Enter and Escape. No equity symbol commands or new router/state framework. |
| Research agent | `backend/agent/tools/registry.py`, `tools/envelope.py`, `frontend/src/agent/components/Grounding.tsx` | Retain explicit read-only tool boundary and source IDs. Deterministic observed facts are separate from statistical inferences, hypotheses and missing/stale data. Optional operator-configured LLM can only append unverified hypotheses referencing known sources. No action/portfolio/filings tools. |
| Historical replay | `frontend/src/shared/chart/replay.ts`, chart workstation linking | Good design reference for a shared event-time cursor, clamping and step controls. Not copied into this POC. Existing NOX chart synchronization and in-window signal checks are preserved; true historical replay still needs archived event-time data and look-ahead tests. |
| Backtesting | `backend/core/backtest_robustness.py`, backtest service/routes | Reuse concepts only: sign-flip/null tests, multi-window evaluation, explicit insufficient samples. Python/pandas and equity assumptions (252-period annualization) are not drop-in for 24/7 crypto. Need funding, fees, latency, OI coverage and out-of-sample tests. |
| Alerts/timeline | `backend/alerts/actions.py`, alert routes, `frontend/src/components/EventsTimeline.tsx`, alerts store | Do not copy corporate-event timeline or paper orders, watchlist writes, arbitrary webhook actions. New NOX timeline reads a persistent provider-neutral signal registry. Existing alert-rule endpoints unchanged. Configurable delivery/escalation remain follow-up work. |
| Provenance/freshness | `components/common/ProvenanceChip.tsx`, `backend/agent/tools/envelope.py` | Adapt source/quality/as-of principle using current NOX model. Show actual source timestamp, unavailable metrics and partial failures; no synthetic fallbacks. AI output never overwrites observed numeric values. |

## Implemented boundary

Existing market adapters → normalization → existing NOX analytics → `signalsFromSnapshots` → `SignalRegistry` → internal timeline.

The optional `NewsLiquidAdapter` is a separate consumer, not an analytics dependency. There is no automatic dispatch and **no publishing HTTP route**. The feature factory checks `NOX_NEWSLIQUID_ENABLED`; default is false. It supports only signed owner-history test messages (`test: true`), not live delivery. Future live publishing needs explicit authorization and an authenticated operational workflow.

New endpoints:

- `GET /api/research/capabilities`: read-only tool allowlist and disabled publication status.
- `GET /api/projects/:id/research/analysis`: deterministic evidence report from existing venue adapters.
- `POST /api/projects/:id/research/analysis`: same report, optionally enriched with unverified hypotheses by an operator-enabled OpenAI-compatible model. User question ≤1000 characters; URL/model/key are server configuration only.
- `GET /api/projects/:id/signals`: existing internal events only.
- `POST /api/projects/:id/signals/refresh`: explicit internal engine evaluation, separate from the read-only agent; no outbound delivery.

Only user-selected project markets are queried. No default assets were added. Workspace reuses the existing native synchronized chart component, interval state and data connections; TradingView remains unchanged in Market Structure.

## NewsLiquid wire protocol and safety

Reference: [TypeScript client](https://github.com/6551Team/newsliquid-signal-skill/blob/main/typescript/src/index.ts) and [README](https://github.com/6551Team/newsliquid-signal-skill/blob/main/README.md).

`POST https://news-api.newsliquid.com/api/v2/signal-sources/push/{appId}/events`

Signature is HMAC-SHA256 over `${timestamp}\n${nonce}\n${rawBody}` using the server secret. Headers: `X-Signal-Timestamp`, `X-Signal-Nonce`, `X-Signal-Signature`. Each retry receives a new nonce/signature but the stable event ID and signed body remain identical. Three bounded attempts for transient/network/429/5xx errors; non-retryable 4xx stop immediately. Transport timeout is 15 seconds; backoff is bounded. Full Retry-After-aware scheduling is deferred.

Public projection uses an explicit numerical metric allowlist. It excludes project IDs, contract/wallet addresses, raw evidence, free-text research, positions, credentials and execution strategies. Signed messages have `test: true`; acceptance must confirm `test:true, queued:false`. In-memory in-flight dedup plus persisted sent audit IDs handles normal retries/restarts. Provider event IDs handle ambiguous deliveries. Audit records contain ID/time/state/attempt/mode only, not payloads or credentials.

No request was sent to NewsLiquid, even test mode. Unit tests use an injected local fake transport. Real provider permission, clock-skew tolerance, rate limits and acceptance are **not live-verified**. Confirm these with an authorized test app before any external trial.

## Compatibility/security risks and limits

1. NOX is React/TypeScript/Express; upstream uses additional Zustand/query/router libraries and a Python backend. No extra state framework/backend migration is justified for this POC.
2. Existing API has permissive CORS and no user authentication. Do not expose model-cost or publishing operations publicly without authentication, CSRF/origin controls, per-user quotas and deployment review. No new public tunnel or deployment was created.
3. Model mode is disabled by default. Endpoint URL is operator-controlled, HTTPS or loopback only; redirects rejected; server-side key; bounded request time. Market facts remain deterministic. Source-ID validation is not semantic fact-checking: model claims stay explicitly unverified. A malicious question cannot grant tools or write authority.
4. Venue snapshot timestamps/coverage are not identical. CVD is window-relative, not lifetime, and must not be summed across incompatible windows. Missing values stay unavailable. Funding comparisons may have differing settlement intervals. Confidence scores are heuristics, not calibrated probabilities.
5. File-backed registry is bounded to 2000 events and serialized within one process. Multi-instance deployments require a database unique constraint, transactional outbox, retention policy and cross-worker locking. Audit logs need operational rotation. No guaranteed exactly-once delivery is claimed.
6. Layout is browser-local, per project, not yet cross-device synced. Four panel types are allowlisted; corrupt or duplicated layouts fall back to defaults. Small-screen docking remains desktop-oriented; panel focus is available via command menu.
7. No equities, filings, portfolio, options, paper-order or automated execution modules were imported. Existing user projects/preferences were not replaced.
8. Runtime currently reports Node 20.13.1; the existing eslint dependency chain requests a newer Node release. Build/tests/lint run here, but update runtime to a supported current LTS before deployment.

## Follow-up priorities

1. Authenticated persistent workspace presets and global command navigation; accessible divider keyboard resizing and focus-trapped modal.
2. Replay from archived normalized trades/OI, no-look-ahead backtests, fee/funding modeling and calibrated signal reliability.
3. Structured provenance for each individual metric (not only venue snapshot); event-time CVD coverage in the unified snapshot response.
4. Authorized model evaluation against malicious questions, stale facts and fabricated numbers; language-specific explanations, structured citation evaluation and model quotas.
5. Database outbox, Retry-After scheduling, audit rotation and authenticated approval workflow before any NewsLiquid network test. Obtain SDK license clarification before considering source reuse.

## Verification

Automated tests cover layout validation, redaction, exact signatures, disabled/dry-run no-network behavior, stable retry IDs/fresh nonces, nonretryable failures, unexpected live response rejection, registry persistence/concurrent dedup, evidence boundaries, plus existing normalization/CVD/OI/aggregation/TradingView tests. Local API and actual selected-project market data are checked separately; tests never present fixtures as live data.

Current verification: 28/28 automated tests pass; production build and ESLint pass. Browser checks confirmed real selected-project Binance data, four-panel render, divider resizing, moving a panel into a new dock position, filtered keyboard command execution, persisted focused layout after reload, Chinese/English controls, dark/light surfaces, and zero document horizontal overflow at the tested desktop viewport (1440px). No new application exception observed. Development HMR WebSocket failure was observed in the in-app browser; production preview avoids the dev-only channel. Exchange streaming may independently show DEGRADED; do not confuse successful REST evidence retrieval with guaranteed WebSocket freshness.
