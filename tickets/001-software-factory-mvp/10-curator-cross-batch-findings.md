# 10: Curator cross-batch findings

**What to build:** Close the findability gap in multi-batch curation. Today `curate()` slices an over-budget KB layer at entry boundaries (`chunkKbLayer`, `src/kb.ts`) and invokes the curator once per batch (`CuratorRequest.batch`, `src/pipeline.ts:246`). Every batch sees only its own entries, so finding classes that span batches are structurally invisible to the curator: an entry in batch 1 can contradict an entry in batch 3, entries that are merge candidates can sit in different batches, and the same stale fact can be flagged inconsistently. The current mitigations are advisory only — the artifact's batch header says "cross-check batches 1..N manually", which pushes the work onto the operator exactly at the scale where the operator is worst at it (the reason curation exists).

**Why it matters:** the batching was added to preserve the prompt budget, not to define what curation can see. Under budget pressure (KB grows, budget fixed), most real curation runs will be multi-batch, so "manual cross-check" becomes the default path rather than the exception.

**Design options (pick one; ordering is my preference):**

1. **Digest index pre-pass (recommended).** Build a compact one-line-per-entry index (date, tag/scope, first prose line, byte offset → which batch) — sized so it *fits inside the same prompt budget* even when full text does not. Include the index in every batch prompt and add one prompt sentence: "flag contradictions/merges against the index; name the batch to check." Findings that span batches become possible with zero additional agent invocations; per-batch findings stay full-text-quality.
   - *Tradeoff:* the index is lossy (a contradiction of substance may not surface in first lines); it extends rather than replaces the caveat, so the artifact header should now name the index as the cross-batch aid.
2. **Cross-batch review pass.** After all per-batch proposals, run one additional curator invocation over a digest of the per-batch findings (plus the one-line index) to reconcile cross-batch patterns into the final artifact.
   - *Tradeoff:* +1 paid agent pass per multi-batch run; best detection rate, worst cost.
3. **Forward findings carry.** Each batch N receives a one-line digest of batches 1..N-1's findings. Contradictions "discovered in batch 3 vs batch 1" surface, batch-1-vs-batch-3-seen-from-1 still do not.
   - *Tradeoff:* cheap, partial coverage; keeps run count identical but biases detection order.
4. **Status quo, documented.** Accept the gap; keep the manual cross-check note. Cheapest; leaves the operator as the only cross-batch detector.

**Blocked by:** 09: Curator pass (shipped — chunking, batching, incremental persistence, and the caveat header all exist).

**Status:** done (2026-10-28, PR #6 — option 1 implemented: digest index pre-pass; cross-batch detection with zero additional agent invocations; lossiness accepted, caveat stays as backstop. Three Greptile review rounds hardened the implementation: whole-entry chunk boundaries, original-text digest parsing, and fence/comment-aware prose selection.)

- [x] Option chosen and recorded (option 1: digest index pre-pass)
- [x] Cross-batch finding classes are covered by test: a contradicting pair seeded into two different batches yields a finding (`tests/ticket09-curate.test.ts`: "a contradicting pair seeded into two different batches yields a finding that names the other batch")
- [x] Prompt budget is still respected for every curator invocation (`tests/kb-chunk.test.ts`: digest bounded to `maxChars` + marker; whole-entry boundaries with byte-exact concat)
- [x] The artifact batch header no longer relies on manual cross-checking alone (`src/pipeline.ts` batch note names the digest index as the cross-batch aid; the caveat remains as backstop per the design)
- [x] Cost note: N/A — option 1 was chosen, which adds zero agent invocations (this box applies only to option 2)