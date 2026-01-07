export function DataGridSkeleton() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20">
      <div className="border-b bg-card/50 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4">
          <div className="h-8 bg-muted rounded w-64 animate-pulse mb-2"></div>
          <div className="h-4 bg-muted rounded w-96 animate-pulse"></div>
        </div>
      </div>
      <div className="container mx-auto px-4 py-8">
        <div className="flex gap-6">
          <div className="w-64 flex-shrink-0 space-y-4">
            <div className="h-32 bg-muted rounded animate-pulse"></div>
            <div className="h-64 bg-muted rounded animate-pulse"></div>
          </div>
          <div className="flex-1">
            <div className="bg-card rounded-lg p-4 space-y-4">
              <div className="h-12 bg-muted rounded animate-pulse"></div>
              {[...Array(12)].map((_, i) => (
                <div key={i} className="h-16 bg-muted rounded animate-pulse"></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

