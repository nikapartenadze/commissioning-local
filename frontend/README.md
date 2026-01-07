# Commissioning Application

IO Checkout Commissioning web application built with Next.js 14, featuring Azure PostgreSQL database and Microsoft Entra ID authentication.

## 📋 Overview

This is a **separate application repository** with its own CI/CD pipeline that:
- Builds the Next.js application
- Creates Docker images
- Pushes to local registry (`registry.lci.ge`)
- Deploys to the Docker host

## 🏗️ Architecture

- **Frontend**: Next.js 14 with App Router
- **Database**: Azure PostgreSQL
- **Authentication**: Microsoft Entra ID (Azure AD)
- **Deployment**: Docker container via GitOps
- **Registry**: Local Docker registry (`registry.lci.ge`)

## 🚀 CI/CD Pipeline

### Drone CI Workflow (`.drone.yml`)

1. **Build & Test** (`build-and-test`)
   - Installs dependencies
   - Runs linting
   - Validates code quality

2. **Build Image** (`build-image`)
   - Creates Docker image with commit SHA tag
   - Tags as `latest`
   - Uses multi-stage Dockerfile

3. **Push to Registry** (`push-image`)
   - Pushes to `registry.lci.ge/commissioning/app`
   - Both SHA and latest tags

4. **Deploy to Server** (`deploy-to-server`)
   - Copies `docker-compose.yml` to server
   - Pulls latest image
   - Restarts application

5. **Health Check** (`health-check`)
   - Verifies application is responding
   - Checks `/api/health` endpoint

## 🔧 Configuration

### Environment Variables

Copy `env.example` to `.env` and configure:

```bash
cp env.example .env
nano .env
```

#### Required Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `DATABASE_URL` | Azure PostgreSQL connection | `postgresql://user:pass@server.postgres.database.azure.com:5432/db?sslmode=require` |
| `AUTH_SECRET` | NextAuth session secret | Generate with `openssl rand -base64 32` |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Azure AD client secret | From Azure Portal |

#### Azure AD Setup

1. **Register Application** in Azure Portal
2. **Redirect URI**: `https://commissioning.lci.ge/api/auth/callback/azure-ad`
3. **Copy credentials** to `.env` file

### Docker Configuration

The application uses a **multi-stage Dockerfile**:
- **Stage 1**: Install dependencies
- **Stage 2**: Build Next.js application
- **Stage 3**: Production runtime

## 🚀 Deployment

### Automatic Deployment (GitOps)

1. **Make changes** to your code
2. **Commit and push** to `main` branch
3. **Drone CI automatically**:
   - Builds new image
   - Pushes to registry
   - Deploys to server

```bash
git add .
git commit -m "Update commissioning app"
git push origin main
```

### Manual Deployment

```bash
# Build and push locally
docker build -t registry.lci.ge/commissioning/app:latest .
docker push registry.lci.ge/commissioning/app:latest

# Deploy on server
ssh adminuser@192.168.5.30
cd /home/adminuser/apps/commissioning
docker compose pull
docker compose up -d
```

## 🔍 Monitoring

### Check Application Status

```bash
# On server
docker ps | grep commissioning
docker compose -f /home/adminuser/apps/commissioning/docker-compose.yml ps
```

### View Logs

```bash
# Application logs
docker logs commissioning-app -f

# Via compose
cd /home/adminuser/apps/commissioning
docker compose logs -f
```

### Health Check

```bash
# Direct health check
curl https://commissioning.lci.ge/api/health

# Should return: {"status":"ok"}
```

## 🐛 Troubleshooting

### Build Fails

**Check Drone CI logs**:
1. Go to https://drone.lci.ge
2. Find your repository
3. Check build logs for errors

**Common issues**:
- **Dependencies**: Check `package.json` for missing packages
- **TypeScript errors**: Run `npm run lint` locally
- **Docker build**: Test locally with `docker build .`

### Deployment Fails

**Check deployment logs**:
```bash
# On server
cd /home/adminuser/apps/commissioning
docker compose logs commissioning-app
```

**Common issues**:
1. **Environment variables**: Verify `.env` file exists on server
2. **Database connection**: Check `DATABASE_URL` is correct
3. **Azure AD**: Verify client secret is not expired

### Application Won't Start

**Check container status**:
```bash
docker ps -a | grep commissioning
```

**Check logs**:
```bash
docker logs commissioning-app
```

**Common causes**:
- Missing environment variables
- Database connection issues
- Azure AD authentication problems

### Health Check Fails

**Test endpoints**:
```bash
# Health endpoint
curl http://localhost:3000/api/health

# Main page
curl http://localhost:3000
```

**Check if app is ready**:
```bash
# Wait for startup
docker logs commissioning-app | grep "Ready"
```

## 🔄 Development Workflow

### Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run linting
npm run lint

# Build for production
npm run build
```

### Testing Changes

1. **Test locally**:
   ```bash
   npm run dev
   # Test at http://localhost:3000
   ```

2. **Build and test Docker image**:
   ```bash
   docker build -t commissioning-test .
   docker run -p 3000:3000 commissioning-test
   ```

3. **Push to staging** (if you have staging environment)

4. **Deploy to production**:
   ```bash
   git push origin main
   ```

## 📊 Application Structure

```
commissioning/
├── app/                    # Next.js App Router pages
│   ├── api/               # API routes
│   ├── auth/              # Authentication pages
│   └── project/           # Project management pages
├── components/            # React components
├── lib/                   # Utility libraries
├── prisma/                # Database schema
├── types/                 # TypeScript type definitions
├── Dockerfile             # Multi-stage build
├── docker-compose.yml     # Production deployment
├── .drone.yml            # CI/CD pipeline
└── env.example           # Environment template
```

## 🔗 Related Services

- **Infrastructure Repository**: Contains Docker Compose configs for services
- **Docker Registry**: Stores built images (`registry.lci.ge`)
- **Nginx Proxy Manager**: Provides HTTPS access
- **Azure PostgreSQL**: Database backend
- **Azure AD**: Authentication provider

## 📚 Access URLs

- **Application**: https://commissioning.lci.ge
- **Drone CI**: https://drone.lci.ge (view builds)
- **Docker Registry**: https://registry.lci.ge (view images)

## 🔧 Maintenance

### Update Dependencies

```bash
# Update npm packages
npm update

# Test locally
npm run dev

# Commit and push
git add package*.json
git commit -m "Update dependencies"
git push origin main
```

### Database Migrations

```bash
# Generate migration
npx prisma migrate dev --name migration_name

# Apply to production (via deployment)
git push origin main
```

### Backup Application Data

```bash
# Backup volumes on server
docker run --rm \
  -v commissioning_uploads:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/commissioning-backup.tar.gz -C /data .
```

---

**Quick Reference**:
```bash
# Local development
npm run dev

# Build and test
docker build -t commissioning-test .
docker run -p 3000:3000 commissioning-test

# Deploy
git push origin main

# Check status
curl https://commissioning.lci.ge/api/health

# View logs
ssh adminuser@192.168.5.30 "docker logs commissioning-app -f"
```