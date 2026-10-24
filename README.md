# Tahir Mukhtarov portfolio

A lightweight, responsive portfolio and password-protected editor. It uses Node.js built-ins only.

## Run locally

Requires Node.js 18 or newer.

```sh
npm start
```

Open [http://localhost:3000](http://localhost:3000). The admin editor is at `/admin`.

The local `.env` file contains the admin login configured for this workspace. It is ignored by Git and never sent to the browser. To deploy, set `ADMIN_USERNAME` and `ADMIN_PASSWORD` as server environment variables, and run `npm start` behind HTTPS. Keep the `data/portfolio.json` file writable so editor changes can be saved.

## Pages

- `/` — introduction, selected work, skills, and contact links
- `/about` — profile, background, and working approach
- `/admin` — edit profile, links, skills, and projects

The public pages are available in English, Russian, Azerbaijani, and Turkish. The language menu remembers each visitor's choice. Profile copy and project descriptions can be edited separately for each language in the admin editor.

