import type { Release } from 'virtual:releases';
import type { Plugin } from 'vite';
import { DESCRIPTION, esc, FAQ, FEATURES, NAME, REPO_URL, SHORTCUTS, SITE } from './content';
import { getReleases } from './releases';

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
const day = (iso: string) => (iso || new Date().toISOString()).slice(0, 10);

const LABELS: Record<string, string> = {
  'win-x64': 'Windows 10 and 11, x64 installer',
  'win-arm64': 'Windows 11 on ARM installer',
  deb: 'Linux .deb (Debian, Ubuntu)',
  appimage: 'Linux AppImage (x86_64)',
};

function downloads(r: Release) {
  return Object.entries(LABELS).flatMap(([kind, label]) => {
    const a = r.files[kind as keyof Release['files']];
    return a ? [{ kind, label, ...a }] : [];
  });
}

/** Plain download links inside #install. The script replaces them with the full table. */
function installFallback(r: Release): string {
  const items = downloads(r)
    .map(
      (d) =>
        `<li><a href="${esc(d.url)}">${esc(d.label)}</a> <span>${esc(d.name)}, ${mb(d.size)}</span></li>`,
    )
    .join('');
  return `<p>Latest version ${esc(r.version)}, released ${day(r.date)}. <a href="${esc(r.notesUrl)}">Release notes</a></p><ul class="in-fallback">${items}</ul>`;
}

function featuresHtml(): string {
  const items = FEATURES.map(([t, d]) => `<li><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`).join('');
  return `<section class="features" id="features" data-no-capture><h2>What anyshot does</h2><ul>${items}</ul></section>`;
}

function faqHtml(): string {
  const items = FAQ.map(
    ([q, a]) => `<details><summary><h3>${esc(q)}</h3></summary><p>${esc(a)}</p></details>`,
  ).join('');
  return `<section class="faq" id="faq" data-no-capture><h2>Questions</h2>${items}</section>`;
}

function jsonLd(r: Release): string {
  const graph = [
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE}#app`,
      name: NAME,
      description: DESCRIPTION,
      url: SITE,
      image: `${SITE}og.png`,
      screenshot: `${SITE}og.png`,
      applicationCategory: 'MultimediaApplication',
      applicationSubCategory: 'Screenshot and screen recording',
      operatingSystem: 'Windows 10, Windows 11, Linux',
      softwareVersion: r.version,
      datePublished: day(r.date),
      downloadUrl: downloads(r).map((d) => d.url),
      installUrl: `${SITE}#download`,
      releaseNotes: r.notesUrl,
      license: 'https://opensource.org/licenses/MIT',
      isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      author: { '@type': 'Person', name: 'Chaitanya Swaroop', url: 'https://github.com/mgamergo' },
      codeRepository: REPO_URL,
      sameAs: [REPO_URL],
      featureList: FEATURES.map(([t]) => t),
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE}#site`,
      name: NAME,
      url: SITE,
      about: { '@id': `${SITE}#app` },
    },
    {
      '@type': 'FAQPage',
      '@id': `${SITE}#faq`,
      mainEntity: FAQ.map(([q, a]) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    },
  ];
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(
    /</g,
    '\\u003c',
  );
  return `<script type="application/ld+json">${json}</script>`;
}

function markdown(r: Release, full: boolean): string {
  const dl = downloads(r)
    .map((d) => `- [${d.label}](${d.url}) (${d.name}, ${mb(d.size)})`)
    .join('\n');
  const head = `# ${NAME}

> ${DESCRIPTION}

- Website: ${SITE}
- Source code (MIT): ${REPO_URL}
- Latest version: ${r.version} (${day(r.date)}), [release notes](${r.notesUrl})
- All releases: ${REPO_URL}/releases

## Download

${dl}
`;
  if (!full) {
    return `${head}
## Docs

- [Full page as Markdown](${SITE}llms-full.txt): features, shortcuts and FAQ
- [README](${REPO_URL}#readme): features and screenshots
- [Licence](${REPO_URL}/blob/main/LICENSE)
`;
  }
  const features = FEATURES.map(([t, d]) => `- **${t}.** ${d}`).join('\n');
  const keys = SHORTCUTS.map(([a, k]) => `| ${a} | ${k} |`).join('\n');
  const faq = FAQ.map(([q, a]) => `### ${q}\n\n${a}`).join('\n\n');
  return `${head}
## Features

${features}

## Default shortcuts

| Action | Shortcut |
| --- | --- |
${keys}

## FAQ

${faq}

## Privacy

No telemetry, analytics or crash reporting. OCR runs offline. The only automatic network request is an optional update check against GitHub releases.
`;
}

/**
 * Search and agent discoverability, all generated at build time from the published
 * releases and plugins/content.ts: JSON-LD, a no-JavaScript download list, the
 * feature list and FAQ in the HTML, plus sitemap.xml, llms.txt, llms-full.txt and index.md.
 */
export function seo({ repo }: { repo: string }): Plugin {
  return {
    name: 'anyshot-seo',
    async transformIndexHtml(html) {
      const [latest] = await getReleases(repo);
      if (!latest) throw new Error('No releases');
      return html
        .replace('<!--seo:jsonld-->', jsonLd(latest))
        .replace('<!--seo:install-->', installFallback(latest))
        .replace('<!--seo:features-->', featuresHtml())
        .replace('<!--seo:faq-->', faqHtml());
    },
    async generateBundle() {
      const [latest] = await getReleases(repo);
      if (!latest) throw new Error('No releases');
      const files: Record<string, string> = {
        'llms.txt': markdown(latest, false),
        'llms-full.txt': markdown(latest, true),
        'index.md': markdown(latest, true),
        'sitemap.xml': `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}</loc><lastmod>${day(new Date().toISOString())}</lastmod></url>
</urlset>
`,
      };
      for (const [fileName, source] of Object.entries(files)) {
        this.emitFile({ type: 'asset', fileName, source });
      }
    },
  };
}
