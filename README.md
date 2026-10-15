# Computer Science 343 Project 2 - Group 61

## Basics

### Installing dependencies

run `npm run install:all` from the project root to install all the required dependencies

### Running the project

## First time setting up

1. After running `npm run install:all`
2. Change JWT_SECRET in .env to a long combination of letters
3. `npm run dev` (on the main root)

## Docker (Python execution)

Python code from the editor and submissions runs in a locked-down Docker container (`python:3.12-slim`), so Docker must be installed (Docker Desktop, Rancher Desktop with the dockerd engine, or Docker Engine on Linux).

- `npm run install:all` runs `npm run docker:setup`, which starts the Docker daemon if it can, pulls the image and runs a test script in the sandbox.
- `npm run dev` runs the same check first and stops with a clear message if Docker is not working.
- `npm run docker:check` only verifies (no starting or pulling); `npm run docker:setup` repairs.
- `ENABLE_PYTHON_EXECUTION=true` in `server/.env` turns execution on; `install:all` adds it to an existing `.env` if missing.
- Frontend-only work without Docker: set `SKIP_DOCKER_CHECK=1`.

## If it is not the first time setup

Using the single root script to run the project you can simply run `npm run dev` from the project root to start the project.

`Accessessing the project:`

- on a browser go to `http://localhost:3000/`

### Project info

Backend: `http://localhost:5001`

Frontend: `http://localhost:3000/`

## AI Usage

- Assistance with Navbar component
- Gemini was used for assistance in the debugging process during project creation
- Generative AI was used to help initialise the project (installing relevant packages and helping initilise project correctly)
- Generative AI used to help set-up ESLint, Husky and Prettier for ensuring code functionality, quality and formatting
- Generative AI was used to aid in the debugging of the 30-minute timeout logic and the calculation of the sessions(how long a user was active or logged on)
- The sign in animation fade in and out was debugged using Generative AI
- ChatGPT was used to assist with planning, implementation guidance, debugging, documentation and testing of the file tree, Python execution, test evaluation, submission processing, response area and submission timeline. AI-assisted suggestions were reviewed, adapted and tested before being committed.
- Claude was used for assistance with development and implementation of synced code editor (such that changes made by one person are reflected on the other persons side (using websockets))
