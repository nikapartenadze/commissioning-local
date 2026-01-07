import "next-auth"

declare module "next-auth" {
  interface Session {
    groups?: string[]
    isAdmin?: boolean
  }
}

