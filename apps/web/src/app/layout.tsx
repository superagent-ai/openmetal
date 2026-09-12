import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { RootProvider } from "fumadocs-ui/provider/next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { pageMetadata } from "@/lib/page-metadata";
import { homeTitle, siteDescription, siteName, siteUrl } from "@/lib/site";
import { cn } from "@/lib/utils";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const defaultMetadata = pageMetadata({
  title: homeTitle(),
  description: siteDescription,
  path: "/",
  absoluteTitle: true,
  image: false,
});

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  applicationName: siteName,
  title: {
    default: homeTitle(),
    template: `%s | ${siteName}`,
  },
  description: siteDescription,
  authors: [{ name: siteName }],
  creator: siteName,
  publisher: siteName,
  category: "technology",
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  openGraph: defaultMetadata.openGraph,
  twitter: defaultMetadata.twitter,
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)} suppressHydrationWarning>
      <body className="min-h-svh antialiased">
        <RootProvider
          theme={{
            defaultTheme: "dark",
            enableSystem: true,
            disableTransitionOnChange: true,
          }}
        >
          <TooltipProvider>{children}</TooltipProvider>
        </RootProvider>
      </body>
    </html>
  );
}
