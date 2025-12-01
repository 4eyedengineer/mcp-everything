# Development Guide

Complete guide for developing on MCP Everything.

## Table of Contents
- [Setup](#setup)
- [Running Locally](#running-locally)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Code Quality](#code-quality)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)

## Setup

### Prerequisites

- **Node.js**: 20.19+ (required for Angular 20)
- **npm**: 10.0+
- **PostgreSQL**: 13+ (with database created)
- **Docker**: Latest version (for building MCP servers)
- **Git**: For version control

### Initial Setup

```bash
# Clone repository
git clone https://github.com/4eyedengineer/mcp-everything.git
cd mcp-everything

# Install all dependencies (monorepo)
npm install

# Copy environment template
cp .env.example .env
```

### Environment Configuration

Edit `.env` with your configuration:

```bash
#===========================================
# Required API Keys
#===========================================
ANTHROPIC_API_KEY=sk-ant-xxx...           # Get from console.anthropic.com
GITHUB_TOKEN=ghp_xxx...                   # Personal Access Token with 'gist' scope

#===========================================
# Database Configuration
#===========================================
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres
DATABASE_NAME=mcp_everything

#===========================================
# Application Settings
#===========================================
NODE_ENV=development
PORT=3000
FRONTEND_URL=http://localhost:4200

#===========================================
# Optional Settings
#===========================================
# Docker
DOCKER_HOST=unix:///var/run/docker.sock

# Performance
CACHE_ENABLED=true
MAX_PARALLEL_OPERATIONS=4

# Logging
LOG_LEVEL=debug
```

### Database Setup

```bash
# Create PostgreSQL database
createdb mcp_everything

# Or using psql
psql -U postgres
CREATE DATABASE mcp_everything;
\q

# Run migrations (automatic on first start)
npm run dev:backend
```

## Running Locally

### Development Mode (Recommended)

```bash
# Terminal 1: Backend with hot reload
npm run dev:backend

# Terminal 2: Frontend with hot reload
npm run dev:frontend

# Application URLs:
# - Frontend: http://localhost:4200
# - Backend API: http://localhost:3000
# - API Docs: http://localhost:3000/api/docs
```

### Docker Compose Mode

```bash
# Start all services (backend, frontend, database)
npm run docker:up

# Stop all services
npm run docker:down

# View logs
docker-compose logs -f
```

### Individual Package Development

```bash
# Backend only
cd packages/backend
npm run start:dev

# Frontend only
cd packages/frontend
npm start

# Shared types (rebuild after changes)
cd packages/shared
npm run build
```

## Project Structure

```
mcp-everything/
├── packages/
│   ├── backend/                    # NestJS API server
│   │   ├── src/
│   │   │   ├── orchestration/     # LangGraph state machine
│   │   │   ├── github/            # GitHub API integration
│   │   │   ├── generation/        # MCP server generation
│   │   │   ├── validation/        # Code validation
│   │   │   └── chat/              # Chat endpoints
│   │   ├── test/                  # Backend tests
│   │   └── package.json
│   │
│   ├── frontend/                   # Angular application
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── features/      # Feature modules
│   │   │   │   │   ├── chat/      # Chat interface
│   │   │   │   │   ├── explore/   # Browse servers
│   │   │   │   │   └── account/   # User settings
│   │   │   │   ├── core/          # Core services
│   │   │   │   └── shared/        # Shared components
│   │   │   ├── assets/            # Static assets
│   │   │   └── environments/      # Environment configs
│   │   └── package.json
│   │
│   └── shared/                     # Shared TypeScript types
│       ├── src/
│       │   ├── types/             # Common types
│       │   └── interfaces/        # Shared interfaces
│       └── package.json
│
├── generated-servers/             # MCP server output directory
├── docker/                        # Docker configurations
│   ├── base-images/              # Base Docker images
│   └── docker-compose.yml        # Service orchestration
│
├── scripts/                       # Build and utility scripts
├── .env.example                  # Environment template
└── package.json                  # Root workspace config
```

## Development Workflow

### Backend Development

#### Creating a New Service

```typescript
// packages/backend/src/my-feature/my-feature.service.ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class MyFeatureService {
  async performAction() {
    // Implementation
  }
}
```

#### Registering in Module

```typescript
// packages/backend/src/my-feature/my-feature.module.ts
import { Module } from '@nestjs/common';
import { MyFeatureService } from './my-feature.service';

@Module({
  providers: [MyFeatureService],
  exports: [MyFeatureService],
})
export class MyFeatureModule {}
```

#### Creating API Endpoints

```typescript
// packages/backend/src/my-feature/my-feature.controller.ts
import { Controller, Get, Post, Body } from '@nestjs/common';
import { MyFeatureService } from './my-feature.service';

@Controller('api/my-feature')
export class MyFeatureController {
  constructor(private readonly service: MyFeatureService) {}

  @Post()
  async create(@Body() data: any) {
    return this.service.performAction();
  }
}
```

### Frontend Development

#### Creating a New Component

```bash
# Generate component using Angular CLI
cd packages/frontend
ng generate component features/my-feature
```

#### Creating a Service

```bash
# Generate service
ng generate service core/services/my-service
```

#### Adding Routes

```typescript
// packages/frontend/src/app/app-routing.module.ts
const routes: Routes = [
  {
    path: 'my-feature',
    loadChildren: () => import('./features/my-feature/my-feature.module')
      .then(m => m.MyFeatureModule)
  }
];
```

### Database Migrations

```bash
# Generate migration
cd packages/backend
npm run migration:generate -- -n MigrationName

# Run migrations
npm run migration:run

# Revert last migration
npm run migration:revert
```

### Adding Dependencies

```bash
# Backend dependency
npm install --workspace=packages/backend <package-name>

# Frontend dependency
npm install --workspace=packages/frontend <package-name>

# Shared dependency
npm install --workspace=packages/shared <package-name>

# Root dependency (affects all packages)
npm install <package-name>
```

## Testing

### Backend Testing

```bash
# Run all backend tests
npm run test:backend

# Watch mode
npm run test:backend:watch

# Coverage report
npm run test:backend:cov

# E2E tests
npm run test:backend:e2e
```

#### Writing Unit Tests

```typescript
// packages/backend/src/my-feature/my-feature.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { MyFeatureService } from './my-feature.service';

describe('MyFeatureService', () => {
  let service: MyFeatureService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MyFeatureService],
    }).compile();

    service = module.get<MyFeatureService>(MyFeatureService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
```

### Frontend Testing

```bash
# Run all frontend tests
npm run test:frontend

# Watch mode
npm run test:frontend:watch

# Coverage report
npm run test:frontend:coverage
```

#### Writing Component Tests

```typescript
// packages/frontend/src/app/features/chat/chat.component.spec.ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChatComponent } from './chat.component';

describe('ChatComponent', () => {
  let component: ChatComponent;
  let fixture: ComponentFixture<ChatComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [ChatComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(ChatComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
```

### Integration Testing

```bash
# Test MCP generation end-to-end
npm run test:mcp-generation

# Test with real repositories
npm run test:github-integration

# Test Docker build pipeline
npm run docker:test
```

## Code Quality

### Linting

```bash
# Lint backend
npm run lint:backend

# Lint frontend
npm run lint:frontend

# Lint and fix
npm run lint:backend -- --fix
npm run lint:frontend -- --fix
```

### Code Formatting

```bash
# Format all code with Prettier
npm run format

# Check formatting without modifying
npm run format:check
```

### Type Checking

```bash
# Check TypeScript types (backend)
cd packages/backend
npm run build

# Check TypeScript types (frontend)
cd packages/frontend
npm run build
```

### Pre-commit Hooks

The project uses Husky for pre-commit hooks:

```bash
# Automatically runs on git commit:
# - Lint staged files
# - Format code
# - Run type checks
```

## Contributing

### Branch Strategy

```bash
# Create feature branch
git checkout -b feature/my-feature

# Create bugfix branch
git checkout -b fix/bug-description

# Create documentation branch
git checkout -b docs/update-readme
```

### Commit Convention

Follow conventional commits:

```bash
# Format: <type>(<scope>): <description>

# Examples:
git commit -m "feat(chat): add message streaming support"
git commit -m "fix(backend): resolve database connection timeout"
git commit -m "docs(readme): update installation instructions"
git commit -m "refactor(frontend): simplify chat component logic"
git commit -m "test(generation): add integration tests"
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Build process or auxiliary tool changes

### Pull Request Process

1. **Update from main**
   ```bash
   git checkout main
   git pull origin main
   git checkout your-branch
   git rebase main
   ```

2. **Ensure all tests pass**
   ```bash
   npm test
   npm run lint
   npm run build
   ```

3. **Create Pull Request**
   - Provide clear description
   - Reference related issues
   - Add screenshots for UI changes
   - Request review from maintainers

4. **Address Review Comments**
   - Make requested changes
   - Push updates to same branch
   - Re-request review when ready

## Troubleshooting

### Backend Issues

#### Port Already in Use
```bash
# Find process using port 3000
lsof -i :3000

# Kill process
kill -9 <PID>
```

#### Database Connection Issues
```bash
# Check PostgreSQL is running
pg_isready

# Restart PostgreSQL
sudo service postgresql restart

# Check connection
psql -U postgres -d mcp_everything
```

#### API Key Issues
```bash
# Verify API key format
echo $ANTHROPIC_API_KEY | grep "^sk-ant-"

# Test API key
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"claude-3-haiku-20240307","messages":[{"role":"user","content":"test"}],"max_tokens":10}'
```

### Frontend Issues

#### Build Errors
```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install

# Clear Angular cache
npx ng cache clean

# Rebuild
npm run build:frontend
```

#### Module Not Found Errors
```bash
# Verify all feature modules exist
ls packages/frontend/src/app/features/

# Check imports in routing module
# Ensure module paths are correct
```

### Docker Issues

#### Docker Build Failures
```bash
# Clear Docker cache
docker builder prune --all --force

# Rebuild without cache
docker build --no-cache -t image:tag .
```

#### Permission Issues
```bash
# Add user to docker group
sudo usermod -aG docker $USER

# Restart docker daemon
sudo systemctl restart docker
```

### Common Development Issues

#### TypeScript Errors After Dependency Update
```bash
# Rebuild shared types
cd packages/shared
npm run build

# Reinstall dependencies
cd ../..
npm install
```

#### Hot Reload Not Working
```bash
# Backend: Check nodemon config
cat packages/backend/nodemon.json

# Frontend: Clear Angular cache
npx ng cache clean

# Restart dev servers
```

## Development Best Practices

### Code Organization
- Keep components focused and single-purpose
- Use services for business logic
- Prefer composition over inheritance
- Follow NestJS and Angular style guides

### Performance
- Use lazy loading for feature modules
- Implement caching where appropriate
- Optimize database queries
- Monitor bundle sizes

### Security
- Never commit API keys or secrets
- Validate all user inputs
- Use parameterized database queries
- Keep dependencies updated

### Documentation
- Document complex logic with comments
- Update README when adding features
- Keep API documentation current
- Write meaningful commit messages

## Resources

- [NestJS Documentation](https://docs.nestjs.com/)
- [Angular Documentation](https://angular.io/docs)
- [LangGraph Documentation](https://langchain-ai.github.io/langgraph/)
- [TypeORM Documentation](https://typeorm.io/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)

## Getting Help

- Check existing issues: https://github.com/4eyedengineer/mcp-everything/issues
- Ask questions in discussions
- Review documentation files in the repository
- Contact maintainers for urgent issues
