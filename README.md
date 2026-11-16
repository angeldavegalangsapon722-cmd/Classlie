# Classlie

Classlie is a classroom and study management web app. It brings class schedules, tasks, attendance, notes, quizzes, and study tools together in one workspace.

## Features

- Manage classes, subjects, schedules, and tasks
- Track attendance
- Create and share notes and reviewers
- Use AI tools for study materials (optional)
- Receive web push notifications (optional)

## Requirements

- Node.js 18 or newer
- PostgreSQL 13 or newer

## Run locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env`. Set `DATABASE_URL` to your PostgreSQL database, replace the example `JWT_SECRET` with a random secret of at least 32 characters, and set `APP_URL` to the app’s URL. For local development, use `http://localhost:3000`.
3. Generate a secret with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. Create or update the database schema:
   ```bash
   npm run db:setup
   ```
5. Start the app:
   ```bash
   npm start
   ```
6. Open `http://localhost:3000`. For development with automatic restarts, run `npm run dev`.

## Optional services

- Set `GEMINI_API_KEY` to enable AI study tools.
- Configure SMTP or `RESEND_API_KEY` to send password reset emails.
- Set the VAPID variables to enable web push notifications.
- See `.env.example` for all configuration options.

## Tests

The test suite requires a separate PostgreSQL test database. Set `TEST_DATABASE_URL` to a throwaway database, then run:

```bash
npm test
```
