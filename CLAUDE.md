# CLAUDE.md - Developer & AI Instructions for Two-Stage Tournament Manager

Welcome to the **Two-Stage Tournament Manager** repository. This document is tailored specifically for **Claude Code** and developers working on this project (particularly on the `tomer` branch).

---

## 📌 Project Overview
A web-based, mobile-responsive application for managing multi-stage sports/gaming tournaments.
- **Frontend Stack**: Vanilla HTML5, modern CSS3 (`style.css`), Vanilla JavaScript (`app.js`).
- **Database & Auth**: Google Firebase (Firestore Database + Firebase Authentication via Google Identity).
- **Deployment**: GitHub Pages (static web hosting).
- **Primary Language of UI**: Hebrew (RTL - Right to Left interface).
- **Owner / Repo**: `noamsee/Two-Stage-Tournament-Manager`
- **Current Production Site**: `https://noamsee.github.io/Two-Stage-Tournament-Manager/`

---

## 🛠️ Architecture & Core Components

### 1. File Structure
```text
├── index.html       # Single Page Application HTML structure (Hebrew RTL layout)
├── style.css        # Responsive styling, RTL tweaks, modals, brackets, standings
├── app.js           # Core business logic, Firebase init, state management, UI rendering
├── .nojekyll        # Disables Jekyll processing on GitHub Pages
├── CLAUDE.md        # This file (Instructions for Claude Code / developers)
└── README.md        # Public repository documentation
```

### 2. State & Data Models
- **Tournaments Collection (`tournaments`)**:
  - `id`: Unique document ID.
  - `name`: Tournament title.
  - `date`: Creation/scheduled date.
  - `status`: `"active"` or `"closed"`.
  - `groups`: Object holding group details (e.g., `Group A`, `Group B`, etc.), teams list, and Berger-round-robin match schedules.
  - `playoff`: Object storing knockout matches (quarter-finals, semi-finals, finals, champion).
  - `lastUpdated`: Timestamp.
- **Users Collection (`users`)**:
  - `email`: Normalized lowercase email string (used as document ID).
  - `role`: `"owner"`, `"admin"`, or `"viewer"`.
  - `name`: Display name.

### 3. Permission System (RBAC)
- **Viewer**: Read-only access to schedules, standings, and playoff brackets. Match inputs and administrative buttons are disabled or hidden.
- **Admin** (added by the Owner in User Management, plus any address listed in `BUILT_IN_ADMIN_EMAILS` in `app.js`, which is empty by default; an address listed there logs in with email + the default password `1234`, so do not ship one to production): Can create tournaments, close/reopen tournaments, enter match scores, generate playoff brackets, and export data.
- **Developer** (`DEVELOPER_EMAILS` in `app.js`, currently `tomerseel@gmail.com`): Everything an Admin can do, plus deleting tournaments and the debugging tools (fill sample results, reset results, simulate/reset playoff, sample team names). No access to User Management. Developer sign-in is Google-only; the password form refuses developer emails. The debugging tools are hidden from Admins (`.debug-only`, `canUseDebugTools`).
- **Owner** (`noamsee@gmail.com`): Full administrative control **plus** access to User Management (grant/revoke admin rights) and permission to permanently delete tournaments.

### 4. Firestore Sync Architecture
- Uses Firestore real-time snapshots (`onSnapshot`) to synchronize scores and status across devices instantly.
- Batch writes (`writeBatch`) ensure updates to all matches/houses occur atomically without orphaned records.
- When saving tournament structure, whole documents are replaced rather than deep-merged to avoid leftover "ghost" groups when reducing group counts.

---

## 🚀 Setup Guide for Tomer (`tom260s`)

### Step 1: Clone or Fork the Repository
Tomer can work in two ways:
#### Option A: Working on his own Fork (Recommended for independent GitHub Pages)
1. Fork `https://github.com/noamsee/Two-Stage-Tournament-Manager` to `tom260s/Two-Stage-Tournament-Manager`.
2. Clone the fork locally:
   ```bash
   git clone https://github.com/tom260s/Two-Stage-Tournament-Manager.git
   cd Two-Stage-Tournament-Manager
   git checkout -b tomer origin/tomer
   ```
3. Enable GitHub Pages on the fork:
   - Go to **Settings** -> **Pages**.
   - Under **Build and deployment**, set branch to `tomer` (or `main`) and folder to `/ (root)`.
   - The test site will be live at: `https://tom260s.github.io/Two-Stage-Tournament-Manager/`

#### Option B: Direct Clone as Collaborator
If working directly on the parent repository:
```bash
git clone https://github.com/noamsee/Two-Stage-Tournament-Manager.git
cd Two-Stage-Tournament-Manager
git checkout tomer
```

