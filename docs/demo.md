# Manual verification: markdown in → pull request out (ticket 05)

Prerequisites:

- Docker (OrbStack or Docker Desktop) running, with the sandbox image built:
  `npx sandcastle docker build-image`
- `OLLAMA_API_KEY` exported on the host (Ollama Cloud)
- `gh` pre-authenticated (`gh auth status`)
- A GitHub-hosted target repo you are allowed to push to, cloned locally

Then:

```bash
# 1. Create the factory root next to nothing else
npx factory init                       # writes ./factory/

# 2. Drop an item (no approvals → autonomous → ready-for-review PR)
cat > factory/inventory.md <<'EOF'  # (put the file in factory/inbox/)
---
title: Add a greeting constant
repo: /path/to/greeter-repo
base: main
approvals: []
---

Add a new file src/hello.ts exporting `export const HELLO = "world"` and a
test asserting it.
EOF

# 3. Drive the pipeline — nothing but the tick verbs
npx factory run     # each invocation advances the item one stage
npx factory status  # shows triage → spec → … → waiting on / done
npx factory resume  # finish the run: pushes `factory/<slug>` and opens the PR

# 4. Verify
gh pr list --repo <greeter-repo>          # PR exists, body contains:
#   - the original request markdown
#   - the spec artifact
#   - the review verdict artifact
#   - rework history ("None — first pass." for a clean run)
git -C /path/to/greeter-repo log --oneline factory/<slug>   # commits on the branch
npx factory status    # item is `done`; PR list shows ready-for-review (no --draft flag)

# 5. HITL variant: repeat with approvals: [spec, review] → the PR is created
#    as a draft, and the factory parks at both approved stages for you.
```

The factory never merges: the merge decision is always the operator's; the
merge step does not exist anywhere in the codebase by design.

Note: without Docker (or a built sandbox image) the item instead parks with
`infrastructure-failure` after its infra-retry budget — which is the
bounded-failure behavior working as specified.