# Starter Template

A modern full-stack web application template with React 19, Node.js 24.22.3, Express, TypeScript, PostgreSQL 15, and Docker.

## 🚀 Tech Stack

### Frontend
- **React 19** - Latest React with modern features
- **Vite** - Fast build tool and dev server
- **TypeScript** - Type-safe development
- **Tailwind CSS 4** - Utility-first CSS framework
- **shadcn/ui** - Beautiful UI components
- **Vitest** - Fast unit testing

### Backend
- **Node.js 24.22.3+** - JavaScript runtime
- **Express** - Web framework
- **TypeScript** - Type-safe development
- **PostgreSQL 15** - Relational database
- **Jest** - Testing framework
- **Pino** - Fast logger

### DevOps
- **Docker & Docker Compose** - Containerization
- **ESLint** - Code linting
- **Prettier** - Code formatting

## 📁 Project Structure

```
starter-template/
├── backend/                 # Node.js + Express backend
│   ├── src/
│   │   ├── app.ts          # Express app configuration
│   │   ├── index.ts        # Entry point
│   │   ├── config/         # Configuration files
│   │   ├── db/             # Database setup and migrations
│   │   ├── domain/         # Domain models/types
│   │   ├── middleware/     # Express middleware
│   │   ├── routes/         # API route handlers
│   │   ├── services/       # Business logic services
│   │   ├── utils/          # Utility functions
│   │   └── workers/        # Background workers
│   ├── uploads/            # File uploads directory
│   ├── Dockerfile
│   └── package.json
├── frontend/                # React frontend
│   ├── src/
│   │   ├── main.jsx        # React entry point
│   │   ├── App.tsx         # Root component
│   │   ├── components/     # React components
│   │   ├── pages/          # Page components
│   │   ├── lib/            # Utilities and API client
│   │   └── types/          # TypeScript types
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml       # Docker services configuration
├── docker-compose.dev.yml   # Development override
└── docker-compose.prod.yml  # Production override
```

## 🛠️ Setup Instructions

### Prerequisites

- Node.js 24.22.3+ installed (`nvm use` picks it up from `.nvmrc`)
- Docker and Docker Compose installed
- Git installed

### Initial Setup

1. **Clone or navigate to the project directory**

2. **Install root dependencies:**
   ```bash
   npm install
   ```

3. **Copy environment files:**
   ```bash
   cp backend/env.example backend/.env
   cp frontend/env.example frontend/.env
   ```

4. **Install all dependencies:**
   ```bash
   npm run install:all
   ```

5. **Build Docker containers:**
   ```bash
   docker-compose build
   ```

6. **Start development servers:**
   ```bash
   npm run start:dev
   ```

The application will be available at:
- Frontend: http://localhost:3000
- Backend API: http://localhost:5001
- PostgreSQL: localhost:5432

## 📜 Available Scripts

### Root Level

- `npm run start:dev` - Start both frontend and backend in development mode
- `npm run install:all` - Install dependencies for both frontend and backend
- `npm run build` - Build both frontend and backend for production
- `npm run lint` - Lint both frontend and backend
- `npm run test` - Run tests for both frontend and backend
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check code formatting

### Backend

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm run start` - Start production server
- `npm run db:migrate` - Run database migrations
- `npm run test` - Run tests
- `npm run lint` - Lint code

### Frontend

- `npm run dev` - Start Vite development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run test` - Run tests with Vitest
- `npm run lint` - Lint code

## 🐳 Docker Usage

### Development with Docker

```bash
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up
```

### Production with Docker

