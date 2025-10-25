# Homeschool Grading App

An offline-first web app to track homeschool grades for multiple students. It runs entirely in your browser and saves to localStorage, with optional cloud sync via Supabase and JSON import/export for backups.

## Quick start

1. Open `index.html` in a modern desktop browser (Chrome/Edge recommended).
2. Settings → School Info/Year/Terms/Students/Subjects:
   - Enter the School name (used in the header and report cards)
   - Choose/Add a School Year and define its 4 Terms (date ranges)
   - Add Students and Subjects
3. Add assignments on the Assignments tab. Use month/subject filters in History.
4. Reports tab: view charts and report cards. Use Print to generate a black‑and‑white report card.

Optional (cloud sync):
- In Settings → Account, sign up/sign in with email and password, then use Sync Now to save/load to Supabase.

## Features

- Students & Subjects management
- School Years with 4 editable Terms (date-based) and year selector
- Assignments: Student, Subject, Total Questions, Total Correct, Date (term auto-set by date)
  - Fast entry; edit/remove from history
- Filters
  - History: Month and Subject
  - Reports: per-student quick buttons, per-term filter, filtered chart by subject
- Charts
  - Performance over time (weekly aggregates)
  - Filtered performance chart
- Report Cards (print)
  - Terms T1–T4 and Year per subject with percent (rounded) and letter grade
  - Overall GPA, Overall Percent
  - Clean black & white print layout
- Import/Export JSON
- Debug utilities: generate sample data; clear all assignments

## Data storage (local)

Saved under localStorage key `homeschool_grading_v1`.

- `students`: `[{ id, name }]`
- `subjects`: `[{ id, name }]`
- `assignments`: `[{ id, studentId, subjectId, total, correct, date (YYYY-MM-DD), termId }]`
- `years`: `[{ id, name, terms: [{ id, name, start, end }] }]`
- `currentYearId`: the active school year
- `schoolName`: shown in header and on report cards

Use Export JSON to back up; Import JSON to restore (includes years, terms, students, subjects, assignments, and school name).

## Cloud sync (Supabase)

This is optional. If not configured, the app still works locally.

1) Configure credentials
- In `scripts.js`, set:
  - `SUPABASE_URL = 'https://YOUR-PROJECT-ref.supabase.co'`
  - `SUPABASE_ANON_KEY = 'YOUR-ANON-KEY'`

2) Create table and policies in your Supabase project

```sql
create table if not exists public.homeschool_grading (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  client_updated_at bigint not null
);

alter table public.homeschool_grading enable row level security;

create policy "own_row_read"
on public.homeschool_grading
for select
to authenticated
using (auth.uid() = user_id);

create policy "own_row_write"
on public.homeschool_grading
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "own_row_update"
on public.homeschool_grading
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
```

3) Enable realtime for the table in Database → Replication → Configure.

4) Sign up/sign in in the app (Settings → Account), then click Sync Now.

## Printing

- Reports → Report Cards → select a student → Print (opens a print view and dialog)

## Notes

- If charts appear clipped, resize the window or switch tabs to trigger a redraw.
- Changing School Year/Terms updates reports immediately; ensure assignment dates fall within term ranges.
- Clearing assignments does not delete students, subjects, or year/term setup.

## Files

- `index.html` — app markup (includes Supabase UMD script)
- `styles.css` — styles and layout
- `scripts.js` — state, logic, charts, reports, import/export, Supabase auth/sync

## License

MIT









