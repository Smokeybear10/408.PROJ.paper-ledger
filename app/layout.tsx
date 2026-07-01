import type { Metadata } from "next";
import "@fontsource/instrument-sans/400.css";
import "@fontsource/instrument-sans/500.css";
import "@fontsource/instrument-sans/600.css";
import "@fontsource/instrument-sans/700.css";
import "./globals.css";
import "./workbench.css";

export const metadata: Metadata = {
  title: "Paper Ledger | PayPal Reconciliation",
  description: "Reconcile invoices and PayPal receipts with exact amounts, inspectable evidence, and manual review.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
