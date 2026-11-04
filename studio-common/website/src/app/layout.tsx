import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { ProjectAudioProvider } from "./project-audio";
import { Nav } from "./nav";
import { connection } from "next/server";
import { gameProfile } from "@/lib/game-profile";
import { headers } from "next/headers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const profile = gameProfile();
  const iconVersion = `${profile.id}-20261104`;
  return {
    title: profile.title,
    description: profile.description,
    icons: {
      icon: [{ url: `/icon.png?v=${iconVersion}`, type: "image/png", sizes: "256x256" }],
      shortcut: `/favicon.ico?v=${iconVersion}`,
      apple: `/icon.png?v=${iconVersion}`,
    },
  };
}

export const viewport: Viewport = { colorScheme: "dark", themeColor: "#09090b" };

export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  const profile = gameProfile();
  const requestHeaders = await headers();
  const protocol = requestHeaders.get("x-forwarded-proto") === "https" ? "https" : "http";
  const sourceOrigin = `${protocol}://${requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost"}`;
  return (
    <html lang="zh-CN" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full bg-zinc-950 text-zinc-100">
        <Nav title={profile.title} gameId={profile.id} sourceOrigin={sourceOrigin} />
        <ProjectAudioProvider hasOriginalChineseAudio={profile.sourceOriginalChineseAudio}>{children}</ProjectAudioProvider>
      </body>
    </html>
  );
}
