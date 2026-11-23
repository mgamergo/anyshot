# anyshot website

The landing page for anyshot. It's its own small project, separate from the app:
Vite and plain TypeScript, no framework, with its own dependencies.

```sh
cd site
bun install
bun run dev        # local dev server
bun run check      # Biome and TypeScript
bun run build      # static site in site/dist
bun run preview    # serve the built site
```

## Downloads

Every download link, file size and version comes from the published GitHub releases,
fetched when the site is built (`plugins/releases.ts`). Nothing is hard-coded: a new
release shows up once the site is rebuilt. Set `GITHUB_TOKEN` to avoid the anonymous
API rate limit; the build fails if it can't read the releases.

The installers are matched by electron-builder's artifact names
(`anyshot-Setup-<v>-x64.exe`, `-arm64.exe`, `anyshot_<v>_amd64.deb`,
`anyshot-<v>-x86_64.AppImage`). If those names change in `electron-builder.yml`, update
`KINDS` in `plugins/releases.ts`.

## Deploying

`.github/workflows/site.yml` builds and publishes to GitHub Pages when `site/` changes
on `main`, after every successful Release run, and when started by hand
(**Actions → Website → Run workflow**). Pull requests that touch `site/` only build it.

The custom domain is set in **Settings → Pages**. The build uses relative asset paths,
so it works at the domain's root and at the github.io project path alike.

## What's on the page

- `src/demo.ts`: the scripted demo, played over a mock code editor showing
  `src/engine/beautify.ts`. Scenes: capture and annotate, record, copy text, pin, Beautify.
- `src/capture.ts`: the page's own capture overlay. Drag on the page or press
  Alt+Shift+X, annotate, then copy, save or pin a real PNG (html2canvas, loaded on demand).
- `src/install.ts`: the install table with OS tabs, architecture, commands and versions.

## Search and AI agents

`plugins/seo.ts` renders, at build time, everything crawlers and agents read without
running JavaScript: the JSON-LD (`SoftwareApplication`, `WebSite`, `FAQPage`), plain
download links inside `#install` (the script swaps them for the table), the feature list
and the FAQ. It also emits `sitemap.xml`, `llms.txt`, `llms-full.txt` and `index.md`.
The copy lives in `plugins/content.ts`; keep it true to the app. `public/robots.txt`
allows every search engine and AI crawler, and `public/og.png` is the 1200×630 share image.
