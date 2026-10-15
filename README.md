# Computer Science 343 Project 2 - Group 61

A hackathon platform. Users sign up, join **groups** (one per event), form **teams**, and solve the group's **problems** together in a shared, live-synced Python editor. Code runs in a locked-down Docker sandbox.

- **Backend** (`server/`): Node.js, Express, Prisma (SQLite), WebSockets (`ws`)
- **Frontend** (`client/`): React 18, Vite, React Router

## Prerequisites

Install these before you start:

| Tool                                                                                                                                                                 | Version           | Check with       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------- |
| [Node.js](https://nodejs.org/) (includes npm)                                                                                                                        | **22.9 or newer** | `node --version` |
| [Git](https://git-scm.com/)                                                                                                                                          | any recent        | `git --version`  |
| Docker: [Docker Desktop](https://www.docker.com/products/docker-desktop/), [Rancher Desktop](https://rancherdesktop.io/) (dockerd engine), or Docker Engine on Linux | any recent        | `docker info`    |

Docker is only needed to **run Python code**. Without it you can still work on the UI (see [Working without Docker](#working-without-docker)).

## First-time setup

```bash
git clone git@git.cs.sun.ac.za:Computer-Science/rw334/2026/projects/project-2/group-61-rw343-project-2.git
cd group-61-rw343-project-2
npm run install:all
npm run dev
```

Then open **http://localhost:3000**.

`npm run install:all` does everything, in this order:

1. Installs dependencies for the root (tooling), `server/` and `client/`.
2. Creates `server/.env` from `server/.env.example` and replaces the example `JWT_SECRET` with a random one.
3. Generates the Prisma client and creates the SQLite database at `server/prisma/dev.db` (`prisma db push`).
4. Checks Docker: starts the daemon if it can, pulls `python:3.12-slim`, and runs a test script in the sandbox.

If step 4 fails, start Docker Desktop or Rancher Desktop yourself and run `npm run docker:setup`.

### Trying it out

1. Register an account on the sign-in page.
2. **Groups**: create a group. You become its admin.
3. As admin, invite other users by **username**. They accept on their own Groups page.
4. Members create a **team** in the group and invite other members to it.
5. Admin adds **problems** and test cases, adjusts the settings, then presses **Start event**.
6. **Coding**: pick your team. Everyone in the team edits the same files live, and **Run Python** executes `main.py` in the sandbox.

To test with two users on one machine, keep `npm run dev` running and open a second client in another terminal:

```bash
npm run dev -- 1
```

That client runs on http://localhost:3001 and shares the backend on port 5000. Use a private window, or a second browser, for the second user, since sign-in is stored per browser. `npm run dev -- 1 --full` gives that client its own backend on port 5001 (separate rooms and separate in-memory state, same database).

## Everyday use

```bash
npm run dev
```

This starts the backend (http://localhost:5000) and the client (http://localhost:3000). Press Ctrl+C to stop both.

### Scripts (run from the project root)

| Command                             | What it does                                                         |
| ----------------------------------- | -------------------------------------------------------------------- |
| `npm run install:all`               | First-time setup (see above). Safe to re-run.                        |
| `npm run dev`                       | Docker check, then backend and client.                               |
| `npm run dev:server`                | Backend only (port from `server/.env`).                              |
| `npm run dev:client`                | Client only.                                                         |
| `npm test`                          | Server unit tests. Sandbox tests are skipped when Docker is off.     |
| `npm run docker:check`              | Verify Docker only (doesn't start or pull anything).                 |
| `npm run docker:setup`              | Start Docker if possible, pull the image, test the sandbox.          |
| `npm run setup:backend`             | Recreate `.env` if missing, regenerate Prisma and sync the database. |
| `npm run format`                    | Format everything with Prettier (`format:check` to only check).      |
| `npm run db:studio --prefix server` | Browse the database in Prisma Studio.                                |

A pre-commit hook (Husky + lint-staged) runs Prettier and ESLint on staged files.

### Configuration (`server/.env`)

| Variable                    | Default         | Meaning                                                                                           |
| --------------------------- | --------------- | ------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | `file:./dev.db` | SQLite file, relative to `server/prisma/`.                                                        |
| `JWT_SECRET`                | random          | Signs sign-in tokens. Required: the server refuses to start without it.                           |
| `PORT`                      | `5000`          | Backend port. `npm run dev` overrides it. The client proxies to `API_PORT` (default 5000).        |
| `ENABLE_PYTHON_EXECUTION`   | `true`          | Lets the editor's **Run Python** (and `POST /api/execute`) use the Docker sandbox.                |
| `ENABLE_SUBMISSION_GRADING` | `false`         | Enables `POST /api/submit` (grading against the problem's test cases). The UI doesn't use it yet. |
| `SANDBOX_CONCURRENCY`       | number of CPUs  | Optional. Most sandbox containers allowed to run at once.                                         |

Ports are fixed in `scripts/dev.mjs` (backend 5000, client 3000). If you need different ones, for example because macOS uses port 5000 for AirPlay, change `BASE_SERVER_PORT` there **and** `PORT` in your `server/.env`. Keep that change local and don't commit it.

### Database

There are no migration files. The schema in `server/prisma/schema.prisma` is applied with `prisma db push`.

- After pulling schema changes: `npm run setup:backend`
- To start over with an empty database: stop the server, delete `server/prisma/dev.db`, then run `npm run setup:backend`.

## Docker sandbox

Every run starts a fresh `python:3.12-slim` container with these limits:

- no network, 128 MB memory (no swap), half a CPU, 64 processes
- read-only file system, no Linux capabilities, runs as user `nobody`
- the code mounted read-only at `/app`
- the time limit is enforced inside the container, and output is capped at 64 KB per stream

Containers are removed after each run. Any left behind by a crash or restart are removed when the server next starts. You can list them with `docker ps -a --filter label=cs343-sandbox`.

### Working without Docker

Set `SKIP_DOCKER_CHECK=1` to skip the Docker check:

- PowerShell: `$env:SKIP_DOCKER_CHECK=1; npm run dev`
- bash: `SKIP_DOCKER_CHECK=1 npm run dev`

Everything works except running code.

## Troubleshooting

| Problem                                               | Fix                                                                                                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every request fails with "Could not reach the server" | The backend isn't running, or isn't on the port the client proxies to. Use `npm run dev`, or make `PORT` in `server/.env` match `API_PORT` (default 5000). |
| `EADDRINUSE` (port already in use)                    | Another copy is still running. Stop it, or find it with `netstat -ano \| findstr :5000` (Windows) or `lsof -i :5000` (macOS/Linux).                        |
| `JWT_SECRET is not set`                               | Run `npm run setup:backend`, or add `JWT_SECRET=<long random string>` to `server/.env`.                                                                    |
| `[docker] Docker daemon is not running`               | Start Docker Desktop or Rancher Desktop, then run `npm run docker:setup`.                                                                                  |
| Prisma `EPERM` on Windows during setup                | The server is still running and holding the Prisma engine. Stop it and re-run `npm run setup:backend`.                                                     |
| Editor says "You are not in a team yet"               | Create or join a team on the group's page first. Editor rooms are per team.                                                                                |
| Editor disconnected after a backend restart           | Reload the page. Room contents live in memory and are reset when the backend restarts.                                                                     |

## Project layout

```
client/                 React app (Vite)
  src/auth/             sign-in state, protected routes
  src/components/       CodeEditor, FileTree, ProblemsPanel, GroupMembers, ...
  src/pages/            Login, Home, Groups, Group pages
server/                 Express + WebSocket backend
  routes/               REST API: auth, groups, problems, teams, leaderboards
  lib/                  sessions, passwords, event timing, text operations (shared with the client)
  execution/            Docker sandbox
  evaluation/           grading a submitted codebase against test cases
  submission/           submission eligibility, reservation and results
  prisma/schema.prisma  database schema
scripts/                dev runner, Docker check, .env setup
```

The scripts in `server/submission/test*.js` are manual checks that write to the real database (and `testSubmissionHttp.js` needs a running server). Run them with `node --env-file=.env submission/<file>.js` from `server/`.

## AI Usage

- Assistance with Navbar component
- Gemini was used for assistance in the debugging process during project creation
- Generative AI was used to help initialise the project (installing relevant packages and helping initilise project correctly)
- Generative AI used to help set-up ESLint, Husky and Prettier for ensuring code functionality, quality and formatting
- Generative AI was used to aid in the debugging of the 30-minute timeout logic and the calculation of the sessions(how long a user was active or logged on)
- The sign in animation fade in and out was debugged using Generative AI
- ChatGPT was used to assist with planning, implementation guidance, debugging, documentation and testing of the file tree, Python execution, test evaluation, submission processing, response area and submission timeline. AI-assisted suggestions were reviewed, adapted and tested before being committed.
- Claude was used for assistance with development and implementation of synced code editor (such that changes made by one person are reflected on the other persons side (using websockets))
- Claude was used to audit the codebase after merging and to fix integration issues (team routes, editor rooms, WebSocket safety, Docker sandbox, submission checks, duplicate UI) and to rewrite this README's setup instructions
