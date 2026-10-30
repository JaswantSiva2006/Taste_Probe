import type { Metadata, Viewport } from "next";
import { Archivo, DM_Sans, IBM_Plex_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import "./sound-passport.css";
import "./afterhours.css";

// S9.15 "Afterhours" type system (all SIL Open Font License, self-hosted by next/font at build time):
// Archivo (variable weight + width) for display, DM Sans for interface, IBM Plex Mono for timestamps and labels.
const display = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-display", display: "swap" });
const sans = DM_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "TasteProbe · Sound Passport — your taste travels",
  description:
    "Discover music from the things you love. Start with a film, artist, show, game or podcast, and TasteProbe finds connected music artists through Qloo and plays verified recordings with YouTube’s own player. Keep the ones you love in your Sound Passport.",
};

export const viewport: Viewport = {
  themeColor: "#0b0e14",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
