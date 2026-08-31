import type { Metadata } from "next";
import { headers } from "next/headers";
import { APP_BASE_PATH, appPath } from "@/lib/app-path";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || requestHeaders.get("host") || "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol = forwardedProtocol ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const imageUrl = new URL(appPath("/og.png"), origin).toString();
  const canonicalUrl = new URL(APP_BASE_PATH || "/", origin).toString();
  const title = "Lumos — Reducto cost preflight";
  const description =
    "Estimate Reducto pipeline costs and enforce a budget before document processing begins.";

  return {
    title,
    description,
    alternates: { canonical: canonicalUrl },
    icons: { icon: appPath("/favicon.svg") },
    openGraph: {
      title,
      description,
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "Lumos — Estimate Reducto costs before processing begins." }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
