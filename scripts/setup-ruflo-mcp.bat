@echo off
claude mcp add claude-flow -- npx -y @claude-flow/cli@latest
npx @claude-flow/cli@latest daemon start
npx @claude-flow/cli@latest doctor --fix
npx @claude-flow/cli@latest swarm init --topology hierarchical --max-agents 8 --strategy specialized --v3-mode