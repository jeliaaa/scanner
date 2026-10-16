import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scanner",
  description: "Photograph pages, detect their edges, and export a clean compressed PDF.",
};

export const viewport: Viewport = {
  themeColor: "#08090c",
  width: "device-width",
  initialScale: 1,
  // Pinch zoom stays on for accessibility. The corner editor opts out of it
  // locally with touch-action: none, which is the precise tool for that job.
  // Lets the layout pad itself past the notch and home indicator via
  // env(safe-area-inset-*).
  viewportFit: "cover",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
