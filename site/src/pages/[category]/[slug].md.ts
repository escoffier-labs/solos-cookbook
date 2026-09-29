import { getCollection } from 'astro:content';

export async function getStaticPaths() {
  const guides = await getCollection('guides');
  return guides.map((entry) => ({
    params: { category: entry.data.category, slug: entry.data.slug },
    props: { entry },
  }));
}

export async function GET({ props }: { props: { entry: { data: { title: string }; body: string } } }) {
  const { entry } = props;
  const markdown = `# ${entry.data.title}\n\n${entry.body.replace(/^\n+/, '')}`;
  return new Response(markdown.endsWith('\n') ? markdown : `${markdown}\n`, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}
