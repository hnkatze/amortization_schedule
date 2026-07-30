# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CLAUDE.md and AGENTS.md must stay identical

The two files ship as a hardlink (one inode) so every agent surface reads the same guidance.
**Most editors and agent write tools break that link**: they replace the file rather than
truncating it, leaving `AGENTS.md` silently stale on the old content.

After editing either file, re-establish the link and verify:

```sh
rm AGENTS.md && ln CLAUDE.md AGENTS.md
ls -i CLAUDE.md AGENTS.md   # the two inode numbers must match
```

Keep the content tool-agnostic — it is read as both `CLAUDE.md` and `AGENTS.md`.

## Commands

```sh
npm run dev            # astro dev — foreground, http://localhost:4321
npx astro dev --background   # preferred: detached dev server
npx astro dev status         # is it running?
npx astro dev logs --follow  # tail its output
npx astro dev stop           # shut it down
npm run build          # production build to ./dist/
npm run preview        # serve the built output
```

Node `>=22.12.0` is required (`package.json` `engines`).

## There is no typecheck, lint, or test command

- No test runner and no linter are configured.
- `astro check` is **not** runnable as-is: `@astrojs/check` and `typescript` are absent from
  `node_modules`, so the first invocation prompts to install them.

Until those are installed, there is no way to typecheck this project. Do not report code as
"typechecking" or "passing" — say the check is unavailable and name it.

## Stack

- **Astro 7**, static output, no SSR adapter, no framework integrations. There is no React,
  Vue, or Svelte here; components are `.astro` only.
- **Tailwind v4 through `@tailwindcss/vite`**, registered as a Vite plugin in
  `astro.config.mjs` — *not* the `@astrojs/tailwind` integration. Consequences:
  - There is no `tailwind.config.js` and adding one does nothing. v4 is configured in CSS
    (`@theme`, `@plugin`, `@source`) inside `src/styles/global.css`.
  - `global.css` is imported exactly once, from `src/layouts/Layout.astro`. Any page that
    needs Tailwind must render through that layout.
- `tsconfig.json` extends `astro/tsconfigs/strict`.

## Current state of the codebase

This is an unmodified `npm create astro@latest -- --template basics` scaffold. Despite the
project name, **no amortization logic exists yet** — there is no domain layer, no routing
beyond `src/pages/index.astro`, and no state management.

`src/components/Welcome.astro`, `src/assets/*`, and `README.md` are template boilerplate and
are meant to be deleted once real work starts. Do not treat them as patterns to imitate.

## Agent skills

`.claude/skills/`, `.agents/skills/`, and `.kiro/skills/` hold three copies of the same skill
set, one per agent tool. All three are gitignored, as is `skills-lock.json`. The generated
index lives at `.atl/skill-registry.md`.

## Documentation

Full documentation: https://docs.astro.build

- [Routing, dynamic routes, middleware](https://docs.astro.build/en/guides/routing/)
- [Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Framework components](https://docs.astro.build/en/guides/framework-components/)
- [Content collections](https://docs.astro.build/en/guides/content-collections/)
- [Styling and Tailwind](https://docs.astro.build/en/guides/styling/)
