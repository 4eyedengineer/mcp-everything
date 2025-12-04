name: claude-md-guide
description: Guide for creating and maintaining effective CLAUDE.md files for Claude Code projects. Use when users want to create a new CLAUDE.md, improve an existing CLAUDE.md, understand CLAUDE.md best practices, or troubleshoot why Claude Code isn't following their project conventions. Triggers include requests to "write CLAUDE.md", "improve my CLAUDE.md", "set up Claude Code for my project", or questions about memory/context in Claude Code.

## CLAUDE.md Guide

CLAUDE.md files provide persistent project context for Claude Code, eliminating repetitive explanations of conventions, commands, and architecture.

## File Hierarchy

Claude Code loads CLAUDE.md files recursively from current directory upward:

| Location | Scope | Version Control |
|----------|-------|-----------------|
| ~/.claude/CLAUDE.md | User-global | No |
| ./CLAUDE.md (project root) | Project-wide | Yes - commit to git |
| ./CLAUDE.local.md | Personal overrides | No - auto-gitignored |
| Subdirectory CLAUDE.md | Component-specific | Yes |

## Core Principle

Write for Claude, not for onboarding humans. Use terse bullet points. If a folder is named components/, don't explain it contains components.

## Required Sections

Structure files with these categories:

```markdown
# Project Context
One-line description of what this codebase does.

## Tech Stack

- Node 22, TypeScript, Tailwind CSS 4

## Commands

- `npm run dev` - development server
- `npm test` - run tests
- `npm run lint` - check linting

## Standards

- Type hints required on all functions
- 2-space indentation

## Workflow

- Check ./docs before asking questions
- Run lint and type-check before committing

## IMPORTANT

Critical rules that must never be violated.
```

## Writing Guidelines

- **Use bullet points** - Short declarative statements, not paragraphs
- **Pair constraints with alternatives** - "Never X, prefer Y instead"
- **Use emphasis for critical rules** - "IMPORTANT" or "YOU MUST" improves adherence
- **Reference docs by path** - Explain when to read files, not @-mention entire contents
- **Iterate based on friction** - Press # during sessions to add instructions organically

## Antipatterns to Avoid

- **Bloated files** - Quality degrades as length increases; test with verification phrases
- **@-mentioning entire files** - Embeds full content on every run; instead describe when to read them
- **Negative-only constraints** - "Never do X" leaves Claude stuck; always provide alternatives
- **Sensitive information** - Never commit API keys or credentials

## Quick Commands

| Command | Purpose |
|---------|---------|
| /init | Generate starter CLAUDE.md from codebase analysis |
| # | Add instruction organically during session |
| /memory | Open memory files in system editor |
| /clear | Reset context between distinct tasks |

## Token Budget Heuristic

For large teams: only document tools used by 30%+ of engineers. If you can't explain a tool concisely, it's not ready for CLAUDE.md inclusion.

## Advanced Patterns

See references/examples.md for real-world CLAUDE.md examples and enterprise patterns for monorepos.

## Technical Note

CLAUDE.md content is delivered as the first user message, not system prompt. For deeper behavioral control, use --append-system-prompt CLI flag.
