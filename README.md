# Study Planner

A personal web app for assignments, reminders and grades. It installs on a laptop and a phone, works offline, and keeps all data on the device. It costs nothing to run.

## What it does

- **Quick add:** type `Bio lab report fri 11:59pm 2h 15% #bio` and it picks out the title, due date, hours of work, grade weight and course. A preview line shows what it understood before you press Add.
- **Calendar import:** load the `.ics` file from Moodle, Blackboard or Brightspace. Importing again updates changed dates, skips duplicates, and never overwrites an assignment you edited.
- **Upcoming:** assignments grouped into Overdue, Today, Tomorrow, Next 7 days and Later. Shows a 14-day workload strip (orange marks a heavy day) and "Start by Tue" hints for bigger tasks.
- **Grades:** weighted categories per course, "drop lowest N" per category, the current grade and letter, and "what do I need on the final?".
- **Import files:** a Study Planner import file (`.json` with `"kind": "study-planner-import"`) adds courses, scores and deadlines without wiping what's already on the device. Choose it in Settings → Import, like an `.ics` file.
- **Reminders:** notifications 3 days, 1 day and 3 hours before each deadline (you can change these), plus a morning summary. Optional phone pushes through the free ntfy app.
- **Backup:** export and restore a JSON file. This is also how you move data between devices.

## Run it on this laptop

From the folder that contains `study-planner`:

```bash
py -3.13 -m http.server 5185 --bind 127.0.0.1 --directory study-planner
```

Then open http://localhost:5185 in Chrome or Edge and click the install icon in the address bar. In Claude Code the same server is the `study-planner` entry in `.claude/launch.json`.

## Getting your portal's calendar file

- **Moodle:** Calendar → Import or export calendars → Export calendar → All courses, "Recent and next 60 days" → Export.
- **Blackboard:** Calendar → settings → Share calendar (Ultra), or Get External Calendar Link (Original). Open the link to download the file.
- **Brightspace:** Calendar → Subscribe → all courses. Open the link to download the file.

If a link starts with `webcal://`, change that to `https://`. Keep the link private, because anyone who has it can see your schedule.

## Sync from Brightspace

Settings → Sync from Brightspace has a button you drag to your bookmarks bar. Click that bookmark on any Brightspace page while you're signed in. It reads your current courses, upcoming assignment and quiz due dates (and whether you've already submitted), other dated calendar items, and released grades with their category weights and drop-lowest rules. Then it opens this app in a new tab, and the app asks before adding anything.

- It only reads, using the same API calls Brightspace's own pages make with your signed-in session. Nothing changes in Brightspace.
- The data goes straight from the Brightspace tab to the app tab. No server sits in between.
- Courses are matched by their Brightspace ID, so renaming a course here won't create a duplicate. Grade categories from Brightspace replace that course's categories here. Courses with no released grades keep whatever you typed.
- If the new tab is blocked, the bookmark saves an import file instead. Choose it in Settings → Import.
- The bookmark opens the address it was dragged from. If you host the app somewhere new, drag a fresh one from there.

The script is in `js/brightspace.js`.

## Phone reminders (ntfy)

1. Install **ntfy** on your phone (free, App Store or Google Play).
2. In the app go to Settings → Phone push. Copy your topic and subscribe to it in ntfy.
3. Turn on Phone push and tap "Send a test to my phone".

Each time the app runs, it schedules reminders up to 3 days ahead on ntfy.sh. Topic names there can be read by anyone who knows them, so keep yours random. A reminder that's already scheduled still arrives if you finish early.

## Using it on your phone

A phone can't reach `localhost` on your laptop, so the folder has to be hosted somewhere first. GitHub Pages, Cloudflare Pages and Netlify all host static sites like this one for free. After that, open the link on your phone and add it to your home screen. Each device keeps its own data, so use Export / Restore backup to copy it across.

## Files

| Path | What it is |
|---|---|
| `index.html`, `css/styles.css` | Page shell and styles (light and dark) |
| `js/app.js` | Views, events, import, backup |
| `js/quickadd.js` | Natural-language quick-add parser |
| `js/ics.js` | Calendar (.ics) reader |
| `js/brightspace.js` | Sync from Brightspace bookmarklet |
| `js/grades.js` | Weighted grade and final-exam math |
| `js/reminders.js` | Notifications and ntfy scheduling |
| `js/store.js`, `js/format.js` | Storage and date formatting |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and install metadata |

## Ideas for later

- Sync between phone and laptop without manual backups (a small free Cloudflare Worker)
- Link scores to assignments, so marking one graded fills in the Grades tab
- Focus timer per assignment, to learn how long things really take
