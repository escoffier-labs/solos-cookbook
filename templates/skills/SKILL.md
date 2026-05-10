---
name: example-skill
version: 1.0.0
description: "One sentence describing when the agent should use this skill."
tags:
  - example
category: workflow
---

# Example Skill

## Goal

State the reusable job this skill performs.

## When to use

- Use when the user asks for this exact workflow.
- Use when local context clearly matches the trigger.

## Inputs

- Required context:
- Optional context:

## Workflow

1. Read only the files needed for the task.
2. Prefer local scripts or templates bundled with the skill.
3. Verify the result with the smallest meaningful check.

## Safety

- Do not expose private identifiers.
- Do not mutate production systems without explicit approval.
- Do not install dependencies unless the user agrees.

## Verification

```bash
<command-that-proves-the-skill-worked>
```
