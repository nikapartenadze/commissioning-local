#!/bin/bash
# =============================================================================
# IO Checkout Tool - Docker Startup Script
# =============================================================================

set -e

echo ""
echo "  ╔═══════════════════════════════════════════════════════════════╗"
echo "  ║       IO CHECKOUT TOOL - Docker Startup                       ║"
echo "  ╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Change to the docker directory
cd "$SCRIPT_DIR"

# Check if docker and docker-compose are installed
if ! command -v docker &> /dev/null; then
    echo "ERROR: Docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "ERROR: Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Determine which docker compose command to use
if docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
else
    COMPOSE_CMD="docker-compose"
fi

# Parse arguments
BUILD=false
DETACH=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --build|-b)
            BUILD=true
            shift
            ;;
        --detach|-d)
            DETACH=true
            shift
            ;;
        --stop)
            echo "Stopping containers..."
            $COMPOSE_CMD down
            exit 0
            ;;
        --logs)
            $COMPOSE_CMD logs -f
            exit 0
            ;;
        --help|-h)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --build, -b    Force rebuild of containers"
            echo "  --detach, -d   Run in background"
            echo "  --stop         Stop all containers"
            echo "  --logs         Follow container logs"
            echo "  --help, -h     Show this help"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Build and start
echo "Starting IO Checkout Tool..."
echo ""

COMPOSE_ARGS=""
if [ "$BUILD" = true ]; then
    COMPOSE_ARGS="--build"
fi

if [ "$DETACH" = true ]; then
    $COMPOSE_CMD up $COMPOSE_ARGS -d

    echo ""
    echo "  ╔═══════════════════════════════════════════════════════════════╗"
    echo "  ║                    CONTAINERS STARTED                         ║"
    echo "  ╠═══════════════════════════════════════════════════════════════╣"
    echo "  ║                                                               ║"
    echo "  ║  Frontend:  http://localhost:3000                             ║"
    echo "  ║  Backend:   http://localhost:5000                             ║"
    echo "  ║  API Docs:  http://localhost:5000/api/status                  ║"
    echo "  ║                                                               ║"
    echo "  ║  Use '$0 --logs' to view logs                          ║"
    echo "  ║  Use '$0 --stop' to stop containers                    ║"
    echo "  ║                                                               ║"
    echo "  ╚═══════════════════════════════════════════════════════════════╝"
    echo ""
else
    $COMPOSE_CMD up $COMPOSE_ARGS
fi
