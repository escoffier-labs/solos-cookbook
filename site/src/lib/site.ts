export const BASE_PATH = '/cookbook';

export function sitePath(path = '/'): string {
  const normalized = `/${path.replace(/^\/+/, '')}`;
  if (normalized === '/') return `${BASE_PATH}/`;
  return `${BASE_PATH}${normalized}`;
}

export const SITE = {
  name: 'Le Répertoire',
  tagline: "Solomon's Cookbook",
  subtitle:
    'How one engineer runs a 24/7 multi-agent AI stack on bare metal. Opinionated. Dogfooded. Broken-and-fixed in production.',
  description:
    "Solomon's Guide to Cookin' with Gas: production-tested recipes for running long-lived AI agents alongside daily coding harnesses. Tested in service.",
  url: 'https://escoffierlabs.dev/cookbook',
  image: sitePath('/cookbook-hero.jpg'),
};

export const NAV_LINKS = [
  { label: 'Recipes', href: sitePath('/recipes') },
  { label: 'Chapters', href: sitePath('/#chapters') },
  { label: 'Templates', href: sitePath('/templates') },
  { label: 'About', href: sitePath('/about') },
];

export const EXTERNAL = {
  github: 'https://github.com/solomonneas/solos-cookbook',
  repoBlob: 'https://github.com/solomonneas/solos-cookbook/blob/main',
  repoTree: 'https://github.com/solomonneas/solos-cookbook/tree/main',
  contributing: 'https://github.com/solomonneas/solos-cookbook/blob/main/CONTRIBUTING.md',
  contentLicense: 'https://github.com/solomonneas/solos-cookbook/blob/main/CONTENT-LICENSE',
  brigade: 'https://brigade.tools',
  brigadeRepo: 'https://github.com/escoffier-labs/brigade',
  contentGuard: 'https://github.com/solomonneas/content-guard',
  openclaw: 'https://github.com/openclaw/openclaw',
};
