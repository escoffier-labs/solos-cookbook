export type PageKind = 'website' | 'article';

interface PageMetadataInput {
  kind: PageKind;
  title: string;
  description: string;
  url: string;
  image: string;
  license: string;
  dateModified?: string;
}

export function buildPageMetadata(input: PageMetadataInput) {
  const author = { '@type': 'Person', name: 'Solomon Neas', url: 'https://solomonneas.dev' };
  if (input.kind === 'article') {
    return {
      openGraphType: 'article' as const,
      structuredData: {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: input.title,
        description: input.description,
        url: input.url,
        mainEntityOfPage: input.url,
        image: input.image,
        author,
        license: input.license,
        ...(input.dateModified ? { dateModified: input.dateModified } : {}),
      },
    };
  }

  return {
    openGraphType: 'website' as const,
    structuredData: {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: input.title,
      description: input.description,
      url: input.url,
      image: input.image,
      author,
      license: input.license,
    },
  };
}
