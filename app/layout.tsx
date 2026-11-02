import type { Metadata } from 'next';
import { Doto, Libre_Franklin } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const franklin = Libre_Franklin({ subsets: ['latin'], variable: '--font-franklin', display: 'swap' });
const doto = Doto({ subsets: ['latin'], weight: ['700', '900'], variable: '--font-doto', display: 'swap' });

export const metadata: Metadata = {
  title: 'Backstop',
  description: 'Get through a cancelled event: refunds, vendors and chargebacks, one signed slip at a time.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${franklin.variable} ${doto.variable}`}>
      <body>{children}</body>
    </html>
  );
}
