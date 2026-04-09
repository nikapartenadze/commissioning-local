// Next.js Metadata type removed — metadata is set in index.html for Vite
// import { Inter } from "next/font/google"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
// import { AuthProvider } from "@/components/auth-provider"
import { UserProvider } from "@/lib/user-context"
import { Toaster } from "@/components/ui/toaster"
import { ErrorBoundary } from "@/components/error-boundary"

// const inter = Inter({ subsets: ["latin"] })

// Metadata is now in index.html (Vite entry point)
// export const metadata = {
//   title: "IO Checkout Tool - Commissioning",
//   description: "Modern IO Checkout and Testing Platform",
// }

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans">
        <ErrorBoundary>
          <UserProvider>
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              disableTransitionOnChange
              storageKey="io-checkout-theme"
            >
              {children}
              <Toaster />
            </ThemeProvider>
          </UserProvider>
        </ErrorBoundary>
      </body>
    </html>
  )
}

