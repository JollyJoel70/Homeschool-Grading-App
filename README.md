# Homeschool Grading App

A simple, vibrant, offline-first web app to track homeschool grades for multiple students. Everything runs locally in your browser (no servers or external CDNs) and saves to localStorage, with JSON import/export for backups.

## Quick start

1. Open `index.html` in a modern desktop browser (Chrome/Edge recommended).
2. Go to Settings and:
   - Enter the School name (used in the app header and report cards)
   - Choose/Add a School Year and define its 4 Terms (date ranges)
   - Add Students and Subjects
3. Add assignments on the Assignments tab. History filters by month and subject.
4. View charts and report cards on the Reports tab. Use Print to generate a professional black-and-white report card.

## Features

- Students & Subjects management
- School Years with 4 editable Terms (date-based) and year selector
- Assignments: Student, Subject, Total Questions, Total Correct, Date (term auto-set by date)
  - Fast entry: focus returns to Total Questions after adding
  - Edit/Remove from history
- Filters
  - History: Month and Subject
  - Reports: per-student buttons, per-term filter, and a filtered chart by student/subject
- Charts
  - Performance over time (weekly aggregates)
  - Weekday averages
  - Filtered performance (fills card height)
- Report Cards (print)
  - Columns T1–T4 and Year per subject with percent (rounded) and letter grade
  - Overall GPA, Overall Percent, Current Term GPA
  - Clean black & white print layout
- Import/Export JSON (choose location where supported)
- Debug utilities: generate sample data; clear all assignments

## Data storage

Saved under localStorage key `homeschool_grading_v1`.

- `students`: `[{ id, name }]`
- `subjects`: `[{ id, name }]`
- `assignments`: `[{ id, studentId, subjectId, total, correct, date (YYYY-MM-DD), termId }]`
- `years`: `[{ id, name, terms: [{ id, name, start, end }] }]`
- `currentYearId`: the active school year
- `schoolName`: shown in header and on report cards

Use Export JSON to back up; Import JSON to restore (includes years, terms, students, subjects, assignments, and school name).

## Printing

- Reports → Report Cards → select a student → Print
- Opens a print view in a new tab and auto-opens the print dialog.

## Notes

- If charts appear clipped, resize the window or switch tabs to trigger a redraw.
- Changing School Year/Terms updates reports immediately; ensure assignment dates fall within term ranges.
- Clearing assignments does not delete students, subjects, or year/term setup.

## Files

- `index.html` — app markup
- `styles.css` — styles and layout
- `app.js` — state, logic, charts, reports, import/export

## License

MIT
