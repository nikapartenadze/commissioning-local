import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader } from "@/components/ui/card"

export default function Loading() {
  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header skeleton */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-32" />
        </div>
      </div>

      {/* Chart skeleton */}
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>

      {/* Table skeleton */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-10 w-64" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {/* Table header */}
            <div className="flex gap-4 pb-2 border-b">
              <Skeleton className="h-4 w-[22%]" />
              <Skeleton className="h-4 w-[16%]" />
              <Skeleton className="h-4 w-[10%]" />
              <Skeleton className="h-4 w-[10%]" />
              <Skeleton className="h-4 w-[12%]" />
              <Skeleton className="h-4 w-[22%]" />
              <Skeleton className="h-4 w-[8%]" />
            </div>
            {/* Table rows */}
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="flex gap-4 py-2">
                <Skeleton className="h-4 w-[22%]" />
                <Skeleton className="h-4 w-[16%]" />
                <Skeleton className="h-4 w-[10%]" />
                <Skeleton className="h-4 w-[10%]" />
                <Skeleton className="h-4 w-[12%]" />
                <Skeleton className="h-4 w-[22%]" />
                <Skeleton className="h-4 w-[8%]" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="text-center text-sm text-muted-foreground mt-8">
        Loading project data...
      </div>
    </div>
  )
}

