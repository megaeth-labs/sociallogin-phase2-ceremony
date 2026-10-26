import type { Metadata } from "next";
import localFont from "next/font/local";

import "./globals.css";
import styles from "./layout.module.css";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Providers } from "./providers";

// Use the same self-hosted family as the MOSS Wallet design system.
const walletFont = localFont({
  src: [
    { path: "./fonts/HelveticaNeue-Light.otf", weight: "300", style: "normal" },
    { path: "./fonts/HelveticaNeue-Roman.otf", weight: "400", style: "normal" },
    { path: "./fonts/HelveticaNeue-Medium.otf", weight: "500", style: "normal" },
    { path: "./fonts/HelveticaNeue-Bold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-wallet",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MOSS social login ceremony",
  description:
    "Add your randomness to the trusted setup behind MOSS’s ZK-powered social login.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={walletFont.variable}>
      <body
        className={styles.body}
      >
        <Providers>
          <ErrorBoundary>{children}</ErrorBoundary>
        </Providers>
      </body>
    </html>
  );
}
