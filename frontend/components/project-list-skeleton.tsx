import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"

export function ProjectListSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {[...Array(6)].map((_, i) => (
        <Card key={i} className="animate-pulse">
          <CardHeader>
            <div className="h-6 bg-muted rounded w-3/4 mb-2"></div>
            <div className="h-4 bg-muted rounded w-1/2"></div>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 mb-4">
              <div className="h-6 bg-muted rounded w-24"></div>
              <div className="h-6 bg-muted rounded w-20"></div>
            </div>
            <div className="h-4 bg-muted rounded w-full"></div>
          </CardContent>
          <CardFooter className="flex-col gap-2">
            <div className="h-10 bg-muted rounded w-full"></div>
            <div className="h-8 bg-muted rounded w-full"></div>
          </CardFooter>
        </Card>
      ))}
    </div>
  )
}

