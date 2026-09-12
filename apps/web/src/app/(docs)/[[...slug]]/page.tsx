import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/notebook/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import { OpenAPIPage } from "@/components/api-page";
import { getMDXComponents } from "@/components/mdx";
import { siteOrigin } from "@/lib/auth-redirect";
import { openapi } from "@/lib/openapi";
import { pageMetadata, resolvePageDescription, resolvePageTitle } from "@/lib/page-metadata";
import { homeTitle, siteDescription, siteName } from "@/lib/site";
import { getPageMarkdownUrl, source } from "@/lib/source";

type DocumentationPageProps = {
  params: Promise<{ slug?: string[] }>;
};

function SiteJsonLd() {
  const origin = siteOrigin();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteName,
    alternateName: homeTitle(),
    url: origin,
    description: siteDescription,
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
    />
  );
}

export default async function DocumentationPage({ params }: DocumentationPageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const isHomePage = !slug || slug.length === 0;
  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} className="*:mx-auto *:w-full">
      {isHomePage ? <SiteJsonLd /> : null}
      {isHomePage ? null : (
        <>
          <DocsTitle>{page.data.title}</DocsTitle>
          <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
          <div className="flex items-center gap-2 border-b pb-6">
            <MarkdownCopyButton markdownUrl={markdownUrl} />
            <ViewOptionsPopover markdownUrl={markdownUrl} />
          </div>
        </>
      )}
      <DocsBody className={isHomePage ? "docs-home" : undefined}>
        <MDX
          components={getMDXComponents({
            a: createRelativeLink(source, page),
            OpenAPIPage: async (props) => (
              <OpenAPIPage {...await openapi.preloadOpenAPIPage(page)} {...props} />
            ),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: DocumentationPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const path = page.url;
  const title = resolvePageTitle(page.data.title, path);
  const description = resolvePageDescription(page.data.title, page.data.description, path);
  const isHome = !slug || slug.length === 0;

  if (isHome) {
    return {
      title: { absolute: title },
      description,
      alternates: {
        canonical: path,
        types: { "text/plain": "/llms.txt" },
      },
      robots: {
        index: true,
        follow: true,
      },
    };
  }

  return pageMetadata({
    title,
    description,
    path,
    type: "article",
    alternates: {
      types: { "text/markdown": getPageMarkdownUrl(page).url },
    },
  });
}
