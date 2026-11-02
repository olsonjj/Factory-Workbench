# Providers note

Everything in the factory above the `StageRunner` seam is agent-provider
agnostic: the pipeline, state machine, SQLite, inbox/KB, gates, and PR
publishing never depend on which agent runtime runs the stages. The agent
runtime backing every agent stage is selected in `factory.config.json` via
`agent.provider` — `"pi"` (default) runs pi + Ollama Cloud, `"claude"` runs
Claude Code — with the full operator table (credentials, sandbox image
build, model defaults) in the README section "Choosing the agent provider".