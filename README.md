# QFL Extension Finder

Extension-number search for Quality Feeds Limited.
Plain JavaScript only — no login for staff, no database, **no npm packages at all**.
The phone list lives in `data.json`, the settings in `config.json`.

---

## 1. How to run

1. Install Node.js (version 14 or newer) from https://nodejs.org
2. Open a terminal / command prompt in this folder
3. Run:

```
node server.js
```

4. Open **http://localhost:6000**

Stop it with `Ctrl + C`.

### For the whole office

Run `node server.js` on one PC, find that PC's IP address (`ipconfig` on
Windows), and everyone else opens `http://THAT-IP:6000`. They all see the
same list.

---

## 2. Two modes

**Normal — what everyone sees.** Search only. No Add, Edit or Delete buttons
anywhere, so the list cannot be changed by accident.

| Action | How |
|---|---|
| Search | Type part of a name, extension, designation or department. Press `/` to jump to the search box. |
| Filter | Pick a department from the dropdown. |
| Copy a number | Click the green extension number. |

**Admin — only the person who manages the list.** Click **Admin** at the
top-right and enter the password. The Add / Edit / Delete buttons appear.
Click **Log out** when finished.

The first password is **`1234`** — change it right away from
**Admin → Change password**.

---

## 3. The password is encrypted

The password is **never stored anywhere in readable form**. The first time the
server starts it is converted with **scrypt** (the algorithm Node.js provides
for exactly this) plus a random salt, and only that result is written into
`config.json`:

```json
"adminPassword": {
  "algo": "scrypt",
  "salt": "6c573c3f90a5772b...",
  "hash": "b3547346109db56a...",
  "changedAt": "2026-08-25T04:57:13.773Z"
}
```

A hash cannot be turned back into the password. Anyone who opens `config.json`
— or copies the whole folder — still cannot log in.

Other protections:

- `config.json` and `otp.log` cannot be downloaded through the browser (403).
- Logging in gives a temporary token that expires after 8 hours; the password
  is not stored in the browser at all, so closing the tab logs you out.
- Passwords are compared in constant time, so they cannot be guessed by timing.
- Five wrong tries from one computer = a 60-second wait.
- Changing or resetting the password logs out every open admin session.

### Changing the password

**Admin → Change password.** You need the current one. You are logged out
afterwards and log back in with the new password.

---

## 4. Forgot the password (email + OTP)

On the login box click **Forgot password?** → **Send code**. A 6-digit
one-time code is emailed to the address in `config.json`
(`recoveryEmail`). Type the code plus your new password and you're back in.

- The code is valid for **10 minutes** and works **once**.
- Five wrong codes cancels it — request a new one.
- The code itself is not saved anywhere; only a hash of it is kept in memory,
  so restarting the server also cancels it.

### Choosing how the email is sent

Open `config.json` and set `mail.mode` to one of three values.

#### a) `"console"` — no email at all (this is the default)

The code is printed in the black server window and appended to `otp.log`.
Nothing to set up. Use this for testing, or if the PC running the app has no
internet.

#### b) `"gmail"` — Gmail or Google Workspace

```json
"mail": {
  "mode": "gmail",
  "from": "QFL Extension Finder <youraddress@gmail.com>",
  "gmail": { "user": "youraddress@gmail.com", "appPassword": "abcd efgh ijkl mnop" }
}
```

The App Password is **not** your normal Gmail password. Get one at
Google Account → Security → 2-Step Verification (must be on) → App passwords.
Google shows 16 letters; paste them in, spaces are fine.

#### c) `"smtp"` — your own company mail server

```json
"mail": {
  "mode": "smtp",
  "from": "QFL Extension Finder <no-reply@yourcompany.com>",
  "smtp": {
    "host": "mail.yourcompany.com",
    "port": 587,
    "secure": false,
    "user": "no-reply@yourcompany.com",
    "password": "your-mail-password",
    "allowSelfSigned": false
  }
}
```

- Port **587** → `"secure": false` (the connection is still encrypted, via STARTTLS)
- Port **465** → `"secure": true`
- If your mail server uses its own certificate and you get a certificate
  error, set `"allowSelfSigned": true`.

Restart the server after editing `config.json`.

### Last resort

If you lose the password *and* email is not set up: open `config.json`,
delete the whole `"adminPassword"` block, save, and restart. The password
goes back to `1234`.

---

## 5. Files

| File | What it is |
|---|---|
| `server.js` | The server + API. Built-in Node modules only. |
| `mailer.js` | Sends the OTP email. A small SMTP client, also zero packages. |
| `index.html` | The whole user interface (HTML + CSS + JavaScript in one file). |
| `config.json` | Encrypted password, recovery email, mail settings. **Keep private.** |
| `data.json` | Your data — 288 extensions imported from the QFL IP Phone List PDF. |
| `data.backup.json` | Untouched copy of the first import, in case you need to restore. |
| `otp.log` | Only created in `console` mail mode. Safe to delete. |

### Data format

```json
{ "id": 1, "name": "Chairman Sir", "ext": "1001",
  "designation": "Head Office", "department": "DIRECTORS" }
```

---

## 6. API

| Method | URL | Purpose | Login needed |
|---|---|---|---|
| GET | `/api/contacts` | list all | no |
| GET | `/api/contacts/:id` | one record | no |
| POST | `/api/contacts` | create | yes |
| PUT | `/api/contacts/:id` | update | yes |
| DELETE | `/api/contacts/:id` | delete | yes |
| POST | `/api/login` | password in, token out | — |
| POST | `/api/logout` | end the session | — |
| POST | `/api/change-password` | current + new password | yes |
| POST | `/api/forgot` | email a one-time code | — |
| POST | `/api/reset` | code + new password | — |

Requests that change data must carry the header `X-Admin-Token: <token>`.

---

## 7. Notes

- Change the port with `PORT=8080 node server.js`
- Duplicate extension numbers are allowed (a few people appear in two
  departments in the original list) but you get a warning when saving one.
- `data.json` and `config.json` are written to a temp file and then renamed,
  so a crash or power cut cannot corrupt them.
- This is meant for your **office network**. It is not hardened for the open
  internet — don't expose port 6000 to the outside world.
