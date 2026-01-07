// Authentication disabled for testing purposes
// import NextAuth from "next-auth"
// import { authOptions } from "@/lib/auth"

// const handler = NextAuth(authOptions)
// export { handler as GET, handler as POST }

// Dummy handlers to prevent 404 errors
export async function GET() {
  return new Response("Authentication disabled for testing", { status: 200 })
}

export async function POST() {
  return new Response("Authentication disabled for testing", { status: 200 })
}

