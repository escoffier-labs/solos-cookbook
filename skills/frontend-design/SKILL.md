---
name: frontend-design
version: 1.0.0
description: "Create distinctive frontend direction that avoids generic AI-looking interfaces. Focus on typography, color, composition, and motion with an opinionated aesthetic point of view."
tags:
  - frontend
  - design
  - ui
  - typography
  - motion
category: design
---

# Frontend Design

> Attribution: inspired by Anthropic's `frontend-design` skill for Claude Code. This is a rewritten, trimmed-down variant, not the original.

Do not ship default-looking UI.

## Goal

Push the design toward a deliberate aesthetic instead of the usual anonymous product-demo look.

## Before designing

Lock three things first:
- **Purpose**: what the interface is for
- **Tone**: what it should feel like
- **Differentiator**: the one thing people will remember

## Tone examples

Pick a direction and commit:
- brutally minimal
- editorial
- playful
- retro-futuristic
- industrial
- luxurious
- organic
- brutalist

## Design rules

### Typography
- choose fonts with character
- use a clear display and body pairing when the project allows it
- avoid generic default stacks unless the brand explicitly needs them

### Color
- use a real palette, not filler gradients
- bias toward one dominant idea with sharp accents
- make light and dark choices feel intentional

### Motion
- use motion to reinforce hierarchy and mood
- one well-executed entrance sequence beats dozens of random micro-interactions
- hover and scroll states should feel designed, not bolted on

### Composition
- allow asymmetry when it helps
- use negative space or density on purpose
- avoid interchangeable card-grid layouts when the product deserves more personality

### Depth
- backgrounds, texture, borders, shadows, and overlays should support the tone
- avoid blank default surfaces unless restraint is the point

## Anti-patterns

- trend-chasing without a design point of view
- generic startup gradients
- interchangeable hero sections
- identical spacing everywhere
- motion used as decoration instead of communication

## Implementation rules

- keep the result accessible
- make it responsive
- match technical complexity to the visual ambition
- document the chosen design direction before building major screens

## Output contract

When using this skill, produce:
1. a short design direction statement
2. typography guidance
3. color guidance
4. composition notes
5. motion notes
6. implementation constraints

## Anti-pattern

If the result could be mistaken for any random AI-generated SaaS landing page, start over.
