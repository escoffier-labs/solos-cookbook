# Manifesto vs Framework

> A cookbook is not a tool. It is a record. The difference matters because tools are owed support and frameworks are owed compatibility; cookbooks are owed only that the recipes still work for the author. Treating one as the other is how bad outcomes happen on both sides.

## What this is

A statement of intent about what this repo is, what it is not, and what each shape would imply about contracts with readers. Useful to read if you are tempted to adopt the cookbook as a framework, fork it as a starter kit, or open an issue that assumes I am running this as a product.

## The shapes

There are three common shapes a body of technical writing can take. They look similar from a distance and have very different obligations.

### A tool

A tool is a thing you import or install. You expect:

- Versioning with deprecation policies
- Bug reports with response times
- A stable interface across releases
- Documentation that covers every parameter
- Backwards compatibility that is taken seriously

A tool author owes their users not breaking them. If you publish `left-pad` and break the API, you have done something wrong even if your usage stayed correct. The contract is implicit in the act of distribution.

### A framework

A framework is a way of thinking that ships with libraries. You import its pieces; you also adopt its conventions. You expect:

- Conventions that hold across the codebase
- A migration story when those conventions change
- Plugin or extension points so you can stay in the framework as your needs grow
- A community around the conventions, separate from any one library

A framework author owes their users a coherent shape. If you ship "convention over configuration" and then ship a release that breaks the convention, you have broken the framework even if every individual library still works.

### A cookbook

A cookbook is a record of recipes that worked. You read it, you take the parts that fit, you adapt the rest. You expect:

- The recipes ran for the author
- The author writes down what broke
- The recipes are real, not theoretical
- Some recipes will not fit your setup, and that is fine

A cookbook author owes their readers honesty about what they did and why. They do not owe maintenance of the recipe in your kitchen. They do not owe backwards compatibility. They do not owe you a working migration story when their preferences change.

## Which one is this

This is a cookbook. Every guide is a recipe that runs on my actual machine against my actual workload. The structure of the repo (`infrastructure/`, `automation/`, `templates/`) is for *my* navigation, not yours; lift the parts that help, ignore the rest.

What this means in practice:

| If you do this | What I will do |
|----------------|----------------|
| Lift a template and ship it | Fine. The templates are MIT-licensed. No attribution required, though it is appreciated |
| Fork the cookbook and replace half the guides | Fine. The narrative is CC BY-NC-ND, the templates and scripts are MIT |
| Open an issue saying "this guide does not work on Fedora" | I will read it. I may not fix it. Fedora is not a platform I run. PRs that add a Fedora variant of a guide are welcome |
| Open an issue saying "this is wrong because [other practice]" | I will read it. I will probably not change anything. Different setups, different constraints |
| Submit a PR that adds a new section to the existing guide | I will review it against the Gotchas + verification standard. If your section says something works without saying how you verified it, I will ask for verification before merging |
| Build a tool that wraps the cookbook's recipes | Fine. Reference the cookbook, do not republish guide bodies wholesale (CC BY-NC-ND) |
| Use the cookbook as the foundation of a paid product or course | Not okay (CC BY-NC-ND, non-commercial). Talk to me first if that is your intent |

## Why not a framework

Tempting question: take the patterns, draw an architecture, write a CLI that scaffolds the whole thing, ship it as a framework. Other people have done variants of this with their own opinions and tools.

I think it is the wrong move for this body of work. A framework's value is in the shape it gives you when you adopt it. A cookbook's value is in the *information* it gives you about a shape that worked. Those are different products.

A few specific reasons:

- **The conventions are mine.** The dual-host pattern, the publish-time scrubber, the three-layer cron stack are choices that fit my workload. They might fit yours. A framework would force them on every consumer; a cookbook lets you take what fits.
- **The release surface would be huge.** Bundling all of this into a framework means shipping versions, deprecating patterns, supporting old configs. The cookbook's release surface is "did I git push." That asymmetry is the whole reason this exists.
- **I am one engineer.** A framework needs at least a small community to outlive the original author's interest. A cookbook lives on disk forever, regardless of who is paying attention.

## Why not a tool

Same reasoning, sharper. The guides do not compose into a single product. The MCP catalog ships as separate tools because they *are* separate tools (each wrapping one service). The dashboard ships as its own repo because it is one thing. There is no "the cookbook tool" because the cookbook is information, not behavior.

Where the cookbook does point at single tools (`content-guard`, `usage-tracker`, the MCP servers in [`../tools/mcp-catalog.md`](../tools/mcp-catalog.md)), those are independent. Each has its own README, its own versioning, its own release cadence. The cookbook references them; it does not own them.

## What this implies for contributions

Two reads, depending on what you are bringing:

### "I tried a guide and it worked / did not work"

This is the most valuable contribution. Open an issue with:

- Which guide
- What platform
- What was the same as the guide
- What was different
- What you had to change to make it work

Verification reports get folded into the Gotchas sections. Drift between the guide and reality is a bug; your report is the bug filing.

### "I have a related pattern that worked for me"

Also valuable. Open a PR with a new guide in the format from [`../CONTRIBUTING.md`](../CONTRIBUTING.md). The bar is the Gotchas section: I need to be able to tell you ran it, broke it, and fixed it. Theoretical guides get bounced.

### What is not a useful contribution

- "You should use [other tool]." Maybe. Open a PR that demonstrates the swap with verification, or leave it.
- "This is bad practice in [enterprise context]." This is not an enterprise context.
- "You should test this with [more frameworks]." This is a record of what I run; expanding it to frameworks I do not run does not serve the primary reader.
- A guide template with no Gotchas and no verification. The format exists for a reason.

## What this implies for readers

Treat the cookbook like a cookbook. You would not blame Julia Child if you used the wrong skillet. You would not assume Modernist Cuisine ships with customer support. You would read what was on the page, take what was useful, and trust your own kitchen for the rest.

A few practical reads:

1. **Skip what does not apply.** Most readers will care about half the cookbook. The agent-stack readers will skip the homelab parts. The homelab readers will skip the publishing parts. That is fine.
2. **Verify everything against your setup.** Commands that work on Ubuntu 24.04 may not work on Debian 13. Most of them will, but the few that do not are exactly the ones that bite.
3. **Take the structure, not just the commands.** Each guide has a "Why this way" section. That is the part that generalizes; the specific commands are just one realization of the principle.
4. **The cookbook is a snapshot, not a stream.** A guide written in March may be slightly stale by November. If a command no longer works, open an issue; if a guide's premise no longer holds, the bigger question is whether the underlying choice changed (and if so, whether yours should too).

## Why "Solomon's Guide to Cookin' with Gas"

Not a framework name. Not a product name. A title that telegraphs cookbook before you have read a paragraph. The naming is intentional: a framework called "ClawStack" or a product called "Agently" would have set the wrong expectations. "A guide" is honest about the shape.

The 🦞 lobster is a placeholder for "this is a person's project, not a corporation." Use the part of the cookbook that helps; ignore the lobsters if they are not your taste.

## Templates

No template here; this is the position piece. Pair with:

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) - the per-guide format that operationalizes "cookbook, not framework"
- [`../README.md`](../README.md) - the inventory of recipes

## Related

- [`why-one-host.md`](why-one-host.md) - the constraint that makes "cookbook, not framework" honest
- [`why-dogfood-everything.md`](why-dogfood-everything.md) - the rule that keeps the recipes from becoming theoretical
- [`what-this-stack-is-not.md`](what-this-stack-is-not.md) - the patterns this cookbook does not advocate, by extension