### Step 2: Authorize Domain in Firebase
To allow Google Sign-In and Firestore connections on Tomer's GitHub Pages:
1. Open the [Firebase Console](https://console.firebase.google.com/).
2. Select the **Two-Stage Tournament Manager** project.
3. Navigate to **Authentication** -> **Settings** -> **Authorized domains**.
4. Click **Add domain** and enter:
   ```text
   tom260s.github.io
   ```
5. Save changes.

---

## 💻 Development & Workflow Rules for Claude Code

When writing code or introducing features:
1. **RTL & Hebrew Support**:
   - The user interface is strictly Hebrew RTL (`dir="rtl"`). Ensure strings, button labels, and alert dialogs maintain native Hebrew phrasing.
2. **Vanilla JS / No Build Steps**:
   - All logic runs directly in modern browsers via standard ES6+ in `app.js`.
   - Do **not** introduce bundlers, Webpack, or npm dependencies unless explicitly instructed by the user. Keep it zero-build so GitHub Pages deploys immediately on `git push`.
3. **Data Integrity & No-Ties Rule**:
   - Matches must never end in a draw/tie. The application enforces winner selection based on higher score.
   - Catchball scoring: a win is worth 2 league points and a loss 1 (fixed for every tournament, not editable). An equal score is an undecided game: it has no winner and is not counted in the standings.
   - Sets: each tournament has `setsPerMatch` (1 or 3, chosen in the wizard with no default; applies to house games and playoff games in every format). With 3 sets a game is best-of-three: `match.sets` holds `{s1, s2}` per set, the game is won by the first team to 2 sets, and `score1`/`score2` then hold sets won. A set with equal points is undecided and not counted.
   - Standings order follows the official cachibol/Mamanet rules: 1) matches won, 2) ranking points (2 per win, 1 per loss), 3) set ratio (sets won / sets lost), 4) point ratio (points scored / points conceded), 5) if exactly two teams are still level, the winner of the last game between them. See `compareByOfficialCriteria` and `applyHeadToHead`.
   - Game board creation is one-time: every new tournament (houses or knockout-only) starts with empty team names and `boardCreated: false`. Only the settings tab is shown until every team has a name and "create game board" (or "create playoff tree" for knockout-only) is pressed; after that the settings tab is hidden. A knockout-only tournament has no houses tab at all. Tournaments saved before this flag existed count as created. Managers can still rename teams afterwards from the header button "שינוי שמות קבוצות" (`renameTeam`), which updates the name everywhere without touching results.
   - Zero tournaments is a valid state. Deleting the last tournament creates nothing in its place, and an empty cloud collection is not re-seeded. The last tournament is not removed from Firestore but overwritten with `isDeleted: true` (a hidden marker that every client filters out in the tournaments listener): browsers still running a build older than v4.38 re-upload their cached tournaments whenever the collection becomes empty, which made the deleted tournament come back. The marker is hard-deleted automatically once another real tournament exists. With no tournament to show (`activeTournamentId === null`, body class `no-tournament`) managers see only a create-tournament button and viewers see a waiting message, both on the entry screen and inside the app. When the displayed tournament disappears the app falls back to the first non-archived one (`getFallbackTournament`), never to an archived one.
   - Tournament names: the displayed `name` is `<baseName> - <dd/mm/yyyy>`, built by `buildTournamentName` from `baseName` and `eventDate` (ISO), set to the creation date in the wizard and editable from the header button "שנה שם או תאריך". Tournaments created earlier have only `name`.
   - Finished vs archived: `isFinished` (set by the header button "סיים טורניר", any manager, only once `isTournamentComplete()` is true) locks every result for everyone but keeps the tournament visible to viewers. `isArchived` ("העבר לארכיון", owner and developer only) also hides it from viewers. `isCurrentTournamentClosed()` is true for both and is the read-only check; use `isCurrentTournamentArchived()` / `isCurrentTournamentFinished()` to tell them apart. Complete means: houses-only, every house game decided; knockout-only, a champion; houses + playoff, both.
4. **Cache Busting**:
   - In `index.html`, script and stylesheet links include version query parameters (e.g., `app.js?v=3.6`). Whenever major modifications are pushed, bump the version string in `index.html` to prevent aggressive browser caching.
5. **Git Workflow**:
   - Commit all progress to the `tomer` branch.
   - When ready for production merge into `main`, open a Pull Request targeting `main`.

---

## 📝 Recent Bug Fixes & Context (October 2026)
- **User Management Deletion**: Fixed an issue where deleted users reappeared on reload. Deletions now call `deleteDoc()` on Firestore document IDs directly.
- **Tournament Actions**: Added "Close Tournament" (`סגור טורניר`) / "Reopen Tournament" (`פתח טורניר מחדש`). Owner retains exclusive button to permanently delete tournaments.
- **Dynamic House Reduction**: Fixed an issue where changing 3 houses to 2 houses caused ghost groups and duplicate match toolbars.
- **Navigation**: Restored and verified the "View Tournament" (`צפה בטורניר`) button handler in the tournament list.
