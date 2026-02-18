# Multi-stage Dockerfile for .NET backend with libplctag
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

# Copy solution and project files
COPY backend/*.csproj backend/
COPY Shared.Library/*.csproj Shared.Library/
RUN dotnet restore backend/*.csproj

# Copy source and build
COPY backend/ backend/
COPY Shared.Library/ Shared.Library/
RUN dotnet publish backend/*.csproj -c Release -o /app/publish --no-restore

# Production runtime
FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS runtime
WORKDIR /app

# Install libplctag for Linux (PLC communication)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates unzip \
    && LIBPLCTAG_VERSION="2.6.3" \
    && curl -sL "https://github.com/libplctag/libplctag/releases/download/v${LIBPLCTAG_VERSION}/libplctag_${LIBPLCTAG_VERSION}_ubuntu_x64.zip" -o /tmp/libplctag.zip \
    && unzip -q /tmp/libplctag.zip -d /tmp/libplctag \
    && find /tmp/libplctag -name "libplctag.so" -exec cp {} /app/ \; \
    && rm -rf /tmp/libplctag* \
    && apt-get remove -y unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Copy published app
COPY --from=build /app/publish .

# Copy config template
COPY backend/config.json.template ./config.json.template

# Create data directory for persistent storage
RUN mkdir -p /data/logs && chmod 777 /data

ENV ASPNETCORE_URLS=http://+:5000
ENV DATA_DIR=/data
ENV ASPNETCORE_ENVIRONMENT=Production

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -sf http://localhost:5000/api/status || exit 1

ENTRYPOINT ["dotnet", "IO Checkout Tool.dll", "--allow-multiple-instances"]
