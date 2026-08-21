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
  // The corner editor uses drag gestures; pinch-zooming the page fights them.
  maximumScale: 1,
  userScalable: false,
  // Lets the sheet pad itself past the home indicator via env(safe-area-inset-*).
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
