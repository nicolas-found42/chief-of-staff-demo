# Set up Chief of Staff

This guide takes you from nothing to a working app. It takes about 20 minutes. Most of that time
is Google's setup, which the app itself walks you through.

You do not need to know Docker, and you do not need to install Node or anything else. Docker
Desktop runs the whole app for you.

Work through the steps in order. Do not skip one.

---

## 1. Install Docker Desktop

Docker Desktop runs this app in a self-contained box, so nothing else on your machine has to
change.

1. Go to **https://www.docker.com/products/docker-desktop/**
2. Download the version for your computer. On a Mac, pick **Apple Silicon** for an M1/M2/M3/M4
   Mac, or **Intel chip** for an older one. If you are not sure, click the Apple menu, then
   **About This Mac**, and read the **Chip** line.
3. Open the file you downloaded and install it.

## 2. Start Docker Desktop

Docker Desktop must be **running**, not only installed. This is the step people miss.

1. Open Docker Desktop from your Applications folder.
2. Accept the terms if it asks.
3. Wait. A whale icon appears in your menu bar and animates while Docker starts.
4. **Do not continue until the whale stops moving.** Until then, the next step fails with an
   error about a socket or a daemon.

## 3. Get the code

Open the **Terminal** app. Copy each line below, paste it, and press Return.

```bash
git clone https://github.com/nicolas-found42/chief-of-staff-demo.git
```

```bash
cd chief-of-staff-demo
```

Skip the first line if you already have the folder. Run the second line either way — every
command after this one must run inside that folder.

## 4. Start the app

```bash
docker compose up -d --build
```

The first run takes a few minutes. It prints a lot of text. That is normal.

The `-d` puts the app in the background, so your Terminal comes back to you when it is ready.
When you see your prompt again, the app is running.

## 5. Open the app

Go to **http://localhost:4317** in your browser.

You see the **Runs** page, and a yellow bar saying Google is not connected yet. That is correct
for now. You fix it in step 7.

## 6. Choose an extraction provider

The app sends each transcript to an AI provider to pull out the action items. You need an API key
from one provider.

1. Click **Settings**.
2. Under **Extraction provider**, choose your provider.
3. The page shows a link to that provider's key page. Open it, sign in, and create a key.
4. Paste the key into **Provider API key**.
5. Leave **Model** as it is.
6. Click **Save settings**.

Providers charge for use. Create the key on the account that pays for it.

## 7. Connect Google

The app creates Google Tasks and Gmail drafts, so Google must give it permission. Google requires
each person to register their own credentials for this. There is no shared credential to hand you.

On the same **Settings** page, find the **Google** card. It lists every step, in order, with the
exact values to copy and a link to each Google page. Follow the card, not this guide: it shows the
values for your own machine, and this guide cannot.

Two things to expect:

- **Google shows a warning that says the app is not verified.** This is expected. The app is
  yours, and Google has not reviewed it. Click **Advanced**, then **Go to localhost (unsafe)**.
  It is your own machine, and nothing leaves it.
- **The steps stay on screen until the connection works.** If a step fails, read the message,
  correct that step, and sign in again.

When it works, the card says **Connected** and shows your email address.

If you are unsure whether every step is done, click **Check my setup**. The app asks Google and
names the exact part that is missing.

## 8. Run a transcript

1. Click **Runs**.
2. Drag the file `tests/fixtures/transcripts/sample-transcript.md` from the project folder onto
   the upload area. You can also click the area and pick the file.
3. The run appears in the table. Click it to watch it work.

## 9. Check the result

Open Google and confirm all three:

1. **Google Tasks** has a list called **Meeting Followups** with **three** tasks. Each task has
   its owner in the notes, like `Owner: Priya`.
2. **Gmail Drafts** has **one** draft addressed to Acme procurement. It is a draft. The app
   cannot send mail.
3. Back in the app, the run says **done**.

If you see all three, you are set up.

---

## Every week: sign in to Google again

Google ends this kind of sign-in after about seven days. **This is normal, and nothing is
broken.**

The app tells you before it happens, and the Google card in Settings shows when you last signed
in. When Google asks:

1. Open **Settings**.
2. Click **Sign in with Google**.

That is the whole fix. You do not repeat the setup steps.

## Starting and stopping the app

Run these from the `chief-of-staff-demo` folder.

Stop the app:

```bash
docker compose down
```

Start it again later:

```bash
docker compose up -d
```

Leave out `--build` after the first time. You only need it again when the code changes.

The app does not start by itself when you turn your computer on. Start it when you want it.

## When something is wrong

| What you see | What to do |
|---|---|
| An error about a socket, a daemon, or `docker` not found | Docker Desktop is not running. Go back to step 2 and wait for the whale to stop moving. |
| The browser cannot open http://localhost:4317 | The app is not running. Run `docker compose up -d`, wait a moment, and try again. |
| A run says **failed** at `extract` | The provider key or the model is wrong. Correct it in Settings, then click **Retry** on the run. |
| A run says **failed** at `outputs` | Google is not connected. Open Settings, fix the Google card, then click **Retry** on the run. The app does not charge you twice: it reuses the result it already has. |
| Google refuses the sign-in and names the redirect URI | The value you registered does not match. The Google card shows the exact string to use. Copy it with the Copy button rather than typing it. |
| A run says **skipped** | The app decided the file is not a transcript. It creates nothing. This is correct behaviour, not a fault. |

Anything else: send the person who gave you this repo the run id and what the page says.
