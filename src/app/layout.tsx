import type { Metadata } from "next";
import Link from "next/link";
import { MatchMenu } from "@/components/MatchMenu";
import { MatchPin } from "@/components/MatchPin";
import {
  BrandMark,
  HEADER_NAV_CLASS,
  HEADER_NAV_ITEMS,
  SiteHeader,
} from "@/components/SiteHeader";
import { THEME_BOOT } from "@/lib/theme-boot";
import "./globals.css";

export const metadata: Metadata = {
  title: "斗场 · AI Arena",
  description: "规则由你写，阵容由你挑。全员并行出招，裁判统一裁决。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-theme="dark" data-mode="auto" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-screen antialiased">
        <SiteHeader
          brand={
            <Link href="/" className="group flex items-center gap-2.5">
              <BrandMark />
            </Link>
          }
          pin={<MatchPin />}
          nav={HEADER_NAV_ITEMS.map((item) =>
            item.href === "/matches" ? (
              <MatchMenu key={item.href} />
            ) : (
              <NavLink key={item.href} href={item.href}>
                {item.label}
              </NavLink>
            ),
          )}
        />
        {children}
      </body>
    </html>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={HEADER_NAV_CLASS}>
      {children}
    </Link>
  );
}
