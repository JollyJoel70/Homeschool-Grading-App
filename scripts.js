(function () {
  const STORAGE_KEY = "homeschool_grading_v1";
  // Supabase configuration (fill with your project's values)
  const SUPABASE_URL = 'YOUR_SUPABASE_URL';
  const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
  let supabaseClient = null;
  let supabaseReady = false;
  let supabaseChannel = null;
  let currentUserId = null;
  let isApplyingRemote = false;

  const defaultTerms = () => {
    const year = new Date().getFullYear();
    return [
      { id: cryptoRandomId(), name: "Term 1", start: `${year}-08-01`, end: `${year}-10-15` },
      { id: cryptoRandomId(), name: "Term 2", start: `${year}-10-16`, end: `${year}-12-31` },
      { id: cryptoRandomId(), name: "Term 3", start: `${year + 1}-01-01`, end: `${year + 1}-03-15` },
      { id: cryptoRandomId(), name: "Term 4", start: `${year + 1}-03-16`, end: `${year + 1}-06-01` },
    ];
  };

  function cryptoRandomId() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  }

  function todayStr() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {
        students: [], subjects: [], assignments: [], terms: defaultTerms(), years: [], currentYearId: undefined, schoolName: 'Homeschool Grading Calculator'
      };
      const parsed = JSON.parse(raw);
      parsed.terms = (parsed.terms && parsed.terms.length === 4) ? parsed.terms : defaultTerms();
      if (!parsed.schoolName) parsed.schoolName = 'Homeschool Grading Calculator';
      return parsed;
    } catch (e) {
      console.error(e);
      return { students: [], subjects: [], assignments: [], terms: defaultTerms(), years: [], currentYearId: undefined, schoolName: 'Homeschool Grading Calculator' };
    }
  }

  function saveState() {
    try { state._updatedAt = Date.now(); } catch (_) { }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (supabaseClient && supabaseReady && !isApplyingRemote) {
      uploadState().catch(() => { /* ignore */ });
    }
    setStatus("Saved");
  }

  function supabaseConfigLooksValid(url, key) {
    if (!url || !key) return false;
    if (/^YOUR_/i.test(url) || /^YOUR_/i.test(key)) return false;
    if (typeof window !== 'undefined' && (!window.supabase || !window.supabase.createClient)) return false;
    return true;
  }

  async function initSupabaseSync() {
    try {
      const btn = document.getElementById('sync-now-btn');
      if (!supabaseConfigLooksValid(SUPABASE_URL, SUPABASE_ANON_KEY)) {
        if (btn) btn.disabled = true;
        return;
      }
      if (supabaseReady && supabaseClient) return;
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      supabaseReady = true;
      if (btn) btn.disabled = false;
      // Initialize auth listener and attempt to restore session
      const { data: { subscription } } = supabaseClient.auth.onAuthStateChange(async (_event, session) => {
        currentUserId = session && session.user ? session.user.id : null;
        updateAuthUi(session);
        await setupDataSyncForUser();
      });
      // Restore session on load
      const { data: sessionData } = await supabaseClient.auth.getSession();
      currentUserId = sessionData && sessionData.session && sessionData.session.user ? sessionData.session.user.id : null;
      updateAuthUi(sessionData ? sessionData.session : null);
      await setupDataSyncForUser();
    } catch (e) {
      console.error(e);
      setStatus('Cloud sync unavailable');
    }
  }

  async function setupDataSyncForUser() {
    // Clear previous channel
    try { if (supabaseChannel) { await supabaseClient.removeChannel(supabaseChannel); supabaseChannel = null; } } catch (_) { }
    if (!currentUserId) { return; }
    // Fetch existing state for this user
    const { data, error } = await supabaseClient
      .from('homeschool_grading')
      .select('state, client_updated_at')
      .eq('user_id', currentUserId)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') { console.error(error); }
    if (data && data.state) {
      const remoteAt = Number(data.client_updated_at || 0);
      const localAt = Number(state && state._updatedAt || 0);
      if (remoteAt > localAt) {
        isApplyingRemote = true;
        state = data.state;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        syncAllUI();
        isApplyingRemote = false;
        setStatus('Synced from cloud');
      }
    }
    // Subscribe to realtime updates for this user
    try {
      supabaseChannel = supabaseClient.channel('public:homeschool_grading_user')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'homeschool_grading', filter: `user_id=eq.${currentUserId}` }, (payload) => {
          try {
            const row = payload.new || payload.record || {};
            const remoteState = row.state;
            const remoteAt = Number(row.client_updated_at || 0);
            const localAt = Number(state && state._updatedAt || 0);
            if (!remoteState) return;
            if (remoteAt > localAt) {
              isApplyingRemote = true;
              state = remoteState;
              localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
              syncAllUI();
              isApplyingRemote = false;
              setStatus('Synced from cloud');
            }
          } catch (e) { console.error(e); }
        })
        .subscribe();
    } catch (e) { console.error(e); }
  }

  async function uploadState(force) {
    if (!supabaseClient || !currentUserId || !state) return;
    const payload = {
      user_id: currentUserId,
      state,
      client_updated_at: Number(state._updatedAt || Date.now())
    };
    const { error } = await supabaseClient
      .from('homeschool_grading')
      .upsert(payload, { onConflict: 'user_id' });
    if (error) { console.error(error); setStatus('Sync failed'); return; }
    setStatus('Synced');
  }

  let state = loadState();

  // DOM refs
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-panel');
  const statusText = document.getElementById('status-text');

  // settings: students/subjects
  const studentForm = document.getElementById('student-form');
  const studentNameInput = document.getElementById('student-name');
  const studentsList = document.getElementById('students-list');

  const subjectForm = document.getElementById('subject-form');
  const subjectNameInput = document.getElementById('subject-name');
  const subjectsList = document.getElementById('subjects-list');

  // assignment form
  const assignmentForm = document.getElementById('assignment-form');
  const asgStudent = document.getElementById('assignment-student');
  const asgSubject = document.getElementById('assignment-subject');
  const asgTotal = document.getElementById('assignment-total');
  const asgCorrect = document.getElementById('assignment-correct');
  const asgDate = document.getElementById('assignment-date');
  const asgPercent = document.getElementById('assignment-percent');
  // term select removed; compute from date
  const assignmentsTableBody = document.querySelector('#assignments-table tbody');
  const assignmentsStudentFilter = document.getElementById('assignments-student-filter');
  const assignmentsMonthFilter = document.getElementById('assignments-month-filter');
  const assignmentsSubjectFilter = document.getElementById('assignments-subject-filter');
  const assignmentsPageSize = document.getElementById('assignments-page-size');
  const assignmentsPager = document.getElementById('assignments-pager');
  if (state.assignmentsPageSize == null) state.assignmentsPageSize = 10;

  // terms
  const termsForm = document.getElementById('terms-form');
  const resetTermsBtn = document.getElementById('reset-terms');
  const saveTermsBtn = document.getElementById('save-terms');
  const autoGenTermsBtn = document.getElementById('auto-generate-terms');
  const yearSelect = document.getElementById('year-select');
  const addYearBtn = document.getElementById('add-year-btn');

  // export/import
  const importBtn = document.getElementById('import-btn');
  const hiddenFileInput = document.getElementById('hidden-file-input');
  const exportExcelBtn = document.getElementById('export-excel-btn');
  // new data card buttons
  const saveBtn = document.getElementById('save-btn');
  const debugImportBtn = document.getElementById('debug-import-btn');
  const resetBtn = document.getElementById('reset-btn');
  const backfillTermsBtn = document.getElementById('backfill-terms-btn');
  const syncNowBtn = document.getElementById('sync-now-btn');

  // reports
  const scoresCanvas = document.getElementById('scores-chart');
  const studentFilters = document.getElementById('student-filters');
  const termFilter = document.getElementById('term-filter');
  const filteredChartCanvas = document.getElementById('filtered-chart');
  // removed: filterStudentSelect
  const filterSubjectSelect = document.getElementById('filter-subject');
  const appSchoolNameEl = document.getElementById('app-school-name');
  const schoolForm = document.getElementById('school-form');
  const schoolNameInput = document.getElementById('school-name-input');
  // removed: reportStudentSelect
  const reportCardContent = document.getElementById('report-card-content');
  const printReportBtn = document.getElementById('print-report');
  // student nav below performance card
  const studentPrevBtn = document.getElementById('student-prev');
  const studentNextBtn = document.getElementById('student-next');
  const studentCurrentLabel = document.getElementById('student-current');
  const filteredCardEl = document.getElementById('filtered-card');
  // debug/clear
  const debugGenerateBtn = document.getElementById('debug-generate-btn');
  const clearAssignmentsBtn = document.getElementById('clear-assignments-btn');
  // auth UI
  const authEmailInput = document.getElementById('auth-email');
  const authPasswordInput = document.getElementById('auth-password');
  const authSignInBtn = document.getElementById('auth-signin');
  const authSignUpBtn = document.getElementById('auth-signup');
  const authSignOutBtn = document.getElementById('auth-signout');
  const authUserEmailLabel = document.getElementById('auth-user-email');

  function setStatus(msg) {
    statusText.textContent = msg;
    setTimeout(() => statusText.textContent = 'Ready', 1500);
  }

  function updateAuthUi(session) {
    const email = session && session.user ? (session.user.email || '') : '';
    if (authUserEmailLabel) authUserEmailLabel.textContent = email ? `Signed in: ${email}` : '';
    if (authSignInBtn) authSignInBtn.disabled = !!email;
    if (authSignUpBtn) authSignUpBtn.disabled = !!email;
    if (authSignOutBtn) authSignOutBtn.disabled = !email;
    const syncBtn = document.getElementById('sync-now-btn');
    if (syncBtn) syncBtn.disabled = !email;
  }

  // Tabs
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
      // refresh chart when switching to reports
      if (btn.dataset.tab === 'reports') {
        refreshReports();
      }
      if (btn.dataset.tab === 'assignments') {
        setDefaultMonthFilter();
        renderAssignmentsTable();
      }
    });
  });

  // Render helpers
  function renderChips(listEl, items, onRemove) {
    listEl.innerHTML = '';
    items.forEach(item => {
      const li = document.createElement('li');
      li.className = 'chip';
      li.innerHTML = `<span>${escapeHtml(item.name)}</span> <button class="remove" aria-label="Remove">✕</button>`;
      li.querySelector('.remove').addEventListener('click', () => onRemove(item.id));
      listEl.appendChild(li);
    });
  }

  function populateSelect(selectEl, items, placeholder) {
    selectEl.innerHTML = '';
    const ph = document.createElement('option');
    ph.disabled = true; ph.selected = true; ph.hidden = true; ph.textContent = placeholder;
    selectEl.appendChild(ph);
    items.forEach(it => {
      const opt = document.createElement('option');
      opt.value = it.id; opt.textContent = it.name;
      selectEl.appendChild(opt);
    });
  }

  function populateSimpleSelect(selectEl, options) {
    if (!selectEl) return;
    const current = selectEl.value;
    selectEl.innerHTML = '';
    options.forEach(({ value, label }) => {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = label;
      selectEl.appendChild(opt);
    });
    if (current && Array.from(selectEl.options).some(o => o.value === current)) {
      selectEl.value = current;
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (s) {
      switch (s) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return s;
      }
    });
  }

  function computePercent(correct, total) {
    if (!total || total <= 0) return 0;
    return Math.round((correct / total) * 1000) / 10; // one decimal
  }

  function letterGrade(percent) {
    if (percent > 100) return 'A++';
    if (percent >= 97) return 'A+';
    if (percent >= 93) return 'A';
    if (percent >= 90) return 'A-';
    if (percent >= 87) return 'B+';
    if (percent >= 83) return 'B';
    if (percent >= 80) return 'B-';
    if (percent >= 77) return 'C+';
    if (percent >= 73) return 'C';
    if (percent >= 70) return 'C-';
    if (percent >= 67) return 'D+';
    if (percent >= 63) return 'D';
    if (percent >= 60) return 'D-';
    return 'F';
  }

  function letterToGpa(letter) {
    switch (letter) {
      case 'A++': return 4.0;
      case 'A+': return 4.0;
      case 'A': return 4.0;
      case 'A-': return 3.7;
      case 'B+': return 3.3;
      case 'B': return 3.0;
      case 'B-': return 2.7;
      case 'C+': return 2.3;
      case 'C': return 2.0;
      case 'C-': return 1.7;
      case 'D+': return 1.3;
      case 'D': return 1.0;
      case 'D-': return 0.7;
      default: return 0.0; // F
    }
  }

  // Parse YYYY-MM-DD as a local Date (no UTC offset applied)
  function parseIsoDateLocal(iso) {
    if (!iso) return new Date(NaN);
    const parts = String(iso).split('-');
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    return new Date(y, m, d);
  }

  function termIdForDate(terms, dateStr) {
    const d = parseIsoDateLocal(dateStr);
    for (const t of terms) {
      const ts = parseIsoDateLocal(t.start);
      const te = parseIsoDateLocal(t.end);
      if (ts <= d && d <= te) return t.id;
    }
    return undefined;
  }

  function getActiveTerms() {
    const y = (state.years || []).find(y => y.id === state.currentYearId);
    return y ? y.terms : state.terms;
  }

  function getAllTerms() {
    const out = [];
    (state.years || []).forEach(y => {
      (y.terms || []).forEach(t => out.push(t));
    });
    (state.terms || []).forEach(t => {
      if (!out.some(x => x.id === t.id)) out.push(t);
    });
    return out;
  }

  function formatDateDisplay(isoDate) {
    if (!isoDate) return '';
    const d = parseIsoDateLocal(isoDate);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${mm}/${dd}/${yy}`;
  }

  function parseDateDisplay(display) {
    // mm/dd/yy or mm/dd/yyyy
    const m = String(display || '').trim().match(/^([0-1]?\d)\/([0-3]?\d)\/(\d{2}|\d{4})$/);
    if (!m) return null;
    const mm = m[1].padStart(2, '0');
    const dd = m[2].padStart(2, '0');
    let yyyy = m[3];
    if (yyyy.length === 2) yyyy = (yyyy >= '70' ? '19' : '20') + yyyy; // simple pivot
    return `${yyyy}-${mm}-${dd}`;
  }

  // Initial UI state
  function init() {
    asgDate.value = todayStr();
    setDefaultMonthFilter();
    syncAllUI();
    if (appSchoolNameEl) appSchoolNameEl.textContent = state.schoolName || 'Homeschool Grading Calculator';
    if (schoolNameInput) schoolNameInput.value = state.schoolName || '';
    // Initialize cloud sync (no-op if config not filled)
    initSupabaseSync();
  }

  function syncAllUI() {
    renderChips(studentsList, state.students, (id) => {
      state.students = state.students.filter(s => s.id !== id);
      state.assignments = state.assignments.filter(a => a.studentId !== id);
      saveState();
      syncAllUI();
    });
    renderChips(subjectsList, state.subjects, (id) => {
      state.subjects = state.subjects.filter(su => su.id !== id);
      state.assignments = state.assignments.filter(a => a.subjectId !== id);
      saveState();
      syncAllUI();
    });

    populateSelect(asgStudent, state.students, 'Select student');
    populateSelect(asgSubject, state.subjects, 'Select subject');
    // removed: report student dropdown
    populateTermFilter();
    populateAssignmentsSubjectFilter();
    populateAssignmentsStudentFilter();
    populateReportFilters();
    // Ensure a selected student exists
    ensureSelectedStudentExists();

    renderAssignmentsTable();
    renderTermsEditor();
    renderStudentFilters();
    refreshReports();
  }

  if (schoolForm) {
    schoolForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = (schoolNameInput && schoolNameInput.value.trim()) || '';
      if (!name) return;
      state.schoolName = name;
      saveState();
      if (appSchoolNameEl) appSchoolNameEl.textContent = name;
      setStatus('School name updated');
    });
  }

  function renderAssignmentsTable() {
    assignmentsTableBody.innerHTML = '';
    const month = (assignmentsMonthFilter && assignmentsMonthFilter.value) ? assignmentsMonthFilter.value : currentMonthStr();
    const studentIdFilter = (assignmentsStudentFilter && assignmentsStudentFilter.value) ? assignmentsStudentFilter.value : 'all';
    const subj = (assignmentsSubjectFilter && assignmentsSubjectFilter.value) ? assignmentsSubjectFilter.value : 'all';
    let rows = [...state.assignments]
      .filter(a => (a.date || '').startsWith(month))
      .filter(a => studentIdFilter === 'all' || a.studentId === studentIdFilter)
      .filter(a => subj === 'all' || a.subjectId === subj);

    // Apply sorting if configured
    const sortKey = state.assignmentsSortKey || 'date';
    const sortDir = state.assignmentsSortDir || 'desc';
    const dirMul = sortDir === 'asc' ? 1 : -1;
    const cmpStr = (x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }) * dirMul;
    const cmpNum = (x, y) => ((x === y) ? 0 : (x < y ? -1 : 1)) * dirMul;
    rows.sort((a, b) => {
      switch (sortKey) {
        case 'date':
          return cmpNum(parseIsoDateLocal(a.date).getTime(), parseIsoDateLocal(b.date).getTime());
        case 'student': {
          const sa = state.students.find(s => s.id === a.studentId)?.name || '';
          const sb = state.students.find(s => s.id === b.studentId)?.name || '';
          return cmpStr(sa, sb);
        }
        case 'subject': {
          const sa = state.subjects.find(su => su.id === a.subjectId)?.name || '';
          const sb = state.subjects.find(su => su.id === b.subjectId)?.name || '';
          return cmpStr(sa, sb);
        }
        case 'result': {
          const pa = (a.correct / Math.max(1, a.total));
          const pb = (b.correct / Math.max(1, b.total));
          return cmpNum(pa, pb);
        }
        case 'percent': {
          return cmpNum(computePercent(a.correct, a.total), computePercent(b.correct, b.total));
        }
        case 'grade': {
          return cmpNum(computePercent(a.correct, a.total), computePercent(b.correct, b.total));
        }
        case 'term': {
          const ta = getAllTerms().find(t => t.id === a.termId)?.name || '';
          const tb = getAllTerms().find(t => t.id === b.termId)?.name || '';
          return cmpStr(ta, tb);
        }
        default:
          return 0;
      }
    });
    // Pagination
    const pageSize = Math.max(1, parseInt((state.assignmentsPageSize != null ? state.assignmentsPageSize : (assignmentsPageSize && assignmentsPageSize.value)), 10) || 10);
    if (assignmentsPageSize) assignmentsPageSize.value = String(pageSize);
    const page = state.assignmentsPage || 1;
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    state.assignmentsPage = currentPage;
    const startIdx = (currentPage - 1) * pageSize;
    const pageRows = rows.slice(startIdx, startIdx + pageSize);

    // Render rows for current page
    pageRows.forEach(a => {
      const student = state.students.find(s => s.id === a.studentId)?.name || '—';
      const subject = state.subjects.find(su => su.id === a.subjectId)?.name || '—';
      const percent = computePercent(a.correct, a.total);
      const grade = letterGrade(percent);
      const activeTerms = getActiveTerms();
      let computedTermId = termIdForDate(activeTerms, a.date);
      let termName = activeTerms.find(t => t.id === computedTermId)?.name;
      if (!termName) {
        const anyTerms = getAllTerms();
        const fromAll = termIdForDate(anyTerms, a.date);
        termName = anyTerms.find(t => t.id === fromAll)?.name || '';
      }
      if (!a.termId && computedTermId) {
        a.termId = computedTermId;
        saveState();
      }
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatDateDisplay(a.date)}</td>
        <td>${escapeHtml(student)}</td>
        <td>${escapeHtml(subject)}</td>
        <td>${a.correct}/${a.total}</td>
        <td>${percent}%</td>
        <td>${grade}</td>
        <td>${termName}</td>
        <td>
          <button class=\"btn subtle\" data-action=\"edit\" data-id=\"${a.id}\">Edit</button>
          <button class=\"btn subtle\" data-action=\"remove\" data-id=\"${a.id}\">Remove</button>
        </td>
      `;
      tr.querySelector('[data-action="remove"]').addEventListener('click', () => {
        state.assignments = state.assignments.filter(x => x.id !== a.id);
        saveState();
        renderAssignmentsTable();
        refreshReports();
      });
      tr.querySelector('[data-action="edit"]').addEventListener('click', () => {
        const newDateDisp = prompt('Date (mm/dd/yy)', formatDateDisplay(a.date));
        const newDateIso = newDateDisp ? parseDateDisplay(newDateDisp) : a.date;
        if (!newDateIso) { setStatus('Invalid date'); return; }
        const newTotalStr = prompt('Total Questions', String(a.total));
        const newCorrectStr = prompt('Total Correct', String(a.correct));
        const newTotal = parseInt(newTotalStr, 10);
        const newCorrect = parseInt(newCorrectStr, 10);
        if (Number.isNaN(newTotal) || Number.isNaN(newCorrect) || newTotal < 1 || newCorrect < 0) {
          setStatus('Invalid totals');
          return;
        }
        a.date = newDateIso;
        a.total = newTotal;
        a.correct = newCorrect;
        a.termId = termIdForDate(getActiveTerms(), a.date);
        saveState();
        renderAssignmentsTable();
        refreshReports();
      });
      assignmentsTableBody.appendChild(tr);
    });

    // Render pagination controls
    if (assignmentsPager) {
      assignmentsPager.innerHTML = '';
      const numbers = document.createElement('div');
      numbers.className = 'pager-numbers';
      const sizeWrap = document.createElement('div');
      sizeWrap.className = 'pager-size';

      const makeBtn = (label, pageNum, disabled = false, active = false) => {
        const b = document.createElement('button');
        b.className = 'btn outline';
        b.textContent = label;
        if (active) b.style.filter = 'brightness(1.25)';
        if (disabled) b.disabled = true;
        b.addEventListener('click', () => {
          state.assignmentsPage = pageNum;
          renderAssignmentsTable();
        });
        return b;
      };

      numbers.appendChild(makeBtn('Prev', Math.max(1, currentPage - 1), currentPage === 1));
      const maxButtons = 7;
      let start = Math.max(1, currentPage - 3);
      let end = Math.min(totalPages, start + maxButtons - 1);
      start = Math.max(1, Math.min(start, end - maxButtons + 1));
      for (let p = start; p <= end; p++) {
        const btn = makeBtn(String(p), p, false, p === currentPage);
        if (p === currentPage) btn.classList.add('active');
        numbers.appendChild(btn);
      }
      numbers.appendChild(makeBtn('Next', Math.min(totalPages, currentPage + 1), currentPage === totalPages));

      // Page size select on bottom-right
      const label = document.createElement('label');
      label.innerHTML = '<span class=\"sr-only\">Rows per page</span>';
      const sel = document.createElement('select');
      sel.innerHTML = '<option value=\"10\">10</option><option value=\"25\">25</option><option value=\"50\">50</option>';
      sel.value = String(pageSize);
      sel.addEventListener('change', () => {
        state.assignmentsPageSize = parseInt(sel.value, 10) || 10;
        if (assignmentsPageSize) assignmentsPageSize.value = String(state.assignmentsPageSize);
        try { saveState(); } catch (_) { }
        state.assignmentsPage = 1;
        renderAssignmentsTable();
      });
      label.appendChild(sel);
      sizeWrap.appendChild(label);

      // Layout: [spacer][numbers centered][size right]
      const spacer = document.createElement('div');
      assignmentsPager.appendChild(spacer);
      assignmentsPager.appendChild(numbers);
      assignmentsPager.appendChild(sizeWrap);
    }
  }

  function renderTermsEditor() {
    termsForm.innerHTML = '';
    const currentYearId = getCurrentYearId();
    const termsForYear = getTermsForYear(currentYearId);
    termsForYear.forEach((t, idx) => {
      const card = document.createElement('div');
      card.className = 'rc-term';
      const grid = document.createElement('div');
      grid.className = 'term-edit';
      grid.innerHTML = `
        <label class=\"full\"><span>Name</span><input type=\"text\" value=\"${escapeHtml(t.name)}\" data-idx=\"${idx}\" data-field=\"name\"></label>
        <label><span>Start</span><input type=\"date\" value=\"${t.start}\" data-idx=\"${idx}\" data-field=\"start\"></label>
        <label><span>End</span><input type=\"date\" value=\"${t.end}\" data-idx=\"${idx}\" data-field=\"end\"></label>
      `;
      const heading = document.createElement('h3');
      heading.textContent = escapeHtml(t.name);
      card.appendChild(heading);
      card.appendChild(grid);
      termsForm.appendChild(card);
    });
  }

  function getCurrentYearId() {
    // store years as array on state.years: [{id, name, terms:[...] }]
    if (!state.years || state.years.length === 0) {
      // initialize with a single year wrapping existing terms
      const id = cryptoRandomId();
      state.years = [{ id, name: schoolYearNameFromTerms(state.terms), terms: state.terms }];
      state.currentYearId = id;
      saveState();
    }
    if (!state.currentYearId) {
      state.currentYearId = state.years[0].id;
      saveState();
    }
    return state.currentYearId;
  }

  function getTermsForYear(yearId) {
    const y = (state.years || []).find(y => y.id === yearId);
    return y ? y.terms : state.terms;
  }

  function schoolYearNameFromTerms(terms) {
    if (!terms || terms.length === 0) return 'School Year';
    const start = parseIsoDateLocal(terms[0].start);
    const end = parseIsoDateLocal(terms[terms.length - 1].end);
    return `${start.getFullYear()}-${end.getFullYear()}`;
  }

  function escapeCsvCell(value) {
    const s = String(value ?? '');
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCurrentYearCsv() {
    const terms = getActiveTerms();
    const rangeTerms = terms && terms.length ? { start: terms[0].start, end: terms[terms.length - 1].end } : null;
    const inRange = (a) => {
      if (!rangeTerms) return true;
      const d = parseIsoDateLocal(a.date);
      return parseIsoDateLocal(rangeTerms.start) <= d && d <= parseIsoDateLocal(rangeTerms.end);
    };
    const rows = state.assignments.filter(inRange).map(a => {
      const student = state.students.find(s => s.id === a.studentId)?.name || '';
      const subject = state.subjects.find(su => su.id === a.subjectId)?.name || '';
      const pct = computePercent(a.correct, a.total);
      const grade = letterGrade(pct);
      const termName = (function () {
        const tId = a.termId || termIdForDate(getActiveTerms(), a.date);
        const t = getAllTerms().find(t => t.id === tId);
        return t ? t.name : '';
      })();
      return [
        a.date,
        student,
        subject,
        `${a.correct}/${a.total}`,
        pct,
        grade,
        termName
      ];
    });
    const header = ['Date', 'Student', 'Subject', 'Result', 'Percent', 'Grade', 'Term'];
    const lines = [header, ...rows].map(cols => cols.map(escapeCsvCell).join(','));
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const yname = schoolYearNameFromTerms(getActiveTerms());
    const fileName = `grades_${yname}_export.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus('Exported CSV for Excel');
  }

  function populateYearSelect() {
    if (!yearSelect) return;
    yearSelect.innerHTML = '';
    (state.years || []).forEach(y => {
      const opt = document.createElement('option');
      opt.value = y.id; opt.textContent = y.name;
      if (y.id === state.currentYearId) opt.selected = true;
      yearSelect.appendChild(opt);
    });
  }

  function populateTermFilter() {
    if (!termFilter) return;
    termFilter.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = 'all'; optAll.textContent = 'All Terms';
    termFilter.appendChild(optAll);
    getActiveTerms().forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id; opt.textContent = t.name;
      termFilter.appendChild(opt);
    });
  }

  function populateAssignmentsSubjectFilter() {
    if (!assignmentsSubjectFilter) return;
    const opts = [{ value: 'all', label: 'All Subjects' }, ...state.subjects.map(s => ({ value: s.id, label: s.name }))];
    populateSimpleSelect(assignmentsSubjectFilter, opts);
  }

  function populateAssignmentsStudentFilter() {
    if (!assignmentsStudentFilter) return;
    const opts = [{ value: 'all', label: 'All Students' }, ...state.students.map(s => ({ value: s.id, label: s.name }))];
    populateSimpleSelect(assignmentsStudentFilter, opts);
  }

  function populateReportFilters() {
    const subjectOpts = [{ value: 'all', label: 'All Subjects' }, ...state.subjects.map(s => ({ value: s.id, label: s.name }))];
    populateSimpleSelect(filterSubjectSelect, subjectOpts);
  }

  function currentMonthStr() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${d.getFullYear()}-${m}`;
  }

  function setDefaultMonthFilter() {
    if (assignmentsMonthFilter && !assignmentsMonthFilter.value) {
      assignmentsMonthFilter.value = currentMonthStr();
    }
  }

  // Events
  studentForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = studentNameInput.value.trim();
    if (!name) return;
    state.students.push({ id: cryptoRandomId(), name });
    studentNameInput.value = '';
    saveState();
    syncAllUI();
  });

  subjectForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = subjectNameInput.value.trim();
    if (!name) return;
    state.subjects.push({ id: cryptoRandomId(), name });
    subjectNameInput.value = '';
    saveState();
    syncAllUI();
  });

  assignmentForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const studentId = asgStudent.value;
    const subjectId = asgSubject.value;
    let total = parseInt(asgTotal.value, 10);
    let correct = parseInt(asgCorrect.value, 10);
    const percentVal = parseFloat(asgPercent.value);
    // If percent is provided, compute totals prioritizing existing total if present
    if (!Number.isNaN(percentVal)) {
      const pct = Math.max(0, percentVal);
      // Use provided total or fall back to 20
      total = Number.isNaN(total) || total < 1 ? 20 : total;
      correct = Math.round((pct / 100) * total);
      if (correct < 0) correct = 0;
      asgTotal.value = String(total);
      asgCorrect.value = String(correct);
    }
    const date = asgDate.value || todayStr();
    const termId = termIdForDate(getActiveTerms(), date);
    if (!studentId || !subjectId || Number.isNaN(total) || Number.isNaN(correct)) { setStatus('Fill all fields'); return; }
    if (total < 1 || correct < 0) { setStatus('Invalid totals'); return; }
    state.assignments.push({ id: cryptoRandomId(), studentId, subjectId, total, correct, date, termId });
    saveState();
    // Preserve student, subject, date; clear totals only
    asgTotal.value = '';
    asgCorrect.value = '';
    asgPercent.value = '';
    // Put cursor into Total Correct for faster entry
    if (asgCorrect && typeof asgCorrect.focus === 'function') {
      asgCorrect.focus();
    }
    // Ensure history filter shows the newly added assignment
    if (assignmentsMonthFilter) assignmentsMonthFilter.value = (date || '').slice(0, 7);
    if (assignmentsSubjectFilter) assignmentsSubjectFilter.value = 'all';
    // keep asgStudent, asgSubject, asgDate as-is
    renderAssignmentsTable();
    setStatus('Assignment added');
    refreshReports();
  });

  // When percent changes, auto-calc totals on the fly
  if (asgPercent) {
    const recalcFromPercent = () => {
      const p = parseFloat(asgPercent.value);
      if (Number.isNaN(p)) return;
      let t = parseInt(asgTotal.value, 10);
      if (Number.isNaN(t) || t < 1) t = 20;
      const c = Math.round((Math.max(0, p) / 100) * t);
      asgTotal.value = String(t);
      asgCorrect.value = String(c);
    };
    asgPercent.addEventListener('input', recalcFromPercent);
    asgPercent.addEventListener('change', recalcFromPercent);
  }

  // Auto-fill percent from totals when both numbers are present
  (function setupPercentAutoFill() {
    if (!asgPercent || !asgTotal || !asgCorrect) return;
    const updatePercent = () => {
      const t = parseInt(asgTotal.value, 10);
      const c = parseInt(asgCorrect.value, 10);
      if (!Number.isNaN(t) && t >= 1 && !Number.isNaN(c) && c >= 0) {
        const pct = computePercent(c, t);
        asgPercent.value = String(pct);
      } else {
        asgPercent.value = '';
      }
    };
    asgTotal.addEventListener('input', updatePercent);
    asgCorrect.addEventListener('input', updatePercent);
    asgTotal.addEventListener('change', updatePercent);
    asgCorrect.addEventListener('change', updatePercent);
  })();

  if (assignmentsMonthFilter) {
    assignmentsMonthFilter.addEventListener('change', () => {
      renderAssignmentsTable();
    });
  }

  if (assignmentsSubjectFilter) {
    assignmentsSubjectFilter.addEventListener('change', () => {
      renderAssignmentsTable();
    });
  }

  if (assignmentsPageSize) {
    assignmentsPageSize.addEventListener('change', () => {
      state.assignmentsPageSize = parseInt(assignmentsPageSize.value, 10) || 10;
      try { saveState(); } catch (_) { }
      state.assignmentsPage = 1;
      renderAssignmentsTable();
    });
  }

  if (assignmentsStudentFilter) {
    assignmentsStudentFilter.addEventListener('change', () => {
      renderAssignmentsTable();
    });
  }

  // Sorting: click table headers to toggle sort
  (function setupAssignmentsSorting() {
    const thead = document.querySelector('#assignments-table thead');
    if (!thead) return;
    const headers = Array.from(thead.querySelectorAll('th'));
    const keys = ['date', 'student', 'subject', 'result', 'percent', 'grade', 'term', 'actions'];
    headers.forEach((th, idx) => {
      const key = keys[idx];
      if (!key || key === 'actions') return;
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const prevKey = state.assignmentsSortKey || 'date';
        const prevDir = state.assignmentsSortDir || 'desc';
        const nextDir = (prevKey === key && prevDir === 'asc') ? 'desc' : 'asc';
        state.assignmentsSortKey = key;
        state.assignmentsSortDir = nextDir;
        saveState();
        renderAssignmentsTable();
      });
    });
  })();

  if (termFilter) {
    termFilter.addEventListener('change', () => {
      refreshChart();
      refreshFilteredChart();
    });
  }

  // removed: filterStudentSelect change handler

  if (filterSubjectSelect) {
    filterSubjectSelect.addEventListener('change', () => {
      refreshFilteredChart();
    });
  }

  // Debug data generation
  if (debugImportBtn) {
    debugImportBtn.addEventListener('click', () => {
      const ok = confirm('Debug Import will generate a large set of sample data. Continue?');
      if (!ok) return;
      if (state.students.length === 0 || state.subjects.length === 0) {
        setStatus('Add at least one student and subject first');
        return;
      }
      const rng = seededRandom();
      state.students.forEach(student => {
        const totalAssignments = 100;
        const perSubject = Math.max(1, Math.floor(totalAssignments / Math.max(1, state.subjects.length)));
        let created = 0;
        state.subjects.forEach(subject => {
          for (let i = 0; i < perSubject; i++) {
            const term = getActiveTerms()[i % getActiveTerms().length];
            const date = randomDateInRange(parseIsoDateLocal(term.start), parseIsoDateLocal(term.end), rng);
            const total = 10 + Math.floor(rng() * 21);
            const correct = Math.max(0, Math.min(total, Math.floor(total * (0.5 + rng() * 0.5))));
            state.assignments.push({
              id: cryptoRandomId(),
              studentId: student.id,
              subjectId: subject.id,
              total,
              correct,
              date: fmtDate(date),
              termId: termIdForDate(getActiveTerms(), fmtDate(date))
            });
            created++;
          }
        });
        while (created < totalAssignments) {
          const subject = state.subjects[Math.floor(rng() * state.subjects.length)];
          const term = getActiveTerms()[Math.floor(rng() * getActiveTerms().length)];
          const date = randomDateInRange(parseIsoDateLocal(term.start), parseIsoDateLocal(term.end), rng);
          const total = 10 + Math.floor(rng() * 21);
          const correct = Math.max(0, Math.min(total, Math.floor(total * (0.5 + rng() * 0.5))));
          state.assignments.push({
            id: cryptoRandomId(),
            studentId: student.id,
            subjectId: subject.id,
            total,
            correct,
            date: fmtDate(date),
            termId: termIdForDate(getActiveTerms(), fmtDate(date))
          });
          created++;
        }
      });
      saveState();
      renderAssignmentsTable();
      refreshReports();
      setStatus('Debug data generated');
    });
  }

  if (clearAssignmentsBtn) {
    clearAssignmentsBtn.addEventListener('click', () => {
      const ok = confirm('Clear ALL assignments? This cannot be undone.');
      if (!ok) return;
      state.assignments = [];
      saveState();
      renderAssignmentsTable();
      refreshReports();
      setStatus('Assignments cleared');
    });
  }

  function fmtDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function randomDateInRange(start, end, rng) {
    const startMs = start.getTime();
    const endMs = end.getTime();
    const ts = startMs + Math.floor(rng() * Math.max(1, (endMs - startMs)));
    return new Date(ts);
  }

  function seededRandom(seed) {
    let x = seed || Math.floor(Math.random() * 0xffffffff);
    return function () {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      return ((x >>> 0) / 0x100000000);
    };
  }

  resetTermsBtn.addEventListener('click', () => {
    const y = (state.years || []).find(y => y.id === getCurrentYearId());
    if (y) y.terms = defaultTerms(); else state.terms = defaultTerms();
    saveState();
    renderTermsEditor();
    refreshReports();
  });

  saveTermsBtn.addEventListener('click', () => {
    const inputs = termsForm.querySelectorAll('input');
    const y = (state.years || []).find(y => y.id === getCurrentYearId());
    const termsArr = y ? y.terms : state.terms;
    inputs.forEach(inp => {
      const idx = parseInt(inp.dataset.idx, 10);
      const field = inp.dataset.field;
      termsArr[idx][field] = inp.value;
    });
    saveState();
    renderTermsEditor();
    refreshReports();
  });

  if (autoGenTermsBtn) {
    autoGenTermsBtn.addEventListener('click', () => {
      // Prompt for start/end dates (mm/dd/yy or mm/dd/yyyy)
      const active = getActiveTerms();
      const suggestedStart = active && active.length ? formatDateDisplay(active[0].start) : '';
      const suggestedEnd = active && active.length ? formatDateDisplay(active[active.length - 1].end) : '';
      const startDisp = prompt('School start date (mm/dd/yy)', suggestedStart);
      if (!startDisp) { setStatus('Cancelled'); return; }
      const startIso = parseDateDisplay(startDisp);
      if (!startIso) { setStatus('Invalid start date'); return; }
      const endDisp = prompt('School end date (mm/dd/yy)', suggestedEnd);
      if (!endDisp) { setStatus('Cancelled'); return; }
      const endIso = parseDateDisplay(endDisp);
      if (!endIso) { setStatus('Invalid end date'); return; }
      const s = parseIsoDateLocal(startIso);
      const e = parseIsoDateLocal(endIso);
      if (!(s instanceof Date) || !(e instanceof Date) || isNaN(s.getTime()) || isNaN(e.getTime())) { setStatus('Invalid dates'); return; }
      if (e < s) { setStatus('End date must be on/after start date'); return; }

      function addDays(date, days) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
      }
      function diffDaysInclusive(a, b) {
        const MS = 24 * 60 * 60 * 1000;
        const aStart = new Date(a.getFullYear(), a.getMonth(), a.getDate());
        const bStart = new Date(b.getFullYear(), b.getMonth(), b.getDate());
        return Math.floor((bStart - aStart) / MS) + 1;
      }

      const totalDays = diffDaysInclusive(s, e);
      if (totalDays < 4) { setStatus('Range too short (min 4 days)'); return; }

      const base = Math.floor(totalDays / 4);
      const extra = totalDays % 4;
      const lens = [base, base, base, base];
      for (let i = 0; i < extra; i++) lens[i] += 1;

      const pieces = [];
      let currentStart = s;
      for (let i = 0; i < 4; i++) {
        const segLen = Math.max(1, lens[i]);
        const segEnd = addDays(currentStart, segLen - 1);
        pieces.push({ start: currentStart, end: segEnd });
        currentStart = addDays(segEnd, 1);
      }
      // Clamp last end to provided end date just in case
      pieces[3].end = e;

      const y = (state.years || []).find(y => y.id === getCurrentYearId());
      const termsArr = y ? y.terms : state.terms;
      // Ensure there are 4 term objects
      if (!termsArr || termsArr.length !== 4) {
        if (y) y.terms = defaultTerms(); else state.terms = defaultTerms();
      }
      const target = y ? y.terms : state.terms;
      target.forEach((t, idx) => {
        t.name = `Term ${idx + 1}`;
        t.start = fmtDate(pieces[idx].start);
        t.end = fmtDate(pieces[idx].end);
      });
      // Optionally update the year display name
      if (y) {
        y.name = schoolYearNameFromTerms(target);
      }
      saveState();
      // Update UI
      populateYearSelect();
      renderTermsEditor();
      refreshReports();
      setStatus('Terms auto-generated');
    });
  }

  if (addYearBtn) {
    addYearBtn.addEventListener('click', () => {
      const baseYear = new Date().getFullYear();
      const nextStart = `${baseYear + 1}-08-01`;
      const nextEnd = `${baseYear + 2}-06-01`;
      const newTerms = [
        { id: cryptoRandomId(), name: 'Term 1', start: `${baseYear + 1}-08-01`, end: `${baseYear + 1}-10-15` },
        { id: cryptoRandomId(), name: 'Term 2', start: `${baseYear + 1}-10-16`, end: `${baseYear + 1}-12-31` },
        { id: cryptoRandomId(), name: 'Term 3', start: `${baseYear + 2}-01-01`, end: `${baseYear + 2}-03-15` },
        { id: cryptoRandomId(), name: 'Term 4', start: `${baseYear + 2}-03-16`, end: `${baseYear + 2}-06-01` },
      ];
      const id = cryptoRandomId();
      const name = `${baseYear + 1}-${baseYear + 2}`;
      state.years = state.years || [];
      state.years.push({ id, name, terms: newTerms });
      state.currentYearId = id;
      saveState();
      populateYearSelect();
      renderTermsEditor();
      refreshReports();
      setStatus('Added next school year');
    });
  }

  if (yearSelect) {
    yearSelect.addEventListener('change', (e) => {
      state.currentYearId = e.target.value;
      saveState();
      renderTermsEditor();
      refreshReports();
      // re-evaluate term filter since terms changed scope
      populateTermFilter();
      refreshChart();
      refreshFilteredChart();
    });
  }

  // Export / Import
  importBtn.addEventListener('click', async () => {
    const canUseNative = !!window.showOpenFilePicker && (window.isSecureContext === true);
    if (!canUseNative) {
      hiddenFileInput.value = '';
      hiddenFileInput.click();
      return;
    }
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'JSON Files', accept: { 'application/json': ['.json'] } }],
        multiple: false
      });
      const file = await handle.getFile();
      const text = await file.text();
      handleImportedJson(text);
    } catch (e) {
      console.error(e);
      // Fallback to hidden input on user-activation or permission errors
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || /activation is required/i.test(String(e.message || '')))) {
        hiddenFileInput.value = '';
        hiddenFileInput.click();
      } else {
        setStatus('Import cancelled');
      }
    }
  });

  hiddenFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      handleImportedJson(text);
    } catch (e) {
      console.error(e);
      setStatus('Import failed');
    }
  });

  function handleImportedJson(text) {
    try {
      const data = JSON.parse(text);
      if (!data || !Array.isArray(data.students) || !Array.isArray(data.subjects) || !Array.isArray(data.assignments)) {
        setStatus('Invalid JSON format');
        return;
      }
      data.terms = (Array.isArray(data.terms) && data.terms.length === 4) ? data.terms : defaultTerms();
      state = data;
      saveState();
      syncAllUI();
      setStatus('Imported JSON');
    } catch (e) {
      console.error(e);
      setStatus('Invalid JSON format');
    }
  }

  // Reports (chart + filters + weekday table + filtered chart)
  function drawChart(canvas, labels, datasets) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    // Ensure canvas matches parent width and a fixed CSS height
    const parent = canvas.parentElement;
    const width = (parent && parent.clientWidth ? parent.clientWidth : canvas.clientWidth) || 800;
    // If the canvas is inside a chart-card, fill available height beneath header
    let cssHeight = parseInt(getComputedStyle(canvas).height, 10) || 300;
    const container = canvas.closest('.chart-card');
    // Keep charts at a stable height; avoid dynamic resizing on interactions
    // Previously we tried to fill remaining height, which caused growth
    // when sibling content changed. We now prefer a fixed canvas CSS height.
    const height = cssHeight;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const margin = { top: 24, right: 16, bottom: 36, left: 36 };
    const plotW = Math.max(1, width - margin.left - margin.right);
    const plotH = Math.max(1, height - margin.top - margin.bottom);

    const bgGrid = 'rgba(255,255,255,0.08)';
    const textColor = '#e8ecf1';
    ctx.fillStyle = textColor;
    ctx.strokeStyle = bgGrid;
    ctx.lineWidth = 1;

    ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    for (let yv = 0; yv <= 100; yv += 20) {
      const y = margin.top + plotH * (1 - yv / 100);
      ctx.strokeStyle = bgGrid;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotW, y);
      ctx.stroke();
      ctx.fillStyle = textColor;
      ctx.fillText(String(yv), 8, y + 4);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(margin.left, margin.top);
    ctx.lineTo(margin.left, margin.top + plotH);
    ctx.lineTo(margin.left + plotW, margin.top + plotH);
    ctx.stroke();

    const maxLabels = Math.max(6, Math.floor(width / 120));
    const step = Math.max(1, Math.ceil(labels.length / maxLabels));
    ctx.fillStyle = textColor;
    for (let i = 0; i < labels.length; i += step) {
      const x = margin.left + (labels.length <= 1 ? 0 : (plotW * (i / (labels.length - 1))));
      const label = labels[i];
      ctx.save();
      ctx.translate(x, margin.top + plotH + 14);
      ctx.rotate(-Math.PI / 6);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }

    function xAt(i) {
      return margin.left + (labels.length <= 1 ? 0 : (plotW * (i / (labels.length - 1))));
    }
    function yAt(pct) {
      const clamped = Math.max(0, Math.min(100, pct ?? 0));
      return margin.top + plotH * (1 - clamped / 100);
    }

    datasets.forEach((ds) => {
      ctx.strokeStyle = ds.borderColor || '#7c5cff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      ds.data.forEach((v, i) => {
        if (v == null) return;
        const x = xAt(i);
        const y = yAt(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else { ctx.lineTo(x, y); }
      });
      ctx.stroke();
      ctx.fillStyle = (ds.borderColor || '#7c5cff') + 'AA';
      ds.data.forEach((v, i) => {
        if (v == null) return;
        const x = xAt(i);
        const y = yAt(v);
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    let lx = margin.left;
    const ly = margin.top - 8;
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
    datasets.forEach((ds) => {
      const color = ds.borderColor || '#7c5cff';
      ctx.fillStyle = color;
      ctx.fillRect(lx, ly - 8, 12, 2);
      ctx.fillStyle = textColor;
      ctx.fillText(ds.label || '', lx + 16, ly);
      lx += ctx.measureText(ds.label || '').width + 48;
    });
  }
  function renderStudentFilters() {
    studentFilters.innerHTML = '';
    const selId = getSelectedStudentId();
    // Render quick chips for jumping, but also sync selected student
    state.students.forEach(s => {
      const b = document.createElement('button');
      b.className = 'btn outline';
      b.textContent = s.name;
      if (s.id === selId) b.style.filter = 'brightness(1.25)';
      b.addEventListener('click', () => { applySelectedStudent(s.id); });
      studentFilters.appendChild(b);
    });
  }

  function datasetColor(idx) {
    const palette = [
      '#7c5cff', '#17d4ff', '#11c38f', '#ff5470', '#ffb020', '#a07cff', '#1fe5aa'
    ];
    return palette[idx % palette.length];
  }

  function assignmentsForStudent(studentId) {
    return state.assignments.filter(a => !studentId || a.studentId === studentId);
  }

  function refreshChart(studentId) {
    const selectedTermId = termFilter ? termFilter.value : 'all';
    const activeTerms = getActiveTerms();
    const termRange = selectedTermId === 'all' ? null : activeTerms.find(t => t.id === selectedTermId);
    const inTerm = (a) => {
      if (!termRange) return true;
      const d = parseIsoDateLocal(a.date);
      return parseIsoDateLocal(termRange.start) <= d && d <= parseIsoDateLocal(termRange.end);
    };

    const students = studentId ? state.students.filter(s => s.id === studentId) : state.students;
    const allFiltered = state.assignments.filter(a => inTerm(a));

    const weekKeyForDate = (dateStr) => {
      const d = parseIsoDateLocal(dateStr);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const wk = weekOfMonth(d);
      return `${ym}-W${wk}`;
    };
    const labelKeysSet = new Set();
    allFiltered
      .map(a => ({ a, d: parseIsoDateLocal(a.date) }))
      .sort((x, y) => x.d - y.d)
      .forEach(({ a }) => labelKeysSet.add(weekKeyForDate(a.date)));
    const labelKeys = Array.from(labelKeysSet.values());

    const labels = labelKeys.map(k => {
      const [ym, wk] = k.split('-W');
      const [y, m] = ym.split('-');
      return `${monthNameShort(parseInt(m, 10))} W${wk}`;
    });

    const datasets = students.map((s, idx) => {
      const data = labelKeys.map(k => {
        const vals = allFiltered.filter(a => a.studentId === s.id && weekKeyForDate(a.date) === k);
        if (vals.length === 0) return null;
        const pct = Math.round((vals.reduce((sum, a) => sum + (a.correct / a.total), 0) / vals.length) * 1000) / 10;
        return pct;
      });
      return {
        label: s.name,
        data,
        borderColor: datasetColor(idx),
        backgroundColor: datasetColor(idx) + '33',
        tension: 0.3,
        spanGaps: true,
      };
    });

    drawChart(scoresCanvas, labels, datasets);
  }

  // removed height sync with weekday card

  function ensureSelectedStudentExists() {
    // Initialize or clean up selected student
    const all = state.students || [];
    if (!all.length) {
      state.selectedStudentId = undefined;
      if (studentCurrentLabel) studentCurrentLabel.textContent = '';
      return;
    }
    if (!state.selectedStudentId || !all.some(s => s.id === state.selectedStudentId)) {
      state.selectedStudentId = all[0].id;
      saveState();
    }
    if (studentCurrentLabel) {
      const nm = all.find(s => s.id === state.selectedStudentId)?.name || '';
      studentCurrentLabel.textContent = nm;
    }
  }

  function getSelectedStudentId() {
    return state.selectedStudentId || (state.students && state.students[0] ? state.students[0].id : undefined);
  }

  function applySelectedStudent(studentId) {
    if (!studentId) return;
    state.selectedStudentId = studentId;
    saveState();
    // Update label
    if (studentCurrentLabel) {
      const nm = state.students.find(s => s.id === studentId)?.name || '';
      studentCurrentLabel.textContent = nm;
    }
    // Update report student select & filtered student select

    // Re-render dependent sections
    refreshChart(studentId);

    refreshFilteredChart();
    buildReportCard(studentId);
  }

  function weekOfMonth(date) {
    const day = date.getDate();
    return Math.floor((day - 1) / 7) + 1;
  }

  function monthNameShort(m) {
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[(m - 1) % 12];
  }

  // removed: renderWeekdayAverages

  function refreshFilteredChart() {
    if (!filteredChartCanvas) return;
    const selectedTermId = termFilter ? termFilter.value : 'all';
    const activeTerms = getActiveTerms();
    const termRange = selectedTermId === 'all' ? null : activeTerms.find(t => t.id === selectedTermId);
    const inTerm = (a) => {
      if (!termRange) return true;
      const d = parseIsoDateLocal(a.date);
      return parseIsoDateLocal(termRange.start) <= d && d <= parseIsoDateLocal(termRange.end);
    };
    const studentId = getSelectedStudentId() || 'all';
    const subjectId = filterSubjectSelect ? filterSubjectSelect.value : 'all';

    const filtered = state.assignments.filter(a => inTerm(a))
      .filter(a => studentId === 'all' || a.studentId === studentId)
      .filter(a => subjectId === 'all' || a.subjectId === subjectId);

    const weekKeyForDate = (dateStr) => {
      const d = parseIsoDateLocal(dateStr);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const wk = weekOfMonth(d);
      return `${ym}-W${wk}`;
    };
    const keys = Array.from(new Set(filtered
      .map(a => ({ a, d: parseIsoDateLocal(a.date) }))
      .sort((x, y) => x.d - y.d)
      .map(({ a }) => weekKeyForDate(a.date))));

    const labels = keys.map(k => {
      const [ym, wk] = k.split('-W');
      const [y, m] = ym.split('-');
      return `${monthNameShort(parseInt(m, 10))} W${wk}`;
    });

    const data = keys.map(k => {
      const vals = filtered.filter(a => weekKeyForDate(a.date) === k);
      if (!vals.length) return null;
      return Math.round((vals.reduce((s, a) => s + (a.correct / a.total), 0) / vals.length) * 1000) / 10;
    });

    const studentLabel = studentId === 'all' ? 'All Students' : (state.students.find(s => s.id === studentId)?.name || 'Student');
    const subjectLabel = subjectId === 'all' ? 'All Subjects' : (state.subjects.find(s => s.id === subjectId)?.name || 'Subject');

    drawChart(filteredChartCanvas, labels, [{ label: `${studentLabel} • ${subjectLabel}`, data, borderColor: '#17d4ff' }]);
  }

  function buildReportCard(studentId) {
    const student = state.students.find(s => s.id === studentId);
    if (!student) { reportCardContent.innerHTML = '<p>Select a student</p>'; return; }
    const studentAssignments = state.assignments.filter(a => a.studentId === studentId);
    const subjectsWithData = state.subjects.filter(sub => studentAssignments.some(a => a.subjectId === sub.id));
    const bySubjectByTerm = new Map();
    subjectsWithData.forEach(sub => bySubjectByTerm.set(sub.id, new Map()));
    getActiveTerms().forEach((t, i) => {
      subjectsWithData.forEach(sub => bySubjectByTerm.get(sub.id).set(t.id, []));
    });
    studentAssignments.forEach(a => {
      const term = a.termId || termIdForDate(getActiveTerms(), a.date);
      if (!bySubjectByTerm.has(a.subjectId)) bySubjectByTerm.set(a.subjectId, new Map());
      if (!bySubjectByTerm.get(a.subjectId).has(term)) bySubjectByTerm.get(a.subjectId).set(term, []);
      bySubjectByTerm.get(a.subjectId).get(term).push(a);
    });

    function pctWeighted(assignments) {
      if (!assignments || assignments.length === 0) return null;
      const sums = assignments.reduce((acc, a) => { acc.c += a.correct; acc.t += a.total; return acc; }, { c: 0, t: 0 });
      if (sums.t <= 0) return null;
      return Math.round((sums.c / sums.t) * 1000) / 10;
    }

    const overallAgg = [];
    const rc = document.createElement('div');
    rc.className = 'report-card-inner';
    rc.innerHTML = `<div class=\"rc-student\">${escapeHtml(student.name)}</div>`;
    const grid = document.createElement('div');
    grid.className = 'rc-grid';
    getActiveTerms().forEach((t) => {
      const termBox = document.createElement('div');
      termBox.className = 'rc-term';
      termBox.innerHTML = `<h3>${escapeHtml(t.name)}</h3>`;
      const subjectsRows = document.createElement('div');
      let termSumC = 0;
      let termSumT = 0;
      subjectsWithData.forEach(sub => {
        const arr = bySubjectByTerm.get(sub.id)?.get(t.id) || [];
        const pct = pctWeighted(arr);
        const letter = pct == null ? '—' : letterGrade(pct);
        if (arr && arr.length) {
          const sums = arr.reduce((acc, a) => { acc.c += a.correct; acc.t += a.total; return acc; }, { c: 0, t: 0 });
          termSumC += sums.c; termSumT += sums.t;
        }
        const row = document.createElement('div');
        row.className = 'rc-row';
        row.innerHTML = `<span>${escapeHtml(sub.name)}</span><span>${pct == null ? '—' : pct + '%'} ${letter == '—' ? '' : '(' + letter + ')'}</span>`;
        subjectsRows.appendChild(row);
      });
      const termAvg = termSumT > 0 ? Math.round((termSumC / termSumT) * 1000) / 10 : null;
      if (termAvg != null) overallAgg.push(termAvg);
      const rowAvg = document.createElement('div');
      rowAvg.className = 'rc-row';
      rowAvg.innerHTML = `<strong>Term Average</strong><strong>${termAvg == null ? '—' : termAvg + '% (' + letterGrade(termAvg) + ')'}</strong>`;
      subjectsRows.appendChild(rowAvg);
      termBox.appendChild(subjectsRows);
      grid.appendChild(termBox);
    });
    rc.appendChild(grid);
    // Compute per-subject full-year grades and GPA
    const subjectYear = subjectsWithData.map(sub => {
      const arr = studentAssignments.filter(a => a.subjectId === sub.id);
      if (arr.length === 0) return null;
      const sums = arr.reduce((acc, a) => { acc.c += a.correct; acc.t += a.total; return acc; }, { c: 0, t: 0 });
      const pct = sums.t > 0 ? Math.round((sums.c / sums.t) * 1000) / 10 : null;
      if (pct == null) return null;
      const letter = letterGrade(pct);
      const gpa = letterToGpa(letter);
      return { subjectName: sub.name, percent: pct, letter, gpa };
    }).filter(Boolean);

    const gpaAvg = subjectYear.length
      ? Math.round((subjectYear.reduce((s, x) => s + x.gpa, 0) / subjectYear.length) * 100) / 100
      : null;

    // Styled like a term card
    const overall = document.createElement('div');
    overall.className = 'rc-term';
    overall.innerHTML = `<h3>Overall Year Summary</h3>`;
    const overallRows = document.createElement('div');
    const sumsAll = studentAssignments.reduce((acc, a) => { acc.c += a.correct; acc.t += a.total; return acc; }, { c: 0, t: 0 });
    const yearAvg = sumsAll.t > 0 ? Math.round((sumsAll.c / sumsAll.t) * 1000) / 10 : null;
    const yearLetter = yearAvg == null ? '—' : letterGrade(yearAvg);
    const gpaText = gpaAvg == null ? '—' : gpaAvg.toFixed(2);
    const rowPct = document.createElement('div');
    rowPct.className = 'rc-row';
    rowPct.innerHTML = `<strong>Overall Year Percent</strong><strong>${yearAvg == null ? '—' : yearAvg + '%'} (${yearLetter})</strong>`;
    overallRows.appendChild(rowPct);
    const rowGpa = document.createElement('div');
    rowGpa.className = 'rc-row';
    rowGpa.innerHTML = `<strong>Overall Year GPA</strong><strong>${gpaText}</strong>`;
    overallRows.appendChild(rowGpa);
    // Subject year rows
    subjectYear.forEach(sy => {
      const r = document.createElement('div');
      r.className = 'rc-row';
      r.innerHTML = `<span>${escapeHtml(sy.subjectName)}</span><span>${sy.percent}% (${sy.letter})</span>`;
      overallRows.appendChild(r);
    });
    overall.appendChild(overallRows);
    rc.appendChild(overall);
    reportCardContent.innerHTML = '';
    reportCardContent.appendChild(rc);
  }

  function refreshReports() {
    
    refreshChart();
    populateReportFilters();
    // Apply selected student across below-cards
    const selId = getSelectedStudentId();
    refreshFilteredChart();
    const current = selId || state.students[0]?.id;
    if (current) {
      buildReportCard(current);
    } else {
      reportCardContent.innerHTML = '<p>Select a student</p>';
    }
  }

  // removed: reportStudentSelect change handler

  printReportBtn.addEventListener('click', () => {
    const studentId = getSelectedStudentId() || state.students[0]?.id;
    if (!studentId) { setStatus('Select a student'); return; }
    openPrintableReport(studentId);
  });

  function openPrintableReport(studentId) {
    const student = state.students.find(s => s.id === studentId);
    if (!student) return;
    const terms = getActiveTerms();
    const yearName = schoolYearNameFromTerms(terms);
    const rangeText = terms.length ? `${formatDateDisplay(terms[0].start)} - ${formatDateDisplay(terms[terms.length - 1].end)}` : '';

    function avgPct(arr) {
      if (!arr || arr.length === 0) return null;
      const sums = arr.reduce((acc, a) => { acc.c += a.correct; acc.t += a.total; return acc; }, { c: 0, t: 0 });
      if (sums.t <= 0) return null;
      return Math.round((sums.c / sums.t) * 1000) / 10;
    }

    const bySubject = state.subjects.map(sub => {
      const perTerm = terms.map(t => {
        return avgPct(
          state.assignments.filter(a => {
            if (a.studentId !== studentId || a.subjectId !== sub.id) return false;
            const d = parseIsoDateLocal(a.date);
            return parseIsoDateLocal(t.start) <= d && d <= parseIsoDateLocal(t.end);
          })
        );
      });
      const perTermLetters = perTerm.map(v => (v == null ? null : letterGrade(v)));
      const perTermGpa = perTermLetters.map(l => (l == null ? null : letterToGpa(l)));
      const allArr = state.assignments.filter(a => a.studentId === studentId && a.subjectId === sub.id);
      const sums = allArr.reduce((acc, a) => { acc.c += a.correct; acc.t += a.total; return acc; }, { c: 0, t: 0 });
      const year = sums.t > 0 ? Math.round((sums.c / sums.t) * 1000) / 10 : null;
      const yearLetter = year == null ? null : letterGrade(year);
      const yearGpa = yearLetter == null ? null : letterToGpa(yearLetter);
      return { name: sub.name, perTerm, perTermLetters, perTermGpa, year, yearLetter, yearGpa, hasData: sums.t > 0 };
    }).filter(r => r.hasData);

    // Overall GPA (year) across subjects with data
    const gpaOverall = bySubject.filter(s => s.yearGpa != null).length
      ? Math.round((bySubject.filter(s => s.yearGpa != null).reduce((sum, s) => sum + s.yearGpa, 0) / bySubject.filter(s => s.yearGpa != null).length) * 100) / 100
      : null;
    // Current GPA = most recent term with any data
    let currentTermIndex = -1;
    for (let i = terms.length - 1; i >= 0; i--) {
      if (bySubject.some(s => s.perTermGpa[i] != null)) { currentTermIndex = i; break; }
    }
    const gpaCurrent = currentTermIndex >= 0
      ? (function () { const xs = bySubject.map(s => s.perTermGpa[currentTermIndex]).filter(v => v != null); return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null; })()
      : null;

    const sumsAll = state.assignments.filter(a => a.studentId === studentId).reduce((acc, a) => { acc.c += a.correct; acc.t += a.total; return acc; }, { c: 0, t: 0 });
    const overallYearPctFloat = sumsAll.t > 0 ? ((sumsAll.c / sumsAll.t) * 100) : null;
    const overallYearPct = overallYearPctFloat == null ? null : Math.round(overallYearPctFloat);

    // Per-term totals across all subjects for this student
    const termTotals = terms.map(t => {
      const arr = state.assignments.filter(a => {
        if (a.studentId !== studentId) return false;
        const d = parseIsoDateLocal(a.date);
        return parseIsoDateLocal(t.start) <= d && d <= parseIsoDateLocal(t.end);
      });
      const sums = arr.reduce((acc, a) => { acc.c += a.correct; acc.t += a.total; return acc; }, { c: 0, t: 0 });
      return sums.t > 0 ? (sums.c / sums.t) * 100 : null;
    });

    const doc = window.open('', '_blank');
    if (!doc) return;
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Report Card - ${escapeHtml(student.name)}</title>
  <style>
    /* Black & White print layout */
    @page { size: Letter; margin: 18mm; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; }
    .header { display:flex; justify-content: space-between; align-items:center; border:2px solid #000; padding:8px; font-weight:700; }
    .hdr-left { font-size:14px; }
    .hdr-right { font-size:12px; }
    .info { display:grid; grid-template-columns: 2fr 1fr 1fr; border:2px solid #000; border-top:none; }
    .cell { border-right:1px solid #000; padding:6px 8px; font-size:12px; }
    .cell:last-child { border-right:none; }
    .label { font-weight:700; display:block; margin-bottom:4px; }
    table { width:100%; border-collapse:collapse; border:2px solid #000; margin-top:8px; }
    th, td { border:1px solid #000; padding:6px 8px; font-size:12px; text-align:left; }
    th { background:#fff; font-weight:700; }
    .center { text-align:center; }
  </style>
  <script>window.onload = function(){ setTimeout(function(){ window.print(); window.close(); }, 100); }<\/script>
  </head>
<body>
  <div class="header">
    <div class="hdr-left">${escapeHtml(state.schoolName || '')} — ${yearName} Report Card</div>
    <div class="hdr-right">${rangeText}</div>
  </div>
  <div class="info">
    <div class="cell"><span class="label">Student Name</span>${escapeHtml(student.name)}</div>
    <div class="cell"><span class="label">School Year</span>${yearName}</div>
    <div class="cell"><span class="label">Generated</span>${formatDateDisplay(todayStr())}</div>
  </div>
  <div class="info" style="border-top:none; grid-template-columns: 1fr 1fr;">
    <div class="cell"><span class="label">Overall GPA</span>${gpaOverall == null ? '' : gpaOverall.toFixed(2)}</div>
    <div class="cell"><span class="label">Overall %</span>${overallYearPct == null ? '' : overallYearPct + '%'}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:40%">Course</th>
        ${terms.map((t, i) => `<th class=\"center\">T${i + 1}</th>`).join('')}
        <th class="center">Year</th>
      </tr>
    </thead>
    <tbody>
      ${bySubject.map(row => `
        <tr>
          <td>${escapeHtml(row.name)}</td>
          ${terms.map((t, i) => `<td class=\"center\">${row.perTerm[i] == null ? '' : Math.round(row.perTerm[i]) + '% (' + row.perTermLetters[i] + ')'}</td>`).join('')}
          <td class="center">${row.year == null ? '' : Math.round(row.year) + '% (' + row.yearLetter + ')'}</td>
        </tr>`).join('')}
        <tr>
          <td><strong>Totals</strong></td>
          ${terms.map((t, i) => {
          const v = termTotals[i];
          const l = v == null ? null : letterGrade(v);
          return `<td class=\"center\"><strong>${v == null ? '' : Math.round(v) + '% (' + l + ')'}</strong></td>`;
        }).join('')}
          <td class="center"><strong>${overallYearPct == null ? '' : Math.round(overallYearPct) + '% (' + letterGrade(overallYearPct) + ')'}</strong></td>
        </tr>
    </tbody>
  </table>
</body>
</html>`;
    doc.document.write(html);
    doc.document.close();
  }

  // Shared data handlers so legacy and data-card buttons both work
  async function doSaveJson() {
    try {
      const now = new Date();
      const y = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const mi = String(now.getMinutes()).padStart(2, '0');
      const defaultName = `homeschool-grades_${y}-${mm}-${dd}_${hh}${mi}.json`;
      const json = JSON.stringify(state, null, 2);
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({
          suggestedName: defaultName,
          types: [{ description: 'JSON Files', accept: { 'application/json': ['.json'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
      } else {
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        const url = URL.createObjectURL(blob);
        a.href = url; a.download = defaultName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
      setStatus('Saved');
    } catch (e) {
      console.error(e);
      setStatus('Save failed');
    }
  }

  async function doImportJson() {
    try {
      if (window.showOpenFilePicker) {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'JSON Files', accept: { 'application/json': ['.json'] } }],
          multiple: false
        });
        const file = await handle.getFile();
        const text = await file.text();
        handleImportedJson(text);
      } else {
        hiddenFileInput.value = '';
        hiddenFileInput.click();
      }
    } catch (e) {
      console.error(e);
      setStatus('Import cancelled');
    }
  }

  function doGenerateDebugData() {
    if (state.students.length === 0 || state.subjects.length === 0) {
      setStatus('Add at least one student and subject first');
      return;
    }
    const ok = confirm('Generate sample assignments across all terms for all students and subjects?');
    if (!ok) return;
    const rng = seededRandom();
    state.students.forEach(student => {
      const totalAssignments = 100;
      const perSubject = Math.max(1, Math.floor(totalAssignments / Math.max(1, state.subjects.length)));
      let created = 0;
      state.subjects.forEach(subject => {
        for (let i = 0; i < perSubject; i++) {
          const term = getActiveTerms()[i % getActiveTerms().length];
          const date = randomDateInRange(parseIsoDateLocal(term.start), parseIsoDateLocal(term.end), rng);
          const total = 10 + Math.floor(rng() * 21);
          const correct = Math.max(0, Math.min(total, Math.floor(total * (0.5 + rng() * 0.5))));
          state.assignments.push({
            id: cryptoRandomId(),
            studentId: student.id,
            subjectId: subject.id,
            total,
            correct,
            date: fmtDate(date),
            termId: termIdForDate(getActiveTerms(), fmtDate(date))
          });
          created++;
        }
      });
      while (created < totalAssignments) {
        const subject = state.subjects[Math.floor(rng() * state.subjects.length)];
        const term = getActiveTerms()[Math.floor(rng() * getActiveTerms().length)];
        const date = randomDateInRange(parseIsoDateLocal(term.start), parseIsoDateLocal(term.end), rng);
        const total = 10 + Math.floor(rng() * 21);
        const correct = Math.max(0, Math.min(total, Math.floor(total * (0.5 + rng() * 0.5))));
        state.assignments.push({
          id: cryptoRandomId(),
          studentId: student.id,
          subjectId: subject.id,
          total,
          correct,
          date: fmtDate(date),
          termId: termIdForDate(getActiveTerms(), fmtDate(date))
        });
        created++;
      }
    });
    saveState();
    renderAssignmentsTable();
    refreshReports();
    setStatus('Debug data generated');
  }

  function doClearAllAssignments() {
    const ok = confirm('Clear ALL assignments? This cannot be undone.');
    if (!ok) return;
    state.assignments = [];
    saveState();
    renderAssignmentsTable();
    refreshReports();
    setStatus('Assignments cleared');
  }

  function doReset() {
    const ok = confirm('Reset will clear ALL data and restore defaults. Continue?');
    if (!ok) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.error(e);
    }
    state = loadState();
    saveState();
    // Update header and input immediately
    if (appSchoolNameEl) appSchoolNameEl.textContent = state.schoolName || 'Homeschool Grading Calculator';
    if (schoolNameInput) schoolNameInput.value = state.schoolName || '';
    syncAllUI();
    setStatus('App reset');
  }

  function doBackfillTerms() {
    const terms = getAllTerms();
    let updated = 0;
    state.assignments.forEach(a => {
      const d = parseIsoDateLocal(a.date);
      const match = terms.find(t => {
        const ts = parseIsoDateLocal(t.start);
        const te = parseIsoDateLocal(t.end);
        return ts <= d && d <= te;
      });
      const newId = match ? match.id : undefined;
      if ((a.termId || undefined) !== newId) {
        a.termId = newId;
        updated++;
      }
    });
    saveState();
    renderAssignmentsTable();
    refreshReports();
    setStatus(updated ? `Backfilled ${updated} assignments` : 'No changes');
  }

  // Wire Save buttons (Data card Save and legacy Export JSON)
  document.querySelectorAll('#save-btn, #export-btn').forEach(btn => {
    if (btn) btn.addEventListener('click', doSaveJson);
  });

  // Wire Import buttons (Data card Import and legacy Import JSON)
  document.querySelectorAll('#import-btn').forEach(btn => {
    if (btn) btn.addEventListener('click', doImportJson);
  });

  // Hidden file input stays as-is for fallback

  // Wire Debug buttons (Data card Debug Import and legacy Generate Debug Data)
  document.querySelectorAll('#debug-import-btn, #debug-generate-btn').forEach(btn => {
    if (btn) btn.addEventListener('click', doGenerateDebugData);
  });

  // Wire Clear All Assignments (both Data card and legacy card)
  document.querySelectorAll('#clear-assignments-btn').forEach(btn => {
    if (btn) btn.addEventListener('click', doClearAllAssignments);
  });

  // Wire Reset and Backfill Terms (Data card)
  document.querySelectorAll('#reset-btn').forEach(btn => {
    if (btn) btn.addEventListener('click', doReset);
  });
  document.querySelectorAll('#backfill-terms-btn').forEach(btn => {
    if (btn) btn.addEventListener('click', doBackfillTerms);
  });

  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', async () => {
      await initSupabaseSync();
      try { await uploadState(true); } catch (_) { setStatus('Sync failed'); return; }
    });
  }

  // Wire Export to Excel (CSV) button
  if (exportExcelBtn) {
    exportExcelBtn.addEventListener('click', exportCurrentYearCsv);
  }

  // Wire student nav buttons
  if (studentPrevBtn) studentPrevBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const list = state.students || [];
    if (!list.length) return;
    const sel = getSelectedStudentId();
    const idx = Math.max(0, list.findIndex(s => s.id === sel));
    const nextIdx = (idx - 1 + list.length) % list.length;
    applySelectedStudent(list[nextIdx].id);
    if (document.activeElement === studentPrevBtn && typeof studentPrevBtn.blur === 'function') studentPrevBtn.blur();
  });
  if (studentNextBtn) studentNextBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    const list = state.students || [];
    if (!list.length) return;
    const sel = getSelectedStudentId();
    const idx = Math.max(0, list.findIndex(s => s.id === sel));
    const nextIdx = (idx + 1) % list.length;
    applySelectedStudent(list[nextIdx].id);
    if (document.activeElement === studentNextBtn && typeof studentNextBtn.blur === 'function') studentNextBtn.blur();
  });

  // Init
  init();
  // After initial render, align heights once DOM settles

  // Auth button handlers
  if (authSignInBtn) authSignInBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!supabaseClient) await initSupabaseSync();
    const email = authEmailInput && authEmailInput.value.trim();
    const password = authPasswordInput && authPasswordInput.value;
    if (!email || !password) { setStatus('Enter email and password'); return; }
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) { console.error(error); setStatus('Sign in failed'); return; }
    setStatus('Signed in');
  });
  if (authSignUpBtn) authSignUpBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!supabaseClient) await initSupabaseSync();
    const email = authEmailInput && authEmailInput.value.trim();
    const password = authPasswordInput && authPasswordInput.value;
    if (!email || !password) { setStatus('Enter email and password'); return; }
    const { error } = await supabaseClient.auth.signUp({ email, password });
    if (error) { console.error(error); setStatus('Sign up failed'); return; }
    setStatus('Check email to confirm');
  });
  if (authSignOutBtn) authSignOutBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!supabaseClient) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) { console.error(error); setStatus('Sign out failed'); return; }
    setStatus('Signed out');
  });

})();
