# Confirmed proactive document execution V3

Tracking: upstream issue #321; additive to V2 (#320). Default off, no automatic merge.

## Product boundary

The existing V2 reminder ledger stays separate from the task ledger. A need for summary, public research or document drafting can produce a proposal; it is not authorization to execute. Only the source author can start, change or accept that task. A card callback binds task ID, revision, chat, author and card message ID. Text commands bind author, chat and topic and require an ID when ambiguous. Changed requirements create a new revision and invalidate previous approval. Confirmations are persisted before starting the worker.

One worker runs at a time and shares the existing process pool with normal bridge work. Defaults: ten-minute timeout, three proposals per author/day, ten-minute topic cooldown. Identical requests deduplicate for 24 hours. Personal pause and quiet hours apply; paused execution is aborted. All task cards reply within the source topic; progress updates the existing card rather than sending new messages. `我的主动任务` reads the persistent status if card updating failed.

## State and failure behavior

States: proposed → running → publishing → delivered → accepted. Missing information enters needs_input; supplementation returns to proposed at a new revision. Cancellation and failures are explicit terminal states for that attempt. Revisions preserve the earlier artifact list and draft, and create a new document rather than overwriting the accepted source. A review reminder reuses V2's bounded scheduler and is cancelled on acceptance or revision.

State schema 3 adds tasks without removing V1/V2 reminders, preferences or message deduplication. Startup marks interrupted running/publishing tasks failed, without replaying model execution or document creation. The pre-publication claim and returned document ID are persisted. An uncertain create/write/permission result never becomes delivered and is not automatically retried. This can leave a partial private document; operators use the recorded ID to inspect it. No automatic deletion is attempted.

Task-card edits are safe to retry, but initial card creation is not automatically retried after an ambiguous send result. Persistence failures block action. There is currently no cross-process distributed worker lease: run one observer process per profile.

## Execution and privacy

This implementation supports Codex only, using a fresh private working directory and read-only sandbox. User config, project rules/instructions, shell, apps, hooks, skills, memory and multi-agent behavior are disabled for task runs. Feishu credentials and bridge-bound environment variables are not inherited; the general bridge prompt granting coding capabilities is not used. Normal `@bot` execution is unchanged.

Codex may still advertise apply_patch even when its obsolete feature flag is disabled. The read-only sandbox must reject the operation. `BRIDGE_CODEX_POLICY_PROBE=1 vitest run tests/process/codex-restricted-policy.test.ts` inspects an installed real CLI against a loopback fake Responses endpoint, forces an attempted write, asserts denial and confirms the file is absent. It uses a new temporary home and a fake API key, not real credentials. Set `BRIDGE_CODEX_POLICY_PROBE_BINARY` for the deployed CLI binary. Do not replace read-only with broader permissions to resolve runtime failures.

Source scope is the current topic's bounded recent text plus up to five explicitly supplied Feishu docx/wiki URLs (40,000 characters each). Source content is untrusted data. Images, attachments, non-docx wiki nodes and arbitrary website ingestion for summary/drafting are not supported; ask for pasted text. Research can use native public web search; generated citations and factual conclusions still require human review. Source-document text is not to be used as a search query. Model output is schema-checked but this is not a factual correctness guarantee.

The host—not the model—performs the fixed publication sequence: create a new docx, write bounded blocks, grant only the requester edit access, read back content. The model cannot choose arbitrary mutation endpoints, recipients or document IDs. Tenant public sharing is never enabled. Required permissions include docx creation/write/read and drive collaborator management; source docs must be shared with the bot. This sequence is not atomic, so failures retain recovery evidence rather than pretend completion.

## Acceptance

- No model run or document creation before confirmation.
- Wrong owner/chat/topic/card/revision cannot approve; duplicate approvals start once.
- Missing inputs are visible and revised requirements require reconfirmation.
- Start → progress → real readable document → revision → acceptance, all in the existing topic.
- Cancellation, timeout, restart, permission/readback failures remain visibly non-delivered.
- Research returns checkable source links; summary uses actual supplied source content.
- Shadow/off sends and executes nothing; V2 reminder and normal mention tests remain green.
- Migration retains reminders and task records through restart.

Rollout: back up configuration, observer state and startup script; verify the built artifact hash; opt in only the existing test chat; use the existing test topic without creating a new top-level group message. Verify running process/version, disk config and real user-visible document access. Rollback first disables `execution.enabled` and restarts after active tasks stop. Keep version-3 state; downgrading to V2 without a saved snapshot can discard task history.
