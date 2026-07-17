export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui', maxWidth: 1100, margin: '40px auto', padding: 24 }}>
        {children}
      </body>
    </html>
  );
}