```bash
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Stop Services

```bash
docker-compose down
```

### View Logs

```bash
docker-compose logs -f [service-name]
```

## 🔧 Environment Variables

### Backend (.env)

```env
PORT=5000
NODE_ENV=development
DATABASE_URL=postgres://user:password@localhost:5432/mydb
FRONTEND_URL=http://localhost:3000
LOG_LEVEL=info
# Mail: central mail service over HTTP (see backend/env.example)
MAILER_URL=http://mailer-<uuid>:3000
MAILER_API_KEY=mk_...
MAIL_BRAND_NAME=TR Fit
```

### Frontend (.env)

```env
VITE_API_URL=http://localhost:5001/api
```

## 🗄️ Database

### Running Migrations

```bash
cd backend
npm run db:migrate
```

### Creating New Migrations

1. Create a new SQL file in `backend/src/db/migrations/`
2. Name it with a sequential number: `002_your_migration_name.sql`
3. Run migrations: `npm run db:migrate`

In production the backend container applies pending migrations on every boot,
using the owner role in `MIGRATION_DATABASE_URL`, before starting the API. Keep
migrations backward compatible (add, don't drop or rename in the same deploy):
the previous container keeps serving while the new one boots.

## 🎨 Adding shadcn/ui Components

This template is configured for shadcn/ui. To add components:

```bash
cd frontend
npx shadcn@latest add [component-name]
```

Example:
```bash
npx shadcn@latest add button
npx shadcn@latest add card
npx shadcn@latest add input
```

## 🧪 Testing

### Frontend Tests

```bash
cd frontend
npm test              # Run tests
npm run test:ui       # Run tests with UI
npm run test:coverage # Run tests with coverage
```

### Backend Tests

```bash
cd backend
npm test              # Run tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage
```

## 📝 Code Quality

### Linting

```bash
npm run lint          # Lint all code
npm run lint:frontend # Lint frontend only
npm run lint:backend  # Lint backend only
```

### Formatting

```bash
npm run format        # Format all code
npm run format:check  # Check formatting without changing files
```

## 🚀 Deployment

Production runs on **Coolify** on a **Hetzner** server (migrated from Railway in
October 2026). Public URL: https://app.tatoroblesfit.com.

- Coolify builds `backend/Dockerfile` and `frontend/Dockerfile` (nginx serving
  the Vite build) straight from the `main` branch of this repo.
- The backend applies pending migrations on boot (see above), so a deploy is
  all a schema change needs.
- Environment variables live in Coolify (resource → Environment Variables).
  `backend/env.example` and `frontend/env.example` list what each one needs.

### Auto-deploy on push to `main`

Every merge to `main` should redeploy both resources. Coolify does that only
when GitHub notifies it. **Connecting the repo as a "Public Repository" does
not notify it**, so pushes do nothing and the site stays on the last manual
deploy. Use one of these, per resource (backend and frontend):

**Option A: GitHub App (recommended)**

1. Coolify → Sources → `+ Add` → GitHub App, then install it on
   `maldonadomatias/tr-fit-web`.
2. In each resource → Configuration → Source, switch to that GitHub App,
   branch `main`.
3. Resource → Configuration → Advanced → turn on **Auto Deploy**.

**Option B: manual webhook (keeps the public-repo source)**

1. Resource → Webhooks → set a **GitHub Webhook Secret** and save. Copy the
   "Manual Git Webhook" URL for GitHub
   (`https://<coolify-host>/webhooks/source/github/events/manual`).
2. GitHub → repo Settings → Webhooks → Add webhook: that URL, content type
   `application/json`, the same secret, event **Just the push event**.
3. Resource → Configuration → Advanced → **Auto Deploy** on.

Do not move the deploy to GitHub Actions: Actions on this account are blocked
by a billing lock (jobs fail in seconds with "account is locked due to a
billing issue"), which is also why the `CI` workflow is disabled.

### Checking what production is running

The frontend bundle name changes on every build. Compare the deployed bundle's
date with the latest merge to `main`:

```bash
curl -s https://app.tatoroblesfit.com | grep -oE 'assets/index-[^"]+\.js'
curl -sI https://app.tatoroblesfit.com/assets/<bundle>.js | grep -i last-modified
```

If it is older than the last merge, open the resource in Coolify →
Deployments: a failed build shows there; no entry at all means the push never
reached Coolify (see auto-deploy above). Press **Redeploy** to ship now.

### Local production build

```bash
npm run build
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

## 📚 Next Steps

1. **Customize Database Schema**
   - Edit `backend/src/db/migrations/001_initial_schema.sql`
   - Add your own tables and indexes

2. **Add API Routes**
   - Create route files in `backend/src/routes/`
   - Register them in `backend/src/app.ts`

3. **Create React Pages**
   - Add page components in `frontend/src/pages/`
   - Set up routing in `frontend/src/App.tsx`

4. **Add shadcn/ui Components**
   - Use `npx shadcn@latest add` to add components
   - Components will be added to `frontend/src/components/ui/`

5. **Implement Authentication** (if needed)
   - Add auth middleware in `backend/src/middleware/`
   - Create auth routes and services

6. **Add Business Logic**
   - Create services in `backend/src/services/`
   - Add domain models in `backend/src/domain/`

## 🤝 Contributing

This is a starter template. Feel free to customize it for your needs!

## 📄 License

MIT

## 🙏 Acknowledgments

- [Vite](https://vitejs.dev/)
- [React](https://react.dev/)
- [shadcn/ui](https://ui.shadcn.com/)
- [Tailwind CSS](https://tailwindcss.com/)
- [Express](https://expressjs.com/)
