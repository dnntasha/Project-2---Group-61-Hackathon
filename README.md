# Computer Science 343 Project 2 - Group 61

## Basics

### Installing dependencies

run `npm run install:all` from the project root to install all the required dependencies

### Running the project

## First time setting up

1. After running `npm run install:all`
2. `cd server`
3. `cp .env.example .env` and set the JWT_SECRET to a long combination of letters
4. `npx prisma db push`
5. `cd ..`
6. `npm run dev` (on the main root)

## If it is not the first time setup

Using the single root script to run the project you can simply run `npm run dev` from the project root to start the project.

`Accessessing the project:`

- on a browser go to `http://localhost:3000/`

### Project info

Backend: `http://localhost:5000`

Frontend: `http://localhost:3000/`

## AI Usage

- Gemini was used for assistance in the debugging process during project creation
- Generative AI was used to help initialise the project (installing relevant packages and helping initilise project correctly)
- Generative AI used to help set-up ESLint, Husky and Prettier for ensuring code functionality, quality and formatting
