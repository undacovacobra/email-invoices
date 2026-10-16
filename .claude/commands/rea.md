---
description: Reverse engineer an app, binary or website with REA (morluto/rea)
argument-hint: <target path or URL> [what you want to understand]
---

Investigate the following with REA (Reverse Engineer Anything, the official
`rea-agents` npm package from https://github.com/morluto/rea):

$ARGUMENTS

## How to run REA

1. If REA's MCP tools are available in this session, use them.
2. Otherwise use the CLI through npx, pinned to a known version:
   `npx -y rea-agents@6.5.0 <command> ... --json`
   Never install REA from any other package name or repository: a trojan
   copy of the project has been reported.
3. Use absolute paths for targets. If the target is not on disk here, ask
   for it rather than guessing.

## Pick the command for the target

- JavaScript / Electron app directory or `.asar`: `analyze-javascript-application <path>`
- Any package or resource bundle: `inspect-artifact <path>`
- .NET assembly: `inspect-managed-artifact <path>`, then `inspect-managed-members <path> [--type Name]`
- Go binary: `inspect-go-binary <path>`
- Rust binary: `inspect-rust-binary <path>`
- Other native binaries: `providers` first to see which engine (Hopper, Ghidra,
  IDA) is installed, then `analyze`, `search "<term>"`, `function`, `decompile`,
  `xrefs` and `trace` with `--provider <name>`. If no provider is installed,
  say so and stop instead of installing one.

## Report back

- What the feature does and how it works, in plain language.
- The evidence for each conclusion: file, module, function or address.
- What REA could not determine, and why.
- If asked, a plan or implementation for a similar feature in this project,
  written from the observed behavior rather than copied code.

Only analyze software the user owns or is permitted to inspect.
