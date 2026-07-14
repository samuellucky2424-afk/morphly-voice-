import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Morphly Voice — Real-time AI Voice Studio",
  description: "Professional real-time RVC voice changer dashboard for Morphly Voice.",
  other: {
    "codex-preview": "development",
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/morphly-icon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/morphly-icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/morphly-icon-48.png", sizes: "48x48", type: "image/png" },
    ],
    shortcut: "/morphly-icon-32.png",
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
