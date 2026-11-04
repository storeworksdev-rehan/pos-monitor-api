import './globals.css';

export const metadata = {
  title: 'POS Fleet Monitor',
  description: 'Live health of every POS machine: system metrics, POS application, SQL connectivity and errors.',
};

export const viewport = {
  themeColor: '#05070d',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
