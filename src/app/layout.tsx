import type { Metadata, Viewport } from "next";
import { Instrument_Sans, Instrument_Serif } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import "./sound-passport.css";

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif", display: "swap" });
const sans = Instrument_Sans({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "TasteProbe · Sound Passport — discover music beyond your world",
  description:
    "Start with something you love. Hear something you never knew you would love. TasteProbe connects a film you love to music artists through Qloo and plays verified recordings through YouTube, so you can keep what moves you in your Sound Passport.",
};

export const viewport: Viewport = {
  themeColor: "#14110e",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
