import type { Metadata } from "next"
// import { Inter } from "next/font/google"
import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
// import { AuthProvider } from "@/components/auth-provider"
import { UserProvider } from "@/lib/user-context"
import { Toaster } from "@/components/ui/toaster"

// const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "IO Checkout Tool - Commissioning",
  description: "Modern IO Checkout and Testing Platform",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans">
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
      </body>
    </html>
  )
}

